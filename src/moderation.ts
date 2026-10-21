import { Hono, type Context } from "hono";
import { errorResponse, characterLength, jsonResponse } from "./http";
import { isUuidV7, utcSeconds, uuidv7 } from "./ids";
import type { Policy } from "./policy";
import { requireModerator } from "./principal";

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type Ctx = Context<AppEnv>;

const REASONS = [
  "spam",
  "harassment",
  "sexual-content",
  "real-person-likeness",
  "private-data",
  "prompt-injection",
  "rules",
  "other",
] as const;

export function mountModeration(app: Hono<AppEnv>): void {
  app.post("/v1/moderation/actions", moderate);
}

async function moderate(c: Ctx): Promise<Response> {
  const requestId = c.get("requestId");
  const principal = await requireModerator(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  if (principal.kind !== "moderator") return errorResponse(requestId, "forbidden");
  const parsed = await readAction(c.req.raw);
  if (!parsed.ok) return errorResponse(requestId, "malformed");
  const action = parseAction(parsed.value);
  if (!action.ok) return errorResponse(requestId, action.code);
  if (action.targetType !== "post" || !isMove(action.action)) {
    return errorResponse(requestId, "state_conflict");
  }
  const name = action.action;

  const post = await c.env.DB.prepare(
    `SELECT posts.state AS state, threads.state AS thread_state,
            posts.asset_id AS asset_id, assets.state AS asset_state
       FROM posts
       JOIN threads ON threads.id = posts.thread_id
       LEFT JOIN assets ON assets.id = posts.asset_id
      WHERE posts.id = ?`,
  ).bind(action.targetId).first<{
    state: string;
    thread_state: string;
    asset_id: string | null;
    asset_state: string | null;
  }>();
  if (!post) return errorResponse(requestId, "not_found");
  const assetReady = post.asset_id === null || post.asset_state === "ready";
  if (!legal(name, post.state, post.thread_state, assetReady)) {
    return errorResponse(requestId, "state_conflict");
  }

  const occurredAt = utcSeconds();
  const actionId = uuidv7();
  // events_one_per_resource allows one post.published per Post. Restore keeps that
  // row. Hide does not write post.withdrawn; that event arrives in a later ticket.
  let eventId: string | null = null;
  if (name === "approve") eventId = uuidv7();
  if (name === "restore") {
    const existing = await c.env.DB.prepare(
      "SELECT id FROM events WHERE type = 'post.published' AND resource_id = ?",
    ).bind(action.targetId).first<{ id: string }>();
    eventId = existing?.id ?? null;
  }

  const where = guard(name);
  const statements: D1PreparedStatement[] = [];
  if (name === "approve" && eventId !== null) {
    statements.push(c.env.DB.prepare(
      `INSERT INTO events (id, type, resource_id, occurred_at)
       SELECT ?, 'post.published', posts.id, ? FROM posts WHERE ${where}`,
    ).bind(eventId, occurredAt, action.targetId));
  }
  statements.push(c.env.DB.prepare(
    `INSERT INTO moderation_actions (
       id, actor_email, target_type, target_id, action, reason_code, private_note, event_id, created_at
     )
     SELECT ?, ?, 'post', posts.id, ?, ?, ?, ?, ? FROM posts WHERE ${where}`,
  ).bind(
    actionId,
    principal.email,
    name,
    action.reasonCode,
    action.privateNote,
    eventId,
    occurredAt,
    action.targetId,
  ));
  statements.push(c.env.DB.prepare(
    `UPDATE posts SET state = ? WHERE ${where}`,
  ).bind(destination(name), action.targetId));
  const results = await c.env.DB.batch(statements);
  const updated = Number(results[results.length - 1]?.meta.changes ?? 0) === 1;
  const audited = Number(results[results.length - 2]?.meta.changes ?? 0) === 1;
  const recorded = name !== "approve" || Number(results[0]?.meta.changes ?? 0) === 1;
  if (!updated || !audited || !recorded) return errorResponse(requestId, "state_conflict");
  const entry: Record<string, string> = { message: logMessage(name), post_id: action.targetId };
  if (eventId !== null) entry.event_id = eventId;
  console.log(JSON.stringify(entry));
  const body: Record<string, unknown> = { post_id: action.targetId, state: destination(name) };
  if (eventId !== null) body.event_id = eventId;
  return jsonResponse(requestId, body);
}

type MoveName = "approve" | "reject" | "hide" | "restore";

function isMove(value: string): value is MoveName {
  return value === "approve" || value === "reject" || value === "hide" || value === "restore";
}

function legal(name: MoveName, state: string, threadState: string, assetReady: boolean): boolean {
  if (name === "approve") return state === "pending_review" && threadState === "open" && assetReady;
  if (name === "reject") return state === "pending_review";
  if (name === "hide") return state === "published";
  return state === "hidden" && assetReady;
}

function destination(name: MoveName): string {
  if (name === "reject") return "rejected";
  if (name === "hide") return "hidden";
  return "published";
}

function logMessage(name: MoveName): string {
  if (name === "approve") return "post published";
  if (name === "reject") return "post rejected";
  if (name === "hide") return "post hidden";
  return "post restored";
}

function guard(name: MoveName): string {
  if (name === "approve") {
    return `posts.id = ? AND posts.state = 'pending_review'
    AND EXISTS (SELECT 1 FROM threads WHERE threads.id = posts.thread_id AND threads.state = 'open')
    AND (posts.asset_id IS NULL OR EXISTS (
      SELECT 1 FROM assets WHERE assets.id = posts.asset_id AND assets.state = 'ready'
    ))`;
  }
  if (name === "restore") {
    return `posts.id = ? AND posts.state = 'hidden'
    AND (posts.asset_id IS NULL OR EXISTS (
      SELECT 1 FROM assets WHERE assets.id = posts.asset_id AND assets.state = 'ready'
    ))`;
  }
  if (name === "hide") return "posts.id = ? AND posts.state = 'published'";
  return "posts.id = ? AND posts.state = 'pending_review'";
}

type ActionInput = {
  targetType: string;
  targetId: string;
  action: string;
  reasonCode: string;
  privateNote: string | null;
};

function parseAction(
  body: Record<string, unknown>,
): { ok: true } & ActionInput | { ok: false; code: "malformed" | "validation_failed" } {
  const allowed = new Set(["target_type", "target_id", "action", "reason_code", "private_note"]);
  if (!Object.keys(body).every((key) => allowed.has(key))) return { ok: false, code: "malformed" };
  if (!["target_type", "target_id", "action", "reason_code"].every((key) => Object.hasOwn(body, key))) {
    return { ok: false, code: "malformed" };
  }
  if (
    typeof body.target_type !== "string"
    || typeof body.target_id !== "string"
    || typeof body.action !== "string"
    || typeof body.reason_code !== "string"
  ) {
    return { ok: false, code: "malformed" };
  }
  if (!isUuidV7(body.target_id)) return { ok: false, code: "malformed" };
  if (!(REASONS as readonly string[]).includes(body.reason_code)) return { ok: false, code: "validation_failed" };
  let privateNote: string | null = null;
  if (Object.hasOwn(body, "private_note")) {
    if (typeof body.private_note !== "string") return { ok: false, code: "malformed" };
    if (characterLength(body.private_note) > 2000) return { ok: false, code: "validation_failed" };
    privateNote = body.private_note;
  }
  return {
    ok: true,
    targetType: body.target_type,
    targetId: body.target_id,
    action: body.action,
    reasonCode: body.reason_code,
    privateNote,
  };
}

async function readAction(request: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  const type = request.headers.get("content-type");
  if (type === null) return { ok: false };
  const lower = type.toLowerCase();
  if (lower.startsWith("application/json")) return readObject(request);
  if (lower.startsWith("application/x-www-form-urlencoded")) return readForm(request);
  return { ok: false };
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

async function readForm(request: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
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
