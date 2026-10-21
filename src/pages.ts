import { Hono, type Context } from "hono";
import { errorResponse, htmlResponse } from "./http";
import { isUuidV7, uuidv7 } from "./ids";
import { parsePolicy, type Policy } from "./policy";
import { requireModerator } from "./principal";

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type PageCtx = Context<AppEnv>;

type FeedRow = {
  thread_id: string;
  title: string | null;
  alt_text: string | null;
  asset_id: string | null;
};

type ThreadRow = FeedRow & {
  caption: string;
  provenance_source: string | null;
  provenance_model: string | null;
  rights_attestation: string | null;
  license: string | null;
  remix_of_post_id: string | null;
};

type QueueRow = {
  post_id: string;
  title: string | null;
  caption: string;
  alt_text: string | null;
  asset_id: string | null;
};

export function mountPages(app: Hono<AppEnv>): void {
  app.get("/boards/:slug", feed);
  app.get("/threads/:id", threadPage);
  app.get("/moderation", queuePage);
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
  const rows = await c.env.DB.prepare(
    `SELECT threads.id AS thread_id, posts.title AS title, posts.alt_text AS alt_text, posts.asset_id AS asset_id
       FROM posts
       JOIN threads ON threads.id = posts.thread_id
      WHERE threads.board_id = ? AND posts.state = 'published' AND posts.title IS NOT NULL
      ORDER BY posts.created_at DESC, posts.id DESC
      LIMIT 25`,
  ).bind(board.id).all<FeedRow>();
  const items = rows.results ?? [];
  const list = items.length === 0
    ? "<p>No published threads.</p>"
    : `<ul>${items.map((item) => feedItem(item)).join("")}</ul>`;
  return htmlResponse(requestId, document(board.name, `<h1>${escapeHtml(board.name)}</h1>${list}`));
}

async function threadPage(c: PageCtx): Promise<Response> {
  const requestId = gate(c.env);
  if (requestId instanceof Response) return requestId;
  const threadId = c.req.param("id");
  if (threadId === undefined || !isUuidV7(threadId)) {
    return htmlResponse(requestId, document("Not found", "<h1>Not found</h1>"), 404);
  }
  const listed = await c.env.DB.prepare(
    `SELECT threads.id AS thread_id, posts.title AS title, posts.caption AS caption, posts.alt_text AS alt_text,
            posts.asset_id AS asset_id, posts.provenance_source AS provenance_source,
            posts.provenance_model AS provenance_model, posts.rights_attestation AS rights_attestation,
            posts.license AS license, posts.remix_of_post_id AS remix_of_post_id
       FROM posts
       JOIN threads ON threads.id = posts.thread_id
      WHERE threads.id = ? AND posts.state = 'published'
      ORDER BY posts.created_at ASC, posts.id ASC`,
  ).bind(threadId).all<ThreadRow>();
  const rows = listed.results ?? [];
  if (rows.length === 0) return htmlResponse(requestId, document("Not found", "<h1>Not found</h1>"), 404);
  const titled = rows.find((row) => row.title !== null);
  const title = titled?.title ?? "Thread";
  const body = [
    `<p><a href="/boards/beta">Board</a></p>`,
    `<h1>${escapeHtml(title)}</h1>`,
    ...rows.map((row) => row.title === null ? replyBlock(row) : openingBlock(row)),
  ].join("");
  return htmlResponse(requestId, document(title, body));
}

function openingBlock(row: ThreadRow): string {
  return [
    imageTag(row.asset_id, row.alt_text, "display"),
    `<p>${escapeHtml(row.caption)}</p>`,
    declarationList(row),
    remixLine(row),
  ].join("");
}

function replyBlock(row: ThreadRow): string {
  const image = row.asset_id === null ? "" : imageTag(row.asset_id, row.alt_text, "display");
  return [
    "<article>",
    "<h2>Reply</h2>",
    image,
    `<p>${escapeHtml(row.caption)}</p>`,
    declarationList(row),
    remixLine(row),
    "</article>",
  ].join("");
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

function remixLine(row: ThreadRow): string {
  if (row.remix_of_post_id === null) return "";
  return `<p>Remix of <code>${escapeHtml(row.remix_of_post_id)}</code></p>`;
}

async function queuePage(c: PageCtx): Promise<Response> {
  const requestId = gate(c.env);
  if (requestId instanceof Response) return requestId;
  const principal = await requireModerator(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  if (principal.kind !== "moderator") return errorResponse(requestId, "forbidden");
  const rows = await c.env.DB.prepare(
    `SELECT posts.id AS post_id, posts.title AS title, posts.caption AS caption,
            posts.alt_text AS alt_text, posts.asset_id AS asset_id
       FROM posts
      WHERE posts.state = 'pending_review'
      ORDER BY posts.created_at ASC, posts.id ASC
      LIMIT 25`,
  ).all<QueueRow>();
  const items = rows.results ?? [];
  const list = items.length === 0
    ? "<p>No posts are waiting for review.</p>"
    : items.map((item) => queueItem(item)).join("");
  return htmlResponse(requestId, document("Moderation", `<h1>Moderation</h1>${list}`));
}

function feedItem(item: FeedRow): string {
  const title = item.title ?? "";
  return `<li><a href="/threads/${escapeHtml(item.thread_id)}">${escapeHtml(title)}</a>${imageTag(item.asset_id, item.alt_text, "thumb")}</li>`;
}

function queueItem(item: QueueRow): string {
  const title = item.title === null || item.title === "" ? "Reply" : item.title;
  return [
    "<article>",
    `<h2>${escapeHtml(title)}</h2>`,
    `<p>${escapeHtml(item.caption)}</p>`,
    item.asset_id === null ? "" : imageTag(item.asset_id, item.alt_text, "thumb"),
    `<form method="post" action="/v1/moderation/actions">`,
    `<input type="hidden" name="target_type" value="post">`,
    `<input type="hidden" name="target_id" value="${escapeHtml(item.post_id)}">`,
    `<input type="hidden" name="action" value="approve">`,
    `<input type="hidden" name="reason_code" value="rules">`,
    `<button type="submit">Approve</button>`,
    "</form>",
    "</article>",
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
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><main>${body}</main></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
