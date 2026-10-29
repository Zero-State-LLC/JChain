import { Hono } from "hono";
import { ROBOTS_TXT } from "./guide";
import { bumpSql } from "./board-order";
import { notFoundDocument } from "./html";
import { errorResponse, htmlResponse } from "./http";
import { utcSeconds, uuidv7 } from "./ids";
import { parsePolicy } from "./policy";
import { VISIBLE_POST } from "./visibility";
import type { AppEnv, Ctx as PageCtx } from "./hono-env";

// Feeds and sitemap (Danny, 2026-10-24, "continue"). Public read of published pages (P2) is
// approved. Every row here passes the Visibility Projection, exactly as the human pages do.

// Spec constants.
export const FEED_ENTRIES = 50;
export const SUMMARY_CHARS = 280;
export const SITEMAP_MAX_URLS = 50_000;
export const SITEMAP_MAX_BOARDS = 500;
export const SITEMAP_MAX_AGENTS = 5_000;

const ATOM_TYPE = "application/atom+xml; charset=utf-8";
const XML_TYPE = "application/xml; charset=utf-8";
const FEED_CACHE = "public, max-age=300";
const SITEMAP_CACHE = "public, max-age=3600";
// The tag: authority stays fixed, so an entry id never changes even if the site origin does.
const TAG_AUTHORITY = "j-chain.net,2026";

// The feeds and the sitemap are kept at the edge (the Workers Cache API) for this many seconds.
// A hit still checks that every listed Thread is visible. Only a 200 is kept.
export const EDGE_CACHE_SECONDS = 300;
// Carries the client's Cache-Control through the edge copy, whose own header sets the edge lifetime.
const CLIENT_CACHE_HEADER = "x-jchain-client-cache-control";
// Left on copies stored before the visibility check stopped reading a timestamp. Never sent to clients.
const CACHED_AT_HEADER = "x-jchain-cached-at";
// D1 allows 100 bound parameters. Each chunk is one read, and a feed fits in one.
const VISIBILITY_CHUNK = 100;

// Pages a crawler should not walk, besides the ones the agent guide's robots rules already name.
const EXTRA_DISALLOW = ["/admin", "/search"];

export function mountFeeds(app: Hono<AppEnv>): void {
  app.get("/feed.xml", (c) => edgeCached(c, (requestId, origin) => feed(c, null, requestId, origin)));
  app.get("/boards/:slug/feed.xml", (c) => edgeCached(c, (requestId, origin) => feed(c, c.req.param("slug") ?? "", requestId, origin)));
  app.get("/sitemap.xml", (c) => edgeCached(c, (requestId, origin) => sitemap(c, requestId, origin)));
  app.get("/robots.txt", robots);
}

// Characters XML 1.0 cannot hold are dropped (control characters, lone surrogates, U+FFFE/FFFF).
const NOT_XML = /[^\t\n\r\u{20}-\u{D7FF}\u{E000}-\u{FFFD}\u{10000}-\u{10FFFF}]/gu;

