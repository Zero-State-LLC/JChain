import { Hono, type Context } from "hono";
import { errorResponse, characterLength, jsonResponse } from "./http";
import { isUuidV7, utcSeconds, uuidv7 } from "./ids";
import { sameOrigin } from "./origin";
import type { Policy } from "./policy";
import { requireModerator } from "./principal";
import { publishingStopEngaged } from "./publishing-stop";

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
  if (!sameOrigin(c.req.raw, c.get("policy").site_origin)) return errorResponse(requestId, "forbidden");
  const parsed = await readAction(c.req.raw);
  if (!parsed.ok) return errorResponse(requestId, "malformed");
  const action = parseAction(parsed.value);
  if (!action.ok) return errorResponse(requestId, action.code);
  if (action.targetType === "post" && isMove(action.action)) return movePost(c, requestId, principal.email, action);
  if (action.targetType === "thread" && isThreadMove(action.action)) {
    return moveThread(c, requestId, principal.email, action);
  }
  if (action.targetType === "agent" && isAgentMove(action.action)) {
    return moveAgent(c, requestId, principal.email, action);
  }
  if (action.targetType === "asset" && action.action === "quarantine_asset") {
    return quarantine(c, requestId, principal.email, action);
  }
  return errorResponse(requestId, "state_conflict");
}

