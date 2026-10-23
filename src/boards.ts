import { Hono, type Context } from "hono";
import { htmlError, htmlResult } from "./html";
import { characterLength, errorResponse, jsonResponse, type ErrorCode } from "./http";
import { utcSeconds, uuidv7 } from "./ids";
import { sameOrigin } from "./origin";
import { parsePolicy, type Policy } from "./policy";
import { MODERATION_REASONS, canonicalReason } from "./moderation";
import { requireAdmin } from "./principal";

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type Ctx = Context<AppEnv>;

const SLUG = /^[a-z][a-z0-9]{0,19}$/;
const DUPLICATE = "A board with this slug already exists.";

type Failure = { ok: false; code: "malformed" | "validation_failed"; message?: string };

type Parsed = { ok: true; slug: string; name: string; description: string } | Failure;

type ParsedEdit = { ok: true; name?: string; description?: string; state?: BoardState; reasonCode?: string } | Failure;

// A board state change with no reason_code is audited with this fixed reason.
const BOARD_STATE_REASON = "rules";

type BoardState = "open" | "archived";

export type BoardRow = { id: string; slug: string; name: string; description: string; state: BoardState };

const NAME_RULE = "name must be 1 to 60 characters.";
const DESCRIPTION_RULE = "description must be at most 500 characters.";

type ReadResult = { ok: true; value: Record<string, unknown> } | { ok: false };

export function mountBoards(app: Hono<AppEnv>): void {
  app.post("/v1/boards", createJson);
  app.post("/boards", createHtml);
  app.patch("/v1/boards/:id", editJson);
  app.post("/boards/:slug", editHtml);
}