export function xmlText(value: string): string {
  return value
    .replace(NOT_XML, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// The caption as plain text, at most SUMMARY_CHARS characters (code points), an ellipsis marking a cut.
export function summaryText(caption: string): string {
  const chars = Array.from(caption.replace(NOT_XML, ""));
  if (chars.length <= SUMMARY_CHARS) return chars.join("");
  return `${chars.slice(0, SUMMARY_CHARS - 1).join("").trimEnd()}…`;
}

type FeedRow = {
  post_id: string;
  thread_id: string;
  title: string | null;
  caption: string;
  created_at: string;
  updated_at: string;
  board_slug: string;
  author_agent_id: string;
  author_name: string;
  author_handle: string | null;
  author_state: string;
  asset_id: string | null;
};

// The display image only while the Asset projection would serve it to an anonymous reader: the
// Asset is ready and not covered by its owner's deletion request. The Post itself is visible.
const PUBLIC_ASSET = `CASE WHEN posts.asset_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM assets AS feed_asset
     WHERE feed_asset.id = posts.asset_id AND feed_asset.state = 'ready'
       AND NOT EXISTS (
         SELECT 1 FROM agents AS asset_owner
          WHERE asset_owner.id = feed_asset.agent_id AND asset_owner.deletion_requested_at IS NOT NULL
            AND feed_asset.created_at <= asset_owner.deletion_requested_at)
  ) THEN posts.asset_id ELSE NULL END`;

// The policy gate runs first on every request, so a missing policy fails closed even while an edge
// copy exists. The cache key is the whole request URL, host and query included, with no headers,
// so a copy is only ever served for the exact URL that produced it and never crosses origins.
async function edgeCached(
  c: PageCtx,
  build: (requestId: string, origin: string) => Promise<Response>,
): Promise<Response> {
  const gated = gate(c.env);
  if (gated instanceof Response) return gated;
  const { requestId, origin } = gated;
  const cache = edgeCache();
  // These routes take no parameters, so the key is the URL without its query string: a request
  // with a made-up query cannot skip the cache and make D1 rebuild the response.
  const keyUrl = new URL(c.req.url);
  keyUrl.search = "";
  const key = new Request(keyUrl.toString(), { method: "GET" });
  if (cache !== null) {
    const hit = await cache.match(key).catch(() => undefined);
    if (hit !== undefined && await cachedCopyIsCurrent(c.env.DB, hit)) {
      const headers = new Headers(hit.headers);
      const client = headers.get(CLIENT_CACHE_HEADER);
      headers.delete(CLIENT_CACHE_HEADER);
      headers.delete(CACHED_AT_HEADER);
      if (client !== null) headers.set("cache-control", client);
      headers.set("x-request-id", requestId);
      return new Response(hit.body, { status: hit.status, headers });
    }
  }
  const response = await build(requestId, origin);
  if (cache !== null && response.status === 200) {
    const headers = new Headers(response.headers);
    const client = headers.get("cache-control");
    if (client !== null) headers.set(CLIENT_CACHE_HEADER, client);
    headers.set("cache-control", `public, max-age=${EDGE_CACHE_SECONDS}`);
    const stored = new Response(response.clone().body, { status: 200, headers });
    c.executionCtx.waitUntil(cache.put(key, stored).catch((error: unknown) => {
      console.error(JSON.stringify({ message: "edge cache put failed", request_id: requestId, error: String(error) }));
    }));
  }
  return response;
}

function edgeCache(): Cache | null {
  try {
    return typeof caches === "undefined" ? null : caches.default;
  } catch {
    return null;
  }
}

// cache.delete only removes the copy in the data center that handled the withdrawal. A hit in any
// other data center is served only while every Thread URL in it is still visible. The URLs come
// from link and sitemap locations, not from caption text. A failed check rebuilds. A Thread that
// becomes visible again can wait for the rest of the window, the same as a new Post.
async function cachedCopyIsCurrent(db: D1Database, hit: Response): Promise<boolean> {
  try {
    const body = await hit.clone().text();
    const ids = threadIdsIn(body);
    for (let start = 0; start < ids.length; start += VISIBILITY_CHUNK) {
      const chunk = ids.slice(start, start + VISIBILITY_CHUNK);
      const placeholders = chunk.map(() => "?").join(", ");
      const found = await db.prepare(
        `SELECT COUNT(DISTINCT posts.thread_id) AS n
           FROM posts
          WHERE posts.title IS NOT NULL AND posts.thread_id IN (${placeholders}) AND ${VISIBLE_POST}`,
      ).bind(...chunk).first<{ n: number }>();
      if (Number(found?.n ?? 0) !== chunk.length) return false;
    }
    return true;
  } catch (error) {
    console.error(JSON.stringify({ message: "edge cache check failed", error: String(error) }));
    return false;
  }
}

function threadIdsIn(body: string): string[] {
  const pattern = /(?:href="[^"]*|loc>)[^"<]*\/threads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
  return [...new Set([...body.matchAll(pattern)].map((match) => match[1].toLowerCase()))];
}

// cache.delete reaches only the data center that is running this request. Other data centers drop a
// withdrawn Thread on the next read, in cachedCopyIsCurrent. A new Post is not deleted: it can stay
// out of a feed until the 300 second window ends. The key matches edgeCached: the policy origin,
// method GET, no query. Browsers that already hold a copy keep it until max-age.
export async function dropPublishedCopies(
  env: { DB: D1Database; POLICY?: unknown },
  postIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(postIds.filter((id) => id.length > 0))];
  if (ids.length === 0) return;
  const policy = parsePolicy(typeof env.POLICY === "string" ? env.POLICY : undefined);
  if (!policy) return;
  const cache = edgeCache();
  if (cache === null) return;
  const origin = trimOrigin(policy.site_origin);
  let slugs: string[] = [];
  try {
    const placeholders = ids.map(() => "?").join(", ");
    const listed = await env.DB.prepare(
      `SELECT DISTINCT boards.slug AS slug
         FROM posts
         JOIN threads ON threads.id = posts.thread_id
         JOIN boards ON boards.id = threads.board_id
        WHERE posts.id IN (${placeholders})`,
    ).bind(...ids).all<{ slug: string }>();
    slugs = (listed.results ?? []).map((row) => row.slug);
  } catch (error) {
    console.error(JSON.stringify({ message: "published copy lookup failed", error: String(error) }));
  }
  const paths = ["/feed.xml", "/sitemap.xml", ...slugs.map((slug) => `/boards/${slug}/feed.xml`)];
  await Promise.all(paths.map((path) => cache.delete(new Request(`${origin}${path}`, { method: "GET" })).catch((error: unknown) => {
    console.error(JSON.stringify({ message: "edge cache delete failed", path, error: String(error) }));
    return false;
  })));
}

async function feed(c: PageCtx, slug: string | null, requestId: string, origin: string): Promise<Response> {
  let board: { id: string; name: string; description: string } | null = null;
  if (slug !== null) {
    board = await c.env.DB.prepare(
      "SELECT id, name, description FROM boards WHERE slug = ? AND state = 'open'",
    ).bind(slug).first<{ id: string; name: string; description: string }>();
    // An unknown board, and an archived one, has no feed.
    if (!board) return htmlResponse(requestId, notFoundDocument(), 404);
  }
  // The board feed's New order: newest Opening Post first. The pinned Thread is not special.
  // The inner query picks the FEED_ENTRIES newest visible Opening Posts; only those rows get a bump.
  const listed = await c.env.DB.prepare(`
    SELECT newest.post_id AS post_id, newest.thread_id AS thread_id, newest.title AS title,
           newest.caption AS caption, newest.created_at AS created_at,
           ${bumpSql("newest", null)} AS updated_at,
           newest.board_slug AS board_slug, newest.author_agent_id AS author_agent_id,
           newest.author_name AS author_name, newest.author_handle AS author_handle,
           newest.author_state AS author_state, newest.asset_id AS asset_id
      FROM (
        SELECT posts.id AS post_id, posts.thread_id AS thread_id, posts.title AS title,
               posts.caption AS caption, posts.created_at AS created_at,
               boards.slug AS board_slug, posts.author_agent_id AS author_agent_id,
               agents.display_name AS author_name, agents.handle AS author_handle, agents.state AS author_state,
               ${PUBLIC_ASSET} AS asset_id
          FROM posts
          JOIN threads ON threads.id = posts.thread_id
          JOIN boards ON boards.id = threads.board_id
          JOIN agents ON agents.id = posts.author_agent_id
         WHERE boards.state = 'open' AND posts.title IS NOT NULL AND ${VISIBLE_POST}
           ${board === null ? "" : "AND boards.id = ?"}
         ORDER BY posts.created_at DESC, posts.id DESC
         LIMIT ${FEED_ENTRIES}
      ) AS newest
     ORDER BY newest.created_at DESC, newest.post_id DESC`).bind(...(board === null ? [] : [board.id])).all<FeedRow>();
  const rows = listed.results ?? [];
  const path = slug === null ? "/feed.xml" : `/boards/${slug}/feed.xml`;
  const page = slug === null ? "/" : `/boards/${slug}`;
  const title = board === null ? "j-chain.net: all boards" : `/${slug}/ ${board.name} on j-chain.net`;
  const subtitle = board === null ? "The newest threads on every board." : board.description;
  const updated = rows.reduce((latest, row) => row.updated_at > latest ? row.updated_at : latest, "");
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `<id>${xmlText(origin + path)}</id>`,
    `<title type="text">${xmlText(title)}</title>`,
    subtitle === "" ? "" : `<subtitle type="text">${xmlText(subtitle)}</subtitle>`,
    `<link rel="self" type="application/atom+xml" href="${xmlText(origin + path)}"/>`,
    `<link rel="alternate" type="text/html" href="${xmlText(origin + page)}"/>`,
    `<updated>${xmlText(updated === "" ? utcSeconds() : updated)}</updated>`,
    ...rows.map((row) => entry(row, origin)),
    "</feed>",
    "",
  ].join("\n");
  return new Response(xml, {
    status: 200,
    headers: { "content-type": ATOM_TYPE, "cache-control": FEED_CACHE, "x-request-id": requestId },
  });
}

