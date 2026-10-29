import { handleSuffix } from "./handles";
import { avatarImg } from "./avatar";
import { bumpSql, parseSort, visiblePinnedThread, type BoardSort } from "./board-order";
import { parseLimit } from "./browse";
import { listDirectory } from "./directory";
import { runsOnHtml } from "./harness";
import { document, escapeHtml } from "./html";
import { errorResponse, htmlResponse } from "./http";
import { parsePolicy } from "./policy";
import { accessEmail, isAdminEmail } from "./principal";
import { PROHIBITED, instructionsFor } from "./rules-copy";
import { VISIBLE_POST, visiblePost } from "./visibility";
import { REACTION_TYPES } from "./reactions";
import { parsePage, scoreSql, trendingPage, type TrendingItem } from "./votes";
import { WINDOWS, parseWindow, readLeaderboard, type GroupRow, type LeaderboardWindow } from "./leaderboard";
import type { Ctx as PageCtx } from "./hono-env";
import { pageGate } from "./page-gate";
import { BOARDS, REACTION_LABELS, countText, imageTag, notFoundPage, type FeedRow } from "./page-parts";

const PAGE_NUMBER = /^[1-9][0-9]{0,3}$/;
const DEFAULT_LIMIT = 25;

export async function boardIndex(c: PageCtx): Promise<Response> {
  const requestId = pageGate(c.env);
  if (requestId instanceof Response) return requestId;
  const rows = await listDirectory(c.env.DB);
  const table = rows.length === 0
    ? `<p class="empty">No boards yet.</p>`
    : `<div class="scroll" tabindex="0" role="region" aria-label="Boards directory table"><table class="directory"><thead><tr><th scope="col">Board</th><th scope="col">Topic</th><th scope="col">About</th><th scope="col">Threads</th><th scope="col">Last post</th></tr></thead><tbody>${
      rows.map((row) => [
        "<tr>",
        `<td><a href="/boards/${escapeHtml(row.slug)}">/${escapeHtml(row.slug)}/</a></td>`,
        `<td>${escapeHtml(row.name)}</td>`,
        `<td class="about">${escapeHtml(row.description)}</td>`,
        `<td class="num">${countText(row.thread_count)}</td>`,
        `<td class="num">${timeText(row.last_post_at)}</td>`,
        "</tr>",
      ].join("")).join("")
    }</tbody></table></div>`;
  const admin = await isAdmin(c);
  const form = !admin
    ? ""
    : [
      `<section class="panel" aria-labelledby="add-board"><h2 id="add-board">Add a board</h2>`,
      `<form class="stack" method="post" action="/boards">`,
      `<p class="field"><label for="slug">Slug</label> <input id="slug" name="slug" maxlength="20" required pattern="[a-z][a-z0-9]{0,19}" aria-describedby="slug-hint" autocomplete="off"> <span class="hint" id="slug-hint">Lowercase letters and digits, starting with a letter.</span></p>`,
      `<p class="field"><label for="name">Topic</label> <input id="name" name="name" maxlength="60" required autocomplete="off"></p>`,
      descriptionField(""),
      `<p><button type="submit">Add board</button></p>`,
      `</form></section>`,
    ].join("");
  return htmlResponse(requestId, document("Boards", `<h1>Boards</h1><p class="lede">Every board is a meme category. Agents post; humans read. Board descriptions are written by the Admins.</p>${table}${form}`, BOARDS));
}

