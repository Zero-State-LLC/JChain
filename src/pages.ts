import { Hono, type Context } from "hono";
import { decodeCursor, encodeCursor, parseLimit } from "./browse";
import { errorResponse, htmlResponse } from "./http";
import { likelyInjection } from "./injection";
import { isUuidV7, uuidv7 } from "./ids";
import { parsePolicy, type Policy } from "./policy";
import { requireModerator } from "./principal";
import { publishingStopEngaged } from "./publishing-stop";
import { visibleAncestry, type RemixAncestor } from "./remix";
import { VISIBLE_POST } from "./visibility";

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type PageCtx = Context<AppEnv>;

type FeedRow = {
  id: string;
  created_at: string;
  thread_id: string;
  title: string | null;
  alt_text: string | null;
  asset_id: string | null;
};

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
  app.get("/boards/:slug", feed);
  app.get("/threads/:id", threadPage);
  app.get("/agents/:id", profilePage);
  app.get("/moderation", queuePage);
  app.get("/reports", reportPage);
}

async function feed(c: PageCtx): Promise<Response> {
  const requestId = gate(c.env);
  if (requestId instanceof Response) return requestId;
  const slug = c.req.param("slug");
  if (slug === undefined) return htmlResponse(requestId, document("Not found", "<h1>Not found</h1>"), 404);
  const board = await c.env.DB.prepare("SELECT id, name FROM boards WHERE slug = ?").bind(slug).first<{
    id: string;
    name: string;
  }>();
  if (!board) return htmlResponse(requestId, document("Not found", "<h1>Not found</h1>"), 404);
  const opened = openPage(c, requestId);
  if (opened instanceof Response) return opened;
  const page = await listedPage<FeedRow>(c.env.DB, `
    SELECT posts.id AS id, posts.created_at AS created_at, threads.id AS thread_id,
           posts.title AS title, posts.alt_text AS alt_text, posts.asset_id AS asset_id
      FROM posts
      JOIN threads ON threads.id = posts.thread_id
     WHERE threads.board_id = ? AND ${VISIBLE_POST} AND posts.title IS NOT NULL`, "DESC", [board.id], opened);
  const list = page.kept.length === 0
    ? "<p>No published threads.</p>"
    : `<ul>${page.kept.map((item) => feedItem(item)).join("")}</ul>`;
  const body = `<h1>${escapeHtml(board.name)}</h1>${list}${nextLink(`/boards/${slug}`, opened.limit, {}, "cursor", page.next, "Feed")}`;
  return htmlResponse(requestId, document(board.name, body));
}

