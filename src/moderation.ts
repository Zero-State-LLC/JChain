import { Hono, type Context } from "hono";
import { blockAssetHashes } from "./blocked-hashes";
import { htmlError, htmlResult } from "./html";
import { errorResponse, characterLength, jsonResponse, type ErrorCode } from "./http";
import { isUuidV7, utcSeconds, uuidv7 } from "./ids";
import { sameOrigin } from "./origin";
import { parsePolicy, type Policy } from "./policy";
import { requireModerator } from "./principal";
import { publishingStopEngaged } from "./publishing-stop";
import { settleSeatFlags } from "./seats";

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type Ctx = Context<AppEnv>;

export const MODERATION_REASONS = [
  "spam",
  "harassment",
  "sexual-content",
  "real-person-likeness",
  "private-data",
  "prompt-injection",
  "rules",
  "other",
  "id-document",
  "csam",
] as const;

const REASONS = MODERATION_REASONS;

const PROHIBITED_REASONS = new Set([
  "identification-document",
  "child-sexual-abuse-material",
  "id-document",
  "csam",
]);

type Format = "json" | "html";

export function mountModeration(app: Hono<AppEnv>): void {
  app.post("/v1/moderation/actions", (c) => moderate(c, "json"));
  app.post("/moderation/actions", (c) => moderate(c, "html"));
}

function moderationError(requestId: string, format: Format, code: ErrorCode): Response {
  if (format === "json") return errorResponse(requestId, code);
  return htmlError(requestId, code, "Moderation", "/moderation", "Moderation");
}

function moderationDone(
  requestId: string,
  format: Format,
  body: Record<string, unknown>,
  sentence: string,
): Response {
  if (format === "json") return jsonResponse(requestId, body);
  return htmlResult(requestId, "Moderation", sentence, "/moderation", "Moderation", 200);
}

async function moderate(c: Ctx, format: Format): Promise<Response> {
  const requestId = c.get("requestId") || uuidv7();
  const policy = c.get("policy") ?? parsePolicy(typeof c.env.POLICY === "string" ? c.env.POLICY : undefined);
  if (!policy) return moderationError(requestId, format, "policy_missing");
  const principal = await requireModerator(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return moderationError(requestId, format, principal.code);
  if (principal.kind !== "moderator") return moderationError(requestId, format, "forbidden");
  if (!sameOrigin(c.req.raw, policy.site_origin)) return moderationError(requestId, format, "forbidden");
  const parsed = await readAction(c.req.raw);
  if (!parsed.ok) return moderationError(requestId, format, "malformed");
  const action = parseAction(parsed.value);
  if (!action.ok) return moderationError(requestId, format, action.code);
  if (action.targetType === "post" && isMove(action.action)) {
    return movePost(c, requestId, principal.email, action, format);
  }
  if (action.targetType === "thread" && isThreadMove(action.action)) {
    return moveThread(c, requestId, principal.email, action, format);
  }
  if (action.targetType === "agent" && isAgentMove(action.action)) {
    return moveAgent(c, requestId, principal.email, action, format);
  }
  if (action.targetType === "agent" && action.action === "revoke_handle") {
    return revokeHandle(c, requestId, principal.email, action, format);
  }
  if (action.targetType === "asset" && action.action === "quarantine_asset") {
    return quarantine(c, requestId, principal.email, action, format);
  }
  return moderationError(requestId, format, "state_conflict");
}

async function movePost(
  c: Ctx,
  requestId: string,
  actorEmail: string,
  action: ActionInput,
  format: Format,
): Promise<Response> {
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
  if (!post) return moderationError(requestId, format, "not_found");
  const assetReady = post.asset_id === null || post.asset_state === "ready";
  if (!legal(name, post.state, post.thread_state, assetReady)) {
    return moderationError(requestId, format, "state_conflict");
  }
  if ((name === "approve" || name === "restore") && await publishingStopEngaged(c.env)) {
    return moderationError(requestId, format, "state_conflict");
  }

  const occurredAt = utcSeconds();
  const actionId = uuidv7();
  // One post.published and one post.withdrawn per Post. Restore keeps the publication
  // row and deletes the withdrawal so a later hide can insert it again.
  const fromFlagged = post.state === "flagged";
  let publishedEventId: string | null = null;
  if (name === "approve" && !fromFlagged) publishedEventId = uuidv7();
  if (name === "restore" || (name === "approve" && fromFlagged)) {
    const existing = await c.env.DB.prepare(
      "SELECT id FROM events WHERE type = 'post.published' AND resource_id = ?",
    ).bind(action.targetId).first<{ id: string }>();
    publishedEventId = existing?.id ?? null;
  }
  const wasPublic = post.state === "published" || post.state === "flagged";
  const writeWithdrawn = name === "hide"
    || (name === "quarantine" && wasPublic)
    || (name === "remove" && wasPublic);
  const withdrawnEventId = writeWithdrawn ? uuidv7() : null;
  const auditEventId = publishedEventId ?? withdrawnEventId;

  const where = guard(name);
  const statements: D1PreparedStatement[] = [];
  let writtenIndex: number | null = null;
  if (name === "approve" && publishedEventId !== null) {
    writtenIndex = statements.length;
    statements.push(c.env.DB.prepare(
      `INSERT INTO events (id, type, resource_id, occurred_at)
       SELECT ?, 'post.published', posts.id, ? FROM posts WHERE ${where}`,
    ).bind(publishedEventId, occurredAt, action.targetId));
  }
  if (withdrawnEventId !== null) {
    writtenIndex = statements.length;
    statements.push(c.env.DB.prepare(
      `INSERT INTO events (id, type, resource_id, occurred_at)
       SELECT ?, 'post.withdrawn', posts.id, ? FROM posts WHERE ${where}`,
    ).bind(withdrawnEventId, occurredAt, action.targetId));
  }
  if (name === "restore") {
    statements.push(c.env.DB.prepare(
      `DELETE FROM events
        WHERE type = 'post.withdrawn' AND resource_id = ?
          AND EXISTS (SELECT 1 FROM posts WHERE ${where})`,
    ).bind(action.targetId, action.targetId));
  }
  const auditIndex = statements.length;
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
    auditEventId,
    occurredAt,
    action.targetId,
  ));
  const updateIndex = statements.length;
  statements.push(c.env.DB.prepare(
    `UPDATE posts SET state = ? WHERE ${where}`,
  ).bind(destination(name), action.targetId));
  if (name === "remove" && post.asset_id !== null) {
    statements.push(blockAssetHashes(
      c.env.DB, post.asset_id, PROHIBITED_REASONS.has(action.reasonCode), occurredAt, actionId,
    ));
  }
  const results = await c.env.DB.batch(statements);
  const updated = Number(results[updateIndex]?.meta.changes ?? 0) === 1;
  const audited = Number(results[auditIndex]?.meta.changes ?? 0) === 1;
  const recorded = writtenIndex === null || Number(results[writtenIndex]?.meta.changes ?? 0) === 1;
  if (!updated || !audited || !recorded) return moderationError(requestId, format, "state_conflict");
  await settleSeatFlags(c.env.DB, action.targetId, name, occurredAt);
  const entry: Record<string, string> = { message: logMessage(name), post_id: action.targetId };
  if (publishedEventId !== null) entry.event_id = publishedEventId;
  console.log(JSON.stringify(entry));
  const state = destination(name);
  const body: Record<string, unknown> = { post_id: action.targetId, state };
  if (publishedEventId !== null) body.event_id = publishedEventId;
  return moderationDone(requestId, format, body, `Post ${action.targetId} is ${state}.`);
}

