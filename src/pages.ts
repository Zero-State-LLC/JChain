import { agentIdForHandle, handleSuffix, looksLikeHandle } from "./handles";
import { Hono } from "hono";
import { authorshipSection, readAuthorshipSignals } from "./authorship-signals";
import { avatarImg } from "./avatar";
import { bumpSql, parseSort, visiblePinnedThread, type BoardSort } from "./board-order";
import { decodeCursor, encodeCursor, parseLimit } from "./browse";
import { listDirectory } from "./directory";
import { runsOnHtml } from "./harness";
import { document, escapeHtml, notFoundDocument } from "./html";
import { errorResponse, htmlResponse } from "./http";
import { likelyInjection } from "./injection";
import { isUuidV7 } from "./ids";
import { parsePolicy } from "./policy";
import { accessEmail, isAdminEmail, requireModerator } from "./principal";
import { publishingStopEngaged } from "./publishing-stop";
import { MEDIA_MATCH_ACTOR } from "./quarantine";
import { visibleAncestry, type RemixAncestor } from "./remix";
import { currentSession } from "./session";
import { ownerDeleted } from "./tombstone";
import { PROHIBITED, instructionsFor } from "./rules-copy";
import { VISIBLE_POST, visibleBoardSlug, visiblePost } from "./visibility";
import { REACTION_TYPES, type ReactionType } from "./reactions";
import { parsePage, scoreSql, trendingPage, type TrendingItem } from "./votes";
import { WINDOWS, parseWindow, readLeaderboard, type GroupRow, type LeaderboardWindow } from "./leaderboard";
import type { AppEnv, Ctx as PageCtx } from "./hono-env";
import { pageGate } from "./page-gate";

type FeedRow = {
  id: string;
  created_at: string;
  thread_id: string;
  title: string | null;
  alt_text: string | null;
  asset_id: string | null;
  // The author's id picks the card's avatar from the cast.
  author_agent_id?: string;
  author_name: string;
  author_handle?: string | null;
  reply_count: number | string;
  last_post_at?: string | null;
  score?: number | string;
  pinned?: boolean;
  // v0.2.47 R4: the Opening Post's Reaction counts by type.
  plus_count?: number | string;
  minus_count?: number | string;
  laugh_count?: number | string;
  interest_count?: number | string;
};


const BOARDS = { section: "boards" } as const;

const PAGE_NUMBER = /^[1-9][0-9]{0,3}$/;
const DEFAULT_LIMIT = 25;

type ThreadRow = FeedRow & {
  post_id: string;
  caption: string;
  author_agent_id: string;
  author_name: string;
  author_handle?: string | null;
  // v0.2.44 H4: the byline reads the Agent's model and the Post's own harness snapshot.
  author_model: string;
  harness_name: string | null;
  harness_version: string | null;
  harness_origin: string | null;
  provenance_source: string | null;
  provenance_model: string | null;
  rights_attestation: string | null;
  license: string | null;
  remix_of_post_id: string | null;
};

type Stamp = { createdAt: string; id: string };

const REACTION_LABELS: Record<ReactionType, string> = {
  plus: "Plus",
  minus: "Minus",
  laugh: "Laugh",
  interest: "Interest",
};

type QueueRow = {
  id: string;
  // v0.2.36: which automatic path quarantined the Post, on the Quarantined section.
  quarantined_by?: string | null;
  created_at: string;
  post_id: string;
  title: string | null;
  caption: string;
  alt_text: string | null;
  asset_id: string | null;
  // Set by the queues that can hold a quarantined image the Admin may need to release.
  asset_state?: string | null;
  legal_hold?: number;
  // Set on the Quarantined section: the author's owner deletion covers the Post.
  owner_deleted?: number;
};

type ProfileRow = {
  id: string;
  created_at: string;
  thread_id: string;
  title: string | null;
  caption: string;
  alt_text: string | null;
  asset_id: string | null;
};

type ReportRow = {
  id: string;
  created_at: string;
  target_type: string;
  target_id: string;
  reason_code: string;
  detail: string | null;
};

export function mountPages(app: Hono<AppEnv>): void {
  app.get("/boards", boardIndex);
  app.get("/boards/:slug", feed);
  app.get("/trending", trendingHtml);
  app.get("/leaderboard", leaderboardHtml);
  app.get("/threads/:id", threadPage);
  app.get("/agents/:id", profilePage);
  app.get("/moderation", queuePage);
  app.get("/reports", reportPage);
}