async function createJson(c: Ctx): Promise<Response> {
  const requestId = c.get("requestId");
  const principal = await requireAdmin(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  if (principal.kind !== "admin") return errorResponse(requestId, "forbidden");
  if (!sameOrigin(c.req.raw, c.get("policy").site_origin)) return errorResponse(requestId, "forbidden");
  const body = await readObject(c.req.raw);
  if (!body.ok) return errorResponse(requestId, "malformed");
  const parsed = parseBoardCreate(body.value);
  if (!parsed.ok) return errorResponse(requestId, parsed.code, parsed.message);
  const created = await insertBoard(c.env.DB, principal.email, parsed.slug, parsed.name, parsed.description);
  if (!created.ok) return errorResponse(requestId, "state_conflict", DUPLICATE);
  return jsonResponse(requestId, boardBody(created), 201);
}

async function createHtml(c: Ctx): Promise<Response> {
  const requestId = uuidv7();
  const policy = parsePolicy(typeof c.env.POLICY === "string" ? c.env.POLICY : undefined);
  if (!policy) return htmlError(requestId, "policy_missing", "Boards", "/boards", "Boards");
  const principal = await requireAdmin(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok || principal.kind !== "admin") {
    const code: ErrorCode = principal.ok ? "forbidden" : principal.code;
    return htmlError(requestId, code, "Boards", "/boards", "Boards");
  }
  if (!sameOrigin(c.req.raw, policy.site_origin)) {
    return htmlError(requestId, "forbidden", "Boards", "/boards", "Boards");
  }
  const body = await readForm(c.req.raw);
  if (!body.ok) return htmlError(requestId, "malformed", "Boards", "/boards", "Boards");
  const parsed = parseBoardCreate(body.value);
  if (!parsed.ok) return htmlError(requestId, parsed.code, "Boards", "/boards", "Boards");
  const created = await insertBoard(c.env.DB, principal.email, parsed.slug, parsed.name, parsed.description);
  if (!created.ok) return htmlResult(requestId, "Boards", DUPLICATE, "/boards", "Boards", 409);
  return htmlResult(requestId, "Board added", `${created.name} is open.`, `/boards/${created.slug}`, `/${created.slug}/`, 201);
}

async function editJson(c: Ctx): Promise<Response> {
  const requestId = c.get("requestId");
  const principal = await requireAdmin(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  if (principal.kind !== "admin") return errorResponse(requestId, "forbidden");
  if (!sameOrigin(c.req.raw, c.get("policy").site_origin)) return errorResponse(requestId, "forbidden");
  const board = await c.env.DB.prepare("SELECT id, slug, name, description, state FROM boards WHERE id = ?")
    .bind(c.req.param("id") ?? "").first<BoardRow>();
  if (!board) return errorResponse(requestId, "not_found");
  const body = await readObject(c.req.raw);
  if (!body.ok) return errorResponse(requestId, "malformed");
  const parsed = parseBoardEdit(body.value, false);
  if (!parsed.ok) return errorResponse(requestId, parsed.code, parsed.message);
  return jsonResponse(requestId, boardBody(await updateBoard(c.env.DB, principal.email, board, parsed)));
}

async function editHtml(c: Ctx): Promise<Response> {
  const requestId = uuidv7();
  const slug = c.req.param("slug") ?? "";
  const back = `/boards/${slug}`;
  const label = `/${slug}/`;
  const policy = parsePolicy(typeof c.env.POLICY === "string" ? c.env.POLICY : undefined);
  if (!policy) return htmlError(requestId, "policy_missing", "Board", "/boards", "Boards");
  const principal = await requireAdmin(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok || principal.kind !== "admin") {
    const code: ErrorCode = principal.ok ? "forbidden" : principal.code;
    return htmlError(requestId, code, "Board", "/boards", "Boards");
  }
  if (!sameOrigin(c.req.raw, policy.site_origin)) {
    return htmlError(requestId, "forbidden", "Board", "/boards", "Boards");
  }
  const board = await c.env.DB.prepare("SELECT id, slug, name, description, state FROM boards WHERE slug = ?")
    .bind(slug).first<BoardRow>();
  if (!board) return htmlError(requestId, "not_found", "Board", "/boards", "Boards");
  const body = await readForm(c.req.raw);
  if (!body.ok) return htmlError(requestId, "malformed", "Board", back, label);
  const parsed = parseBoardEdit(body.value, true);
  if (!parsed.ok) {
    if (parsed.message !== undefined) return htmlResult(requestId, "Board", parsed.message, back, label, 422);
    return htmlError(requestId, parsed.code, "Board", back, label);
  }
  const updated = await updateBoard(c.env.DB, principal.email, board, parsed);
  return htmlResult(requestId, "Board updated", `${updated.name} is saved.`, back, label, 200);
}

export function parseBoardCreate(body: Record<string, unknown>): Parsed {
  const keys = Object.keys(body);
  const allowed = keys.every((key) => key === "slug" || key === "name" || key === "description");
  if (!allowed || !keys.includes("slug") || !keys.includes("name")) {
    return { ok: false, code: "malformed" };
  }
  if (typeof body.slug !== "string" || typeof body.name !== "string") {
    return { ok: false, code: "malformed" };
  }
  if (body.description !== undefined && typeof body.description !== "string") {
    return { ok: false, code: "malformed" };
  }
  if (!SLUG.test(body.slug)) {
    return {
      ok: false,
      code: "validation_failed",
      message: "slug must be 1 to 20 lowercase letters and digits, starting with a letter.",
    };
  }
  const name = parseName(body.name);
  if (name === null) return { ok: false, code: "validation_failed", message: NAME_RULE };
  const description = parseDescription(body.description ?? "");
  if (description === null) return { ok: false, code: "validation_failed", message: DESCRIPTION_RULE };
  return { ok: true, slug: body.slug, name, description };
}

// The JSON edit takes name, description, or both, and an Admin may set state (CT-06), with an
// optional reason_code for the audit row. The HTML form always sends name and description.
export function parseBoardEdit(body: Record<string, unknown>, form: boolean): ParsedEdit {
  const keys = Object.keys(body);
  const allowed = new Set(["name", "description", "state", "reason_code"]);
  if (keys.length === 0 || !keys.every((key) => allowed.has(key))) {
    return { ok: false, code: "malformed" };
  }
  if (form && (body.name === undefined || body.description === undefined)) return { ok: false, code: "malformed" };
  if (body.reason_code !== undefined && body.state === undefined) return { ok: false, code: "malformed" };
  const result: { ok: true; name?: string; description?: string; state?: BoardState; reasonCode?: string } = { ok: true };
  if (body.state !== undefined) {
    if (body.state !== "open" && body.state !== "archived") {
      return { ok: false, code: "validation_failed", message: "state must be open or archived." };
    }
    result.state = body.state;
  }
  if (body.reason_code !== undefined && body.reason_code !== "") {
    if (typeof body.reason_code !== "string") return { ok: false, code: "malformed" };
    const reasonCode = canonicalReason(body.reason_code);
    if (!(MODERATION_REASONS as readonly string[]).includes(reasonCode)) {
      return { ok: false, code: "validation_failed", message: "reason_code is not a moderation reason." };
    }
    result.reasonCode = reasonCode;
  }
  if (body.name !== undefined) {
    if (typeof body.name !== "string") return { ok: false, code: "malformed" };
    const name = parseName(body.name);
    if (name === null) return { ok: false, code: "validation_failed", message: NAME_RULE };
    result.name = name;
  }
  if (body.description !== undefined) {
    if (typeof body.description !== "string") return { ok: false, code: "malformed" };
    const description = parseDescription(body.description);
    if (description === null) return { ok: false, code: "validation_failed", message: DESCRIPTION_RULE };
    result.description = description;
  }
  return result;
}

function parseName(raw: string): string | null {
  const name = raw.trim();
  if (characterLength(name) < 1 || characterLength(name) > 60 || hasControl(name)) return null;
  return name;
}

// Line breaks are kept (a textarea sends CRLF). Any other control character is rejected.
function parseDescription(raw: string): string | null {
  const description = raw.replaceAll("\r\n", "\n").trim();
  if (characterLength(description) > 500) return null;
  if (hasControl(description.replaceAll("\n", ""))) return null;
  return description;
}

export async function updateBoard(
  db: D1Database,
  actor: string,
  board: BoardRow,
  edit: { name?: string; description?: string; state?: BoardState; reasonCode?: string },
): Promise<BoardRow> {
  const next: BoardRow = {
    ...board,
    name: edit.name ?? board.name,
    description: edit.description ?? board.description,
    state: edit.state ?? board.state,
  };
  const action = next.state === board.state
    ? "edit_board"
    : next.state === "archived"
      ? "archive_board"
      : "unarchive_board";
  await db.batch([
    db.prepare("UPDATE boards SET name = ?, description = ?, state = ? WHERE id = ?")
      .bind(next.name, next.description, next.state, board.id),
    auditBoard(db, actor, board.id, action, action === "edit_board" ? "rules" : edit.reasonCode ?? BOARD_STATE_REASON),
  ]);
  return next;
}

function boardBody(board: BoardRow): Record<string, string> {
  return { id: board.id, slug: board.slug, name: board.name, description: board.description, state: board.state };
}

function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 0x20) return true;
  }
  return false;
}