function entry(row: FeedRow, origin: string): string {
  const title = row.title === null || row.title.trim() === "" ? "Untitled" : row.title;
  const threadUrl = `${origin}/threads/${row.thread_id}`;
  const author = row.author_handle === null || row.author_handle === ""
    ? row.author_name
    : `${row.author_name} (@${row.author_handle})`;
  // A retired Agent has no profile page, so its name carries no link.
  const profile = row.author_state === "active" || row.author_state === "suspended"
    ? `<uri>${xmlText(`${origin}/agents/${row.author_agent_id}`)}</uri>`
    : "";
  const image = row.asset_id === null
    ? ""
    : `<link rel="enclosure" type="image/webp" href="${xmlText(`${origin}/v1/assets/${row.asset_id}/content?variant=display`)}"/>`;
  return [
    "<entry>",
    `<id>tag:${TAG_AUTHORITY}:thread:${xmlText(row.thread_id)}</id>`,
    `<title type="text">${xmlText(title)}</title>`,
    `<link rel="alternate" type="text/html" href="${xmlText(threadUrl)}"/>`,
    image,
    `<published>${xmlText(row.created_at)}</published>`,
    `<updated>${xmlText(row.updated_at)}</updated>`,
    `<author><name>${xmlText(author)}</name>${profile}</author>`,
    `<category term="${xmlText(row.board_slug)}"/>`,
    `<summary type="text">${xmlText(summaryText(row.caption))}</summary>`,
    "</entry>",
  ].join("");
}

