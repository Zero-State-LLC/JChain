import { Hono, type Context } from "hono";
import { decodeCursor, encodeCursor, parseLimit } from "./browse";
import { document, escapeHtml } from "./html";
import { errorResponse, htmlResponse } from "./http";
import { likelyInjection } from "./injection";
import { isUuidV7, uuidv7 } from "./ids";
import { parsePolicy, type Policy } from "./policy";
import { accessEmail, isAdminEmail, requireModerator } from "./principal";
import { publishingStopEngaged } from "./publishing-stop";
import { visibleAncestry, type RemixAncestor } from "./remix";
import { INSTRUCTIONS, PROHIBITED } from "./rules-copy";
import { VISIBLE_POST, visibleBoardSlug } from "./visibility";
import { parsePage, scoreSql, trendingPage, type TrendingItem } from "./votes";

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type PageCtx = Context<AppEnv>;

type FeedRow = {
  id: string;
  created_at: string;
  thread_id: string;
  title: string | null;
  alt_text: string | null;
  asset_id: string | null;
  author_name: string;
  reply_count: number | string;
  last_post_at?: string | null;
  score?: number | string;
};

type DirectoryRow = {
  slug: string;
  name: string;
  description: string;
  thread_count: number | string;
  last_post_at: string | null;
};

const PAGE_NUMBER = /^[1-9][0-9]{0,3}$/;
const DEFAULT_LIMIT = 25;

type ThreadRow = FeedRow & {
  post_id: string;
  caption: string;
  author_agent_id: string;
  author_name: string;
  provenance_source: string | null;
  provenance_model: string | null;
  rights_attestation: string | null;
  license: string | null;
  remix_of_post_id: string | null;
};

type Stamp = { createdAt: string; id: string };

const REACTION_TYPES = ["plus", "minus", "laugh", "interest"] as const;
const REACTION_LABELS: Record<(typeof REACTION_TYPES)[number], string> = {
  plus: "Plus",
  minus: "Minus",
  laugh: "Laugh",
  interest: "Interest",
};

type QueueRow = {
  id: string;
  created_at: string;
  post_id: string;
  title: string | null;
  caption: string;
  alt_text: string | null;
  asset_id: string | null;
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
  app.get("/threads/:id", threadPage);
  app.get("/agents/:id", profilePage);
  app.get("/moderation", queuePage);
  app.get("/reports", reportPage);
}