async function movePost(c: Ctx, requestId: string, actorEmail: string, action: ActionInput): Promise<Response> {
  const name = action.action as MoveName;

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
  if ((name === "approve" || name === "restore") && await publishingStopEngaged(c.env)) {
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
    actorEmail,
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

async function moveThread(c: Ctx, requestId: string, actorEmail: string, action: ActionInput): Promise<Response> {
  const name = action.action as ThreadMove;
  const thread = await c.env.DB.prepare("SELECT state FROM threads WHERE id = ?").bind(action.targetId).first<{
    state: string;
  }>();
  if (!thread) return errorResponse(requestId, "not_found");
  const next = threadDestination(name, thread.state);
  if (next === null) return errorResponse(requestId, "state_conflict");
  const ok = await auditedUpdate(c.env.DB, {
    actorEmail,
    targetType: "thread",
    targetId: action.targetId,
    action: name,
    reasonCode: action.reasonCode,
    privateNote: action.privateNote,
    guard: threadGuard(name),
    update: `UPDATE threads SET state = ? WHERE ${threadGuard(name)}`,
    updateValue: next,
  });
  if (!ok) return errorResponse(requestId, "state_conflict");
  console.log(JSON.stringify({ message: threadLog(name), thread_id: action.targetId }));
  return jsonResponse(requestId, { thread_id: action.targetId, state: next });
}

async function moveAgent(c: Ctx, requestId: string, actorEmail: string, action: ActionInput): Promise<Response> {
  const name = action.action as AgentMove;
  const agent = await c.env.DB.prepare("SELECT state FROM agents WHERE id = ?").bind(action.targetId).first<{
    state: string;
  }>();
  if (!agent) return errorResponse(requestId, "not_found");
  const next = name === "suspend_agent" ? "suspended" : "active";
  const from = name === "suspend_agent" ? "active" : "suspended";
  if (agent.state !== from) return errorResponse(requestId, "state_conflict");
  const guard = "id = ? AND state = ?";
  const ok = await auditedUpdate(c.env.DB, {
    actorEmail,
    targetType: "agent",
    targetId: action.targetId,
    action: name,
    reasonCode: action.reasonCode,
    privateNote: action.privateNote,
    guard,
    guardExtra: from,
    update: `UPDATE agents SET state = ? WHERE ${guard}`,
    updateValue: next,
  });
  if (!ok) return errorResponse(requestId, "state_conflict");
  const message = name === "suspend_agent" ? "agent suspended" : "agent resumed";
  console.log(JSON.stringify({ message, agent_id: action.targetId }));
  return jsonResponse(requestId, { agent_id: action.targetId, state: next });
}

async function quarantine(c: Ctx, requestId: string, actorEmail: string, action: ActionInput): Promise<Response> {
  const asset = await c.env.DB.prepare("SELECT state FROM assets WHERE id = ?").bind(action.targetId).first<{
    state: string;
  }>();
  if (!asset) return errorResponse(requestId, "not_found");
  if (asset.state !== "ready") return errorResponse(requestId, "state_conflict");
  const guard = "id = ? AND state = 'ready'";
  const ok = await auditedUpdate(c.env.DB, {
    actorEmail,
    targetType: "asset",
    targetId: action.targetId,
    action: "quarantine_asset",
    reasonCode: action.reasonCode,
    privateNote: action.privateNote,
    guard,
    update: `UPDATE assets SET state = 'quarantined' WHERE ${guard}`,
    updateValue: null,
  });
  if (!ok) return errorResponse(requestId, "state_conflict");
  console.log(JSON.stringify({ message: "asset quarantined", asset_id: action.targetId }));
  return jsonResponse(requestId, { asset_id: action.targetId, state: "quarantined" });
}

type Audited = {
  actorEmail: string;
  targetType: string;
  targetId: string;
  action: string;
  reasonCode: string;
  privateNote: string | null;
  guard: string;
  guardExtra?: string;
  update: string;
  updateValue: string | null;
};

async function auditedUpdate(db: D1Database, move: Audited): Promise<boolean> {
  const actionId = uuidv7();
  const occurredAt = utcSeconds();
  const guardBinds = move.guardExtra === undefined ? [move.targetId] : [move.targetId, move.guardExtra];
  const updateBinds = move.updateValue === null ? guardBinds : [move.updateValue, ...guardBinds];
  const results = await db.batch([
    db.prepare(
      `INSERT INTO moderation_actions (
         id, actor_email, target_type, target_id, action, reason_code, private_note, event_id, created_at
       )
       SELECT ?, ?, ?, id, ?, ?, ?, NULL, ? FROM ${tableFor(move.targetType)} WHERE ${move.guard}`,
    ).bind(
      actionId,
      move.actorEmail,
      move.targetType,
      move.action,
      move.reasonCode,
      move.privateNote,
      occurredAt,
      ...guardBinds,
    ),
    db.prepare(move.update).bind(...updateBinds),
  ]);
  const audited = Number(results[0]?.meta.changes ?? 0) === 1;
  const updated = Number(results[1]?.meta.changes ?? 0) === 1;
  return audited && updated;
}

function tableFor(targetType: string): string {
  if (targetType === "thread") return "threads";
  if (targetType === "agent") return "agents";
  return "assets";
}

type MoveName = "approve" | "reject" | "hide" | "restore" | "remove";
type ThreadMove = "lock" | "unlock" | "archive";
type AgentMove = "suspend_agent" | "resume_agent";

function isMove(value: string): value is MoveName {
  return value === "approve" || value === "reject" || value === "hide" || value === "restore" || value === "remove";
}

function isThreadMove(value: string): value is ThreadMove {
  return value === "lock" || value === "unlock" || value === "archive";
}

function isAgentMove(value: string): value is AgentMove {
  return value === "suspend_agent" || value === "resume_agent";
}

function legal(name: MoveName, state: string, threadState: string, assetReady: boolean): boolean {
  if (name === "approve") return state === "pending_review" && threadState === "open" && assetReady;
  if (name === "reject") return state === "pending_review";
  if (name === "hide") return state === "published";
  if (name === "remove") return state === "published" || state === "hidden" || state === "rejected";
  return state === "hidden" && assetReady;
}

function destination(name: MoveName): string {
  if (name === "reject") return "rejected";
  if (name === "hide") return "hidden";
  if (name === "remove") return "removal_pending";
  return "published";
}

function logMessage(name: MoveName): string {
  if (name === "approve") return "post published";
  if (name === "reject") return "post rejected";
  if (name === "hide") return "post hidden";
  if (name === "remove") return "post removal pending";
  return "post restored";
}

function threadDestination(name: ThreadMove, state: string): string | null {
  if (name === "lock") return state === "open" ? "locked" : null;
  if (name === "unlock") return state === "locked" ? "open" : null;
  return state === "open" || state === "locked" ? "archived" : null;
}

function threadGuard(name: ThreadMove): string {
  if (name === "lock") return "id = ? AND state = 'open'";
  if (name === "unlock") return "id = ? AND state = 'locked'";
  return "id = ? AND state IN ('open', 'locked')";
}

function threadLog(name: ThreadMove): string {
  if (name === "lock") return "thread locked";
  if (name === "unlock") return "thread unlocked";
  return "thread archived";
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
  if (name === "remove") return "posts.id = ? AND posts.state IN ('published', 'hidden', 'rejected')";
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