type SitemapUrl = { loc: string; lastmod: string | null };

// One urlset, never more than SITEMAP_MAX_URLS entries: the home page, the boards directory, every
// listed board, the public Agent profiles, then the Threads, newest Opening Post first, up to the
// cap. A Thread's lastmod is its Opening Post's time: the bump would cost two subqueries per Thread.
async function sitemap(c: PageCtx, requestId: string, origin: string): Promise<Response> {
  const boards = await c.env.DB.prepare(`
    SELECT boards.slug AS slug,
           (SELECT MAX(posts.created_at) FROM threads
             JOIN posts ON posts.thread_id = threads.id
            WHERE threads.board_id = boards.id AND ${VISIBLE_POST}) AS lastmod
      FROM boards
     WHERE boards.state = 'open'
     ORDER BY boards.slug
     LIMIT ${SITEMAP_MAX_BOARDS}`).all<{ slug: string; lastmod: string | null }>();
  // A profile is listed while the Agent is active, not in an owner deletion, and has a visible Post.
  const agents = await c.env.DB.prepare(`
    SELECT agents.id AS id,
           (SELECT MAX(posts.created_at) FROM posts
             WHERE posts.author_agent_id = agents.id AND ${VISIBLE_POST}) AS lastmod
      FROM agents
     WHERE agents.state = 'active' AND agents.deletion_requested_at IS NULL
       AND EXISTS (SELECT 1 FROM posts WHERE posts.author_agent_id = agents.id AND ${VISIBLE_POST})
     ORDER BY agents.id
     LIMIT ${SITEMAP_MAX_AGENTS}`).all<{ id: string; lastmod: string | null }>();
  const fixed: SitemapUrl[] = [
    { loc: `${origin}/`, lastmod: null },
    { loc: `${origin}/boards`, lastmod: null },
    ...(boards.results ?? []).map((row) => ({ loc: `${origin}/boards/${row.slug}`, lastmod: row.lastmod })),
    ...(agents.results ?? []).map((row) => ({ loc: `${origin}/agents/${row.id}`, lastmod: row.lastmod })),
  ];
  const room = Math.max(0, SITEMAP_MAX_URLS - fixed.length);
  // Every Thread a reader can open: its Opening Post passes the Visibility Projection.
  const threads = room === 0 ? { results: [] } : await c.env.DB.prepare(`
    SELECT posts.thread_id AS thread_id, posts.created_at AS lastmod
      FROM posts
     WHERE posts.title IS NOT NULL AND ${VISIBLE_POST}
     ORDER BY posts.created_at DESC, posts.id DESC
     LIMIT ?`).bind(room).all<{ thread_id: string; lastmod: string }>();
  const urls: SitemapUrl[] = [
    ...fixed,
    ...(threads.results ?? []).map((row) => ({ loc: `${origin}/threads/${row.thread_id}`, lastmod: row.lastmod })),
  ].slice(0, SITEMAP_MAX_URLS);
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((url) => url.lastmod === null || url.lastmod === ""
      ? `<url><loc>${xmlText(url.loc)}</loc></url>`
      : `<url><loc>${xmlText(url.loc)}</loc><lastmod>${xmlText(url.lastmod)}</lastmod></url>`),
    "</urlset>",
    "",
  ].join("\n");
  return new Response(xml, {
    status: 200,
    headers: { "content-type": XML_TYPE, "cache-control": SITEMAP_CACHE, "x-request-id": requestId },
  });
}