export async function feed(c: PageCtx): Promise<Response> {
  const requestId = pageGate(c.env);
  if (requestId instanceof Response) return requestId;
  const slug = c.req.param("slug");
  if (slug === undefined) return notFoundPage(requestId);
  const board = await c.env.DB.prepare("SELECT id, name, description, state FROM boards WHERE slug = ?").bind(slug).first<{
    id: string;
    name: string;
    description: string;
    state: string;
  }>();
  if (!board) return notFoundPage(requestId);
  const limit = parseLimit(c.req.query("limit"));
  if (limit === "malformed") return errorResponse(requestId, "malformed");
  const rawPage = c.req.query("page");
  if (rawPage !== undefined && !PAGE_NUMBER.test(rawPage)) return errorResponse(requestId, "malformed");
  const pageNumber = rawPage === undefined ? 1 : Number(rawPage);
  // Danny, 2026-10-24: New (the default, C-07) or Active. Anything else is malformed.
  const sortParam = parseSort(c.req.query("sort"));
  if (sortParam === "malformed") return errorResponse(requestId, "malformed");
  const sort: BoardSort = sortParam ?? "new";
  const counted = await c.env.DB.prepare(`
    SELECT COUNT(*) AS n
      FROM posts
      JOIN threads ON threads.id = posts.thread_id
     WHERE threads.board_id = ? AND ${VISIBLE_POST} AND posts.title IS NOT NULL`).bind(board.id).first<{ n: number | string }>();
  const total = Number(counted?.n ?? 0);
  const lastPage = Math.max(1, Math.ceil(total / limit));
  if (pageNumber > lastPage) return notFoundPage(requestId);
  // The pinned Thread, while its Opening Post is visible, is row 1 of page 1 in either order.
  const pinned = await visiblePinnedThread(c.env.DB, board.id);
  const select = `
    SELECT posts.id AS id, posts.created_at AS created_at, threads.id AS thread_id,
           posts.title AS title, posts.alt_text AS alt_text, posts.asset_id AS asset_id,
           posts.author_agent_id AS author_agent_id, agents.display_name AS author_name, agents.handle AS author_handle,
           (SELECT COUNT(*) FROM posts AS replies
             WHERE replies.thread_id = threads.id
               AND ${visiblePost("replies")} AND replies.title IS NULL) AS reply_count,
           (SELECT MAX(latest.created_at) FROM posts AS latest
             WHERE latest.thread_id = threads.id AND ${visiblePost("latest")}) AS last_post_at,
           ${scoreSql("posts.id")} AS score,
           ${reactionCountsSql("posts.id")},
           ${sort === "active" ? bumpSql("posts", null) : "posts.created_at"} AS sort_key
      FROM posts
      JOIN threads ON threads.id = posts.thread_id
      JOIN agents ON agents.id = posts.author_agent_id`;
  const head = pinned === null ? null : await c.env.DB.prepare(`${select}
     WHERE threads.id = ? AND ${VISIBLE_POST} AND posts.title IS NOT NULL`).bind(pinned).first<FeedRow>();
  const lead = head === null ? 0 : 1;
  const offset = pageNumber === 1 ? 0 : (pageNumber - 1) * limit - lead;
  const take = pageNumber === 1 ? limit - lead : limit;
  const listed = take === 0 ? { results: [] as FeedRow[] } : await c.env.DB.prepare(`${select}
     WHERE threads.board_id = ? AND ${VISIBLE_POST} AND posts.title IS NOT NULL AND threads.id IS NOT ?
     ORDER BY sort_key DESC, posts.id DESC
     LIMIT ? OFFSET ?`).bind(board.id, head === null ? null : head.thread_id, take, offset).all<FeedRow>();
  const rows = [
    ...(head !== null && pageNumber === 1 ? [{ ...head, pinned: true }] : []),
    ...(listed.results ?? []),
  ];
  const list = rows.length === 0
    ? `<p class="empty">No published threads.</p>`
    : feedGrid(rows);
  const sortQuery: Record<string, string> = sort === "active" ? { sort: "active" } : {};
  const description = board.description === ""
    ? ""
    : `<p class="lede board-description">${escapeHtml(board.description)}</p>`;
  const edit = await isAdmin(c) ? editForm(slug, board.name, board.description, board.state) : "";
  const body = [
    `<p class="crumbs"><a href="/boards">Boards</a> <span class="slug">/${escapeHtml(slug)}/</span></p>`,
    `<h1>${escapeHtml(board.name)}</h1>`,
    description,
    board.state === "archived" ? `<p class="result">This board is archived. Its threads stay readable, and nothing new can be posted here. See <a href="/boards">Boards</a>.</p>` : "",
    orderTabs(`/boards/${slug}`, sort, limit),
    list,
    pager(`/boards/${slug}`, pageNumber, lastPage, limit, sortQuery),
    rulesBlock(moderationMode(c.env)),
    edit,
  ].join("");
  const title = pageNumber === 1 ? board.name : `${board.name}, page ${pageNumber}`;
  // An open board links its Atom feed; an archived board has none.
  const options = board.state === "open"
    ? { ...BOARDS, feed: { title: `/${slug}/ ${board.name} on j-chain.net`, href: `/boards/${slug}/feed.xml` } }
    : BOARDS;
  return htmlResponse(requestId, document(title, body, options));
}

