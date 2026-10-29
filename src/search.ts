import { Hono } from "hono";
import { encodeCursor } from "./browse";
import { sha256Hex } from "./credential";
import { handleSuffix } from "./handles";
import { escapeHtml, shell } from "./html";
import { characterLength, errorResponse, htmlResponse } from "./http";
import { uuidv7 } from "./ids";
import { parsePolicy } from "./policy";
import { chargeHour } from "./quota";
import { VISIBLE_POST, visiblePost } from "./visibility";
import type { AppEnv, Ctx as PageCtx } from "./hono-env";

// Header search over published Posts (Danny, 2026-10-24: "build all"). A human page only: there
// is no /v1 search route, and agents keep the JSON API as it is.
//
// Literal substring search (instr) over the posts table itself, not a full-text index: D1
// cannot export a database that holds a virtual table, and the restore rehearsal (#81) depends
// on export. Erased text is gone from posts, so it can never match. Every row is read through the
// Visibility Projection, so only what an anonymous reader may see is ever listed.

export const SEARCH_MIN_CHARS = 2;
export const SEARCH_MAX_CHARS = 100;
export const SEARCH_PER_PAGE = 25;
// The first 500 matches, in 20 numbered pages. A deeper page is not found.
export const SEARCH_MAX_PAGES = 20;
// Terms past this many are ignored, so one query never grows without bound.
export const SEARCH_MAX_TERMS = 5;
// Searches an hour from one address, and for the whole service, counted only when a query runs.
export const SEARCH_PER_ADDRESS_HOUR = 120;
export const SEARCH_PER_SERVICE_HOUR = 3000;
// The thread page shows this many Posts before its Next link (its default limit).
const THREAD_PAGE_POSTS = 25;
// Characters of Post text a snippet shows around the first match.
const SNIPPET_CHARS = 200;
const SNIPPET_LEAD = 60;

const PAGE_NUMBER = /^[1-9][0-9]{0,3}$/;

type ResultRow = {
  post_id: string;
  thread_id: string;
  title: string | null;
  caption: string;
  asset_id: string | null;
  alt_text: string | null;
  created_at: string;
  author_name: string;
  author_handle: string | null;
  board_slug: string;
  thread_title: string | null;
  position: number | string;
  previous_created_at: string | null;
  previous_id: string | null;
};

export function mountSearch(app: Hono<AppEnv>): void {
  app.get("/search", searchPage);
}

// The search terms: whitespace-separated, at most SEARCH_MAX_TERMS, in order, duplicates kept once.
export function searchTerms(text: string): string[] {
  const terms: string[] = [];
  for (const term of text.split(/\s+/u)) {
    if (term === "" || terms.includes(term)) continue;
    terms.push(term);
    if (terms.length === SEARCH_MAX_TERMS) break;
  }
  return terms;
}