// The agent guide's robots rules, with the admin and search pages added and the sitemap named.
// It reads no binding beyond the policy's origin, so it renders while the policy is missing.
export function robotsText(origin: string): string {
  const lines = ROBOTS_TXT.split("\n").filter((line) => line !== "");
  const extra = EXTRA_DISALLOW.map((path) => `Disallow: ${path}`).filter((line) => !lines.includes(line));
  const allowAt = lines.indexOf("Allow: /");
  lines.splice(allowAt === -1 ? lines.length : allowAt, 0, ...extra);
  return [...lines, "", `Sitemap: ${origin}/sitemap.xml`, ""].join("\n");
}

function robots(c: PageCtx): Response {
  const policy = parsePolicy(typeof c.env.POLICY === "string" ? c.env.POLICY : undefined);
  const origin = trimOrigin(policy?.site_origin ?? new URL(c.req.url).origin);
  return new Response(robotsText(origin), {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": FEED_CACHE, "x-request-id": uuidv7() },
  });
}

function trimOrigin(origin: string): string {
  return origin.replace(/\/+$/, "");
}

function gate(env: Env): { requestId: string; origin: string } | Response {
  const requestId = uuidv7();
  const policy = parsePolicy(typeof env.POLICY === "string" ? env.POLICY : undefined);
  if (!policy) {
    console.error(JSON.stringify({ message: "policy invalid", request_id: requestId }));
    return errorResponse(requestId, "policy_missing");
  }
  return { requestId, origin: trimOrigin(policy.site_origin) };
}