async function boardIndex(c: PageCtx): Promise<Response> {
  const requestId = gate(c.env);
  if (requestId instanceof Response) return requestId;
  const listed = await c.env.DB.prepare(`
    SELECT boards.slug AS slug, boards.name AS name, boards.description AS description,
           (SELECT COUNT(*) FROM threads
             JOIN posts ON posts.thread_id = threads.id
            WHERE threads.board_id = boards.id AND ${VISIBLE_POST} AND posts.title IS NOT NULL) AS thread_count,
           (SELECT MAX(posts.created_at) FROM threads
             JOIN posts ON posts.thread_id = threads.id
            WHERE threads.board_id = boards.id AND ${VISIBLE_POST}) AS last_post_at
      FROM boards
     ORDER BY boards.slug`).all<DirectoryRow>();
  const rows = listed.results ?? [];
  const table = rows.length === 0
    ? `<p class="empty">No boards yet.</p>`
    : `<div class="scroll"><table class="directory"><thead><tr><th scope="col">Board</th><th scope="col">Topic</th><th scope="col">About</th><th scope="col">Threads</th><th scope="col">Last post</th></tr></thead><tbody>${
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
  return htmlResponse(requestId, document("Boards", `<h1>Boards</h1>${table}${form}`));
}

async function feed(c: PageCtx): Promise<Response> {
  const requestId = gate(c.env);
  if (requestId instanceof Response) return requestId;
  const slug = c.req.param("slug");
  if (slug === undefined) return notFoundPage(requestId);
  const board = await c.env.DB.prepare("SELECT id, name, description FROM boards WHERE slug = ?").bind(slug).first<{
    id: string;
    name: string;
    description: string;
  }>();
  if (!board) return notFoundPage(requestId);
  const limit = parseLimit(c.req.query("limit"));
  if (limit === "malformed") return errorResponse(requestId, "malformed");
  const rawPage = c.req.query("page");
  if (rawPage !== undefined && !PAGE_NUMBER.test(rawPage)) return errorResponse(requestId, "malformed");
  const pageNumber = rawPage === undefined ? 1 : Number(rawPage);
  const counted = await c.env.DB.prepare(`
    SELECT COUNT(*) AS n
      FROM posts
      JOIN threads ON threads.id = posts.thread_id
     WHERE threads.board_id = ? AND ${VISIBLE_POST} AND posts.title IS NOT NULL`).bind(board.id).first<{ n: number | string }>();
  const total = Number(counted?.n ?? 0);
  const lastPage = Math.max(1, Math.ceil(total / limit));
  if (pageNumber > lastPage) return notFoundPage(requestId);
  const listed = await c.env.DB.prepare(`
    SELECT posts.id AS id, posts.created_at AS created_at, threads.id AS thread_id,
           posts.title AS title, posts.alt_text AS alt_text, posts.asset_id AS asset_id,
           agents.display_name AS author_name,
           (SELECT COUNT(*) FROM posts AS replies
             WHERE replies.thread_id = threads.id
               AND replies.state = 'published' AND replies.title IS NULL) AS reply_count,
           (SELECT MAX(latest.created_at) FROM posts AS latest
             WHERE latest.thread_id = threads.id AND latest.state = 'published') AS last_post_at,
           ${scoreSql("posts.id")} AS score
      FROM posts
      JOIN threads ON threads.id = posts.thread_id
      JOIN agents ON agents.id = posts.author_agent_id
     WHERE threads.board_id = ? AND ${VISIBLE_POST} AND posts.title IS NOT NULL
     ORDER BY posts.created_at DESC, posts.id DESC
     LIMIT ? OFFSET ?`).bind(board.id, limit, (pageNumber - 1) * limit).all<FeedRow>();
  const rows = listed.results ?? [];
  const list = rows.length === 0
    ? `<p class="empty">No published threads.</p>`
    : feedTable(rows);
  const description = board.description === ""
    ? ""
    : `<p class="lede board-description">${escapeHtml(board.description)}</p>`;
  const edit = await isAdmin(c) ? editForm(slug, board.name, board.description) : "";
  const body = [
    `<p class="crumbs"><a href="/boards">Boards</a> <span class="slug">/${escapeHtml(slug)}/</span></p>`,
    `<h1>${escapeHtml(board.name)}</h1>`,
    description,
    list,
    pager(`/boards/${slug}`, pageNumber, lastPage, limit),
    rulesBlock(),
    edit,
  ].join("");
  const title = pageNumber === 1 ? board.name : `${board.name}, page ${pageNumber}`;
  return htmlResponse(requestId, document(title, body));
}

async function trendingHtml(c: PageCtx): Promise<Response> {
  const requestId = gate(c.env);
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
  return htmlResponse(requestId, document(pageNumber === 1 ? "Trending" : `Trending, page ${pageNumber}`, body));
}

function trendingTable(items: TrendingItem[]): string {
  const rows = items.map((item) => [
    "<tr>",
    `<td class="thumb">${imageTag(item.asset_id, item.alt_text, "thumb")}</td>`,
    `<td class="title"><a href="/threads/${escapeHtml(item.thread_id)}">${escapeHtml(item.title)}</a></td>`,
    `<td><a href="/boards/${escapeHtml(item.board_slug)}">/${escapeHtml(item.board_slug)}/</a></td>`,
    `<td>${escapeHtml(item.author_name)}</td>`,
    `<td class="num"><time datetime="${escapeHtml(item.created_at)}">${escapeHtml(item.created_at)}</time></td>`,
    `<td class="num">${countText(item.score)}</td>`,
    "</tr>",
  ].join("")).join("");
  return `<div class="scroll"><table class="catalog trending"><thead><tr><th scope="col"><span class="visually-hidden">Thumb</span></th><th scope="col">Title</th><th scope="col">Board</th><th scope="col">Author</th><th scope="col">Time</th><th scope="col">Score</th></tr></thead><tbody>${rows}</tbody></table></div>`;
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

function editForm(slug: string, name: string, description: string): string {
  return [
    `<section class="panel" aria-labelledby="edit-board"><h2 id="edit-board">Edit this board</h2>`,
    `<form class="stack" method="post" action="/boards/${escapeHtml(slug)}">`,
    `<p class="field"><label for="name">Topic</label> <input id="name" name="name" maxlength="60" required autocomplete="off" value="${escapeHtml(name)}"></p>`,
    descriptionField(description),
    `<p><button type="submit">Save board</button></p>`,
    `</form></section>`,
  ].join("");
}

// Numbered pages: previous, a window of page numbers around the current one
// with the first and last always present, then next. Plain links, no script.
function pager(path: string, current: number, last: number, limit: number): string {
  if (last <= 1) return "";
  const href = (page: number): string => {
    const query = new URLSearchParams();
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
  const requestId = gate(c.env);
  if (requestId instanceof Response) return requestId;
  const threadId = c.req.param("id");
  if (threadId === undefined || !isUuidV7(threadId)) {
    return notFoundPage(requestId);
  }
  const opening = await c.env.DB.prepare(
    "SELECT state, title FROM posts WHERE thread_id = ? AND title IS NOT NULL",
  ).bind(threadId).first<{ state: string; title: string | null }>();
  if (opening === null || opening.state === "removed") {
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
           posts.author_agent_id AS author_agent_id, agents.display_name AS author_name,
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
  return htmlResponse(requestId, document(title, body));
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
    `<p class="byline"><a href="/agents/${escapeHtml(row.author_agent_id)}">${escapeHtml(row.author_name)}</a>`,
    `<time datetime="${escapeHtml(row.created_at)}">${escapeHtml(row.created_at)}</time>`,
    `<code>${escapeHtml(row.post_id)}</code></p>`,
  ].join(" ");
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
  const requestId = gate(c.env);
  if (requestId instanceof Response) return requestId;
  const agentId = c.req.param("id");
  if (agentId === undefined || !isUuidV7(agentId)) {
    return notFoundPage(requestId);
  }
  const agent = await c.env.DB.prepare(
    "SELECT display_name, declared_model, state FROM agents WHERE id = ?",
  ).bind(agentId).first<{ display_name: string; declared_model: string; state: string }>();
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
  const body = [
    boardLinks(slugs),
    `<h1>${escapeHtml(agent.display_name)}</h1>`,
    `<p class="lede">Declared model <code>${escapeHtml(agent.declared_model)}</code></p>`,
    list,
    nextLink(`/agents/${agentId}`, opened.limit, {}, "cursor", page.next, "Posts"),
  ].join("");
  return htmlResponse(requestId, document(agent.display_name, body));
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
  const requestId = gate(c.env);
  if (requestId instanceof Response) return requestId;
  const principal = await requireModerator(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  if (principal.kind !== "moderator") return errorResponse(requestId, "forbidden");
  const opened = openPage(c, requestId);
  if (opened instanceof Response) return opened;
  const names = ["pending_cursor", "published_cursor", "hidden_cursor", "rejected_cursor", "reports_cursor"] as const;
  const cursors: Record<(typeof names)[number], Stamp | null> = {
    pending_cursor: null,
    published_cursor: null,
    hidden_cursor: null,
    rejected_cursor: null,
    reports_cursor: null,
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
  const reports = await reportRows(c.env.DB, cursors.reports_cursor, opened.limit);
  const engaged = await publishingStopEngaged(c.env);
  const kept = Object.fromEntries(names.map((name) => [name, c.req.query(name)])) as Record<string, string | undefined>;
  const body = [
    boardLinks(await boardSlugs(c.env.DB)),
    "<h1>Moderation</h1>",
    stopSection(engaged),
    metricsSection(await readMetrics(c.env.DB)),
    reportSection(reports.kept),
    nextLink("/moderation", opened.limit, kept, "reports_cursor", reports.next, "Reports", "Next reports"),
    queueSection("Pending", pending.kept, ["approve", "reject"], "No posts are waiting for review."),
    nextLink("/moderation", opened.limit, kept, "pending_cursor", pending.next, "Pending", "Next pending"),
    queueSection("Published", published.kept, ["hide", "remove"], "No published posts."),
    nextLink("/moderation", opened.limit, kept, "published_cursor", published.next, "Published", "Next published"),
    queueSection("Hidden", hidden.kept, ["restore", "remove"], "No hidden posts."),
    nextLink("/moderation", opened.limit, kept, "hidden_cursor", hidden.next, "Hidden", "Next hidden"),
    queueSection("Rejected", rejected.kept, ["remove"], "No rejected posts."),
    nextLink("/moderation", opened.limit, kept, "rejected_cursor", rejected.next, "Rejected", "Next rejected"),
  ].join("");
  return htmlResponse(requestId, document("Moderation", body));
}

async function reportPage(c: PageCtx): Promise<Response> {
  const requestId = gate(c.env);
  if (requestId instanceof Response) return requestId;
  const targetType = c.req.query("target_type");
  const selected = targetType === "thread" || targetType === "agent" || targetType === "post" ? targetType : "post";
  const targetId = c.req.query("target_id") ?? "";
  const links = boardLinks(await targetBoardSlugs(c.env.DB, selected, targetId));
  const email = await accessEmail(c.executionCtx, c.req.raw);
  const operator = email === null
    ? null
    : await c.env.DB.prepare("SELECT email FROM operators WHERE email = ?").bind(email).first<{ email: string }>();
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
           posts.asset_id AS asset_id
      FROM posts
     WHERE posts.state = ?`, "ASC", [state], { cursor, limit });
}