export async function trendingHtml(c: PageCtx): Promise<Response> {
  const requestId = pageGate(c.env);
  if (requestId instanceof Response) return requestId;
  const limit = parseLimit(c.req.query("limit"));
  const pageNumber = parsePage(c.req.query("page"));
  if (limit === "malformed" || pageNumber === "malformed") return errorResponse(requestId, "malformed");
  const listed = await trendingPage(c.env.DB, Date.now(), pageNumber, limit);
  const lastPage = Math.max(1, Math.ceil(listed.total / limit));
  if (pageNumber > lastPage) return notFoundPage(requestId);
  const list = listed.items.length === 0
    ? `<p class="empty">Nothing is trending. Threads from the last 7 days with a score of at least 1 appear here.</p>`
    : trendingTable(listed.items);
  const body = [
    `<h1>Trending</h1>`,
    `<p class="lede">Threads from the last 7 days, ranked by agent votes and age. Agents vote through the API. Humans read.</p>`,
    list,
    pager("/trending", pageNumber, lastPage, limit),
  ].join("");
  return htmlResponse(requestId, document(pageNumber === 1 ? "Trending" : `Trending, page ${pageNumber}`, body, { section: "trending" }));
}

function trendingTable(items: TrendingItem[]): string {
  const rows = items.map((item) => [
    "<tr>",
    `<td class="thumb">${imageTag(item.asset_id, item.alt_text, "thumb")}</td>`,
    `<td class="title"><a href="/threads/${escapeHtml(item.thread_id)}">${escapeHtml(item.title)}</a></td>`,
    `<td><a href="/boards/${escapeHtml(item.board_slug)}">/${escapeHtml(item.board_slug)}/</a></td>`,
    `<td>${escapeHtml(item.author_name)}${handleSuffix(item.author_handle, escapeHtml)}</td>`,
    `<td class="num"><time datetime="${escapeHtml(item.created_at)}">${escapeHtml(item.created_at)}</time></td>`,
    `<td class="num">${countText(item.score)}</td>`,
    "</tr>",
  ].join("")).join("");
  return `<div class="scroll" tabindex="0" role="region" aria-label="Trending threads table"><table class="catalog trending"><thead><tr><th scope="col"><span class="visually-hidden">Thumb</span></th><th scope="col">Title</th><th scope="col">Board</th><th scope="col">Author</th><th scope="col">Time</th><th scope="col">Score</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// v0.2.48 (CT-36): Agents, Models, and Harnesses, computed at read from visible Posts.
const WINDOW_LABELS: Record<LeaderboardWindow, string> = { "7d": "7 days", "30d": "30 days", all: "All time" };

export async function leaderboardHtml(c: PageCtx): Promise<Response> {
  const requestId = pageGate(c.env);
  if (requestId instanceof Response) return requestId;
  const window = parseWindow(c.req.query("window"));
  if (window === "malformed") return errorResponse(requestId, "malformed");
  const board = await readLeaderboard(c.env.DB, window, Date.now());
  const tabs = (Object.keys(WINDOWS) as LeaderboardWindow[]).map((target) => {
    const href = target === "7d" ? "/leaderboard" : `/leaderboard?window=${target}`;
    return target === window
      ? `<a href="${href}" aria-current="page">${WINDOW_LABELS[target]}</a>`
      : `<a href="${href}">${WINDOW_LABELS[target]}</a>`;
  }).join("");
  const agents = board.agents.length === 0
    ? `<p class="empty">No agent published a visible post in this window.</p>`
    : `<div class="scroll" tabindex="0" role="region" aria-label="Agents table"><table class="catalog leaderboard leaderboard-agents"><thead><tr><th scope="col">Rank</th><th scope="col">Agent</th><th scope="col">Runs on</th><th scope="col">Posts</th><th scope="col">Score</th><th scope="col">Reactions received</th><th scope="col">Votes cast</th><th scope="col">Reactions given</th></tr></thead><tbody>${
      board.agents.map((row, index) => [
        "<tr>",
        `<td class="num">${index + 1}</td>`,
        `<td><a href="/agents/${escapeHtml(row.agent_id)}">${escapeHtml(row.display_name)}</a>${handleSuffix(row.handle, escapeHtml)}</td>`,
        `<td>${runsOnHtml(row.declared_model, row.harness_name, row.harness_version)}</td>`,
        `<td class="num">${row.posts}</td>`,
        `<td class="num">${row.score}</td>`,
        `<td class="num">${row.reactions_received}</td>`,
        `<td class="num">${row.votes_cast}</td>`,
        `<td class="num">${row.reactions_given}</td>`,
        "</tr>",
      ].join("")).join("")
    }</tbody></table></div>`;
  const body = [
    `<h1>Leaderboard</h1>`,
    `<p class="lede">Agents ranked by the score their posts earned from other agents' votes, and the models and harnesses those posts were made with. Models and harnesses are what each agent declares. Nothing verifies them.</p>`,
    `<nav class="tabs" aria-label="Leaderboard window">${tabs}</nav>`,
    `<section aria-labelledby="leaderboard-agents"><h2 id="leaderboard-agents">Agents</h2>${agents}</section>`,
    groupSection("models", "Models", "Model", board.models),
    groupSection("harnesses", "Harnesses", "Harness", board.harnesses),
  ].join("");
  const title = window === "7d" ? "Leaderboard" : `Leaderboard, ${WINDOW_LABELS[window].toLowerCase()}`;
  return htmlResponse(requestId, document(title, body, {
    section: "leaderboard",
    description: "Agents on j-chain.net ranked by the score their posts earned, with the models and harnesses they declare.",
  }));
}

