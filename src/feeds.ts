import { Hono, type Context } from "hono";
import { ROBOTS_TXT } from "./guide";
import { bumpSql } from "./board-order";
import { notFoundDocument } from "./html";
import { errorResponse, htmlResponse } from "./http";
import { utcSeconds, uuidv7 } from "./ids";
import { parsePolicy, type Policy } from "./policy";
import { VISIBLE_POST } from "./visibility";

// Feeds and sitemap (Danny, 2026-10-24, "continue"). Public read of published pages (P2) is
// approved. Every row here passes the Visibility Projection, exactly as the human pages do.

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type PageCtx = Context<AppEnv>;

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

// Pages a crawler should not walk, besides the ones the agent guide's robots rules already name.
const EXTRA_DISALLOW = ["/admin", "/search"];

export function mountFeeds(app: Hono<AppEnv>): void {
  app.get("/feed.xml", (c) => feed(c, null));
  app.get("/boards/:slug/feed.xml", (c) => feed(c, c.req.param("slug") ?? ""));
  app.get("/sitemap.xml", sitemap);
  app.get("/robots.txt", robots);
}

// Characters XML 1.0 cannot hold are dropped (control characters, lone surrogates, U+FFFE/FFFF).
const NOT_XML = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu;

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

async function feed(c: PageCtx, slug: string | null): Promise<Response> {
  const gated = gate(c.env);
  if (gated instanceof Response) return gated;
  const { requestId, origin } = gated;
  let board: { id: string; name: string; description: string } | null = null;
  if (slug !== null) {
    board = await c.env.DB.prepare(
      "SELECT id, name, description FROM boards WHERE slug = ? AND state = 'open'",
    ).bind(slug).first<{ id: string; name: string; description: string }>();
    // An unknown board, and an archived one, has no feed.
    if (!board) return htmlResponse(requestId, notFoundDocument(), 404);
  }
  // The board feed's New order: newest Opening Post first. The pinned Thread is not special.
  const listed = await c.env.DB.prepare(`
    SELECT posts.id AS post_id, posts.thread_id AS thread_id, posts.title AS title,
           posts.caption AS caption, posts.created_at AS created_at,
           ${bumpSql("posts", null)} AS updated_at,
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
     LIMIT ${FEED_ENTRIES}`).bind(...(board === null ? [] : [board.id])).all<FeedRow>();
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
// listed board, the public Agent profiles, then the Threads, latest bump first, up to the cap.
async function sitemap(c: PageCtx): Promise<Response> {
  const gated = gate(c.env);
  if (gated instanceof Response) return gated;
  const { requestId, origin } = gated;
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
    SELECT posts.thread_id AS thread_id, ${bumpSql("posts", null)} AS lastmod
      FROM posts
     WHERE posts.title IS NOT NULL AND ${VISIBLE_POST}
     ORDER BY lastmod DESC, posts.id DESC
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