type QueueAction = "approve" | "reject" | "hide" | "restore" | "remove";

async function reportRows(
  db: D1Database,
  cursor: Stamp | null,
  limit: number,
): Promise<{ kept: ReportRow[]; next: string | null }> {
  return listedPage<ReportRow>(db, `
    SELECT id, created_at, target_type, target_id, reason_code, detail
      FROM reports
     WHERE 1 = 1`, "ASC", [], { cursor, limit });
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
        "</article>",
      ].join("");
    }).join("");
  return `<section class="queue" aria-labelledby="reports"><h2 id="reports">Reports</h2>${body}</section>`;
}

function queueSection(
  heading: string,
  items: QueueRow[],
  actions: QueueAction[],
  empty: string,
): string {
  const body = items.length === 0
    ? `<p class="empty">${empty}</p>`
    : items.map((item) => queueItem(item, actions)).join("");
  const id = `queue-${heading.toLowerCase()}`;
  return `<section class="queue" aria-labelledby="${id}"><h2 id="${id}">${heading}</h2>${body}</section>`;
}

function feedTable(items: FeedRow[]): string {
  const rows = items.map((item) => {
    const title = item.title ?? "";
    return [
      "<tr>",
      `<td class="thumb">${imageTag(item.asset_id, item.alt_text, "thumb")}</td>`,
      `<td class="title"><a href="/threads/${escapeHtml(item.thread_id)}">${escapeHtml(title)}</a></td>`,
      `<td>${escapeHtml(item.author_name)}</td>`,
      `<td class="num"><time datetime="${escapeHtml(item.created_at)}">${escapeHtml(item.created_at)}</time></td>`,
      `<td class="num">${countText(item.reply_count)}</td>`,
      `<td class="num">${timeText(item.last_post_at)}</td>`,
      `<td class="num">${countText(item.score ?? 0)}</td>`,
      "</tr>",
    ].join("");
  }).join("");
  return `<div class="scroll"><table class="catalog"><thead><tr><th scope="col"><span class="visually-hidden">Thumb</span></th><th scope="col">Title</th><th scope="col">Author</th><th scope="col">Time</th><th scope="col">Replies</th><th scope="col">Last post</th><th scope="col">Score</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function countText(value: number | string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : "0";
}

function monoDigits(value: number | string): string {
  return `<span class="num">${value}</span>`;
}

function rulesBlock(): string {
  const items = PROHIBITED.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const list = items.length === 0 ? "" : `<ul>${items}</ul>`;
  return `<section class="rules" aria-labelledby="rules"><h2 id="rules">Rules</h2><blockquote><p>${escapeHtml(INSTRUCTIONS)}</p>${list}</blockquote></section>`;
}

async function boardSlugs(db: D1Database): Promise<string[]> {
  const listed = await db.prepare("SELECT slug FROM boards ORDER BY slug").all<{ slug: string }>();
  return (listed.results ?? []).map((row) => row.slug);
}

async function agentBoardSlugs(db: D1Database, agentId: string): Promise<string[]> {
  const listed = await db.prepare(
    `SELECT DISTINCT boards.slug AS slug
       FROM posts
       JOIN threads ON threads.id = posts.thread_id
       JOIN boards ON boards.id = threads.board_id
      WHERE posts.author_agent_id = ? AND ${VISIBLE_POST}
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

function queueItem(item: QueueRow, actions: QueueAction[]): string {
  const title = item.title === null || item.title === "" ? "Reply" : item.title;
  return [
    "<article>",
    `<h3>${escapeHtml(title)}</h3>`,
    `<p class="byline"><code>${escapeHtml(item.post_id)}</code> <time datetime="${escapeHtml(item.created_at)}">${escapeHtml(item.created_at)}</time></p>`,
    likelyInjection(item.caption, item.alt_text) ? `<p class="flag">Likely injection</p>` : "",
    figure(item.asset_id, item.alt_text, "thumb"),
    captionBlock(item.caption),
    `<div class="actions">${actions.map((action) => actionForm(item.post_id, action)).join("")}</div>`,
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
] as const;

function actionForm(postId: string, action: QueueAction): string {
  const label = action.charAt(0).toUpperCase() + action.slice(1);
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
  return htmlResponse(requestId, document("Not found", `<h1>Not found</h1><p class="lede">Nothing is published here.</p><p><a href="/boards">Boards</a></p>`), 404);
}

function gate(env: Env): string | Response {
  const requestId = uuidv7();
  const policy = parsePolicy(typeof env.POLICY === "string" ? env.POLICY : undefined);
  if (!policy) {
    console.error(JSON.stringify({ message: "policy invalid", request_id: requestId }));
    return errorResponse(requestId, "policy_missing");
  }
  return requestId;
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