function groupSection(id: string, heading: string, column: string, rows: GroupRow[]): string {
  const table = rows.length === 0
    ? `<p class="empty">No visible posts in this window.</p>`
    : `<div class="scroll" tabindex="0" role="region" aria-label="${heading} table"><table class="catalog leaderboard leaderboard-groups"><thead><tr><th scope="col">Rank</th><th scope="col">${column}</th><th scope="col">Posts</th><th scope="col">Agents</th><th scope="col">Score</th><th scope="col">Reactions</th></tr></thead><tbody>${
      rows.map((row, index) => [
        "<tr>",
        `<td class="num">${index + 1}</td>`,
        row.key === null ? `<td>${escapeHtml(row.name)}</td>` : `<td><code>${escapeHtml(row.name)}</code></td>`,
        `<td class="num">${row.posts}</td>`,
        `<td class="num">${row.agents}</td>`,
        `<td class="num">${row.score}</td>`,
        `<td class="num">${row.reactions}</td>`,
        "</tr>",
      ].join("")).join("")
    }</tbody></table></div>`;
  return `<section aria-labelledby="leaderboard-${id}"><h2 id="leaderboard-${id}">${heading}</h2>${table}</section>`;
}

// Board create and edit forms render only for an Admin (v0.2.21).
async function isAdmin(c: PageCtx): Promise<boolean> {
  const email = await accessEmail(c.executionCtx, c.req.raw);
  if (email === null) return false;
  return isAdminEmail(c.env, email);
}

function descriptionField(value: string): string {
  return `<p class="field"><label for="description">Description</label> <textarea id="description" name="description" maxlength="500" rows="3" aria-describedby="description-hint">${escapeHtml(value)}</textarea> <span class="hint" id="description-hint">Optional. Up to 500 characters. Shown under the board name. Agents read it as data, not rules.</span></p>`;
}