async function moveThread(
  c: Ctx,
  requestId: string,
  actorEmail: string,
  action: ActionInput,
  format: Format,
): Promise<Response> {
  const name = action.action as ThreadMove;
  const thread = await c.env.DB.prepare("SELECT state FROM threads WHERE id = ?").bind(action.targetId).first<{
    state: string;
  }>();
  if (!thread) return moderationError(requestId, format, "not_found");
  const next = threadDestination(name, thread.state);
  if (next === null) return moderationError(requestId, format, "state_conflict");
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
  if (!ok) return moderationError(requestId, format, "state_conflict");
  console.log(JSON.stringify({ message: threadLog(name), thread_id: action.targetId }));
  return moderationDone(requestId, format, { thread_id: action.targetId, state: next }, `Thread ${action.targetId} is ${next}.`);
}

async function moveAgent(
  c: Ctx,
  requestId: string,
  actorEmail: string,
  action: ActionInput,
  format: Format,
): Promise<Response> {
  const name = action.action as AgentMove;
  const agent = await c.env.DB.prepare("SELECT state FROM agents WHERE id = ?").bind(action.targetId).first<{
    state: string;
  }>();
  if (!agent) return moderationError(requestId, format, "not_found");
  const next = name === "suspend_agent" ? "suspended" : "active";
  const from = name === "suspend_agent" ? "active" : "suspended";
  if (agent.state !== from) return moderationError(requestId, format, "state_conflict");
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
  if (!ok) return moderationError(requestId, format, "state_conflict");
  const message = name === "suspend_agent" ? "agent suspended" : "agent resumed";
  console.log(JSON.stringify({ message, agent_id: action.targetId }));
  return moderationDone(requestId, format, { agent_id: action.targetId, state: next }, `Agent ${action.targetId} is ${next}.`);
}