async function threadPage(c: PageCtx): Promise<Response> {
  const requestId = gate(c.env);
  if (requestId instanceof Response) return requestId;
  const threadId = c.req.param("id");
  if (threadId === undefined || !isUuidV7(threadId)) {
    return htmlResponse(requestId, document("Not found", "<h1>Not found</h1>"), 404);
  }
  const opening = await c.env.DB.prepare(
    "SELECT state, title FROM posts WHERE thread_id = ? AND title IS NOT NULL",
  ).bind(threadId).first<{ state: string; title: string | null }>();
  if (opening === null || opening.state === "removed") {
    return htmlResponse(requestId, document("Not found", "<h1>Not found</h1>"), 404);
  }
  const visible = await c.env.DB.prepare(
    `SELECT 1 AS present FROM posts WHERE thread_id = ? AND ${VISIBLE_POST} LIMIT 1`,
  ).bind(threadId).first();
  if (visible === null) {
    return htmlResponse(requestId, document("Not found", "<h1>Not found</h1>"), 404);
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
           posts.remix_of_post_id AS remix_of_post_id
      FROM posts
      JOIN threads ON threads.id = posts.thread_id
      JOIN agents ON agents.id = posts.author_agent_id
     WHERE threads.id = ? AND ${VISIBLE_POST}`, "ASC", [threadId], opened);
  if (page.kept.length === 0 && opened.cursor === null) {
    return htmlResponse(requestId, document("Not found", "<h1>Not found</h1>"), 404);
  }
  const counts = await reactionCounts(c.env.DB, threadId);
  const ancestry = await visibleAncestry(c.env.DB, page.kept.map((row) => row.post_id));
  const visibleTitle = page.kept.find((row) => row.title !== null && row.title !== "");
  const title = visibleTitle?.title ?? (opening.state === "published" ? opening.title ?? "Thread" : "Thread");
  const posts = page.kept.length === 0
    ? "<p>No more posts.</p>"
    : page.kept.map((row) => row.title === null
      ? replyBlock(row, counts, ancestry.get(row.post_id) ?? [])
      : openingBlock(row, counts, ancestry.get(row.post_id) ?? [])).join("");
  const body = [
    `<p><a href="/boards/beta">Board</a></p>`,
    `<p><a href="/reports?target_type=thread&amp;target_id=${escapeHtml(threadId)}">Report this thread</a></p>`,
    `<h1>${escapeHtml(title)}</h1>`,
    posts,
    nextLink(`/threads/${threadId}`, opened.limit, {}, "cursor", page.next, "Posts"),
  ].join("");
  return htmlResponse(requestId, document(title, body));
}

function openingBlock(
  row: ThreadRow,
  counts: Map<string, Map<string, number>>,
  ancestry: RemixAncestor[],
): string {
  return [
    imageTag(row.asset_id, row.alt_text, "display"),
    `<p>${escapeHtml(row.caption)}</p>`,
    reactionList(counts.get(row.post_id)),
    declarationList(row),
    ancestryList(ancestry),
    postLinks(row),
  ].join("");
}

function replyBlock(
  row: ThreadRow,
  counts: Map<string, Map<string, number>>,
  ancestry: RemixAncestor[],
): string {
  const image = row.asset_id === null ? "" : imageTag(row.asset_id, row.alt_text, "display");
  return [
    "<article>",
    "<h2>Reply</h2>",
    image,
    `<p>${escapeHtml(row.caption)}</p>`,
    reactionList(counts.get(row.post_id)),
    declarationList(row),
    ancestryList(ancestry),
    postLinks(row),
    "</article>",
  ].join("");
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
  const items = REACTION_TYPES.map((type) => `<dt>${type}</dt><dd>${counts?.get(type) ?? 0}</dd>`);
  return `<dl>${items.join("")}</dl>`;
}

function declarationList(row: ThreadRow): string {
  if (row.provenance_source === null) return "";
  const model = row.provenance_model === null
    ? ""
    : `<dt>Model</dt><dd>${escapeHtml(row.provenance_model)}</dd>`;
  return [
    "<dl>",
    `<dt>Source</dt><dd>${escapeHtml(row.provenance_source)}</dd>`,
    model,
    `<dt>Rights</dt><dd>${escapeHtml(row.rights_attestation ?? "")}</dd>`,
    `<dt>License</dt><dd>${escapeHtml(row.license ?? "")}</dd>`,
    "</dl>",
  ].join("");
}

function ancestryList(ancestry: RemixAncestor[]): string {
  if (ancestry.length === 0) return "";
  const items = ancestry.map((item) =>
    `<li><a href="/threads/${escapeHtml(item.thread_id)}">${escapeHtml(item.caption)}</a> <code>${escapeHtml(item.post_id)}</code></li>`);
  return `<ol>${items.join("")}</ol>`;
}

async function profilePage(c: PageCtx): Promise<Response> {
  const requestId = gate(c.env);
  if (requestId instanceof Response) return requestId;
  const agentId = c.req.param("id");
  if (agentId === undefined || !isUuidV7(agentId)) {
    return htmlResponse(requestId, document("Not found", "<h1>Not found</h1>"), 404);
  }
  const agent = await c.env.DB.prepare(
    "SELECT display_name, declared_model, state FROM agents WHERE id = ?",
  ).bind(agentId).first<{ display_name: string; declared_model: string; state: string }>();
  if (!agent || (agent.state !== "active" && agent.state !== "suspended")) {
    return htmlResponse(requestId, document("Not found", "<h1>Not found</h1>"), 404);
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
    ? "<p>No published posts.</p>"
    : page.kept.map((item) => profileItem(item)).join("");
  const body = [
    `<p><a href="/boards/beta">Board</a></p>`,
    `<h1>${escapeHtml(agent.display_name)}</h1>`,
    `<p>${escapeHtml(agent.declared_model)}</p>`,
    list,
    nextLink(`/agents/${agentId}`, opened.limit, {}, "cursor", page.next, "Posts"),
  ].join("");
  return htmlResponse(requestId, document(agent.display_name, body));
}

function profileItem(item: ProfileRow): string {
  const heading = item.title === null || item.title === "" ? "Reply" : item.title;
  const image = item.asset_id === null ? "" : imageTag(item.asset_id, item.alt_text, "thumb");
  return [
    "<article>",
    `<h2>${escapeHtml(heading)}</h2>`,
    image,
    `<p>${escapeHtml(item.caption)}</p>`,
    `<p><a href="/threads/${escapeHtml(item.thread_id)}">Thread</a></p>`,
    `<p><a href="/reports?target_type=post&amp;target_id=${escapeHtml(item.id)}">Report this post</a></p>`,
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
    "<h1>Moderation</h1>",
    `<p><a href="/boards/beta">Board</a></p>`,
    stopSection(engaged),
    reportSection(reports.kept),
    nextLink("/moderation", opened.limit, kept, "reports_cursor", reports.next, "Reports"),
    queueSection("Pending", pending.kept, ["approve", "reject"], "No posts are waiting for review."),
    nextLink("/moderation", opened.limit, kept, "pending_cursor", pending.next, "Pending"),
    queueSection("Published", published.kept, ["hide", "remove"], "No published posts."),
    nextLink("/moderation", opened.limit, kept, "published_cursor", published.next, "Published"),
    queueSection("Hidden", hidden.kept, ["restore", "remove"], "No hidden posts."),
    nextLink("/moderation", opened.limit, kept, "hidden_cursor", hidden.next, "Hidden"),
    queueSection("Rejected", rejected.kept, ["remove"], "No rejected posts."),
    nextLink("/moderation", opened.limit, kept, "rejected_cursor", rejected.next, "Rejected"),
  ].join("");
  return htmlResponse(requestId, document("Moderation", body));
}

function reportPage(c: PageCtx): Response {
  const requestId = gate(c.env);
  if (requestId instanceof Response) return requestId;
  const targetType = c.req.query("target_type");
  const selected = targetType === "thread" || targetType === "agent" || targetType === "post" ? targetType : "post";
  const targetId = c.req.query("target_id") ?? "";
  const options = ["post", "thread", "agent"].map((type) => {
    const selectedAttr = type === selected ? " selected" : "";
    return `<option value="${type}"${selectedAttr}>${type}</option>`;
  }).join("");
  const reasons = [
    "spam", "harassment", "sexual-content", "real-person-likeness",
    "private-data", "prompt-injection", "rules", "other",
  ].map((reason) => `<option value="${reason}">${reason}</option>`).join("");
  const body = [
    `<p><a href="/boards/beta">Board</a></p>`,
    "<h1>Report</h1>",
    `<form method="post" action="/v1/reports">`,
    `<label for="target_type">Target type</label>`,
    `<select id="target_type" name="target_type">${options}</select>`,
    `<label for="target_id">Target</label>`,
    `<input id="target_id" name="target_id" value="${escapeHtml(targetId)}">`,
    `<label for="reason_code">Reason</label>`,
    `<select id="reason_code" name="reason_code">${reasons}</select>`,
    `<label for="detail">Detail</label>`,
    `<textarea id="detail" name="detail" maxlength="500"></textarea>`,
    `<label for="turnstile_token">Turnstile</label>`,
    `<input id="turnstile_token" name="turnstile_token">`,
    `<button type="submit">Report</button>`,
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

function stopSection(engaged: boolean): string {
  const state = engaged ? "Engaged" : "Disengaged";
  return [
    "<h2>Publishing stop</h2>",
    `<p>${state}</p>`,
    `<form method="post" action="/v1/admin/publishing-stop">`,
    `<input type="hidden" name="engaged" value="true">`,
    `<button type="submit">Engage</button>`,
    `</form>`,
    `<form method="post" action="/v1/admin/publishing-stop">`,
    `<input type="hidden" name="engaged" value="false">`,
    `<button type="submit">Lift</button>`,
    `</form>`,
  ].join("");
}

function reportSection(items: ReportRow[]): string {
  const body = items.length === 0
    ? "<p>No reports.</p>"
    : items.map((item) => {
      const detail = item.detail === null || item.detail === "" ? "" : `<p>${escapeHtml(item.detail)}</p>`;
      return [
        "<article>",
        "<h3>Report</h3>",
        `<p>${escapeHtml(item.target_type)} <code>${escapeHtml(item.target_id)}</code></p>`,
        `<p>${escapeHtml(item.reason_code)}</p>`,
        detail,
        "</article>",
      ].join("");
    }).join("");
  return `<h2>Reports</h2>${body}`;
}

function queueSection(
  heading: string,
  items: QueueRow[],
  actions: QueueAction[],
  empty: string,
): string {
  const body = items.length === 0
    ? `<p>${empty}</p>`
    : items.map((item) => queueItem(item, actions)).join("");
  return `<h2>${heading}</h2>${body}`;
}

function feedItem(item: FeedRow): string {
  const title = item.title ?? "";
  return `<li><a href="/threads/${escapeHtml(item.thread_id)}">${escapeHtml(title)}</a>${imageTag(item.asset_id, item.alt_text, "thumb")}</li>`;
}

function queueItem(item: QueueRow, actions: QueueAction[]): string {
  const title = item.title === null || item.title === "" ? "Reply" : item.title;
  return [
    "<article>",
    `<h2>${escapeHtml(title)}</h2>`,
    `<p>${escapeHtml(item.caption)}</p>`,
    likelyInjection(item.caption, item.alt_text) ? "<p>Likely injection</p>" : "",
    item.asset_id === null ? "" : imageTag(item.asset_id, item.alt_text, "thumb"),
    ...actions.map((action) => actionForm(item.post_id, action)),
    "</article>",
  ].join("");
}

function actionForm(postId: string, action: QueueAction): string {
  const label = action.charAt(0).toUpperCase() + action.slice(1);
  return [
    `<form method="post" action="/v1/moderation/actions">`,
    `<input type="hidden" name="target_type" value="post">`,
    `<input type="hidden" name="target_id" value="${escapeHtml(postId)}">`,
    `<input type="hidden" name="action" value="${action}">`,
    `<input type="hidden" name="reason_code" value="rules">`,
    `<button type="submit">${label}</button>`,
    "</form>",
  ].join("");
}

function imageTag(assetId: string | null, alt: string | null, variant: "display" | "thumb"): string {
  if (assetId === null) return "<p>Image description missing</p>";
  const src = `/v1/assets/${escapeHtml(assetId)}/content?variant=${variant}`;
  if (alt === null || alt === "") return `<img src="${src}" alt=""><p>Image description missing</p>`;
  return `<img src="${src}" alt="${escapeHtml(alt)}">`;
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

function document(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><a href="#content">Skip to content</a><main id="content">${body}</main></body></html>`;
}

function postLinks(row: { post_id: string; author_agent_id: string; author_name: string }): string {
  return [
    `<p><a href="/agents/${escapeHtml(row.author_agent_id)}">${escapeHtml(row.author_name)}</a></p>`,
    `<p><a href="/reports?target_type=post&amp;target_id=${escapeHtml(row.post_id)}">Report this post</a></p>`,
  ].join("");
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
): string {
  if (next === null) return "";
  const query = new URLSearchParams();
  query.set("limit", String(limit));
  for (const [name, value] of Object.entries(extra)) {
    if (name === key || value === undefined || value === "") continue;
    query.set(name, value);
  }
  query.set(key, next);
  return `<nav aria-label="${escapeHtml(label)}"><a href="${escapeHtml(`${path}?${query.toString()}`)}">Next</a></nav>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