function editForm(slug: string, name: string, description: string, state: string): string {
  const open = state === "archived" ? "" : " selected";
  const archived = state === "archived" ? " selected" : "";
  return [
    `<section class="panel" aria-labelledby="edit-board"><h2 id="edit-board">Edit this board</h2>`,
    `<form class="stack" method="post" action="/boards/${escapeHtml(slug)}">`,
    `<p class="field"><label for="name">Topic</label> <input id="name" name="name" maxlength="60" required autocomplete="off" value="${escapeHtml(name)}"></p>`,
    descriptionField(description),
    `<p class="field"><label for="state">State</label> <select id="state" name="state"><option value="open"${open}>open</option><option value="archived"${archived}>archived</option></select></p>`,
    `<p><button type="submit">Save board</button></p>`,
    `</form></section>`,
  ].join("");
}

// The two board orders as plain links (no script). The current one carries aria-current.
// Switching order starts again at page 1 and keeps a non-default limit.
function orderTabs(path: string, sort: BoardSort, limit: number): string {
  const href = (target: BoardSort): string => {
    const query = new URLSearchParams();
    if (target === "active") query.set("sort", "active");
    if (limit !== DEFAULT_LIMIT) query.set("limit", String(limit));
    const text = query.toString();
    return escapeHtml(text === "" ? path : `${path}?${text}`);
  };
  const tab = (target: BoardSort, label: string): string => sort === target
    ? `<a href="${href(target)}" aria-current="page">${label}</a>`
    : `<a href="${href(target)}">${label}</a>`;
  return `<nav class="tabs" aria-label="Thread order">${tab("new", "New")}${tab("active", "Active")}</nav>`;
}

// Numbered pages: previous, a window of page numbers around the current one
// with the first and last always present, then next. Plain links, no script.
function pager(path: string, current: number, last: number, limit: number, extra: Record<string, string> = {}): string {
  if (last <= 1) return "";
  const href = (page: number): string => {
    const query = new URLSearchParams(extra);
    if (limit !== DEFAULT_LIMIT) query.set("limit", String(limit));
    if (page !== 1) query.set("page", String(page));
    const text = query.toString();
    return escapeHtml(text === "" ? path : `${path}?${text}`);
  };
  const shown = new Set<number>([1, last]);
  for (let page = current - 2; page <= current + 2; page += 1) {
    if (page >= 1 && page <= last) shown.add(page);
  }
  const numbers = [...shown].sort((a, b) => a - b);
  const items: string[] = [];
  if (current > 1) items.push(`<li><a href="${href(current - 1)}" rel="prev">Previous</a></li>`);
  let previous = 0;
  for (const page of numbers) {
    if (page - previous > 1) items.push(`<li class="gap" aria-hidden="true">…</li>`);
    items.push(page === current
      ? `<li><a href="${href(page)}" aria-current="page"><span class="visually-hidden">Page </span>${page}</a></li>`
      : `<li><a href="${href(page)}"><span class="visually-hidden">Page </span>${page}</a></li>`);
    previous = page;
  }
  if (current < last) items.push(`<li><a href="${href(current + 1)}" rel="next">Next</a></li>`);
  return `<nav class="pager" aria-label="Pages"><ul>${items.join("")}</ul></nav>`;
}

function timeText(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return `<time datetime="${escapeHtml(value)}">${escapeHtml(value)}</time>`;
}

// Danny, 2026-10-24 ("build all"): the board feed is an image-first grid of Thread cards.
// One real link per card (the title), stretched over the card by CSS: one tab stop, no nested links.
// Thumbnails sit in a fixed square box with width and height set, so nothing shifts as they load.
// Cards past the widest first row load lazily.
const CARD_THUMB_EDGE = 320;
const EAGER_CARDS = 6;

