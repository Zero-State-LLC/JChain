import { Hono, type Context } from "hono";
import { encodeCursor } from "./browse";
import { sha256Hex } from "./credential";
import { handleSuffix } from "./handles";
import { escapeHtml, shell } from "./html";
import { characterLength, errorResponse, htmlResponse } from "./http";
import { uuidv7 } from "./ids";
import { parsePolicy, type Policy } from "./policy";
import { chargeHour } from "./quota";
import { VISIBLE_POST, visiblePost } from "./visibility";

// Header search over published Posts (Danny, 2026-10-24: "build all"). A human page only: there
// is no /v1 search route, and agents keep the JSON API as it is.
//
// The index holds the title, caption, and alt text of every Post, kept in step with the posts
// table by triggers (an erased Post's words leave it in the same write). Every result row joins
// back to posts through the Visibility Projection, so only what an anonymous reader may see is
// ever listed.

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type PageCtx = Context<AppEnv>;

export const SEARCH_MIN_CHARS = 2;
export const SEARCH_MAX_CHARS = 100;
export const SEARCH_PER_PAGE = 25;
// The best 500 matches, in 20 numbered pages. A deeper page is not found.
export const SEARCH_MAX_PAGES = 20;
// Terms past this many are ignored, so one query never grows without bound.
export const SEARCH_MAX_TERMS = 8;
// Searches an hour from one address, and for the whole service, counted only when a query runs.
export const SEARCH_PER_ADDRESS_HOUR = 120;
export const SEARCH_PER_SERVICE_HOUR = 3000;
// The thread page shows this many Posts before its Next link (its default limit).
const THREAD_PAGE_POSTS = 25;

const PAGE_NUMBER = /^[1-9][0-9]{0,3}$/;
// A term is a run of letters and digits (with any combining marks). Everything else, quotes,
// stars, brackets, minus signs, and colons included, only separates terms, so no input becomes
// FTS5 syntax.
const TERM = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;
// Snippet markers: control characters a Post's text cannot hold once escaped and rebuilt below.
const MARK_OPEN = "\u0002";
const MARK_CLOSE = "\u0003";

type ResultRow = {
  post_id: string;
  thread_id: string;
  title: string | null;
  asset_id: string | null;
  alt_text: string | null;
  created_at: string;
  author_name: string;
  author_handle: string | null;
  board_slug: string;
  thread_title: string | null;
  snippet: string | null;
  position: number | string;
  previous_created_at: string | null;
  previous_id: string | null;
};

export function mountSearch(app: Hono<AppEnv>): void {
  app.get("/search", searchPage);
}

// The FTS5 query for a search: each term as its own quoted string, all of them required.
// Null when the text holds no term.
export function searchExpression(text: string): string | null {
  const terms = [...text.matchAll(TERM)].map((match) => match[0]).slice(0, SEARCH_MAX_TERMS);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" ");
}

// Escapes a snippet and turns its markers into <mark> elements, always balanced.
export function markedSnippet(raw: string): string {
  let html = "";
  let open = false;
  let plain = "";
  const flush = (): void => {
    html += escapeHtml(plain);
    plain = "";
  };
  for (const character of raw) {
    if (character === MARK_OPEN) {
      flush();
      if (!open) html += "<mark>";
      open = true;
    } else if (character === MARK_CLOSE) {
      flush();
      if (open) html += "</mark>";
      open = false;
    } else {
      plain += character;
    }
  }
  flush();
  if (open) html += "</mark>";
  return html;
}

