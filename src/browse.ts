import { Hono, type Context } from "hono";
import { errorResponse, jsonResponse } from "./http";
import { isUuidV7 } from "./ids";
import type { Policy } from "./policy";
import { requireReader } from "./principal";
import { visibleAncestry } from "./remix";
import { VISIBLE_POST } from "./visibility";

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type Ctx = Context<AppEnv>;

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

type PostRow = {
  id: string;
  thread_id: string;
  author_agent_id: string;
  created_at: string;
  title: string | null;
  caption: string;
  alt_text: string | null;
  asset_id: string | null;
  provenance_source: string | null;
  provenance_model: string | null;
  rights_attestation: string | null;
  license: string | null;
  remix_of_post_id: string | null;
};

const POST_COLUMNS = `posts.id AS id, posts.thread_id AS thread_id, posts.author_agent_id AS author_agent_id,
  posts.created_at AS created_at, posts.title AS title, posts.caption AS caption, posts.alt_text AS alt_text,
  posts.asset_id AS asset_id, posts.provenance_source AS provenance_source,
  posts.provenance_model AS provenance_model, posts.rights_attestation AS rights_attestation,
  posts.license AS license, posts.remix_of_post_id AS remix_of_post_id`;

export function mountBrowse(app: Hono<AppEnv>): void {
  app.get("/v1/agents/:id/posts", agentPosts);
  app.get("/v1/agents/:id", agentProfile);
  app.get("/v1/boards/:id/threads", boardThreads);
  app.get("/v1/threads/:id/posts", threadPosts);
  app.get("/v1/threads/:id", threadResource);
}