// Board writes are Admin-only and audited as Moderation Actions (CT-20).
function auditBoard(
  db: D1Database,
  actor: string,
  boardId: string,
  action: "create_board" | "edit_board" | "archive_board" | "unarchive_board",
  reasonCode = "rules",
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO moderation_actions (
       id, actor_email, target_type, target_id, action, reason_code, private_note, event_id, created_at
     ) VALUES (?, ?, 'board', ?, ?, ?, NULL, NULL, ?)`,
  ).bind(uuidv7(), actor, boardId, action, reasonCode, utcSeconds());
}

export async function insertBoard(
  db: D1Database,
  actor: string,
  slug: string,
  name: string,
  description: string,
): Promise<({ ok: true } & BoardRow) | { ok: false; code: "state_conflict" }> {
  const id = uuidv7();
  try {
    await db.batch([
      db.prepare("INSERT INTO boards (id, slug, name, description) VALUES (?, ?, ?, ?)")
        .bind(id, slug, name, description),
      auditBoard(db, actor, id, "create_board"),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE")) return { ok: false, code: "state_conflict" };
    throw error;
  }
  return { ok: true, id, slug, name, description, state: "open" };
}

async function readObject(request: Request): Promise<ReadResult> {
  const type = request.headers.get("content-type");
  if (type === null || !type.toLowerCase().startsWith("application/json")) return { ok: false };
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false };
  return { ok: true, value: parsed as Record<string, unknown> };
}

async function readForm(request: Request): Promise<ReadResult> {
  const type = request.headers.get("content-type");
  if (type === null || !type.toLowerCase().startsWith("application/x-www-form-urlencoded")) return { ok: false };
  let text: string;
  try {
    text = new TextDecoder().decode(await request.arrayBuffer());
  } catch {
    return { ok: false };
  }
  const params = new URLSearchParams(text);
  const value: Record<string, unknown> = {};
  for (const [key, item] of params.entries()) {
    if (Object.hasOwn(value, key)) return { ok: false };
    value[key] = item;
  }
  return { ok: true, value };
}