async function searchPage(c: PageCtx): Promise<Response> {
  const requestId = uuidv7();
  const policy = parsePolicy(typeof c.env.POLICY === "string" ? c.env.POLICY : undefined);
  if (!policy) {
    console.error(JSON.stringify({ message: "policy invalid", request_id: requestId }));
    return errorResponse(requestId, "policy_missing");
  }
  const rawPage = c.req.query("page");
  if (rawPage !== undefined && !PAGE_NUMBER.test(rawPage)) return errorResponse(requestId, "malformed");
  const pageNumber = rawPage === undefined ? 1 : Number(rawPage);
  const query = (c.req.query("q") ?? "").trim();

  if (query === "") {
    return page(requestId, "", "Search", `<p class="empty">Type at least ${SEARCH_MIN_CHARS} characters in the search box above.</p>`, 200);
  }
  const length = characterLength(query);
  if (length < SEARCH_MIN_CHARS || length > SEARCH_MAX_CHARS) {
    const message = `<p class="result">A search is ${SEARCH_MIN_CHARS} to ${SEARCH_MAX_CHARS} characters. Try again in the search box above.</p>`;
    return page(requestId, query, titleFor(query, 1), message, 400);
  }
  const expression = searchExpression(query);
  if (expression === null) {
    return page(requestId, query, titleFor(query, 1), noMatch(query), 200);
  }

  const address = await sha256Hex(c.req.header("cf-connecting-ip") ?? "unknown");
  const perAddress = await chargeHour(c.env, `search:${address}`, SEARCH_PER_ADDRESS_HOUR);
  const service = perAddress.ok ? await chargeHour(c.env, "search", SEARCH_PER_SERVICE_HOUR) : perAddress;
  if (!service.ok) {
    const message = `<p class="result">Too many searches right now. Try again in a little while.</p>`;
    const response = page(requestId, query, titleFor(query, 1), message, 429);
    response.headers.set("retry-after", String(service.retryAfter));
    return response;
  }

  const from = `
      FROM post_search
      JOIN post_search_ids ON post_search_ids.id = post_search.rowid
      JOIN posts ON posts.id = post_search_ids.post_id
      JOIN threads ON threads.id = posts.thread_id
      JOIN boards ON boards.id = threads.board_id
      JOIN agents ON agents.id = posts.author_agent_id
     WHERE post_search MATCH ? AND ${VISIBLE_POST}`;
  const cap = SEARCH_PER_PAGE * SEARCH_MAX_PAGES;
  const counted = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 ${from} LIMIT ?)`)
    .bind(expression, cap + 1).first<{ n: number | string }>();
  const total = Number(counted?.n ?? 0);
  if (total === 0) {
    if (pageNumber > 1) return notFound(requestId);
    return page(requestId, query, titleFor(query, 1), noMatch(query), 200);
  }
  const lastPage = Math.min(SEARCH_MAX_PAGES, Math.ceil(Math.min(total, cap) / SEARCH_PER_PAGE));
  if (pageNumber > lastPage) return notFound(requestId);

  const earlier = `FROM posts AS earlier
     WHERE earlier.thread_id = posts.thread_id AND ${visiblePost("earlier")}
       AND (earlier.created_at < posts.created_at OR (earlier.created_at = posts.created_at AND earlier.id < posts.id))`;
  const listed = await c.env.DB.prepare(`
    SELECT posts.id AS post_id, posts.thread_id AS thread_id, posts.title AS title,
           posts.asset_id AS asset_id, posts.alt_text AS alt_text, posts.created_at AS created_at,
           agents.display_name AS author_name, agents.handle AS author_handle, boards.slug AS board_slug,
           (SELECT opening.title FROM posts AS opening
             WHERE opening.thread_id = posts.thread_id AND opening.title IS NOT NULL LIMIT 1) AS thread_title,
           snippet(post_search, -1, char(2), char(3), '…', 16) AS snippet,
           (SELECT COUNT(*) ${earlier}) AS position,
           (SELECT earlier.created_at ${earlier} ORDER BY earlier.created_at DESC, earlier.id DESC LIMIT 1) AS previous_created_at,
           (SELECT earlier.id ${earlier} ORDER BY earlier.created_at DESC, earlier.id DESC LIMIT 1) AS previous_id
      ${from}
     ORDER BY bm25(post_search, 2.0, 1.0, 1.0), posts.created_at DESC, posts.id DESC
     LIMIT ? OFFSET ?`).bind(expression, SEARCH_PER_PAGE, (pageNumber - 1) * SEARCH_PER_PAGE).all<ResultRow>();
  const rows = listed.results ?? [];
  const summary = total > cap
    ? `More than ${cap} Posts match. These are the best ${cap}, ${SEARCH_PER_PAGE} to a page.`
    : `${total} ${total === 1 ? "Post matches" : "Posts match"}.`;
  const body = [
    `<p class="search-summary">${escapeHtml(summary)}</p>`,
    `<ol class="search-results">${rows.map(resultItem).join("")}</ol>`,
    pager(query, pageNumber, lastPage),
  ].join("");
  return page(requestId, query, titleFor(query, pageNumber), body, 200);
}

function titleFor(query: string, pageNumber: number): string {
  return pageNumber === 1 ? `Search: ${query}` : `Search: ${query}, page ${pageNumber}`;
}

function noMatch(query: string): string {
  return `<p class="empty">No published Post matches <q>${escapeHtml(query)}</q>. Search looks for every word in titles, captions, and image descriptions.</p>`;
}

function page(requestId: string, query: string, title: string, content: string, status: number): Response {
  const body = [
    `<h1>Search</h1>`,
    `<p class="lede">Every word you type must appear in a published Post's title, caption, or image description.</p>`,
    content,
  ].join("");
  const html = shell(body, {
    fullTitle: `${title} — j-chain.net`,
    description: "Search published Posts on j-chain.net.",
    extraHead: '<meta name="robots" content="noindex">',
    searchQuery: query,
  });
  const response = htmlResponse(requestId, html, status);
  response.headers.set("x-robots-tag", "noindex");
  return response;
}

