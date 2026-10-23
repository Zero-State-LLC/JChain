import { Hono, type Context } from "hono";
import { blockAssetHashes } from "./blocked-hashes";
import { htmlError, htmlResult } from "./html";
import { errorResponse, characterLength, jsonResponse, type ErrorCode } from "./http";
import { isUuidV7, utcSeconds, uuidv7 } from "./ids";
import { sameOrigin } from "./origin";
import { parsePolicy, type Policy } from "./policy";
import { isAdminEmail, requireModerator } from "./principal";
import { publishingStopEngaged } from "./publishing-stop";
import { settleSeatFlags } from "./seats";
import { applyOperatorAction, isOperatorAction, parseOperatorExtras } from "./operator-admin";

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
  if (action.targetType === "operator" && isOperatorAction(action.action)) {
    // v0.2.30 (ticket 44, CT-20): Operator pairs are Admin only.
    if (!(await isAdminEmail(c.env, principal.email))) return moderationError(requestId, format, "forbidden");
    if (action.action === "remove_operator" && format === "html" && parsed.value.confirm !== "yes") {
      return moderationError(requestId, format, "validation_failed");
    }
    const extras = parseOperatorExtras(action.action, parsed.value);
    if (!extras.ok) return moderationError(requestId, format, extras.code);
    const result = await applyOperatorAction(c.env.DB, principal.email, {
      action: action.action,
      operatorId: action.targetId,
      ...(extras.value === undefined ? {} : { value: extras.value }),
      ...(extras.email === undefined ? {} : { email: extras.email }),
    }, action.reasonCode, action.privateNote);
    if (!result.ok) {
      if (format === "json") return errorResponse(requestId, result.code, result.message);
      return htmlResult(requestId, "Admin", result.message ?? "The action could not be applied.", "/admin", "Admin", result.code === "not_found" ? 404 : result.code === "forbidden" ? 403 : result.code === "validation_failed" ? 422 : 409);
    }
    if (format === "json") return jsonResponse(requestId, result.body);
    return htmlResult(requestId, "Admin", result.sentence, "/admin", "Admin", 200);
  }
  if (action.targetType === "post" && action.action === "uphold") {
    return upholdAppeal(c, requestId, principal.email, action, format);
  }
  if (action.targetType === "post" && action.action === "dismiss_flags") {
    return dismissFlags(c, requestId, principal.email, action, format);
  }
  if (action.targetType === "asset" && action.action === "restore_asset") {
    if (!(await isAdminEmail(c.env, principal.email))) return moderationError(requestId, format, "forbidden");
    return restoreAsset(c, requestId, principal.email, action, format);
  }
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
    `SELECT posts.state AS state, posts.legal_hold AS legal_hold, threads.state AS thread_state,
            posts.asset_id AS asset_id, assets.state AS asset_state
       FROM posts
       JOIN threads ON threads.id = posts.thread_id
       LEFT JOIN assets ON assets.id = posts.asset_id
      WHERE posts.id = ?`,
  ).bind(action.targetId).first<{
    state: string;
    legal_hold: number;
    thread_state: string;
    asset_id: string | null;
    asset_state: string | null;
  }>();
  if (!post) return moderationError(requestId, format, "not_found");
  // #116: any Moderator may remove or quarantine (the safe direction). Releasing a quarantined
  // Post, or any Post under a legal hold, is Admin only, and it releases the quarantined Asset in
  // the same batch, so a false report or false CSAM match can be cleared without editing D1.
  const fromQuarantine = name === "restore" && post.state === "quarantined";
  if (name === "restore" && (fromQuarantine || post.legal_hold === 1)) {
    if (!(await isAdminEmail(c.env, actorEmail))) return moderationError(requestId, format, "forbidden");
  }
  const assetReady = post.asset_id === null || post.asset_state === "ready"
    || (fromQuarantine && post.asset_state === "quarantined");
  if (!legal(name, post.state, post.thread_state, assetReady)) {
    return moderationError(requestId, format, "state_conflict");
  }
  if ((name === "approve" || name === "restore") && await publishingStopEngaged(c.env)) {
    return moderationError(requestId, format, "state_conflict");
  }

  const occurredAt = utcSeconds();
  const actionId = uuidv7();
  // One post.published per Post. Each withdrawal writes a post.withdrawn row, and each
  // restore (including approve from flagged) writes a post.restored row.
  const fromFlagged = post.state === "flagged";
  const isRestore = name === "restore" || (name === "approve" && fromFlagged);
  const publishedEventId = name === "approve" && !fromFlagged ? uuidv7() : null;
  const restoredEventId = isRestore ? uuidv7() : null;
  const wasPublic = post.state === "published" || post.state === "flagged";
  const writeWithdrawn = name === "hide"
    || (name === "quarantine" && wasPublic)
    || (name === "remove" && wasPublic);
  let withdrawnEventId: string | null = null;
  let insertWithdrawn = false;
  if (writeWithdrawn) {
    if (fromFlagged) {
      const existingWithdrawn = await c.env.DB.prepare(
        `SELECT e.id FROM events AS e
          WHERE e.resource_id = ? AND e.type = 'post.withdrawn'
            AND NOT EXISTS (
              SELECT 1 FROM events AS r
               WHERE r.resource_id = e.resource_id
                 AND r.type IN ('post.published', 'post.restored')
                 AND (r.occurred_at > e.occurred_at OR (r.occurred_at = e.occurred_at AND r.id > e.id))
            )
          ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1`,
      ).bind(action.targetId).first<{ id: string }>();
      if (existingWithdrawn) {
        withdrawnEventId = existingWithdrawn.id;
      } else {
        withdrawnEventId = uuidv7();
        insertWithdrawn = true;
      }
    } else {
      withdrawnEventId = uuidv7();
      insertWithdrawn = true;
    }
  }
  const primaryEventId = publishedEventId ?? restoredEventId;
  const auditEventId = primaryEventId ?? withdrawnEventId;

  const where = fromQuarantine
    ? `posts.id = ? AND posts.state = 'quarantined'
    AND (posts.asset_id IS NULL OR EXISTS (
      SELECT 1 FROM assets WHERE assets.id = posts.asset_id AND assets.state IN ('ready', 'quarantined')
    ))`
    : guard(name);
  const statements: D1PreparedStatement[] = [];
  let writtenIndex: number | null = null;
  if (name === "approve" && publishedEventId !== null) {
    writtenIndex = statements.length;
    statements.push(c.env.DB.prepare(
      `INSERT INTO events (id, type, resource_id, occurred_at)
       SELECT ?, 'post.published', posts.id, ? FROM posts WHERE ${where}`,
    ).bind(publishedEventId, occurredAt, action.targetId));
  }
  if (isRestore && restoredEventId !== null) {
    writtenIndex = statements.length;
    statements.push(c.env.DB.prepare(
      `INSERT INTO events (id, type, resource_id, occurred_at)
       SELECT ?, 'post.restored', posts.id, ? FROM posts WHERE ${where}`,
    ).bind(restoredEventId, occurredAt, action.targetId));
  }
  if (insertWithdrawn && withdrawnEventId !== null) {
    writtenIndex = statements.length;
    statements.push(c.env.DB.prepare(
      `INSERT INTO events (id, type, resource_id, occurred_at)
       SELECT ?, 'post.withdrawn', posts.id, ? FROM posts WHERE ${where}`,
    ).bind(withdrawnEventId, occurredAt, action.targetId));
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
  // v0.2.29: a Moderator hide is final and never appealable. Restore and approve clear who hid it.
  const hiddenBy = name === "hide" ? "'moderator'" : name === "restore" || name === "approve" ? "NULL" : "hidden_by";
  const holdSql = name === "restore"
    ? ", legal_hold = 0, legal_hold_reason = NULL"
    : action.reasonCode === "csam" && (name === "remove" || name === "quarantine")
      ? ", legal_hold = 1, legal_hold_reason = 'csam'"
      : "";
  statements.push(c.env.DB.prepare(
    `UPDATE posts SET state = ?, hidden_by = ${hiddenBy}${holdSql} WHERE ${where}`,
  ).bind(destination(name), action.targetId));
  if (name === "restore") {
    // An open appeal is answered by the restore, in the same batch, only when the restore applied.
    statements.push(c.env.DB.prepare(
      `UPDATE post_appeals SET outcome = 'restore', decided_at = ?, decided_by = ?
        WHERE post_id = ? AND outcome IS NULL
          AND EXISTS (SELECT 1 FROM moderation_actions WHERE id = ?)`,
    ).bind(occurredAt, actorEmail, action.targetId, actionId));
  }
  if (fromQuarantine && post.asset_id !== null) {
    // Runs after the Post update, so it keys on the audit row this batch wrote.
    statements.push(c.env.DB.prepare(
      `UPDATE assets SET state = 'ready'
        WHERE id = ? AND state = 'quarantined'
          AND EXISTS (SELECT 1 FROM moderation_actions WHERE id = ?)`,
    ).bind(post.asset_id, actionId));
  }
  const policy = c.get("policy") ?? parsePolicy(typeof c.env.POLICY === "string" ? c.env.POLICY : undefined);
  const enqueueScan = name === "approve" && post.state === "pending_review" && policy?.moderation_mode === "postpublish";
  if (enqueueScan) {
    statements.push(c.env.DB.prepare(
      `INSERT OR IGNORE INTO post_scans (post_id, result, hidden, published_at)
       SELECT posts.id, 'pending', 0, ? FROM posts
        WHERE id = ? AND EXISTS (SELECT 1 FROM moderation_actions WHERE id = ?)`,
    ).bind(occurredAt, action.targetId, actionId));
  }
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
  if (enqueueScan) {
    try {
      await c.env.ASSET_UPLOAD.send({ post_id: action.targetId });
    } catch {
      await c.env.DB.prepare(
        "UPDATE post_scans SET result = 'unscanned' WHERE post_id = ? AND result = 'pending'",
      ).bind(action.targetId).run();
    }
  }
  await settleSeatFlags(c.env.DB, action.targetId, name, occurredAt, actorEmail, policy);
  const entry: Record<string, string> = { message: logMessage(name), post_id: action.targetId };
  if (primaryEventId !== null) entry.event_id = primaryEventId;
  console.log(JSON.stringify(entry));
  const state = destination(name);
  const body: Record<string, unknown> = { post_id: action.targetId, state };
  if (primaryEventId !== null) body.event_id = primaryEventId;
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
    // Runs only when the guarded audit row was written, so a handle claimed after the read stays intact.
    extra: (actionId, at) => [
      c.env.DB.prepare(
        `UPDATE agent_handles SET state = 'revoked', released_at = COALESCE(released_at, ?)
          WHERE agent_id = ? AND state != 'revoked'
            AND EXISTS (SELECT 1 FROM moderation_actions WHERE id = ?)`,
      ).bind(at, action.targetId, actionId),
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

// v0.2.29 (CT-21): close an open appeal and keep the hide. Its Seat Flags count as confirmed.
async function upholdAppeal(
  c: Ctx,
  requestId: string,
  actorEmail: string,
  action: ActionInput,
  format: Format,
): Promise<Response> {
  const open = await c.env.DB.prepare(
    "SELECT post_appeals.post_id AS post_id FROM post_appeals WHERE post_id = ? AND outcome IS NULL",
  ).bind(action.targetId).first();
  if (!open) {
    const post = await c.env.DB.prepare("SELECT 1 AS one FROM posts WHERE id = ?").bind(action.targetId).first();
    return moderationError(requestId, format, post ? "state_conflict" : "not_found");
  }
  const actionId = uuidv7();
  const at = utcSeconds();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO moderation_actions (
         id, actor_email, target_type, target_id, action, reason_code, private_note, event_id, created_at
       )
       SELECT ?, ?, 'post', post_id, 'uphold', ?, ?, NULL, ? FROM post_appeals WHERE post_id = ? AND outcome IS NULL`,
    ).bind(actionId, actorEmail, action.reasonCode, action.privateNote, at, action.targetId),
    c.env.DB.prepare(
      `UPDATE post_appeals SET outcome = 'uphold', decided_at = ?, decided_by = ?
        WHERE post_id = ? AND outcome IS NULL AND EXISTS (SELECT 1 FROM moderation_actions WHERE id = ?)`,
    ).bind(at, actorEmail, action.targetId, actionId),
    c.env.DB.prepare(
      "UPDATE posts SET queue_first = 0 WHERE id = ? AND EXISTS (SELECT 1 FROM moderation_actions WHERE id = ?)",
    ).bind(action.targetId, actionId),
  ]);
  if (Number(results[1]?.meta.changes ?? 0) !== 1) return moderationError(requestId, format, "state_conflict");
  const policy = c.get("policy") ?? parsePolicy(typeof c.env.POLICY === "string" ? c.env.POLICY : undefined);
  await settleSeatFlags(c.env.DB, action.targetId, "uphold", at, actorEmail, policy);
  console.log(JSON.stringify({ message: "appeal upheld", post_id: action.targetId }));
  const post = await c.env.DB.prepare("SELECT state FROM posts WHERE id = ?").bind(action.targetId).first<{ state: string }>();
  return moderationDone(
    requestId,
    format,
    { post_id: action.targetId, state: post?.state ?? "hidden", appeal: "upheld" },
    `The appeal on Post ${action.targetId} is upheld. The Post stays ${post?.state ?? "hidden"}.`,
  );
}

// v0.2.29 (CT-21): clear the open Seat Flags and scan flags on a published Post, without hiding it.
async function dismissFlags(
  c: Ctx,
  requestId: string,
  actorEmail: string,
  action: ActionInput,
  format: Format,
): Promise<Response> {
  const post = await c.env.DB.prepare(
    `SELECT posts.state AS state,
            (SELECT COUNT(*) FROM seat_flags WHERE seat_flags.post_id = posts.id AND seat_flags.outcome = 'pending') AS seat,
            (SELECT COUNT(*) FROM post_scans
              WHERE post_scans.post_id = posts.id AND post_scans.result IN ('unsafe', 'unscanned')
                AND post_scans.hidden = 0 AND post_scans.dismissed_at IS NULL) AS scan
       FROM posts WHERE posts.id = ?`,
  ).bind(action.targetId).first<{ state: string; seat: number; scan: number }>();
  if (!post) return moderationError(requestId, format, "not_found");
  if (post.state !== "published" || (Number(post.seat) === 0 && Number(post.scan) === 0)) {
    return moderationError(requestId, format, "state_conflict");
  }
  const actionId = uuidv7();
  const at = utcSeconds();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO moderation_actions (
         id, actor_email, target_type, target_id, action, reason_code, private_note, event_id, created_at
       )
       SELECT ?, ?, 'post', id, 'dismiss_flags', ?, ?, NULL, ? FROM posts WHERE id = ? AND state = 'published'`,
    ).bind(actionId, actorEmail, action.reasonCode, action.privateNote, at, action.targetId),
    c.env.DB.prepare(
      `UPDATE post_scans SET dismissed_at = ?
        WHERE post_id = ? AND dismissed_at IS NULL AND EXISTS (SELECT 1 FROM moderation_actions WHERE id = ?)`,
    ).bind(at, action.targetId, actionId),
    c.env.DB.prepare(
      "UPDATE posts SET queue_first = 0 WHERE id = ? AND EXISTS (SELECT 1 FROM moderation_actions WHERE id = ?)",
    ).bind(action.targetId, actionId),
  ]);
  if (Number(results[0]?.meta.changes ?? 0) !== 1) return moderationError(requestId, format, "state_conflict");
  const policy = c.get("policy") ?? parsePolicy(typeof c.env.POLICY === "string" ? c.env.POLICY : undefined);
  await settleSeatFlags(c.env.DB, action.targetId, "dismiss_flags", at, actorEmail, policy);
  console.log(JSON.stringify({ message: "flags dismissed", post_id: action.targetId }));
  return moderationDone(
    requestId,
    format,
    { post_id: action.targetId, state: "published", flags: "dismissed" },
    `The flags on Post ${action.targetId} are dismissed.`,
  );
}