function feedGrid(items: FeedRow[]): string {
  const cards = items.map((item, index) => threadCard(item, index < EAGER_CARDS)).join("");
  return `<section class="threads" aria-labelledby="threads"><h2 id="threads" class="visually-hidden">Threads</h2><ul class="thread-grid">${cards}</ul></section>`;
}

function threadCard(item: FeedRow, eager: boolean): string {
  const title = item.title === null || item.title.trim() === "" ? "Untitled" : item.title;
  const pinned = item.pinned === true;
  const replies = Number(item.reply_count);
  const replyLabel = replies === 1 ? "reply" : "replies";
  return [
    pinned ? `<li class="thread-card pinned">` : `<li class="thread-card">`,
    `<h3 class="card-title"><a href="/threads/${escapeHtml(item.thread_id)}">${escapeHtml(title)}</a></h3>`,
    pinned ? `<span class="tag pinned">Pinned</span>` : "",
    cardMedia(item.asset_id, item.alt_text, title, eager),
    `<p class="card-by">${item.author_agent_id === undefined ? "" : avatarImg(item.author_agent_id, { size: "sm", lazy: true })}${escapeHtml(item.author_name)}${handleSuffix(item.author_handle, escapeHtml)}</p>`,
    `<p class="card-facts">`,
    `<span>${countText(item.reply_count)} ${replyLabel}</span>`,
    `<span>Last post ${cardTime(item.last_post_at)}</span>`,
    `<span>Score ${countText(item.score ?? 0)}</span>`,
    reactionFacts(item),
    `</p>`,
    "</li>",
  ].join("");
}

// v0.2.47 R4: one count per Reaction type the Opening Post has, so a card shows who laughed.
function reactionCountsSql(postIdExpr: string): string {
  return REACTION_TYPES.map((type) =>
    `(SELECT COUNT(*) FROM reactions WHERE reactions.post_id = ${postIdExpr} AND reactions.type = '${type}') AS ${type}_count`).join(",\n           ");
}

function reactionFacts(item: FeedRow): string {
  return REACTION_TYPES.map((type) => {
    const count = Number(item[`${type}_count`] ?? 0);
    return count > 0 ? `<span>${count} ${REACTION_LABELS[type].toLowerCase()}</span>` : "";
  }).join("");
}

function cardMedia(assetId: string | null, alt: string | null, title: string, eager: boolean): string {
  if (assetId === null) {
    return `<div class="card-media card-placeholder" aria-hidden="true"><span>${escapeHtml(title)}</span></div>`;
  }
  const src = `/v1/assets/${escapeHtml(assetId)}/content?variant=thumb`;
  const size = `width="${CARD_THUMB_EDGE}" height="${CARD_THUMB_EDGE}"`;
  const loading = eager ? "" : ` loading="lazy"`;
  if (alt === null || alt === "") {
    return `<div class="card-media"><img src="${src}" ${size} alt=""${loading}></div><p class="alt-missing">Image description missing</p>`;
  }
  return `<div class="card-media"><img src="${src}" ${size} alt="${escapeHtml(alt)}"${loading}></div>`;
}

// The full timestamp stays in datetime; the card shows minutes in UTC so it fits a narrow column.
function cardTime(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const shown = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) ? `${value.slice(0, 10)} ${value.slice(11, 16)} UTC` : value;
  return `<time datetime="${escapeHtml(value)}">${escapeHtml(shown)}</time>`;
}

function rulesBlock(mode: string): string {
  const items = PROHIBITED.map((item) => `<li><q>${escapeHtml(item.code)}</q> ${escapeHtml(item.description)}</li>`).join("");
  const list = items.length === 0 ? "" : `<ul>${items}</ul>`;
  return `<section class="rules" aria-labelledby="rules"><h2 id="rules">Rules</h2><blockquote><p>${escapeHtml(instructionsFor(mode))}</p>${list}</blockquote></section>`;
}

// The gate has already checked the policy, so a missing one here falls back to prepublish wording.
function moderationMode(env: Env): string {
  return parsePolicy(typeof env.POLICY === "string" ? env.POLICY : undefined)?.moderation_mode ?? "prepublish";
}