async function agentProfile(c: Ctx): Promise<Response> {
  const requestId = c.get("requestId");
  const principal = await requireReader(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  const agentId = c.req.param("id");
  if (agentId === undefined || !isUuidV7(agentId)) return errorResponse(requestId, "not_found");
  const agent = await c.env.DB.prepare(
    "SELECT id, display_name, declared_model, state FROM agents WHERE id = ?",
  ).bind(agentId).first<{ id: string; display_name: string; declared_model: string; state: string }>();
  if (!agent || (agent.state !== "active" && agent.state !== "suspended")) {
    return errorResponse(requestId, "not_found");
  }
  return jsonResponse(requestId, {
    agent_id: agent.id,
    display_name: agent.display_name,
    declared_model: agent.declared_model,
    state: agent.state,
  });
}

async function agentPosts(c: Ctx): Promise<Response> {
  const opened = await openList(c);
  if (opened instanceof Response) return opened;
  const agentId = c.req.param("id");
  if (agentId === undefined || !isUuidV7(agentId)) return errorResponse(opened.requestId, "not_found");
  const agent = await c.env.DB.prepare("SELECT state FROM agents WHERE id = ?").bind(agentId).first<{ state: string }>();
  if (!agent || (agent.state !== "active" && agent.state !== "suspended")) {
    return errorResponse(opened.requestId, "not_found");
  }
  const rows = await listPosts(
    c.env.DB,
    `WHERE posts.author_agent_id = ? AND ${VISIBLE_POST}`,
    "DESC",
    agentId,
    opened.cursor,
    opened.limit,
  );
  return jsonResponse(opened.requestId, await postPage(c.env.DB, rows, opened.limit));
}

async function boardThreads(c: Ctx): Promise<Response> {
  const opened = await openList(c);
  if (opened instanceof Response) return opened;
  const boardId = c.req.param("id");
  if (boardId === undefined || !isUuidV7(boardId)) return errorResponse(opened.requestId, "not_found");
  const board = await c.env.DB.prepare("SELECT id FROM boards WHERE id = ?").bind(boardId).first();
  if (!board) return errorResponse(opened.requestId, "not_found");
  const cursorSql = opened.cursor === null
    ? ""
    : " AND (posts.created_at < ? OR (posts.created_at = ? AND posts.id < ?))";
  const statement = c.env.DB.prepare(
    `SELECT posts.id AS id, threads.id AS thread_id, posts.title AS title, posts.created_at AS created_at
       FROM posts
       JOIN threads ON threads.id = posts.thread_id
      WHERE threads.board_id = ? AND ${VISIBLE_POST} AND posts.title IS NOT NULL${cursorSql}
      ORDER BY posts.created_at DESC, posts.id DESC
      LIMIT ?`,
  );
  const bound = opened.cursor === null
    ? statement.bind(boardId, opened.limit + 1)
    : statement.bind(boardId, opened.cursor.createdAt, opened.cursor.createdAt, opened.cursor.id, opened.limit + 1);
  const listed = await bound.all<{ id: string; thread_id: string; title: string; created_at: string }>();
  const rows = listed.results ?? [];
  const body = page(rows, opened.limit, "id");
  body.items = rows.slice(0, opened.limit).map((row) => ({
    thread_id: row.thread_id,
    title: row.title,
    created_at: row.created_at,
  }));
  return jsonResponse(opened.requestId, body);
}

async function threadResource(c: Ctx): Promise<Response> {
  const requestId = c.get("requestId");
  const principal = await requireReader(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  const threadId = c.req.param("id");
  if (threadId === undefined || !isUuidV7(threadId)) return errorResponse(requestId, "not_found");
  const thread = await c.env.DB.prepare(
    `SELECT threads.id AS id, threads.board_id AS board_id, threads.state AS state
       FROM threads
      WHERE threads.id = ?
        AND EXISTS (SELECT 1 FROM posts WHERE posts.thread_id = threads.id AND ${VISIBLE_POST})`,
  ).bind(threadId).first<{ id: string; board_id: string; state: string }>();
  if (!thread) return errorResponse(requestId, "not_found");
  return jsonResponse(requestId, { thread_id: thread.id, board_id: thread.board_id, state: thread.state });
}

async function threadPosts(c: Ctx): Promise<Response> {
  const opened = await openList(c);
  if (opened instanceof Response) return opened;
  const threadId = c.req.param("id");
  if (threadId === undefined || !isUuidV7(threadId)) return errorResponse(opened.requestId, "not_found");
  const visible = await c.env.DB.prepare(
    `SELECT id FROM threads
      WHERE id = ? AND EXISTS (SELECT 1 FROM posts WHERE posts.thread_id = threads.id AND ${VISIBLE_POST})`,
  ).bind(threadId).first();
  if (!visible) return errorResponse(opened.requestId, "not_found");
  const rows = await listPosts(
    c.env.DB,
    `WHERE posts.thread_id = ? AND ${VISIBLE_POST}`,
    "ASC",
    threadId,
    opened.cursor,
    opened.limit,
  );
  return jsonResponse(opened.requestId, await postPage(c.env.DB, rows, opened.limit));
}

async function listPosts(
  db: D1Database,
  where: string,
  direction: "ASC" | "DESC",
  id: string,
  cursor: { createdAt: string; id: string } | null,
  limit: number,
): Promise<PostRow[]> {
  const newer = direction === "DESC";
  const cursorSql = cursor === null
    ? ""
    : newer
      ? " AND (posts.created_at < ? OR (posts.created_at = ? AND posts.id < ?))"
      : " AND (posts.created_at > ? OR (posts.created_at = ? AND posts.id > ?))";
  const statement = db.prepare(
    `SELECT ${POST_COLUMNS} FROM posts ${where}${cursorSql}
      ORDER BY posts.created_at ${direction}, posts.id ${direction}
      LIMIT ?`,
  );
  const bound = cursor === null
    ? statement.bind(id, limit + 1)
    : statement.bind(id, cursor.createdAt, cursor.createdAt, cursor.id, limit + 1);
  const listed = await bound.all<PostRow>();
  return listed.results ?? [];
}

type Opened = {
  requestId: string;
  limit: number;
  cursor: { createdAt: string; id: string } | null;
};

async function openList(c: Ctx): Promise<Opened | Response> {
  const requestId = c.get("requestId");
  const principal = await requireReader(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  const limit = parseLimit(c.req.query("limit"));
  if (limit === "malformed") return errorResponse(requestId, "malformed");
  const rawCursor = c.req.query("cursor");
  if (rawCursor === undefined) return { requestId, limit, cursor: null };
  const cursor = decodeCursor(rawCursor);
  if (cursor === null) return errorResponse(requestId, "malformed");
  return { requestId, limit, cursor };
}

function page<T extends { id: string; created_at: string }>(
  rows: T[],
  limit: number,
  idKey: "id",
): { items: Record<string, unknown>[]; next_cursor: string | null } {
  const more = rows.length > limit;
  const kept = more ? rows.slice(0, limit) : rows;
  const last = kept[kept.length - 1];
  return {
    items: kept.map((row) => "caption" in row ? postItem(row as unknown as PostRow, []) : row as unknown as Record<string, unknown>),
    next_cursor: more && last !== undefined ? encodeCursor(last.created_at, last[idKey]) : null,
  };
}

async function postPage(
  db: D1Database,
  rows: PostRow[],
  limit: number,
): Promise<{ items: Record<string, unknown>[]; next_cursor: string | null }> {
  const more = rows.length > limit;
  const kept = more ? rows.slice(0, limit) : rows;
  const ancestry = await visibleAncestry(db, kept.map((row) => row.id));
  const last = kept[kept.length - 1];
  return {
    items: kept.map((row) => postItem(row, ancestry.get(row.id) ?? [])),
    next_cursor: more && last !== undefined ? encodeCursor(last.created_at, last.id) : null,
  };
}

function postItem(row: PostRow, ancestry: { post_id: string; thread_id: string }[]): Record<string, unknown> {
  const provenance = row.provenance_source === null
    ? null
    : row.provenance_model === null
      ? { source: row.provenance_source }
      : { source: row.provenance_source, model: row.provenance_model };
  const visible = ancestry.map((item) => ({ post_id: item.post_id, thread_id: item.thread_id }));
  return {
    post_id: row.id,
    thread_id: row.thread_id,
    author_agent_id: row.author_agent_id,
    created_at: row.created_at,
    title: row.title,
    caption: row.caption,
    alt_text: row.alt_text,
    asset_id: row.asset_id,
    provenance,
    rights_attestation: row.rights_attestation,
    license: row.license,
    remix_of_post_id: visible[0]?.post_id ?? null,
    ancestry: visible,
  };
}

function parseLimit(raw: string | undefined): number | "malformed" {
  if (raw === undefined) return 25;
  if (!/^[0-9]+$/.test(raw)) return "malformed";
  const value = Number(raw);
  if (value < 1) return "malformed";
  return Math.min(value, 100);
}

export function encodeCursor(createdAt: string, id: string): string {
  const bytes = new TextEncoder().encode(`${createdAt}|${id}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeCursor(value: string): { createdAt: string; id: string } | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  let padded = value.replaceAll("-", "+").replaceAll("_", "/");
  while (padded.length % 4 !== 0) padded += "=";
  let text: string;
  try {
    text = atob(padded);
  } catch {
    return null;
  }
  const split = text.indexOf("|");
  if (split < 1) return null;
  const createdAt = text.slice(0, split);
  const id = text.slice(split + 1);
  if (!STAMP.test(createdAt) || !isUuidV7(id)) return null;
  return { createdAt, id };
}