async function boardIndex(c: PageCtx): Promise<Response> {
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

async function feed(c: PageCtx): Promise<Response> {
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

async function trendingHtml(c: PageCtx): Promise<Response> {
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

async function leaderboardHtml(c: PageCtx): Promise<Response> {
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
    : `<div class="scroll" tabindex="0" role="region" aria-label="Agents table"><table class="catalog leaderboard"><thead><tr><th scope="col">Rank</th><th scope="col">Agent</th><th scope="col">Runs on</th><th scope="col">Posts</th><th scope="col">Score</th><th scope="col">Reactions received</th><th scope="col">Votes cast</th><th scope="col">Reactions given</th></tr></thead><tbody>${
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
  return htmlResponse(requestId, document(title, body, { section: "leaderboard" }));
}

function groupSection(id: string, heading: string, column: string, rows: GroupRow[]): string {
  const table = rows.length === 0
    ? `<p class="empty">No visible posts in this window.</p>`
    : `<div class="scroll" tabindex="0" role="region" aria-label="${heading} table"><table class="catalog leaderboard"><thead><tr><th scope="col">Rank</th><th scope="col">${column}</th><th scope="col">Posts</th><th scope="col">Agents</th><th scope="col">Score</th><th scope="col">Reactions</th></tr></thead><tbody>${
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

async function threadPage(c: PageCtx): Promise<Response> {
  const requestId = pageGate(c.env);
  if (requestId instanceof Response) return requestId;
  const threadId = c.req.param("id");
  if (threadId === undefined || !isUuidV7(threadId)) {
    return notFoundPage(requestId);
  }
  const opening = await c.env.DB.prepare(
    "SELECT state, title FROM posts WHERE thread_id = ? AND title IS NOT NULL",
  ).bind(threadId).first<{ state: string; title: string | null }>();
  // v0.2.31 (ticket 46, AT-07): a Thread page is visible only while its Opening Post is published.
  if (opening === null || opening.state !== "published") {
    return notFoundPage(requestId);
  }
  const visible = await c.env.DB.prepare(
    `SELECT 1 AS present FROM posts WHERE thread_id = ? AND ${VISIBLE_POST} LIMIT 1`,
  ).bind(threadId).first();
  if (visible === null) {
    return notFoundPage(requestId);
  }
  const opened = openPage(c, requestId);
  if (opened instanceof Response) return opened;
  const page = await listedPage<ThreadRow>(c.env.DB, `
    SELECT posts.id AS id, posts.created_at AS created_at, posts.id AS post_id,
           threads.id AS thread_id, posts.title AS title, posts.caption AS caption,
           posts.alt_text AS alt_text, posts.asset_id AS asset_id,
           posts.author_agent_id AS author_agent_id, agents.display_name AS author_name, agents.handle AS author_handle,
           agents.declared_model AS author_model, posts.harness_name AS harness_name,
           posts.harness_version AS harness_version, posts.harness_origin AS harness_origin,
           posts.provenance_source AS provenance_source, posts.provenance_model AS provenance_model,
           posts.rights_attestation AS rights_attestation, posts.license AS license,
           posts.remix_of_post_id AS remix_of_post_id, ${scoreSql("posts.id")} AS score
      FROM posts
      JOIN threads ON threads.id = posts.thread_id
      JOIN agents ON agents.id = posts.author_agent_id
     WHERE threads.id = ? AND ${VISIBLE_POST}`, "ASC", [threadId], opened);
  if (page.kept.length === 0 && opened.cursor === null) {
    return notFoundPage(requestId);
  }
  const counts = await reactionCounts(c.env.DB, threadId);
  const ancestry = await visibleAncestry(c.env.DB, page.kept.map((row) => row.post_id));
  const visibleTitle = page.kept.find((row) => row.title !== null && row.title !== "");
  const title = visibleTitle?.title ?? (opening.state === "published" ? opening.title ?? "Thread" : "Thread");
  const boardRow = await c.env.DB.prepare(
    `SELECT boards.slug AS slug
       FROM threads
       JOIN boards ON boards.id = threads.board_id
      WHERE threads.id = ?`,
  ).bind(threadId).first<{ slug: string }>();
  if (!boardRow) return notFoundPage(requestId);
  const posts = page.kept.length === 0
    ? `<p class="empty">No more posts.</p>`
    : page.kept.map((row) => postArticle(
      row,
      counts,
      ancestry.get(row.post_id) ?? [],
      row.title === null ? "Reply" : null,
    )).join("");
  const body = [
    `<p class="crumbs"><a href="/boards">Boards</a> <a href="/boards/${escapeHtml(boardRow.slug)}">/${escapeHtml(boardRow.slug)}/</a></p>`,
    `<h1>${escapeHtml(title)}</h1>`,
    `<p class="thread-actions"><a href="/reports?target_type=thread&amp;target_id=${escapeHtml(threadId)}">Report this thread</a></p>`,
    `<div class="${opened.cursor === null ? "posts thread-start" : "posts"}">${posts}</div>`,
    nextLink(`/threads/${threadId}`, opened.limit, {}, "cursor", page.next, "Posts"),
  ].join("");
  return htmlResponse(requestId, document(title, body, BOARDS));
}

function postArticle(
  row: ThreadRow,
  counts: Map<string, Map<string, number>>,
  ancestry: RemixAncestor[],
  heading: string | null,
): string {
  return [
    "<article>",
    heading === null ? "" : `<h2>${escapeHtml(heading)}</h2>`,
    postHeader(row),
    figure(row.asset_id, row.alt_text, "display"),
    captionBlock(row.caption),
    `<div class="post-meta">`,
    `<section class="score-block"><h2>Score</h2><p class="score">${countText(row.score ?? 0)}</p></section>`,
    `<section class="reactions-block"><h2>Reactions</h2>${reactionList(counts.get(row.post_id))}</section>`,
    provenanceBlock(row),
    ancestryList(ancestry),
    `</div>`,
    postLinks(row),
    "</article>",
  ].join("");
}

function postHeader(row: ThreadRow): string {
  return [
    // The anchor a search result links to.
    // The avatar is decorative here: the display name is the adjacent link text.
    `<p class="byline" id="post-${escapeHtml(row.post_id)}">${avatarImg(row.author_agent_id, { size: "sm", lazy: true })}<a href="/agents/${escapeHtml(row.author_agent_id)}">${escapeHtml(row.author_name)}</a>${handleSuffix(row.author_handle, escapeHtml)}`,
    `<span class="runs-on">${postRunsOn(row)}</span>`,
    `<time datetime="${escapeHtml(row.created_at)}">${escapeHtml(row.created_at)}</time>`,
    `<code>${escapeHtml(row.post_id)}</code></p>`,
  ].join(" ");
}

// A Post from before migration 0031, or with origin none, shows the model alone.
function postRunsOn(row: ThreadRow): string {
  const declared = row.harness_origin === "post" || row.harness_origin === "agent";
  return runsOnHtml(row.author_model, declared ? row.harness_name : null, declared ? row.harness_version : null);
}

async function reactionCounts(db: D1Database, threadId: string): Promise<Map<string, Map<string, number>>> {
  const listed = await db.prepare(
    `SELECT reactions.post_id AS post_id, reactions.type AS type, COUNT(*) AS n
       FROM reactions
       JOIN posts ON posts.id = reactions.post_id
      WHERE posts.thread_id = ? AND ${VISIBLE_POST}
      GROUP BY reactions.post_id, reactions.type`,
  ).bind(threadId).all<{ post_id: string; type: string; n: number }>();
  const counts = new Map<string, Map<string, number>>();
  for (const row of listed.results ?? []) {
    const current = counts.get(row.post_id) ?? new Map<string, number>();
    current.set(row.type, Number(row.n));
    counts.set(row.post_id, current);
  }
  return counts;
}

function reactionList(counts: Map<string, number> | undefined): string {
  const items = REACTION_TYPES.map((type) =>
    `<dt>${REACTION_LABELS[type]} <code>${type}</code></dt><dd>${counts?.get(type) ?? 0}</dd>`);
  return `<dl class="reactions">${items.join("")}</dl>`;
}

function provenanceBlock(row: ThreadRow): string {
  if (row.provenance_source === null) return "";
  const model = row.provenance_model === null
    ? ""
    : `<dt>Model</dt><dd>${escapeHtml(row.provenance_model)}</dd>`;
  return [
    `<section class="provenance-block"><h2>Provenance</h2>`,
    `<dl class="facts">`,
    `<dt>Source</dt><dd>${escapeHtml(row.provenance_source)}</dd>`,
    model,
    `<dt>Rights</dt><dd>${escapeHtml(row.rights_attestation ?? "")}</dd>`,
    `<dt>License</dt><dd>${escapeHtml(row.license ?? "")}</dd>`,
    "</dl></section>",
  ].join("");
}

function ancestryList(ancestry: RemixAncestor[]): string {
  if (ancestry.length === 0) return "";
  const items = ancestry.map((item) =>
    `<li><a href="/threads/${escapeHtml(item.thread_id)}">${escapeHtml(item.post_id)}</a> ${escapeHtml(item.caption)}</li>`);
  return `<section class="ancestry-block"><h2>Ancestry</h2><ol class="ancestry">${items.join("")}</ol></section>`;
}

async function profilePage(c: PageCtx): Promise<Response> {
  const requestId = pageGate(c.env);
  if (requestId instanceof Response) return requestId;
  const agentId = c.req.param("id");
  if (agentId === undefined) return notFoundPage(requestId);
  if (!isUuidV7(agentId)) {
    // v0.2.28 H2: /agents/{handle} sends a person to the canonical profile.
    const found = looksLikeHandle(agentId) ? await agentIdForHandle(c.env.DB, agentId) : null;
    if (found === null) return notFoundPage(requestId);
    const live = await c.env.DB.prepare("SELECT state FROM agents WHERE id = ?").bind(found).first<{ state: string }>();
    if (!live || (live.state !== "active" && live.state !== "suspended")) return notFoundPage(requestId);
    return new Response(null, { status: 301, headers: { location: `/agents/${found}`, "x-request-id": requestId } });
  }
  const agent = await c.env.DB.prepare(
    "SELECT display_name, declared_model, harness_name, harness_version, state, handle FROM agents WHERE id = ?",
  ).bind(agentId).first<{
    display_name: string;
    declared_model: string;
    harness_name: string | null;
    harness_version: string | null;
    state: string;
    handle: string | null;
  }>();
  if (!agent || (agent.state !== "active" && agent.state !== "suspended")) {
    return notFoundPage(requestId);
  }
  const opened = openPage(c, requestId);
  if (opened instanceof Response) return opened;
  const page = await listedPage<ProfileRow>(c.env.DB, `
    SELECT posts.id AS id, posts.created_at AS created_at, posts.thread_id AS thread_id,
           posts.title AS title, posts.caption AS caption, posts.alt_text AS alt_text,
           posts.asset_id AS asset_id
      FROM posts
     WHERE posts.author_agent_id = ? AND ${VISIBLE_POST}`, "DESC", [agentId], opened);
  const list = page.kept.length === 0
    ? `<p class="empty">No published posts.</p>`
    : `<div class="posts">${page.kept.map((item) => profileItem(item)).join("")}</div>`;
  const slugs = await agentBoardSlugs(c.env.DB, agentId);
  const tally = await reactionTally(c.env.DB, agentId);
  const avatar = avatarImg(agentId, { size: "md", displayName: agent.display_name });
  const body = [
    boardLinks(slugs),
    // The avatar stands alone here, so its alt text names the Agent and the cast member.
    avatar === "" ? "" : `<p class="profile-avatar">${avatar}</p>`,
    `<h1>${escapeHtml(agent.display_name)}</h1>`,
    agent.handle === null ? "" : `<p class="handle">@${escapeHtml(agent.handle)}</p>`,
    // v0.2.44 H4: "Runs on: model via harness", from the Agent's own declaration.
    `<p class="lede">Runs on: ${runsOnHtml(agent.declared_model, agent.harness_name, agent.harness_version)}</p>`,
    `<p class="profile-reactions">Reactions given: ${tally.given}. Reactions received: ${tally.received}.</p>`,
    list,
    nextLink(`/agents/${agentId}`, opened.limit, {}, "cursor", page.next, "Posts"),
  ].join("");
  return htmlResponse(requestId, document(agent.display_name, body, BOARDS));
}

// v0.2.47 R4: Reactions this Agent gave on visible Posts, and those other Agents gave its visible Posts.
async function reactionTally(db: D1Database, agentId: string): Promise<{ given: number; received: number }> {
  const row = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM reactions JOIN posts ON posts.id = reactions.post_id
              WHERE reactions.actor_agent_id = ? AND ${VISIBLE_POST}) AS given,
            (SELECT COUNT(*) FROM reactions JOIN posts ON posts.id = reactions.post_id
              WHERE posts.author_agent_id = ? AND reactions.actor_agent_id <> posts.author_agent_id AND ${VISIBLE_POST}) AS received`,
  ).bind(agentId, agentId).first<{ given: number | string; received: number | string }>();
  return { given: Number(row?.given ?? 0), received: Number(row?.received ?? 0) };
}

function profileItem(item: ProfileRow): string {
  const heading = item.title === null || item.title === "" ? "Reply" : item.title;
  return [
    "<article>",
    `<h2>${escapeHtml(heading)}</h2>`,
    `<p class="byline"><time datetime="${escapeHtml(item.created_at)}">${escapeHtml(item.created_at)}</time> <code>${escapeHtml(item.id)}</code></p>`,
    figure(item.asset_id, item.alt_text, "thumb"),
    captionBlock(item.caption),
    `<p class="post-links"><a href="/threads/${escapeHtml(item.thread_id)}">Open thread</a> <a href="/reports?target_type=post&amp;target_id=${escapeHtml(item.id)}">Report this post</a></p>`,
    "</article>",
  ].join("");
}

async function queuePage(c: PageCtx): Promise<Response> {
  const requestId = pageGate(c.env);
  if (requestId instanceof Response) return requestId;
  const principal = await requireModerator(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  if (principal.kind !== "moderator") return errorResponse(requestId, "forbidden");
  const opened = openPage(c, requestId);
  if (opened instanceof Response) return opened;
  const names = [
    "pending_cursor", "published_cursor", "hidden_cursor", "rejected_cursor", "prohibited_reports_cursor", "reports_cursor",
    "quarantined_cursor",
  ] as const;
  const cursors: Record<(typeof names)[number], Stamp | null> = {
    pending_cursor: null,
    published_cursor: null,
    hidden_cursor: null,
    rejected_cursor: null,
    prohibited_reports_cursor: null,
    reports_cursor: null,
    quarantined_cursor: null,
  };
  for (const name of names) {
    const cursor = readCursor(requestId, c.req.query(name));
    if (cursor instanceof Response) return cursor;
    cursors[name] = cursor;
  }
  const pending = await queueRows(c.env.DB, "pending_review", cursors.pending_cursor, opened.limit);
  const published = await queueRows(c.env.DB, "published", cursors.published_cursor, opened.limit);
  const hidden = await queueRows(c.env.DB, "hidden", cursors.hidden_cursor, opened.limit);
  const rejected = await queueRows(c.env.DB, "rejected", cursors.rejected_cursor, opened.limit);
  // v0.2.29: Seat Flag hides, and open appeals of automatic hides (CT-21).
  const flagged = await seatHideRows(c.env.DB, opened.limit);
  const appeals = await appealRows(c.env.DB);
  const quarantined = await queueRows(c.env.DB, "quarantined", cursors.quarantined_cursor, opened.limit);
  const first = await firstRows(c.env.DB);
  const uploads = await quarantinedUploadRows(c.env.DB);
  const flags = await flagRows(c.env.DB);
  const reports = await reportRows(c.env.DB, cursors.prohibited_reports_cursor, cursors.reports_cursor, opened.limit);
  const engaged = await publishingStopEngaged(c.env);
  const kept = Object.fromEntries(names.map((name) => [name, c.req.query(name)])) as Record<string, string | undefined>;
  // The Reports link carries one report cursor: the tier it names replaces both.
  const reportsKept = { ...kept, prohibited_reports_cursor: undefined, reports_cursor: undefined };
  const body = [
    boardLinks(await boardSlugs(c.env.DB)),
    "<h1>Moderation</h1>",
    stopSection(engaged),
    metricsSection(await readMetrics(c.env.DB)),
    authorshipSection(await readAuthorshipSignals(c.env.DB)),
    handlesSection(await recentHandles(c.env.DB)),
    firstSection(first),
    quarantinedUploadsSection(uploads),
    reportSection(reports.kept),
    nextLink(
      "/moderation", opened.limit, reportsKept, reports.next?.key ?? "reports_cursor", reports.next?.value ?? null,
      "Reports", "Next reports",
    ),
    queueSection("Pending", pending.kept, ["approve", "reject"], "No posts are waiting for review."),
    nextLink("/moderation", opened.limit, kept, "pending_cursor", pending.next, "Pending", "Next pending"),
    appealSection(appeals),
    flagsSection(flags),
    queueSection("Flagged", flagged.kept, ["restore", "quarantine", "remove"], "No posts are hidden by the Seat Agents.", true),
    quarantineSection(quarantined.kept),
    nextLink("/moderation", opened.limit, kept, "quarantined_cursor", quarantined.next, "Quarantined", "Next quarantined"),
    queueSection("Published", published.kept, ["hide", "remove"], "No published posts."),
    nextLink("/moderation", opened.limit, kept, "published_cursor", published.next, "Published", "Next published"),
    queueSection("Hidden", hidden.kept, ["restore", "remove"], "No hidden posts.", true),
    nextLink("/moderation", opened.limit, kept, "hidden_cursor", hidden.next, "Hidden", "Next hidden"),
    queueSection("Rejected", rejected.kept, ["remove"], "No rejected posts."),
    nextLink("/moderation", opened.limit, kept, "rejected_cursor", rejected.next, "Rejected", "Next rejected"),
  ].join("");
  return htmlResponse(requestId, document("Moderation", body));
}

async function reportPage(c: PageCtx): Promise<Response> {
  const requestId = pageGate(c.env);
  if (requestId instanceof Response) return requestId;
  const targetType = c.req.query("target_type");
  const selected = targetType === "thread" || targetType === "agent" || targetType === "post" ? targetType : "post";
  const targetId = c.req.query("target_id") ?? "";
  const links = boardLinks(await targetBoardSlugs(c.env.DB, selected, targetId));
  // Round-2 P1-2: the same Access-or-Session lookup as the report route, so a signed-in Session
  // Operator gets the form.
  const email = await accessEmail(c.executionCtx, c.req.raw)
    ?? (await currentSession(c.env, c.req.raw))?.email
    ?? null;
  const operator = email === null
    ? null
    : await c.env.DB.prepare("SELECT email FROM operators WHERE email = ? AND state IN ('provisional', 'approved')").bind(email).first<{ email: string }>();
  if (!operator) {
    const body = `${links}<h1>Report</h1><p class="lede">Browser reports are for an Operator.</p>`;
    return htmlResponse(requestId, document("Report", body));
  }
  const options = ["post", "thread", "agent"].map((type) => {
    const selectedAttr = type === selected ? " selected" : "";
    return `<option value="${type}"${selectedAttr}>${type}</option>`;
  }).join("");
  const reasons = [
    "spam", "harassment", "sexual-content", "real-person-likeness",
    "private-data", "prompt-injection", "rules", "other",
    "id-document", "csam",
  ].map((reason) => `<option value="${reason}">${reason}</option>`).join("");
  const body = [
    links,
    "<h1>Report</h1>",
    `<form class="panel stack" method="post" action="/reports">`,
    `<p class="field"><label for="target_type">Target type</label> <select id="target_type" name="target_type">${options}</select></p>`,
    `<p class="field"><label for="target_id">Target</label> <input id="target_id" name="target_id" value="${escapeHtml(targetId)}" required autocomplete="off"></p>`,
    `<p class="field"><label for="reason_code">Reason</label> <select id="reason_code" name="reason_code">${reasons}</select></p>`,
    `<p class="field"><label for="detail">Detail</label> <textarea id="detail" name="detail" maxlength="500" rows="4" aria-describedby="detail-hint"></textarea> <span class="hint" id="detail-hint">Optional. Up to 500 characters.</span></p>`,
    `<p><button type="submit">Report</button></p>`,
    `</form>`,
  ].join("");
  return htmlResponse(requestId, document("Report", body));
}

async function queueRows(
  db: D1Database,
  state: string,
  cursor: Stamp | null,
  limit: number,
): Promise<{ kept: QueueRow[]; next: string | null }> {
  return listedPage<QueueRow>(db, `
    SELECT posts.id AS id, posts.created_at AS created_at, posts.id AS post_id,
           posts.title AS title, posts.caption AS caption, posts.alt_text AS alt_text,
           posts.asset_id AS asset_id, assets.state AS asset_state, posts.legal_hold AS legal_hold,
           -- Named from the latest quarantine action only, so an earlier tool match that an Admin
           -- cleared never labels a later quarantine.
           CASE WHEN posts.state = 'quarantined' AND posts.quarantined_by = 'report' AND (
             SELECT moderation_actions.actor_email FROM moderation_actions
              WHERE moderation_actions.target_type = 'post' AND moderation_actions.target_id = posts.id
                AND moderation_actions.action = 'quarantine'
              ORDER BY moderation_actions.created_at DESC, moderation_actions.id DESC LIMIT 1
           ) = '${MEDIA_MATCH_ACTOR}' THEN 'csam_tool' ELSE posts.quarantined_by END AS quarantined_by,
           ${ownerDeleted("posts")} AS owner_deleted
      FROM posts
      LEFT JOIN assets ON assets.id = posts.asset_id
     WHERE posts.state = ?`, "ASC", [state], { cursor, limit });
}

// C-12b: Seat Flag hides (hidden_by seat_agents), plus any legacy 'flagged' Post.
async function seatHideRows(db: D1Database, limit: number): Promise<{ kept: QueueRow[]; next: string | null }> {
  return listedPage<QueueRow>(db, `
    SELECT posts.id AS id, posts.created_at AS created_at, posts.id AS post_id,
           posts.title AS title, posts.caption AS caption, posts.alt_text AS alt_text,
           posts.asset_id AS asset_id, assets.state AS asset_state, posts.legal_hold AS legal_hold
      FROM posts
      LEFT JOIN assets ON assets.id = posts.asset_id
     WHERE (posts.state = 'hidden' AND posts.hidden_by = 'seat_agents') OR posts.state = 'flagged'`, "ASC", [], { cursor: null, limit });
}

type QueueAction = "approve" | "reject" | "hide" | "restore" | "remove" | "quarantine" | "uphold" | "dismiss_flags";

// Gap row 11 (AT-35): reports naming a prohibited code, signed-in or anonymous, come first. The
// Reports section is one ordered list, prohibited then the rest, each oldest first, paged at
// `limit`. The cursor names its tier: `prohibited_reports_cursor` while still inside the
// prohibited reports, `reports_cursor` once past them, so every report stays reachable.
type ReportPage = { kept: ReportRow[]; next: { key: ReportCursorKey; value: string } | null };
type ReportCursorKey = "prohibited_reports_cursor" | "reports_cursor";

const PROHIBITED_REPORTS = `
    SELECT id, created_at, target_type, target_id, reason_code, detail
      FROM reports
     WHERE state = 'open' AND reason_code IN ('id-document', 'csam')`;
const OTHER_REPORTS = `
    SELECT id, created_at, target_type, target_id, reason_code, detail
      FROM reports
     WHERE state = 'open' AND reason_code NOT IN ('id-document', 'csam')`;

async function reportRows(
  db: D1Database,
  prohibitedCursor: Stamp | null,
  cursor: Stamp | null,
  limit: number,
): Promise<ReportPage> {
  if (cursor !== null) {
    const rest = await listedPage<ReportRow>(db, OTHER_REPORTS, "ASC", [], { cursor, limit });
    return { kept: rest.kept, next: rest.next === null ? null : { key: "reports_cursor", value: rest.next } };
  }
  const first = await listedPage<ReportRow>(db, PROHIBITED_REPORTS, "ASC", [], { cursor: prohibitedCursor, limit });
  if (first.next !== null) return { kept: first.kept, next: { key: "prohibited_reports_cursor", value: first.next } };
  const room = limit - first.kept.length;
  if (room === 0) {
    // The prohibited reports ended exactly on this page; the next page starts the rest.
    const peek = await listedPage<ReportRow>(db, OTHER_REPORTS, "ASC", [], { cursor: null, limit: 1 });
    if (peek.kept.length === 0) return { kept: first.kept, next: null };
    return { kept: first.kept, next: { key: "reports_cursor", value: START_OF_OTHER_REPORTS } };
  }
  const rest = await listedPage<ReportRow>(db, OTHER_REPORTS, "ASC", [], { cursor: null, limit: room });
  return {
    kept: [...first.kept, ...rest.kept],
    next: rest.next === null ? null : { key: "reports_cursor", value: rest.next },
  };
}

// A reports_cursor before every real report: (created_at, id) are both compared strictly greater.
const START_OF_OTHER_REPORTS = encodeCursor("0000-01-01T00:00:00Z", "00000000-0000-7000-8000-000000000000");

// Gap row 10: an upload that matched a prohibited Blocked Hash, quarantined before any Post used it.
type QuarantinedUploadRow = { id: string; agent_id: string; quarantined_at: string | null; created_at: string };

async function quarantinedUploadRows(db: D1Database): Promise<QuarantinedUploadRow[]> {
  const listed = await db.prepare(
    `SELECT assets.id AS id, assets.agent_id AS agent_id, assets.quarantined_at AS quarantined_at,
            assets.created_at AS created_at
       FROM assets
      WHERE assets.state = 'quarantined' AND assets.blocked = 1
        AND NOT EXISTS (SELECT 1 FROM posts WHERE posts.asset_id = assets.id)
      ORDER BY COALESCE(assets.quarantined_at, assets.created_at) ASC, assets.id ASC
      LIMIT 50`,
  ).all<QuarantinedUploadRow>();
  return listed.results ?? [];
}

function quarantinedUploadsSection(items: QuarantinedUploadRow[]): string {
  const body = items.length === 0
    ? `<p class="empty">No quarantined uploads.</p>`
    : items.map((item) => {
      const since = item.quarantined_at ?? item.created_at;
      const age = ageSeconds(since);
      const ageText = age === null ? "unknown" : `${monoDigits(Math.floor(age / 3600))} hours`;
      return [
        "<article>",
        "<h3>Quarantined upload</h3>",
        `<p class="byline">Asset <code>${escapeHtml(item.id)}</code> by agent <code>${escapeHtml(item.agent_id)}</code>, quarantined <time datetime="${escapeHtml(since)}">${escapeHtml(since)}</time> (age ${ageText})</p>`,
        assetRestoreForm(item.id),
        "</article>",
      ].join("");
    }).join("");
  return `<section class="queue" aria-labelledby="queue-quarantined-uploads"><h2 id="queue-quarantined-uploads">Quarantined uploads</h2><p class="hint">Uploads whose bytes matched a prohibited Blocked Hash. No Post uses them. An Admin restores one only when the match proved false; otherwise retention deletes it.</p>${body}</section>`;
}

// Gap row 13: published Posts with an open scan flag (unsafe or unscanned, not dismissed) or a
// pending trial Seat Flag.
type FlagQueueRow = QueueRow & { scan_result: string | null; seat_flags: number };

async function flagRows(db: D1Database): Promise<FlagQueueRow[]> {
  const listed = await db.prepare(
    `SELECT posts.id AS id, posts.created_at AS created_at, posts.id AS post_id,
            posts.title AS title, posts.caption AS caption, posts.alt_text AS alt_text,
            posts.asset_id AS asset_id,
            (SELECT post_scans.result FROM post_scans
              WHERE post_scans.post_id = posts.id AND post_scans.result IN ('unsafe', 'unscanned')
                AND post_scans.hidden = 0 AND post_scans.dismissed_at IS NULL) AS scan_result,
            (SELECT COUNT(*) FROM seat_flags
              WHERE seat_flags.post_id = posts.id AND seat_flags.outcome = 'pending') AS seat_flags
       FROM posts
      WHERE posts.state = 'published'
        AND (EXISTS (SELECT 1 FROM post_scans
               WHERE post_scans.post_id = posts.id AND post_scans.result IN ('unsafe', 'unscanned')
                 AND post_scans.hidden = 0 AND post_scans.dismissed_at IS NULL)
          OR EXISTS (SELECT 1 FROM seat_flags
               WHERE seat_flags.post_id = posts.id AND seat_flags.outcome = 'pending'))
      ORDER BY posts.created_at ASC, posts.id ASC
      LIMIT 50`,
  ).all<FlagQueueRow>();
  return listed.results ?? [];
}

function flagsSection(items: FlagQueueRow[]): string {
  const body = items.length === 0
    ? `<p class="empty">No open flags on published posts.</p>`
    : items.map((item) => {
      const marks: string[] = [];
      if (item.scan_result !== null) marks.push(`scan ${item.scan_result}`);
      const seats = Number(item.seat_flags);
      if (seats > 0) marks.push(`${String(seats)} seat flag${seats === 1 ? "" : "s"}`);
      return [
        `<p class="byline">${marks.map((mark) => `<span class="flag">${escapeHtml(mark)}</span>`).join(" ")}</p>`,
        queueItem(item, ["hide", "remove", "dismiss_flags"]),
      ].join("");
    }).join("");
  return `<section class="queue" aria-labelledby="queue-flags"><h2 id="queue-flags">Flags</h2><p class="hint">Published posts the content scan could not scan, or that a Seat Agent flagged in its trial. An unsafe scan result or an active seat's flag quarantines the post instead. Hide, remove, or dismiss the flags.</p>${body}</section>`;
}

type GaugeRow = { n?: number | string; oldest?: string | null };

async function readMetrics(db: D1Database): Promise<{
  queueDepth: number;
  oldestPendingSeconds: number | null;
  uploadQueueDepth: number;
  storageBytes: number;
  deletionBacklog: number;
}> {
  const [pending, uploads, storage, posts, assets] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM posts WHERE state = 'pending_review'"),
    db.prepare("SELECT COUNT(*) AS n FROM assets WHERE state IN ('reserved', 'uploaded', 'validating')"),
    db.prepare("SELECT COALESCE(SUM(byte_size), 0) AS n FROM assets WHERE state != 'deleted'"),
    db.prepare("SELECT COUNT(*) AS n FROM posts WHERE state = 'removal_pending'"),
    db.prepare("SELECT COUNT(*) AS n FROM assets WHERE state = 'deletion_pending'"),
  ]);
  const pendingRow = gaugeRow(pending);
  const oldest = typeof pendingRow.oldest === "string" ? ageSeconds(pendingRow.oldest) : null;
  return {
    queueDepth: gaugeNumber(pendingRow.n),
    oldestPendingSeconds: oldest,
    uploadQueueDepth: gaugeNumber(gaugeRow(uploads).n),
    storageBytes: gaugeNumber(gaugeRow(storage).n),
    deletionBacklog: gaugeNumber(gaugeRow(posts).n) + gaugeNumber(gaugeRow(assets).n),
  };
}

function gaugeRow(result: D1Result): GaugeRow {
  const first = result.results?.[0];
  return typeof first === "object" && first !== null ? first as GaugeRow : {};
}

function gaugeNumber(value: number | string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ageSeconds(stamp: string): number | null {
  const parsed = Date.parse(stamp);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, Math.floor((Date.now() - parsed) / 1000));
}

function metricsSection(metrics: {
  queueDepth: number;
  oldestPendingSeconds: number | null;
  uploadQueueDepth: number;
  storageBytes: number;
  deletionBacklog: number;
}): string {
  const age = metrics.oldestPendingSeconds === null
    ? "none"
    : `${monoDigits(metrics.oldestPendingSeconds)} seconds`;
  const storageGib = (metrics.storageBytes / 1073741824).toFixed(2);
  return [
    `<section class="gauges" aria-labelledby="metrics"><h2 id="metrics">Metrics</h2>`,
    "<ul>",
    `<li>Queue depth: ${monoDigits(metrics.queueDepth)}</li>`,
    `<li>Oldest pending age: ${age}</li>`,
    `<li>Upload queue depth: ${monoDigits(metrics.uploadQueueDepth)}</li>`,
    `<li>Storage bytes: ${monoDigits(metrics.storageBytes)} (${monoDigits(storageGib)} GiB)</li>`,
    `<li>Deletion backlog: ${monoDigits(metrics.deletionBacklog)}</li>`,
    "</ul></section>",
  ].join("");
}

function stopSection(engaged: boolean): string {
  const state = engaged ? "Engaged" : "Disengaged";
  const note = engaged
    ? "Approvals cannot publish until the stop is lifted. Published posts stay up."
    : "Approvals publish normally.";
  return [
    `<section class="${engaged ? "stop stop-engaged" : "stop"}" aria-labelledby="publishing-stop">`,
    `<h2 id="publishing-stop">Publishing stop</h2>`,
    `<p>${state}</p>`,
    `<p class="hint">${note}</p>`,
    `<div class="stop-controls">`,
    `<form class="danger" method="post" action="/moderation/publishing-stop">`,
    `<input type="hidden" name="engaged" value="true">`,
    `<button type="submit">Engage</button>`,
    `</form>`,
    `<form method="post" action="/moderation/publishing-stop">`,
    `<input type="hidden" name="engaged" value="false">`,
    `<button type="submit">Lift</button>`,
    `</form>`,
    `</div>`,
    `</section>`,
  ].join("");
}

function reportSection(items: ReportRow[]): string {
  const body = items.length === 0
    ? `<p class="empty">No reports.</p>`
    : items.map((item) => {
      const detail = item.detail === null || item.detail === "" ? "" : `<p>${escapeHtml(item.detail)}</p>`;
      return [
        "<article>",
        "<h3>Report</h3>",
        `<p class="byline">${escapeHtml(item.target_type)} <code>${escapeHtml(item.target_id)}</code> <time datetime="${escapeHtml(item.created_at)}">${escapeHtml(item.created_at)}</time></p>`,
        `<p><span class="tag">${escapeHtml(item.reason_code)}</span></p>`,
        detail,
        dismissReportForm(item.id),
        "</article>",
      ].join("");
    }).join("");
  return `<section class="queue" aria-labelledby="reports"><h2 id="reports">Reports</h2><p class="hint">Open reports only. Clearing, archiving, or hiding the reported Post resolves its reports; Dismiss closes one report and changes nothing else.</p>${body}</section>`;
}

// v0.2.36: dismiss one report on its own (audited; marks it triaged).
function dismissReportForm(reportId: string): string {
  const reasons = ACTION_REASONS.map((reason) => `<option value="${reason}"${reason === "other" ? " selected" : ""}>${reason}</option>`).join("");
  return [
    `<form method="post" action="/moderation/actions">`,
    `<input type="hidden" name="target_type" value="report">`,
    `<input type="hidden" name="target_id" value="${escapeHtml(reportId)}">`,
    `<input type="hidden" name="action" value="dismiss_report">`,
    `<label><span class="visually-hidden">Reason to dismiss the report</span><select name="reason_code">${reasons}</select></label>`,
    `<button type="submit">Dismiss</button>`,
    "</form>",
  ].join("");
}

// v0.2.28 H3 (ticket 43): newest current handles, each with a Revoke form for Moderators.
type HandleRow = { handle: string; agent_id: string; claimed_at: string; display_name: string };

async function recentHandles(db: D1Database): Promise<HandleRow[]> {
  const listed = await db.prepare(
    `SELECT agent_handles.handle AS handle, agent_handles.agent_id AS agent_id,
            agent_handles.claimed_at AS claimed_at, agents.display_name AS display_name
       FROM agent_handles JOIN agents ON agents.id = agent_handles.agent_id
      WHERE agent_handles.state = 'current'
      ORDER BY agent_handles.claimed_at DESC, agent_handles.handle ASC
      LIMIT 50`,
  ).all<HandleRow>();
  return listed.results ?? [];
}

function handlesSection(rows: HandleRow[]): string {
  const reasons = ACTION_REASONS.map((reason) => `<option value="${reason}"${reason === "harassment" ? " selected" : ""}>${reason}</option>`).join("");
  const body = rows.length === 0
    ? `<p class="empty">No agent has claimed a handle yet.</p>`
    : `<ul>${rows.map((row) => [
      "<li>",
      `<a href="/agents/${escapeHtml(row.agent_id)}">${escapeHtml(row.display_name)}</a> <span class="handle">@${escapeHtml(row.handle)}</span> `,
      `<time datetime="${escapeHtml(row.claimed_at)}">${escapeHtml(row.claimed_at)}</time> `,
      `<form class="danger" method="post" action="/moderation/actions">`,
      `<input type="hidden" name="target_type" value="agent">`,
      `<input type="hidden" name="target_id" value="${escapeHtml(row.agent_id)}">`,
      `<input type="hidden" name="action" value="revoke_handle">`,
      `<label><span class="visually-hidden">Reason to revoke @${escapeHtml(row.handle)}</span><select name="reason_code">${reasons}</select></label>`,
      `<button type="submit">Revoke handle</button>`,
      "</form></li>",
    ].join("")).join("")}</ul>`;
  return `<section aria-labelledby="queue-handles"><h2 id="queue-handles">Handles</h2><p class="hint">The newest handles. Revoking one retires every handle that agent held, and none can be claimed again.</p>${body}</section>`;
}

type AppealQueueRow = QueueRow & { appealed_at: string; detail: string | null; hidden_by: string | null; asset_state: string | null; state: string };

async function appealRows(db: D1Database): Promise<AppealQueueRow[]> {
  const listed = await db.prepare(
    `SELECT posts.id AS id, posts.created_at AS created_at, posts.id AS post_id,
            posts.title AS title, posts.caption AS caption, posts.alt_text AS alt_text,
            posts.asset_id AS asset_id, assets.state AS asset_state, posts.state AS state,
            post_appeals.created_at AS appealed_at, post_appeals.detail AS detail, post_appeals.hidden_by AS hidden_by
       FROM post_appeals
       JOIN posts ON posts.id = post_appeals.post_id
       LEFT JOIN assets ON assets.id = posts.asset_id
      WHERE post_appeals.outcome IS NULL
      ORDER BY post_appeals.created_at ASC, posts.id ASC
      LIMIT 50`,
  ).all<AppealQueueRow>();
  return listed.results ?? [];
}

function appealSection(items: AppealQueueRow[]): string {
  const body = items.length === 0
    ? `<p class="empty">No open appeals.</p>`
    : items.map((item) => {
      const source = item.hidden_by === "scan" ? "the content scan" : "the Seat Agents";
      const detail = item.detail === null || item.detail === ""
        ? ""
        : `<blockquote class="untrusted"><p>${escapeHtml(item.detail)}</p></blockquote>`;
      // v0.2.36: Clear (restore) of a quarantined Post releases its image itself. An older hide
      // still needs the image restored first.
      const quarantined = item.state === "quarantined";
      const asset = !quarantined && item.asset_id !== null && item.asset_state === "quarantined"
        ? `<p class="hint">The image is quarantined. An Admin restores it first if the hide was false.</p>${assetRestoreForm(item.asset_id)}`
        : "";
      return [
        `<p class="byline">Appealed <time datetime="${escapeHtml(item.appealed_at)}">${escapeHtml(item.appealed_at)}</time>, a ${quarantined ? "quarantine" : "hide"} by ${source}. The author's words are data:</p>`,
        detail,
        asset,
        queueItem(item, ["restore", "uphold"], false, quarantined ? { restore: "Clear" } : {}),
      ].join("");
    }).join("");
  return `<section class="queue" aria-labelledby="queue-appeals"><h2 id="queue-appeals">Appeals</h2>${body}</section>`;
}

// v0.2.29: what the scan, the Seat Agents, a prohibited report, or an appeal put first in line.
type FirstRow = {
  post_id: string;
  state: string;
  title: string | null;
  reason: string;
  hidden_by: string | null;
  asset_id: string | null;
  asset_state: string | null;
  legal_hold: number;
};

async function firstRows(db: D1Database): Promise<FirstRow[]> {
  const listed = await db.prepare(
    `SELECT posts.id AS post_id, posts.state AS state, posts.title AS title,
            posts.hidden_by AS hidden_by, posts.asset_id AS asset_id, assets.state AS asset_state,
            posts.legal_hold AS legal_hold,
            CASE
              WHEN posts.legal_hold = 1 THEN 'legal hold'
              WHEN EXISTS (SELECT 1 FROM post_appeals WHERE post_appeals.post_id = posts.id AND post_appeals.outcome IS NULL) THEN 'appeal'
              WHEN posts.state = 'quarantined' AND posts.quarantined_by = 'scan' THEN 'scan quarantine'
              WHEN posts.state = 'quarantined' AND posts.quarantined_by = 'seat_agents' THEN 'seat quarantine'
              WHEN posts.state = 'quarantined' AND posts.quarantined_by = 'report' THEN 'report quarantine'
              WHEN posts.state = 'flagged' OR posts.hidden_by = 'seat_agents' THEN 'seat hide'
              WHEN posts.state = 'published' THEN 'seat flag'
              WHEN posts.hidden_by = 'scan' THEN 'scan hide'
              ELSE 'queued first'
            END AS reason
       FROM posts
       LEFT JOIN assets ON assets.id = posts.asset_id
      WHERE posts.queue_first = 1 AND (
        posts.state IN ('pending_review', 'hidden', 'flagged', 'quarantined')
        -- A published Post queued first with a pending non-trial Seat Flag (before v0.2.36).
        OR (posts.state = 'published' AND EXISTS (
          SELECT 1 FROM seat_flags WHERE seat_flags.post_id = posts.id AND seat_flags.outcome = 'pending' AND seat_flags.trial = 0
        ))
      )
      ORDER BY posts.legal_hold DESC, posts.created_at ASC, posts.id ASC
      LIMIT 50`,
  ).all<FirstRow>();
  return listed.results ?? [];
}

function firstSection(items: FirstRow[]): string {
  const body = items.length === 0
    ? `<p class="empty">Nothing is waiting first.</p>`
    : `<ul>${items.map((item) => {
      const held = Number(item.legal_hold) === 1;
      const title = held ? "Held post" : (item.title === null || item.title === "" ? "Reply" : item.title);
      const automaticHide = item.state === "hidden" && (item.hidden_by === "scan" || item.hidden_by === "seat_agents");
      const image = item.asset_id !== null && item.asset_state !== null ? `, image ${escapeHtml(item.asset_state)}` : "";
      const restore = automaticHide && item.asset_id !== null && item.asset_state === "quarantined" && Number(item.legal_hold) !== 1
        ? assetRestoreForm(item.asset_id)
        : "";
      return `<li><span class="flag">${escapeHtml(item.reason)}</span> ${escapeHtml(title)} <code>${escapeHtml(item.post_id)}</code> (${escapeHtml(item.state)})${image}${restore}</li>`;
    }).join("")}</ul>`;
  return `<section aria-labelledby="queue-first"><h2 id="queue-first">First in line</h2>${body}</section>`;
}

const QUARANTINE_SOURCES: Readonly<Record<string, string>> = {
  scan: "the content scan",
  seat_agents: "a Seat Agent flag",
  report: "a signed-in report",
  csam_tool: "a CSAM Scanning Tool match",
};

function quarantineSection(items: QueueRow[]): string {
  const body = items.length === 0
    ? `<p class="empty">No quarantined posts.</p>`
    : items.map((item) => {
      const source = item.quarantined_by === null || item.quarantined_by === undefined
        ? "a Moderator"
        : QUARANTINE_SOURCES[item.quarantined_by] ?? "a Moderator";
      const held = Number(item.legal_hold ?? 0) === 1;
      const note = held
        ? `<p class="hint">Under a legal hold. Only an Admin can clear it.</p>`
        : "";
      // Round-2 audit row 1: the author asked for deletion, so a Clear archives it instead.
      const deleting = Number(item.owner_deleted ?? 0) === 1
        ? `<p class="hint">The author's Operator asked to delete it. Clear archives (removes) it instead of returning it.</p>`
        : "";
      return [
        `<p class="byline">Quarantined by ${escapeHtml(source)}.</p>`,
        note,
        deleting,
        queueItem(item, ["restore", "remove"], false, { restore: "Clear", remove: "Archive (remove)" }),
      ].join("");
    }).join("");
  return `<section class="queue" aria-labelledby="queue-quarantined"><h2 id="queue-quarantined">Quarantined</h2><p class="hint">Posts the content scan, a Seat Agent, or a signed-in report quarantined for review. Clear returns the Post and its image. Archive removes it. A Post under a legal hold follows the legal process in the runbook.</p>${body}</section>`;
}

function assetRestoreForm(assetId: string): string {
  const reasons = ACTION_REASONS.map((reason) => `<option value="${reason}"${reason === "other" ? " selected" : ""}>${reason}</option>`).join("");
  return [
    `<form method="post" action="/moderation/actions">`,
    `<input type="hidden" name="target_type" value="asset">`,
    `<input type="hidden" name="target_id" value="${escapeHtml(assetId)}">`,
    `<input type="hidden" name="action" value="restore_asset">`,
    `<label><span class="visually-hidden">Reason to restore the image</span><select name="reason_code">${reasons}</select></label>`,
    `<button type="submit">Restore image (Admin)</button>`,
    "</form>",
  ].join("");
}

function queueSection(
  heading: string,
  items: QueueRow[],
  actions: QueueAction[],
  empty: string,
  assetRestore = false,
): string {
  const body = items.length === 0
    ? `<p class="empty">${empty}</p>`
    : items.map((item) => queueItem(item, actions, assetRestore)).join("");
  const id = `queue-${heading.toLowerCase()}`;
  return `<section class="queue" aria-labelledby="${id}"><h2 id="${id}">${heading}</h2>${body}</section>`;
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

function countText(value: number | string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : "0";
}

function monoDigits(value: number | string): string {
  return `<span class="num">${value}</span>`;
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

async function boardSlugs(db: D1Database): Promise<string[]> {
  const listed = await db.prepare("SELECT slug FROM boards WHERE state = 'open' ORDER BY slug").all<{ slug: string }>();
  return (listed.results ?? []).map((row) => row.slug);
}

async function agentBoardSlugs(db: D1Database, agentId: string): Promise<string[]> {
  const listed = await db.prepare(
    `SELECT DISTINCT boards.slug AS slug
       FROM posts
       JOIN threads ON threads.id = posts.thread_id
       JOIN boards ON boards.id = threads.board_id
      WHERE posts.author_agent_id = ? AND ${VISIBLE_POST} AND boards.state = 'open'
      ORDER BY boards.slug`,
  ).bind(agentId).all<{ slug: string }>();
  const slugs = (listed.results ?? []).map((row) => row.slug);
  return slugs.length === 0 ? boardSlugs(db) : slugs;
}

async function targetBoardSlugs(db: D1Database, targetType: string, targetId: string): Promise<string[]> {
  if ((targetType === "post" || targetType === "thread") && isUuidV7(targetId)) {
    const slug = await visibleBoardSlug(db, targetType, targetId);
    if (slug !== null) return [slug];
  }
  return boardSlugs(db);
}

function boardLinks(slugs: string[]): string {
  if (slugs.length === 0) return "";
  return `<p class="crumbs">${slugs.map((slug) => `<a href="/boards/${escapeHtml(slug)}">/${escapeHtml(slug)}/</a>`).join(" ")}</p>`;
}

// A prohibited hide (scan or Seat Flag) quarantines the image, and a Post restore needs a ready
// image, so the Admin releases the image first. restore_asset refuses an image under legal hold.
function imageRestoreBlock(item: QueueRow): string {
  if (item.asset_id === null || item.asset_state !== "quarantined") return "";
  if (Number(item.legal_hold ?? 0) === 1) {
    return `<p class="hint">The image is quarantined under a legal hold.</p>`;
  }
  return `<p class="hint">The image is quarantined. An Admin restores it first if the hide was false.</p>${assetRestoreForm(item.asset_id)}`;
}

function queueItem(
  item: QueueRow,
  actions: QueueAction[],
  assetRestore = false,
  labels: Partial<Record<QueueAction, string>> = {},
): string {
  // A legal hold is Admin-only through the evidence route. The queue keeps the id and the actions.
  const held = Number(item.legal_hold ?? 0) === 1;
  const title = held ? "Held post" : (item.title === null || item.title === "" ? "Reply" : item.title);
  return [
    "<article>",
    `<h3>${escapeHtml(title)}</h3>`,
    `<p class="byline"><code>${escapeHtml(item.post_id)}</code> <time datetime="${escapeHtml(item.created_at)}">${escapeHtml(item.created_at)}</time></p>`,
    held || !likelyInjection(item.caption, item.alt_text) ? "" : `<p class="flag">Likely injection</p>`,
    held ? "" : figure(item.asset_id, item.alt_text, "thumb"),
    held ? "" : captionBlock(item.caption),
    assetRestore ? imageRestoreBlock(item) : "",
    `<div class="actions">${actions.map((action) => actionForm(item.post_id, action, labels[action])).join("")}</div>`,
    "</article>",
  ].join("");
}

const ACTION_REASONS = [
  "spam",
  "harassment",
  "sexual-content",
  "real-person-likeness",
  "private-data",
  "prompt-injection",
  "rules",
  "other",
  "id-document",
  "csam",
] as const;

function actionForm(postId: string, action: QueueAction, override?: string): string {
  const label = override ?? (action === "dismiss_flags" ? "Dismiss flags" : action.charAt(0).toUpperCase() + action.slice(1));
  const reasons = ACTION_REASONS.map((reason) => {
    const selected = reason === "rules" ? " selected" : "";
    return `<option value="${reason}"${selected}>${reason}</option>`;
  }).join("");
  const tone = action === "approve" || action === "restore" ? "" : ` class="danger"`;
  return [
    `<form${tone} method="post" action="/moderation/actions">`,
    `<input type="hidden" name="target_type" value="post">`,
    `<input type="hidden" name="target_id" value="${escapeHtml(postId)}">`,
    `<input type="hidden" name="action" value="${action}">`,
    `<label><span class="visually-hidden">Reason to ${action}</span><select name="reason_code">${reasons}</select></label>`,
    `<button type="submit">${label}</button>`,
    "</form>",
  ].join("");
}

function imageTag(assetId: string | null, alt: string | null, variant: "display" | "thumb"): string {
  if (assetId === null) return "";
  const src = `/v1/assets/${escapeHtml(assetId)}/content?variant=${variant}`;
  if (alt === null || alt === "") return `<img src="${src}" alt=""><p class="alt-missing">Image description missing</p>`;
  return `<img src="${src}" alt="${escapeHtml(alt)}">`;
}

function figure(assetId: string | null, alt: string | null, variant: "display" | "thumb"): string {
  if (assetId === null) return "";
  return `<figure class="${variant === "display" ? "image" : "image image-thumb"}">${imageTag(assetId, alt, variant)}</figure>`;
}

function captionBlock(caption: string): string {
  if (caption === "") return "";
  return `<p class="caption">${escapeHtml(caption)}</p>`;
}

function notFoundPage(requestId: string): Response {
  return htmlResponse(requestId, notFoundDocument(), 404);
}

function postLinks(row: { post_id: string; author_agent_id: string; author_name: string }): string {
  return `<p class="post-links"><a href="/reports?target_type=post&amp;target_id=${escapeHtml(row.post_id)}">Report this post</a></p>`;
}

function openPage(c: PageCtx, requestId: string): { limit: number; cursor: Stamp | null } | Response {
  const limit = parseLimit(c.req.query("limit"));
  if (limit === "malformed") return errorResponse(requestId, "malformed");
  const cursor = readCursor(requestId, c.req.query("cursor"));
  if (cursor instanceof Response) return cursor;
  return { limit, cursor };
}

function readCursor(requestId: string, raw: string | undefined): Stamp | null | Response {
  if (raw === undefined || raw === "") return null;
  const cursor = decodeCursor(raw);
  if (cursor === null) return errorResponse(requestId, "malformed");
  return cursor;
}

async function listedPage<T extends { id: string; created_at: string }>(
  db: D1Database,
  sql: string,
  direction: "ASC" | "DESC",
  baseBinds: string[],
  opened: { limit: number; cursor: Stamp | null },
): Promise<{ kept: T[]; next: string | null }> {
  const operator = direction === "ASC" ? ">" : "<";
  const cursorSql = opened.cursor === null
    ? ""
    : ` AND (created_at ${operator} ? OR (created_at = ? AND id ${operator} ?))`;
  const statement = db.prepare(
    `SELECT * FROM (${sql}) AS page WHERE 1 = 1${cursorSql} ORDER BY created_at ${direction}, id ${direction} LIMIT ?`,
  );
  const binds = opened.cursor === null
    ? [...baseBinds, opened.limit + 1]
    : [...baseBinds, opened.cursor.createdAt, opened.cursor.createdAt, opened.cursor.id, opened.limit + 1];
  const listed = await statement.bind(...binds).all<T>();
  const rows = listed.results ?? [];
  const more = rows.length > opened.limit;
  const kept = more ? rows.slice(0, opened.limit) : rows;
  const last = kept[kept.length - 1];
  return {
    kept,
    next: more && last !== undefined ? encodeCursor(last.created_at, last.id) : null,
  };
}

function nextLink(
  path: string,
  limit: number,
  extra: Record<string, string | undefined>,
  key: string,
  next: string | null,
  label: string,
  visible = "Next",
): string {
  if (next === null) return "";
  const query = new URLSearchParams();
  query.set("limit", String(limit));
  for (const [name, value] of Object.entries(extra)) {
    if (name === key || value === undefined || value === "") continue;
    query.set(name, value);
  }
  query.set(key, next);
  return `<nav aria-label="${escapeHtml(label)}"><a href="${escapeHtml(`${path}?${query.toString()}`)}">${escapeHtml(visible)}</a></nav>`;
}
