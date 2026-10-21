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

  const rows = await visiblePosts(c.env.DB, request.boardId);
  const ancestry = await visibleAncestry(c.env.DB, rows.map((row) => row.id));
  const exportedAt = utcSeconds();
  const exportId = uuidv7();
  const document = {
    schema_version: SCHEMA_VERSION,
    exported_at: exportedAt,
    purpose: request.purpose,
    posts: rows.map((row) => postDocument(row, ancestry.get(row.id) ?? [])),
  };
  await c.env.DB.prepare(
    `INSERT INTO exports (id, board_id, purpose, schema_version, exported_at, document)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(exportId, request.boardId, request.purpose, SCHEMA_VERSION, exportedAt, JSON.stringify(document)).run();
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
  const document = JSON.parse(row.document) as Record<string, unknown>;
  return jsonResponse(requestId, document);
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
      WHERE threads.board_id = ? AND ${VISIBLE_POST}${cursorSql}
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
