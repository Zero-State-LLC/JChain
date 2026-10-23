import { Hono, type Context } from "hono";
import { errorResponse, jsonResponse } from "./http";
import { isUuidV7, utcSeconds, uuidv7 } from "./ids";
import { sameOrigin } from "./origin";
import type { Policy } from "./policy";
import { requireModerator } from "./principal";
import { visibleAncestry } from "./remix";
import { VISIBLE_POST } from "./visibility";

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type App = Hono<AppEnv>;
type Ctx = Context<AppEnv>;

const SCHEMA_VERSION = 1;
const PAGE = 100;
const INSERT_BATCH = 30;
// D1 allows 100 bound parameters per statement.
const ID_BATCH = 80;
// A Post under legal hold (C-13 item 5) is never exported, whatever its state.
const EXPORTABLE_POST = `${VISIBLE_POST} AND posts.legal_hold = 0`;
// An export runs inside the request. Above this many Posts on the Board it is state_conflict.
export const EXPORT_MAX_POSTS = 5000;

type Purpose = "archive" | "training";

type PostRow = {
  id: string;
  thread_id: string;
  author_agent_id: string;
  asset_id: string | null;
  title: string | null;
  caption: string;
  alt_text: string | null;
  provenance_source: string | null;
  provenance_model: string | null;
  rights_attestation: string | null;
  license: string | null;
  created_at: string;
};

export function mountExports(app: App): void {
  app.post("/v1/exports", createExport);
  app.get("/v1/exports/:id", readExport);
}

async function createExport(c: Ctx): Promise<Response> {
  const allowed = await gate(c, true);
  if (allowed instanceof Response) return allowed;
  const requestId = c.get("requestId");
  const parsed = await readObject(c.req.raw);
  if (!parsed.ok) return errorResponse(requestId, "malformed");
  const request = exportRequest(parsed.value);
  if (request === "malformed") return errorResponse(requestId, "malformed");
  if (!isUuidV7(request.boardId)) return errorResponse(requestId, "not_found");
  const board = await c.env.DB.prepare("SELECT id FROM boards WHERE id = ?").bind(request.boardId).first();
  if (!board) return errorResponse(requestId, "not_found");
  if (request.purpose === "training" && !c.get("policy").training_export_approved) {
    return errorResponse(requestId, "training_export_blocked");
  }

  const size = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM posts JOIN threads ON threads.id = posts.thread_id WHERE threads.board_id = ?",
  ).bind(request.boardId).first<{ n: number }>();
  if (Number(size?.n ?? 0) > EXPORT_MAX_POSTS) {
    return errorResponse(requestId, "state_conflict", `This board has more than ${EXPORT_MAX_POSTS} Posts, the most an export runs in one request.`);
  }
  const rows = await visiblePosts(c.env.DB, request.boardId);
  const ancestry = await visibleAncestry(c.env.DB, rows.map((row) => row.id));
  const exportedAt = utcSeconds();
  const exportId = uuidv7();
  const header = {
    schema_version: SCHEMA_VERSION,
    exported_at: exportedAt,
    purpose: request.purpose,
  };
  const posts = rows.map((row) => postDocument(row, ancestry.get(row.id) ?? []));
  await storeExport(c.env.DB, exportId, request.boardId, request.purpose, exportedAt, header, posts);
  console.log(JSON.stringify({
    message: "export created",
    export_id: exportId,
    board_id: request.boardId,
    purpose: request.purpose,
  }));
  return jsonResponse(requestId, { export_id: exportId }, 201);
}

async function readExport(c: Ctx): Promise<Response> {
  const allowed = await gate(c, false);
  if (allowed instanceof Response) return allowed;
  const requestId = c.get("requestId");
  const exportId = c.req.param("id");
  if (exportId === undefined || !isUuidV7(exportId)) return errorResponse(requestId, "not_found");
  const row = await c.env.DB.prepare(
    "SELECT document FROM exports WHERE id = ?",
  ).bind(exportId).first<{ document: string }>();
  if (!row) return errorResponse(requestId, "not_found");
  const header = JSON.parse(row.document) as Record<string, unknown>;
  const posts = await stillVisible(c.env.DB, await storedPosts(c.env.DB, exportId));
  return jsonResponse(requestId, { ...header, posts });
}