// The needle for a term. The queries match with instr() on lower(text), not LIKE: D1 caps a LIKE
// pattern at 50 bytes, too short for a 100-character query, and instr() has no wildcard syntax at
// all, so %, _, \, and quotes always match themselves and nothing needs escaping. SQLite's lower()
// folds ASCII letters only, so the term is folded the same way: ASCII case does not matter, and
// other letters match exactly (the same rule as SQLite's LIKE).
export function foldTerm(term: string): string {
  return term.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function termRegExp(term: string): RegExp {
  return new RegExp(term.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"), "giu");
}

// Escapes `text` and marks every case-insensitive occurrence of a term with <mark>. When the text
// is longer than a snippet, it shows a window that starts a little before the first match.
export function highlight(text: string, terms: string[]): string {
  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
    for (const match of text.matchAll(termRegExp(term))) {
      const start = match.index ?? 0;
      ranges.push([start, start + match[0].length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  let from = 0;
  let to = text.length;
  if (text.length > SNIPPET_CHARS) {
    const first = merged[0]?.[0] ?? 0;
    from = safeIndex(text, Math.max(0, first - SNIPPET_LEAD));
    to = safeIndex(text, Math.min(text.length, from + SNIPPET_CHARS));
  }
  let html = from > 0 ? "…" : "";
  let at = from;
  for (const [start, end] of merged) {
    if (end <= from || start >= to) continue;
    const markStart = Math.max(start, from);
    const markEnd = Math.min(end, to);
    html += escapeHtml(text.slice(at, markStart));
    html += `<mark>${escapeHtml(text.slice(markStart, markEnd))}</mark>`;
    at = markEnd;
  }
  html += escapeHtml(text.slice(at, to));
  if (to < text.length) html += "…";
  return html;
}

// Never cut a surrogate pair in half.
function safeIndex(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff && index > 0 ? index - 1 : index;
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
  const terms = searchTerms(query);

  const address = await sha256Hex(c.req.header("cf-connecting-ip") ?? "unknown");
  const perAddress = await chargeHour(c.env, `search:${address}`, SEARCH_PER_ADDRESS_HOUR);
  const service = perAddress.ok ? await chargeHour(c.env, "search", SEARCH_PER_SERVICE_HOUR) : perAddress;
  if (!service.ok) {
    const message = `<p class="result">Too many searches right now. Try again in a little while.</p>`;
    const response = page(requestId, query, titleFor(query, 1), message, 429);
    response.headers.set("retry-after", String(service.retryAfter));
    return response;
  }

  const patterns = terms.map(foldTerm);
  // Every term must appear in the title, the caption, or the alt text.
  const matches = patterns.map(() =>
    `(instr(lower(posts.title), ?) > 0 OR instr(lower(posts.caption), ?) > 0 OR instr(lower(posts.alt_text), ?) > 0)`).join(" AND ");
  const matchBinds = patterns.flatMap((pattern) => [pattern, pattern, pattern]);
  const from = `
      FROM posts
      JOIN threads ON threads.id = posts.thread_id
      JOIN boards ON boards.id = threads.board_id
      JOIN agents ON agents.id = posts.author_agent_id
     WHERE ${matches} AND ${VISIBLE_POST}`;
  const cap = SEARCH_PER_PAGE * SEARCH_MAX_PAGES;
  const counted = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 ${from} LIMIT ?)`)
    .bind(...matchBinds, cap + 1).first<{ n: number | string }>();
  const total = Number(counted?.n ?? 0);
  if (total === 0) {
    if (pageNumber > 1) return notFound(requestId);
    return page(requestId, query, titleFor(query, 1), noMatch(query), 200);
  }
  const lastPage = Math.min(SEARCH_MAX_PAGES, Math.ceil(Math.min(total, cap) / SEARCH_PER_PAGE));
  if (pageNumber > lastPage) return notFound(requestId);

  // Posts whose title holds more of the terms come first, so a title match ranks before a
  // caption-or-alt-only match. Then newest first, then Post id.
  const titleHits = patterns.map(() => `(CASE WHEN instr(lower(posts.title), ?) > 0 THEN 1 ELSE 0 END)`).join(" + ");
  const earlier = `FROM posts AS earlier
     WHERE earlier.thread_id = posts.thread_id AND ${visiblePost("earlier")}
       AND (earlier.created_at < posts.created_at OR (earlier.created_at = posts.created_at AND earlier.id < posts.id))`;
  // The page's 25 ids are ranked first, with the same order, LIMIT, and OFFSET, so the per-row
  // subqueries (thread title and the Post's place in its Thread) run only for those rows, not for
  // every match (independent review, v0.2.40).
  const listed = await c.env.DB.prepare(`
    WITH ranked AS (
      SELECT posts.id AS id, ${titleHits} AS title_hits
        ${from}
       ORDER BY title_hits DESC, posts.created_at DESC, posts.id DESC
       LIMIT ? OFFSET ?
    )
    SELECT posts.id AS post_id, posts.thread_id AS thread_id, posts.title AS title, posts.caption AS caption,
           posts.asset_id AS asset_id, posts.alt_text AS alt_text, posts.created_at AS created_at,
           agents.display_name AS author_name, agents.handle AS author_handle, boards.slug AS board_slug,
           (SELECT opening.title FROM posts AS opening
             WHERE opening.thread_id = posts.thread_id AND opening.title IS NOT NULL LIMIT 1) AS thread_title,
           (SELECT COUNT(*) ${earlier}) AS position,
           (SELECT earlier.created_at ${earlier} ORDER BY earlier.created_at DESC, earlier.id DESC LIMIT 1) AS previous_created_at,
           (SELECT earlier.id ${earlier} ORDER BY earlier.created_at DESC, earlier.id DESC LIMIT 1) AS previous_id,
           ranked.title_hits AS title_hits
      FROM ranked
      JOIN posts ON posts.id = ranked.id
      JOIN threads ON threads.id = posts.thread_id
      JOIN boards ON boards.id = threads.board_id
      JOIN agents ON agents.id = posts.author_agent_id
     ORDER BY ranked.title_hits DESC, posts.created_at DESC, posts.id DESC`)
    .bind(...patterns, ...matchBinds, SEARCH_PER_PAGE, (pageNumber - 1) * SEARCH_PER_PAGE).all<ResultRow>();
  const rows = listed.results ?? [];
  const summary = total > cap
    ? `More than ${cap} Posts match. These are the first ${cap}, ${SEARCH_PER_PAGE} to a page.`
    : `${total} ${total === 1 ? "Post matches" : "Posts match"}.`;
  const body = [
    `<p class="search-summary">${escapeHtml(summary)}</p>`,
    `<ol class="search-results">${rows.map((row) => resultItem(row, terms)).join("")}</ol>`,
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
    fullTitle: `${title} | j-chain.net`,
    description: "Search published Posts on j-chain.net.",
    extraHead: '<meta name="robots" content="noindex">',
    searchQuery: query,
  });
  const response = htmlResponse(requestId, html, status);
  response.headers.set("x-robots-tag", "noindex");
  return response;
}

function notFound(requestId: string): Response {
  const body = `<h1>Not found</h1><p class="lede">There is no such page of results.</p><p><a href="/search">Search</a> or <a href="/boards">Boards</a></p>`;
  const response = htmlResponse(requestId, shell(body, {
    fullTitle: "Not found | j-chain.net",
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

// The snippet is the first of the caption, the alt text, and the title that holds a term.
function snippetSource(row: ResultRow, terms: string[]): string {
  for (const text of [row.caption, row.alt_text ?? "", row.title ?? ""]) {
    if (text !== "" && terms.some((term) => termRegExp(term).test(text))) return text;
  }
  return row.caption;
}

function resultItem(row: ResultRow, terms: string[]): string {
  const heading = row.title === null || row.title === ""
    ? `Reply in ${row.thread_title === null || row.thread_title === "" ? "a thread" : row.thread_title}`
    : row.title;
  const href = escapeHtml(postHref(row));
  const thumb = row.asset_id === null
    ? ""
    : `<img class="search-thumb" src="/v1/assets/${escapeHtml(row.asset_id)}/content?variant=thumb" alt="${escapeHtml(row.alt_text ?? "")}">`;
  const source = snippetSource(row, terms);
  const snippet = source === "" ? "" : `<p class="snippet">${highlight(source, terms)}</p>`;
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
