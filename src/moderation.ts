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
  if (action.targetType !== "post" || action.action !== "approve") {
    return errorResponse(requestId, "state_conflict");
  }

  const post = await c.env.DB.prepare(
    `SELECT posts.state AS state, threads.state AS thread_state, assets.state AS asset_state
       FROM posts
       JOIN threads ON threads.id = posts.thread_id
       JOIN assets ON assets.id = posts.asset_id
      WHERE posts.id = ?`,
  ).bind(action.targetId).first<{ state: string; thread_state: string; asset_state: string }>();
  if (!post) return errorResponse(requestId, "not_found");
  if (post.state !== "pending_review" || post.thread_state !== "open" || post.asset_state !== "ready") {
    return errorResponse(requestId, "state_conflict");
  }

  const eventId = uuidv7();
  const actionId = uuidv7();
  const occurredAt = utcSeconds();
  // The outbox insert must see pending_review, so it runs before the update.
  // D1 batch() is the transaction that commits the Post and the Event together.
  const guard = `posts.id = ? AND posts.state = 'pending_review'
    AND EXISTS (SELECT 1 FROM threads WHERE threads.id = posts.thread_id AND threads.state = 'open')
    AND EXISTS (SELECT 1 FROM assets WHERE assets.id = posts.asset_id AND assets.state = 'ready')`;
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO events (id, type, resource_id, occurred_at)
       SELECT ?, 'post.published', posts.id, ? FROM posts WHERE ${guard}`,
    ).bind(eventId, occurredAt, action.targetId),
    c.env.DB.prepare(
      `INSERT INTO moderation_actions (
         id, actor_email, target_type, target_id, action, reason_code, private_note, event_id, created_at
       )
       SELECT ?, ?, 'post', posts.id, 'approve', ?, ?, ?, ? FROM posts WHERE ${guard}`,
    ).bind(actionId, principal.email, action.reasonCode, action.privateNote, eventId, occurredAt, action.targetId),
    c.env.DB.prepare(
      `UPDATE posts SET state = 'published'
        WHERE id = ? AND state = 'pending_review'
          AND EXISTS (SELECT 1 FROM threads WHERE threads.id = posts.thread_id AND threads.state = 'open')
          AND EXISTS (SELECT 1 FROM assets WHERE assets.id = posts.asset_id AND assets.state = 'ready')`,
    ).bind(action.targetId),
  ]);
  const published = Number(results[2]?.meta.changes ?? 0) === 1 && Number(results[0]?.meta.changes ?? 0) === 1;
  if (!published) return errorResponse(requestId, "state_conflict");
  console.log(JSON.stringify({ message: "post published", post_id: action.targetId, event_id: eventId }));
  return jsonResponse(requestId, { event_id: eventId, post_id: action.targetId, state: "published" });
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