// v0.2.29 (CT-21): Admin only. A falsely quarantined Asset returns to ready and leaves the Blocked Hash list.
async function restoreAsset(
  c: Ctx,
  requestId: string,
  actorEmail: string,
  action: ActionInput,
  format: Format,
): Promise<Response> {
  const asset = await c.env.DB.prepare(
    `SELECT state, EXISTS (SELECT 1 FROM posts WHERE posts.asset_id = assets.id AND posts.legal_hold = 1) AS held
       FROM assets WHERE id = ?`,
  ).bind(action.targetId).first<{ state: string; held: number }>();
  if (!asset) return moderationError(requestId, format, "not_found");
  if (asset.state !== "quarantined" || Number(asset.held) === 1) return moderationError(requestId, format, "state_conflict");
  const guard = "id = ? AND state = 'quarantined' AND NOT EXISTS (SELECT 1 FROM posts WHERE posts.asset_id = assets.id AND posts.legal_hold = 1)";
  const ok = await auditedUpdate(c.env.DB, {
    actorEmail,
    targetType: "asset",
    targetId: action.targetId,
    action: "restore_asset",
    reasonCode: action.reasonCode,
    privateNote: action.privateNote,
    guard,
    update: `UPDATE assets SET state = 'ready' WHERE ${guard}`,
    updateValue: null,
    extra: (actionId) => [
      c.env.DB.prepare(
        "DELETE FROM blocked_hashes WHERE asset_id = ? AND EXISTS (SELECT 1 FROM moderation_actions WHERE id = ?)",
      ).bind(action.targetId, actionId),
    ],
  });
  if (!ok) return moderationError(requestId, format, "state_conflict");
  console.log(JSON.stringify({ message: "asset restored", asset_id: action.targetId }));
  return moderationDone(
    requestId,
    format,
    { asset_id: action.targetId, state: "ready" },
    `Asset ${action.targetId} is ready again.`,
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
  if (name === "remove") return state === "published" || state === "hidden" || state === "rejected" || state === "flagged" || state === "quarantined";
  if (name === "quarantine") return state === "flagged" || state === "published" || state === "hidden";
  return (state === "hidden" || state === "flagged" || state === "quarantined") && assetReady;
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
    return `posts.id = ? AND posts.state IN ('hidden', 'flagged', 'quarantined')
    AND (posts.asset_id IS NULL OR EXISTS (
      SELECT 1 FROM assets WHERE assets.id = posts.asset_id AND assets.state = 'ready'
    ))`;
  }
  if (name === "hide") return "posts.id = ? AND posts.state = 'published'";
  if (name === "remove") return "posts.id = ? AND posts.state IN ('published', 'hidden', 'rejected', 'flagged', 'quarantined')";
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
  // v0.2.30: Operator pairs carry a value, an email, or a confirmation.
  const operatorKeys = body.target_type === "operator" ? ["value", "email", "confirm"] : [];
  if (!Object.keys(body).every((key) => allowed.has(key) || operatorKeys.includes(key))) return { ok: false, code: "malformed" };
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