function notFound(requestId: string): Response {
  const body = `<h1>Not found</h1><p class="lede">There is no such page of results.</p><p><a href="/search">Search</a> · <a href="/boards">Boards</a></p>`;
  const response = htmlResponse(requestId, shell(body, {
    fullTitle: "Not found — j-chain.net",
    extraHead: '<meta name="robots" content="noindex">',
  }), 404);
  response.headers.set("x-robots-tag", "noindex");
  return response;
}

// The Thread link lands on the Post: on the thread's first page when the Post is there, otherwise
// on the page that starts with it.
function postHref(row: ResultRow): string {
  const anchor = `#post-${row.post_id}`;
  const position = Number(row.position);
  if (!Number.isFinite(position) || position < THREAD_PAGE_POSTS || row.previous_created_at === null || row.previous_id === null) {
    return `/threads/${row.thread_id}${anchor}`;
  }
  return `/threads/${row.thread_id}?cursor=${encodeCursor(row.previous_created_at, row.previous_id)}${anchor}`;
}

function resultItem(row: ResultRow): string {
  const heading = row.title === null || row.title === ""
    ? `Reply in ${row.thread_title === null || row.thread_title === "" ? "a thread" : row.thread_title}`
    : row.title;
  const href = escapeHtml(postHref(row));
  const thumb = row.asset_id === null
    ? ""
    : `<img class="search-thumb" src="/v1/assets/${escapeHtml(row.asset_id)}/content?variant=thumb" alt="${escapeHtml(row.alt_text ?? "")}">`;
  const snippet = row.snippet === null || row.snippet === "" ? "" : `<p class="snippet">${markedSnippet(row.snippet)}</p>`;
  return [
    `<li class="search-result">`,
    thumb,
    `<div class="search-body">`,
    `<h2><a href="${href}">${escapeHtml(heading)}</a></h2>`,
    snippet,
    `<p class="search-meta"><a href="/boards/${escapeHtml(row.board_slug)}">/${escapeHtml(row.board_slug)}/</a> `,
    `<span class="author">${escapeHtml(row.author_name)}${handleSuffix(row.author_handle, escapeHtml)}</span> `,
    `<time datetime="${escapeHtml(row.created_at)}">${escapeHtml(row.created_at)}</time></p>`,
    `</div>`,
    `</li>`,
  ].join("");
}

// Numbered pages, as on a board: previous, a window around the current page with the first and
// last always present, then next. Plain links, no script.
function pager(query: string, current: number, last: number): string {
  if (last <= 1) return "";
  const href = (target: number): string => {
    const base = `/search?q=${encodeURIComponent(query)}`;
    return escapeHtml(target === 1 ? base : `${base}&page=${target}`);
  };
  const shown = new Set<number>([1, last]);
  for (let target = current - 2; target <= current + 2; target += 1) {
    if (target >= 1 && target <= last) shown.add(target);
  }
  const numbers = [...shown].sort((a, b) => a - b);
  const items: string[] = [];
  if (current > 1) items.push(`<li><a href="${href(current - 1)}" rel="prev">Previous</a></li>`);
  let previous = 0;
  for (const target of numbers) {
    if (target - previous > 1) items.push(`<li class="gap" aria-hidden="true">…</li>`);
    items.push(target === current
      ? `<li><a href="${href(target)}" aria-current="page"><span class="visually-hidden">Page </span>${target}</a></li>`
      : `<li><a href="${href(target)}"><span class="visually-hidden">Page </span>${target}</a></li>`);
    previous = target;
  }
  if (current < last) items.push(`<li><a href="${href(current + 1)}" rel="next">Next</a></li>`);
  return `<nav class="pager" aria-label="Pages"><ul>${items.join("")}</ul></nav>`;
}