async function storeExport(
  db: D1Database,
  exportId: string,
  boardId: string,
  purpose: Purpose,
  exportedAt: string,
  header: { schema_version: number; exported_at: string; purpose: Purpose },
  posts: Record<string, unknown>[],
): Promise<void> {
  const statements = [
    db.prepare(
      `INSERT INTO exports (id, board_id, purpose, schema_version, exported_at, document)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(exportId, boardId, purpose, SCHEMA_VERSION, exportedAt, JSON.stringify(header)),
  ];
  for (let start = 0; start < posts.length; start += INSERT_BATCH) {
    const slice = posts.slice(start, start + INSERT_BATCH);
    const values = slice.map(() => "(?, ?, ?)").join(", ");
    const binds: (string | number)[] = [];
    slice.forEach((post, index) => {
      binds.push(exportId, start + index, JSON.stringify(post));
    });
    statements.push(db.prepare(
      `INSERT INTO export_posts (export_id, ordinal, document) VALUES ${values}`,
    ).bind(...binds));
  }
  await db.batch(statements);
}

async function storedPosts(db: D1Database, exportId: string): Promise<Record<string, unknown>[]> {
  const posts: Record<string, unknown>[] = [];
  let after = -1;
  for (;;) {
    const listed = await db.prepare(
      `SELECT ordinal, document
         FROM export_posts
        WHERE export_id = ? AND ordinal > ?
        ORDER BY ordinal ASC
        LIMIT ?`,
    ).bind(exportId, after, PAGE).all<{ ordinal: number; document: string }>();
    const page = listed.results ?? [];
    for (const row of page) posts.push(JSON.parse(row.document) as Record<string, unknown>);
    const last = page[page.length - 1];
    if (page.length < PAGE || last === undefined) return posts;
    after = last.ordinal;
  }
}

// An export is a stored snapshot, but every read goes through the Visibility Projection again:
// a Post hidden, removed, owner-deleted, or put under legal hold since the export drops out,
// and remix_of_post_id names the nearest ancestor that is still visible.
async function stillVisible(
  db: D1Database,
  posts: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const ids = [...new Set(posts.map((post) => post.post_id).filter((id): id is string => typeof id === "string"))];
  const visible = new Set<string>();
  for (let start = 0; start < ids.length; start += ID_BATCH) {
    const batch = ids.slice(start, start + ID_BATCH);
    const placeholders = batch.map(() => "?").join(", ");
    const listed = await db.prepare(
      `SELECT posts.id AS id FROM posts WHERE posts.id IN (${placeholders}) AND ${EXPORTABLE_POST}`,
    ).bind(...batch).all<{ id: string }>();
    for (const found of listed.results ?? []) visible.add(found.id);
  }
  const kept = posts.filter((post) => typeof post.post_id === "string" && visible.has(post.post_id));
  const ancestry = await visibleAncestry(db, kept.map((post) => String(post.post_id)));
  return kept.map((post) => ({
    ...post,
    remix_of_post_id: ancestry.get(String(post.post_id))?.[0]?.post_id ?? null,
  }));
}

async function visiblePosts(db: D1Database, boardId: string): Promise<PostRow[]> {
  const rows: PostRow[] = [];
  let cursor: { createdAt: string; id: string } | null = null;
  for (;;) {
    const page = await postPage(db, boardId, cursor);
    rows.push(...page);
    const last = page[page.length - 1];
    if (page.length < PAGE || last === undefined) return rows;
    cursor = { createdAt: last.created_at, id: last.id };
  }
}

async function postPage(
  db: D1Database,
  boardId: string,
  cursor: { createdAt: string; id: string } | null,
): Promise<PostRow[]> {
  const cursorSql = cursor === null
    ? ""
    : " AND (posts.created_at > ? OR (posts.created_at = ? AND posts.id > ?))";
  const statement = db.prepare(
    `SELECT posts.id AS id, posts.thread_id AS thread_id, posts.author_agent_id AS author_agent_id,
            posts.asset_id AS asset_id, posts.title AS title, posts.caption AS caption,
            posts.alt_text AS alt_text, posts.provenance_source AS provenance_source,
            posts.provenance_model AS provenance_model, posts.rights_attestation AS rights_attestation,
            posts.license AS license, posts.created_at AS created_at
       FROM posts
       JOIN threads ON threads.id = posts.thread_id
      WHERE threads.board_id = ? AND ${EXPORTABLE_POST}${cursorSql}
      ORDER BY posts.created_at ASC, posts.id ASC
      LIMIT ?`,
  );
  const bound = cursor === null
    ? statement.bind(boardId, PAGE)
    : statement.bind(boardId, cursor.createdAt, cursor.createdAt, cursor.id, PAGE);
  const listed = await bound.all<PostRow>();
  return listed.results ?? [];
}

function postDocument(
  row: PostRow,
  ancestry: { post_id: string }[],
): Record<string, unknown> {
  const provenance = row.provenance_source === null
    ? null
    : row.provenance_model === null
      ? { source: row.provenance_source }
      : { source: row.provenance_source, model: row.provenance_model };
  return {
    post_id: row.id,
    thread_id: row.thread_id,
    author_agent_id: row.author_agent_id,
    asset_id: row.asset_id,
    created_at: row.created_at,
    title: row.title,
    caption: row.caption,
    alt_text: row.alt_text,
    provenance,
    rights_attestation: row.rights_attestation,
    license: row.license,
    remix_of_post_id: ancestry[0]?.post_id ?? null,
  };
}

async function gate(c: Ctx, write: boolean): Promise<true | Response> {
  const requestId = c.get("requestId");
  const moderator = await requireModerator(c.env, c.req.raw, c.executionCtx);
  if (!moderator.ok) return errorResponse(requestId, moderator.code);
  if (moderator.kind !== "moderator") return errorResponse(requestId, "forbidden");
  if (write && !sameOrigin(c.req.raw, c.get("policy").site_origin)) {
    return errorResponse(requestId, "forbidden");
  }
  return true;
}

function exportRequest(body: Record<string, unknown>): { boardId: string; purpose: Purpose } | "malformed" {
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes("board_id") || !keys.includes("purpose")) return "malformed";
  if (typeof body.board_id !== "string") return "malformed";
  if (body.purpose !== "archive" && body.purpose !== "training") return "malformed";
  return { boardId: body.board_id, purpose: body.purpose };
}

async function readObject(request: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false };
  return { ok: true, value: parsed as Record<string, unknown> };
}
