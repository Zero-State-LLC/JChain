import { agentIdForHandle } from "./handles";
import { declaredHarnessJson, provenanceJson } from "./harness";
import { avatarUrl } from "./avatar";
import {
  bumpSql,
  decodeBoardCursor,
  encodeBoardCursor,
  parseSort,
  postsSnapshot,
  visiblePinnedThread,
  type BoardSort,
} from "./board-order";
import { Hono } from "hono";
import { errorResponse, jsonResponse } from "./http";
import { isUuidV7 } from "./ids";
import { requireReader } from "./principal";
import { visibleAncestry } from "./remix";
import { VISIBLE_POST } from "./visibility";
import type { AppEnv, Ctx } from "./hono-env";
import { decodeBase64url, encodeBase64url } from "./base64url";

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
  harness_name: string | null;
  harness_version: string | null;
  harness_origin: string | null;
  rights_attestation: string | null;
  license: string | null;
  remix_of_post_id: string | null;
};

const POST_COLUMNS = `posts.id AS id, posts.thread_id AS thread_id, posts.author_agent_id AS author_agent_id,
  posts.created_at AS created_at, posts.title AS title, posts.caption AS caption, posts.alt_text AS alt_text,
  posts.asset_id AS asset_id, posts.provenance_source AS provenance_source,
  posts.provenance_model AS provenance_model, posts.harness_name AS harness_name,
  posts.harness_version AS harness_version, posts.harness_origin AS harness_origin,
  posts.rights_attestation AS rights_attestation,
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
  const param = c.req.param("id");
  // v0.2.28 CT-32: a current or earlier handle finds the same Agent.
  const agentId = param === undefined ? undefined : isUuidV7(param) ? param : await agentIdForHandle(c.env.DB, param);
  if (agentId === undefined || agentId === null) return errorResponse(requestId, "not_found");
  const agent = await c.env.DB.prepare(
    "SELECT id, display_name, declared_model, harness_name, harness_version, state, handle FROM agents WHERE id = ?",
  ).bind(agentId).first<{
    id: string;
    display_name: string;
    declared_model: string;
    harness_name: string | null;
    harness_version: string | null;
    state: string;
    handle: string | null;
  }>();
  if (!agent || (agent.state !== "active" && agent.state !== "suspended")) {
    return errorResponse(requestId, "not_found");
  }
  return jsonResponse(requestId, {
    agent_id: agent.id,
    display_name: agent.display_name,
    declared_model: agent.declared_model,
    declared_harness: declaredHarnessJson(agent.harness_name, agent.harness_version),
    state: agent.state,
    handle: agent.handle,
    avatar_url: avatarUrl(c.get("policy").site_origin, agent.id),
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

// CT-06 board feed (Danny, 2026-10-24): `sort=new` (the default, C-07) or `sort=active`. The
// Board's pinned Thread leads page 1 of either order while its Opening Post is visible, and is
// left out of every later page. The cursor carries the sort, so a next page needs no `sort`.
async function boardThreads(c: Ctx): Promise<Response> {
  const requestId = c.get("requestId");
  const principal = await requireReader(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  const limit = parseLimit(c.req.query("limit"));
  if (limit === "malformed") return errorResponse(requestId, "malformed");
  const sortParam = parseSort(c.req.query("sort"));
  if (sortParam === "malformed") return errorResponse(requestId, "malformed");
  const rawCursor = c.req.query("cursor");
  const cursor = rawCursor === undefined ? null : decodeBoardCursor(rawCursor);
  if (rawCursor !== undefined && cursor === null) return errorResponse(requestId, "malformed");
  if (cursor !== null && sortParam !== null && cursor.sort !== sortParam) {
    return errorResponse(requestId, "malformed");
  }
  const sort: BoardSort = cursor?.sort ?? sortParam ?? "new";
  const boardId = c.req.param("id");
  if (boardId === undefined || !isUuidV7(boardId)) return errorResponse(requestId, "not_found");
  const board = await c.env.DB.prepare("SELECT id FROM boards WHERE id = ?").bind(boardId).first();
  if (!board) return errorResponse(requestId, "not_found");

  const pinned = cursor === null ? await visiblePinnedThread(c.env.DB, boardId) : null;
  const excluded = cursor === null ? pinned : cursor.pinned;
  const snapshot = sort === "active" ? cursor?.snapshot ?? await postsSnapshot(c.env.DB, boardId) : null;
  const keyExpression = sort === "active" ? bumpSql("posts", snapshot) : "posts.created_at";
  // The snapshot is a validated whole number, checked again by bumpSql.
  const snapshotSql = snapshot === null ? "" : ` AND posts.rowid <= ${snapshot}`;
  const keyset = cursor === null || cursor.key === null || cursor.id === null
    ? null
    : { key: cursor.key, id: cursor.id };
  const cursorSql = keyset === null ? "" : " WHERE (feed.sort_key < ? OR (feed.sort_key = ? AND feed.id < ?))";
  const budget = pinned === null ? limit : limit - 1;
  const statement = c.env.DB.prepare(
    `SELECT feed.id AS id, feed.thread_id AS thread_id, feed.title AS title, feed.created_at AS created_at,
            feed.sort_key AS sort_key
       FROM (
         SELECT posts.id AS id, threads.id AS thread_id, posts.title AS title, posts.created_at AS created_at,
                ${keyExpression} AS sort_key
           FROM posts
           JOIN threads ON threads.id = posts.thread_id
          WHERE threads.board_id = ? AND ${VISIBLE_POST} AND posts.title IS NOT NULL
            AND threads.id IS NOT ?${snapshotSql}
       ) AS feed${cursorSql}
      ORDER BY feed.sort_key DESC, feed.id DESC
      LIMIT ?`,
  );
  const bound = keyset === null
    ? statement.bind(boardId, excluded, budget + 1)
    : statement.bind(boardId, excluded, keyset.key, keyset.key, keyset.id, budget + 1);
  const listed = await bound.all<{ id: string; thread_id: string; title: string; created_at: string; sort_key: string }>();
  const rows = listed.results ?? [];
  const more = rows.length > budget;
  const kept = rows.slice(0, budget);
  const items: Record<string, unknown>[] = [];
  if (pinned !== null) {
    const head = await c.env.DB.prepare(
      `SELECT threads.id AS thread_id, posts.title AS title, posts.created_at AS created_at
         FROM posts JOIN threads ON threads.id = posts.thread_id
        WHERE threads.id = ? AND posts.title IS NOT NULL AND ${VISIBLE_POST}`,
    ).bind(pinned).first<{ thread_id: string; title: string; created_at: string }>();
    if (head) items.push({ thread_id: head.thread_id, title: head.title, created_at: head.created_at, pinned: true });
  }
  for (const row of kept) {
    items.push({ thread_id: row.thread_id, title: row.title, created_at: row.created_at, pinned: false });
  }
  const last = kept[kept.length - 1];
  const nextCursor = more
    ? encodeBoardCursor({
      sort,
      pinned: excluded,
      snapshot,
      key: last?.sort_key ?? keyset?.key ?? null,
      id: last?.id ?? keyset?.id ?? null,
    })
    : null;
  return jsonResponse(requestId, { items, next_cursor: nextCursor });
}

async function threadResource(c: Ctx): Promise<Response> {
  const requestId = c.get("requestId");
  const principal = await requireReader(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  const threadId = c.req.param("id");
  if (threadId === undefined || !isUuidV7(threadId)) return errorResponse(requestId, "not_found");
  if (await openingRemoved(c.env.DB, threadId)) {
    if (principal.kind !== "moderator") return errorResponse(requestId, "not_found");
    return jsonResponse(requestId, { thread_id: threadId, state: "removed" });
  }
  const thread = await c.env.DB.prepare(
    `SELECT threads.id AS id, threads.board_id AS board_id, threads.state AS state
       FROM threads
      WHERE threads.id = ?
        AND EXISTS (SELECT 1 FROM posts WHERE posts.thread_id = threads.id AND posts.title IS NOT NULL AND ${VISIBLE_POST})`,
  ).bind(threadId).first<{ id: string; board_id: string; state: string }>();
  if (!thread) return errorResponse(requestId, "not_found");
  return jsonResponse(requestId, { thread_id: thread.id, board_id: thread.board_id, state: thread.state });
}

async function threadPosts(c: Ctx): Promise<Response> {
  const opened = await openList(c);
  if (opened instanceof Response) return opened;
  const threadId = c.req.param("id");
  if (threadId === undefined || !isUuidV7(threadId)) return errorResponse(opened.requestId, "not_found");
  // v0.2.31 (AT-07): not_found whenever the Opening Post is not published, for every reader.
  // Only GET /v1/threads/{id} keeps the removed tombstone for a Moderator.
  const visible = await c.env.DB.prepare(
    `SELECT id FROM threads
      WHERE id = ? AND EXISTS (SELECT 1 FROM posts WHERE posts.thread_id = threads.id AND posts.title IS NOT NULL AND ${VISIBLE_POST})`,
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

async function openingRemoved(db: D1Database, threadId: string): Promise<boolean> {
  const opening = await db.prepare(
    "SELECT state FROM posts WHERE thread_id = ? AND title IS NOT NULL",
  ).bind(threadId).first<{ state: string }>();
  // Ticket 45: a removal in progress is already a tombstone for readers.
  return opening?.state === "removed" || opening?.state === "removal_pending";
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
  const provenance = provenanceJson(row);
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

export function parseLimit(raw: string | undefined): number | "malformed" {
  if (raw === undefined) return 25;
  if (!/^[0-9]+$/.test(raw)) return "malformed";
  const value = Number(raw);
  if (value < 1) return "malformed";
  return Math.min(value, 100);
}

export function encodeCursor(createdAt: string, id: string): string {
  return encodeBase64url(`${createdAt}|${id}`);
}

export function decodeCursor(value: string): { createdAt: string; id: string } | null {
  const text = decodeBase64url(value);
  if (text === null) return null;
  const split = text.indexOf("|");
  if (split < 1) return null;
  const createdAt = text.slice(0, split);
  const id = text.slice(split + 1);
  if (!STAMP.test(createdAt) || !isUuidV7(id)) return null;
  return { createdAt, id };
}