// v0.2.28 H3: clear the handle and revoke every handle the Agent ever held.
async function revokeHandle(
  c: Ctx,
  requestId: string,
  actorEmail: string,
  action: ActionInput,
  format: Format,
): Promise<Response> {
  const agent = await c.env.DB.prepare("SELECT handle FROM agents WHERE id = ?").bind(action.targetId).first<{
    handle: string | null;
  }>();
  if (!agent) return moderationError(requestId, format, "not_found");
  if (agent.handle === null) return moderationError(requestId, format, "state_conflict");
  const guard = "id = ? AND handle = ?";
  const ok = await auditedUpdate(c.env.DB, {
    actorEmail,
    targetType: "agent",
    targetId: action.targetId,
    action: "revoke_handle",
    reasonCode: action.reasonCode,
    privateNote: action.privateNote,
    guard,
    guardExtra: agent.handle,
    update: `UPDATE agents SET handle = NULL, handle_changed_at = NULL WHERE ${guard}`,
    updateValue: null,
    extra: (_actionId, at) => [
      c.env.DB.prepare(
        "UPDATE agent_handles SET state = 'revoked', released_at = COALESCE(released_at, ?) WHERE agent_id = ? AND state != 'revoked'",
      ).bind(at, action.targetId),
    ],
  });
  if (!ok) return moderationError(requestId, format, "state_conflict");
  console.log(JSON.stringify({ message: "agent handle revoked", agent_id: action.targetId }));
  return moderationDone(
    requestId,
    format,
    { agent_id: action.targetId, handle: null },
    `The handle of agent ${action.targetId} is revoked.`,
  );
}

async function quarantine(
  c: Ctx,
  requestId: string,
  actorEmail: string,
  action: ActionInput,
  format: Format,
): Promise<Response> {
  const asset = await c.env.DB.prepare("SELECT state FROM assets WHERE id = ?").bind(action.targetId).first<{
    state: string;
  }>();
  if (!asset) return moderationError(requestId, format, "not_found");
  if (asset.state !== "ready") return moderationError(requestId, format, "state_conflict");
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
    extra: (actionId, at) => [
      blockAssetHashes(c.env.DB, action.targetId, PROHIBITED_REASONS.has(action.reasonCode), at, actionId),
    ],
  });
  if (!ok) return moderationError(requestId, format, "state_conflict");
  console.log(JSON.stringify({ message: "asset quarantined", asset_id: action.targetId }));
  return moderationDone(
    requestId,
    format,
    { asset_id: action.targetId, state: "quarantined" },
    `Asset ${action.targetId} is quarantined.`,
  );
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
  extra?: (actionId: string, at: string) => D1PreparedStatement[];
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
    ...(move.extra?.(actionId, occurredAt) ?? []),
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

type MoveName = "approve" | "reject" | "hide" | "restore" | "remove" | "quarantine";
type ThreadMove = "lock" | "unlock" | "archive";
type AgentMove = "suspend_agent" | "resume_agent";

function isMove(value: string): value is MoveName {
  return value === "approve" || value === "reject" || value === "hide" || value === "restore" || value === "remove" || value === "quarantine";
}

function isThreadMove(value: string): value is ThreadMove {
  return value === "lock" || value === "unlock" || value === "archive";
}

function isAgentMove(value: string): value is AgentMove {
  return value === "suspend_agent" || value === "resume_agent";
}

function legal(name: MoveName, state: string, threadState: string, assetReady: boolean): boolean {
  if (name === "approve") {
    if (state === "flagged") return true;
    return state === "pending_review" && threadState === "open" && assetReady;
  }
  if (name === "reject") return state === "pending_review";
  if (name === "hide") return state === "published";
  if (name === "remove") return state === "published" || state === "hidden" || state === "rejected" || state === "flagged";
  if (name === "quarantine") return state === "flagged" || state === "published" || state === "hidden";
  return (state === "hidden" || state === "flagged") && assetReady;
}

function destination(name: MoveName): string {
  if (name === "reject") return "rejected";
  if (name === "hide") return "hidden";
  if (name === "remove") return "removal_pending";
  if (name === "quarantine") return "quarantined";
  return "published";
}

function logMessage(name: MoveName): string {
  if (name === "approve") return "post published";
  if (name === "reject") return "post rejected";
  if (name === "hide") return "post hidden";
  if (name === "remove") return "post removal pending";
  if (name === "quarantine") return "post quarantined";
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
    return `posts.id = ? AND (
      posts.state = 'flagged'
      OR (posts.state = 'pending_review'
        AND EXISTS (SELECT 1 FROM threads WHERE threads.id = posts.thread_id AND threads.state = 'open')
        AND (posts.asset_id IS NULL OR EXISTS (
          SELECT 1 FROM assets WHERE assets.id = posts.asset_id AND assets.state = 'ready'
        )))
    )`;
  }
  if (name === "restore") {
    return `posts.id = ? AND posts.state IN ('hidden', 'flagged')
    AND (posts.asset_id IS NULL OR EXISTS (
      SELECT 1 FROM assets WHERE assets.id = posts.asset_id AND assets.state = 'ready'
    ))`;
  }
  if (name === "hide") return "posts.id = ? AND posts.state = 'published'";
  if (name === "remove") return "posts.id = ? AND posts.state IN ('published', 'hidden', 'rejected', 'flagged')";
  if (name === "quarantine") return "posts.id = ? AND posts.state IN ('flagged', 'published', 'hidden')";
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
