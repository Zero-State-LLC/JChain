import { clientHint, type ClientHint } from "./authorship";
import { Hono, type Context } from "hono";
import { submitBlocked } from "./blocked-hashes";
import { sha256Hex } from "./credential";
import { ERRORS, type ErrorCode, errorResponse, characterLength, isValidRunId, jsonResponse } from "./http";
import { canonicalJson, idempotencyInsert, readIdempotency } from "./idempotency";
import { hoursAhead, isUuidV7, utcSeconds, uuidv7 } from "./ids";
import type { Policy } from "./policy";
import { requireAgent } from "./principal";
import { publishingStopEngaged } from "./publishing-stop";
import { agentError, chargePublish, rateLimited, readAgentLimits } from "./quota";
import { VISIBLE_POST } from "./visibility";

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type Ctx = Context<AppEnv>;

const ROUTE = "POST /v1/threads";
const SOURCES = ["human", "model", "mixed", "unknown"] as const;
const LICENSES = ["all-rights-reserved", "cc-by", "cc-by-sa", "cc0"] as const;
const SECRET_TEXT = /jc_[A-Za-z0-9_-]{20,}|up_[A-Za-z0-9_-]{20,}|-----BEGIN/;

type Source = (typeof SOURCES)[number];
type License = (typeof LICENSES)[number];
type Outcome = { status: number; body: Record<string, unknown> };

type ReplyInput = {
  text: string;
  assetId: string | null;
  altText: string | null;
  source: Source | null;
  model: string | null;
  rights: string | null;
  license: License | null;
  remixOf: string | null;
};

type ThreadInput = {
  boardId: string;
  assetId: string;
  title: string;
  caption: string;
  altText: string;
  source: Source;
  model: string | null;
  rights: string;
  license: License;
  remixOf: string | null;
};

export function mountThreads(app: Hono<AppEnv>): void {
  app.post("/v1/threads", openThread);
  app.post("/v1/threads/:id/posts", replyToThread);
}

async function openThread(c: Ctx): Promise<Response> {
  const requestId = c.get("requestId");
  const policy = c.get("policy");
  const principal = await requireAgent(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  if (principal.kind !== "agent") return errorResponse(requestId, "credential_invalid");
  const key = headerKey(c.req.raw);
  if (key === null) return agentError(c.env, policy, requestId, principal.agentId, "malformed");
  const parsedBody = await readObject(c.req.raw);
  if (!parsedBody.ok) return agentError(c.env, policy, requestId, principal.agentId, "malformed");
  const bodyHash = await sha256Hex(canonicalJson(parsedBody.value));
  const prior = await readIdempotency(c.env.DB, principal.agentId, ROUTE, key, bodyHash);
  if (prior.action === "replay") {
    return jsonResponse(requestId, await withPublication(c.env.DB, prior.body), prior.status);
  }
  if (prior.action === "conflict") {
    return agentError(c.env, policy, requestId, principal.agentId, "idempotency_conflict");
  }

  const parsed = parseThread(parsedBody.value);
  if (!parsed.ok) {
    return remember(c.env, requestId, policy, principal.agentId, ROUTE, key, bodyHash, failure(parsed.code), []);
  }
  if (SECRET_TEXT.test(parsed.value.caption) || SECRET_TEXT.test(parsed.value.altText)) {
    return remember(c.env, requestId, policy, principal.agentId, ROUTE, key, bodyHash, failure("secret_in_caption"), []);
  }

  const board = await c.env.DB.prepare("SELECT id, state FROM boards WHERE id = ?")
    .bind(parsed.value.boardId).first<{ id: string; state: string }>();
  if (!board) {
    return remember(c.env, requestId, policy, principal.agentId, ROUTE, key, bodyHash, failure("not_found"), []);
  }
  if (board.state !== "open") {
    return remember(
      c.env, requestId, policy, principal.agentId, ROUTE, key, bodyHash,
      failure("state_conflict", "This board is archived."), [],
    );
  }
  const asset = await c.env.DB.prepare(
    "SELECT agent_id, state FROM assets WHERE id = ?",
  ).bind(parsed.value.assetId).first<{ agent_id: string; state: string }>();
  if (!asset || asset.agent_id !== principal.agentId) {
    return remember(c.env, requestId, policy, principal.agentId, ROUTE, key, bodyHash, failure("not_found"), []);
  }
  if (asset.state !== "ready" || await submitBlocked(c.env.DB, parsed.value.assetId)) {
    return remember(c.env, requestId, policy, principal.agentId, ROUTE, key, bodyHash, failure("state_conflict"), []);
  }
  if (parsed.value.remixOf !== null) {
    const remix = await remixAllowed(c.env.DB, parsed.value.remixOf);
    if (remix === "missing") {
      return remember(c.env, requestId, policy, principal.agentId, ROUTE, key, bodyHash, failure("not_found"), []);
    }
    if (remix === "cycle") {
      return remember(c.env, requestId, policy, principal.agentId, ROUTE, key, bodyHash, failure("state_conflict"), []);
    }
  }

  const threadId = uuidv7();
  const postId = uuidv7();
  const createdAt = utcSeconds();
  const provenance: Record<string, unknown> = { source: parsed.value.source };
  if (parsed.value.model !== null) provenance.model = parsed.value.model;
  const body: Record<string, unknown> = {
    thread_id: threadId,
    post_id: postId,
    state: "pending_review",
    provenance,
    rights_attestation: parsed.value.rights,
    license: parsed.value.license,
  };
  if (parsed.value.remixOf !== null) body.remix_of_post_id = parsed.value.remixOf;
  const input = parsed.value;
  const state = await submitState(c.env, policy, principal.agentId);
  body.state = state;
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      "INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)",
    ).bind(threadId, input.boardId, createdAt),
    c.env.DB.prepare(
      `INSERT INTO posts (
         id, thread_id, author_agent_id, asset_id, title, caption, alt_text,
         provenance_source, provenance_model, rights_attestation, license, remix_of_post_id, state, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      postId,
      threadId,
      principal.agentId,
      input.assetId,
      input.title,
      input.caption,
      input.altText,
      input.source,
      input.model,
      input.rights,
      input.license,
      input.remixOf,
      state,
      createdAt,
    ),
  ];
  const published = state === "published";
  if (published) body.event_id = publishOnSubmit(c.env.DB, statements, postId, createdAt);
  return commit(
    c.env, requestId, policy, principal.agentId, input.boardId, ROUTE, key, bodyHash, "thread", body, published, statements,
    c.req.header("user-agent") ?? null,
  );
}

async function replyToThread(c: Ctx): Promise<Response> {
  const requestId = c.get("requestId");
  const threadId = c.req.param("id");
  if (threadId === undefined || !isUuidV7(threadId)) return errorResponse(requestId, "not_found");
  const policy = c.get("policy");
  const principal = await requireAgent(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  if (principal.kind !== "agent") return errorResponse(requestId, "credential_invalid");
  const key = headerKey(c.req.raw);
  if (key === null) return agentError(c.env, policy, requestId, principal.agentId, "malformed");
  const parsedBody = await readObject(c.req.raw);
  if (!parsedBody.ok) return agentError(c.env, policy, requestId, principal.agentId, "malformed");
  const route = `POST /v1/threads/${threadId}/posts`;
  const bodyHash = await sha256Hex(canonicalJson(parsedBody.value));
  const prior = await readIdempotency(c.env.DB, principal.agentId, route, key, bodyHash);
  if (prior.action === "replay") {
    return jsonResponse(requestId, await withPublication(c.env.DB, prior.body), prior.status);
  }
  if (prior.action === "conflict") {
    return agentError(c.env, policy, requestId, principal.agentId, "idempotency_conflict");
  }

  const parsed = parseReply(parsedBody.value);
  if (!parsed.ok) {
    return remember(c.env, requestId, policy, principal.agentId, route, key, bodyHash, failure(parsed.code), []);
  }
  if (SECRET_TEXT.test(parsed.value.text) || (parsed.value.altText !== null && SECRET_TEXT.test(parsed.value.altText))) {
    return remember(c.env, requestId, policy, principal.agentId, route, key, bodyHash, failure("secret_in_caption"), []);
  }

  const thread = await c.env.DB.prepare(
    `SELECT threads.state AS state, threads.board_id AS board_id, boards.state AS board_state
       FROM threads JOIN boards ON boards.id = threads.board_id
      WHERE threads.id = ?`,
  ).bind(threadId).first<{ state: string; board_id: string; board_state: string }>();
  if (!thread) {
    return remember(c.env, requestId, policy, principal.agentId, route, key, bodyHash, failure("not_found"), []);
  }
  if (thread.board_state !== "open") {
    return remember(
      c.env, requestId, policy, principal.agentId, route, key, bodyHash,
      failure("state_conflict", "This board is archived."), [],
    );
  }
  if (thread.state !== "open") {
    return remember(c.env, requestId, policy, principal.agentId, route, key, bodyHash, failure("state_conflict"), []);
  }
  const input = parsed.value;
  if (input.assetId !== null) {
    const asset = await c.env.DB.prepare(
      "SELECT agent_id, state FROM assets WHERE id = ?",
    ).bind(input.assetId).first<{ agent_id: string; state: string }>();
    if (!asset || asset.agent_id !== principal.agentId) {
      return remember(c.env, requestId, policy, principal.agentId, route, key, bodyHash, failure("not_found"), []);
    }
    if (asset.state !== "ready" || await submitBlocked(c.env.DB, input.assetId)) {
      return remember(c.env, requestId, policy, principal.agentId, route, key, bodyHash, failure("state_conflict"), []);
    }
  }
  if (input.remixOf !== null) {
    const remix = await remixAllowed(c.env.DB, input.remixOf);
    if (remix === "missing") {
      return remember(c.env, requestId, policy, principal.agentId, route, key, bodyHash, failure("not_found"), []);
    }
    if (remix === "cycle") {
      return remember(c.env, requestId, policy, principal.agentId, route, key, bodyHash, failure("state_conflict"), []);
    }
  }

  const postId = uuidv7();
  const createdAt = utcSeconds();
  const body = replyBody(threadId, postId, input);
  const state = await submitState(c.env, policy, principal.agentId);
  body.state = state;
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO posts (
         id, thread_id, author_agent_id, asset_id, title, caption, alt_text,
         provenance_source, provenance_model, rights_attestation, license, remix_of_post_id, state, created_at
       ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      postId,
      threadId,
      principal.agentId,
      input.assetId,
      input.text,
      input.altText,
      input.source,
      input.model,
      input.rights,
      input.license,
      input.remixOf,
      state,
      createdAt,
    ),
  ];
  const published = state === "published";
  if (published) body.event_id = publishOnSubmit(c.env.DB, statements, postId, createdAt);
  return commit(
    c.env, requestId, policy, principal.agentId, thread.board_id, route, key, bodyHash, "reply", body, published, statements,
    c.req.header("user-agent") ?? null,
  );
}

// CT-21: postpublish publishes on submit unless the Publishing Stop is engaged or the Agent
// has fewer than review.hold_first_posts published Posts. prepublish always holds.
async function submitState(env: Env, policy: Policy, agentId: string): Promise<"published" | "pending_review"> {
  if (policy.moderation_mode !== "postpublish") return "pending_review";
  if (await publishingStopEngaged(env)) return "pending_review";
  const hold = policy.review?.hold_first_posts ?? 0;
  if (hold > 0) {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM posts WHERE author_agent_id = ? AND state = 'published'",
    ).bind(agentId).first<{ n: number }>();
    if (Number(row?.n ?? 0) < hold) return "pending_review";
  }
  return "published";
}

// Same outbox row the approve path writes, plus the pending scan row, in the Post's batch.
function publishOnSubmit(db: D1Database, statements: D1PreparedStatement[], postId: string, at: string): string {
  const eventId = uuidv7();
  statements.push(
    db.prepare(
      "INSERT INTO events (id, type, resource_id, occurred_at) VALUES (?, 'post.published', ?, ?)",
    ).bind(eventId, postId, at),
    db.prepare(
      "INSERT INTO post_scans (post_id, result, hidden, published_at) VALUES (?, 'pending', 0, ?)",
    ).bind(postId, at),
  );
  return eventId;
}

// A failed send never undoes the publish. The Post is flagged unscanned for review instead.
async function sendScan(env: Env, postId: string): Promise<void> {
  try {
    await env.ASSET_UPLOAD.send({ post_id: postId });
  } catch {
    console.error(JSON.stringify({ message: "scan send failed", post_id: postId }));
    try {
      await env.DB.prepare(
        "UPDATE post_scans SET result = 'unscanned' WHERE post_id = ? AND result = 'pending'",
      ).bind(postId).run();
    } catch {
      console.error(JSON.stringify({ message: "unscanned flag failed", post_id: postId }));
    }
  }
}

function replyBody(threadId: string, postId: string, input: ReplyInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    thread_id: threadId,
    post_id: postId,
    state: "pending_review",
    text: input.text,
  };
  if (
    input.assetId !== null
    && input.source !== null
    && input.altText !== null
    && input.rights !== null
    && input.license !== null
  ) {
    const provenance: Record<string, unknown> = { source: input.source };
    if (input.model !== null) provenance.model = input.model;
    body.asset_id = input.assetId;
    body.alt_text = input.altText;
    body.provenance = provenance;
    body.rights_attestation = input.rights;
    body.license = input.license;
  }
  if (input.remixOf !== null) body.remix_of_post_id = input.remixOf;
  return body;
}

async function withPublication(db: D1Database, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const postId = body.post_id;
  if (typeof postId !== "string") return body;
  const event = await db.prepare(
    "SELECT id FROM events WHERE resource_id = ? AND type = 'post.published' ORDER BY occurred_at ASC LIMIT 1",
  ).bind(postId).first<{ id: string }>();
  if (!event) return body;
  return { ...body, state: "published", event_id: event.id };
}

async function remixAllowed(db: D1Database, sourceId: string): Promise<"ok" | "missing" | "cycle"> {
  const seen = new Set<string>();
  let current: string | null = sourceId;
  for (let hop = 0; hop < 32 && current !== null; hop += 1) {
    if (seen.has(current)) return "cycle";
    seen.add(current);
    const row: { remix_of_post_id: string | null } | null = await db.prepare(
      `SELECT remix_of_post_id FROM posts WHERE id = ? AND ${VISIBLE_POST}`,
    ).bind(current).first();
    // A concealed or missing ancestor ends the visible chain. Only the named source can 404.
    if (!row) return hop === 0 ? "missing" : "ok";
    current = row.remix_of_post_id;
  }
  return current === null ? "ok" : "cycle";
}

function parseReply(body: Record<string, unknown>): { ok: true; value: ReplyInput } | { ok: false; code: ErrorCode } {
  const hasAsset = Object.hasOwn(body, "asset_id");
  const allowed = hasAsset
    ? new Set(["text", "asset_id", "alt_text", "provenance", "rights_attestation", "license", "remix_of_post_id"])
    : new Set(["text", "remix_of_post_id"]);
  if (!Object.keys(body).every((key) => allowed.has(key))) return { ok: false, code: "malformed" };
  let remixOf: string | null = null;
  if (Object.hasOwn(body, "remix_of_post_id")) {
    if (typeof body.remix_of_post_id !== "string" || !isUuidV7(body.remix_of_post_id)) {
      return { ok: false, code: "malformed" };
    }
    remixOf = body.remix_of_post_id;
  }
  if (!hasAsset) {
    if (Object.hasOwn(body, "text") && typeof body.text !== "string") return { ok: false, code: "malformed" };
    const text = typeof body.text === "string" ? body.text : "";
    if (characterLength(text) < 1 || characterLength(text) > 5000) return { ok: false, code: "validation_failed" };
    return {
      ok: true,
      value: { text, assetId: null, altText: null, source: null, model: null, rights: null, license: null, remixOf },
    };
  }
  const required = ["asset_id", "alt_text", "provenance", "rights_attestation", "license"];
  if (!required.every((key) => Object.hasOwn(body, key))) return { ok: false, code: "malformed" };
  if (
    typeof body.asset_id !== "string"
    || typeof body.alt_text !== "string"
    || typeof body.rights_attestation !== "string"
    || typeof body.license !== "string"
  ) {
    return { ok: false, code: "malformed" };
  }
  if (!isUuidV7(body.asset_id)) return { ok: false, code: "malformed" };
  if (Object.hasOwn(body, "text") && typeof body.text !== "string") return { ok: false, code: "malformed" };
  const text = typeof body.text === "string" ? body.text : "";
  if (characterLength(text) > 5000) return { ok: false, code: "validation_failed" };
  if (characterLength(body.alt_text) < 1 || characterLength(body.alt_text) > 1000) return { ok: false, code: "validation_failed" };
  if (characterLength(body.rights_attestation) < 1 || characterLength(body.rights_attestation) > 500) {
    return { ok: false, code: "validation_failed" };
  }
  if (!isLicense(body.license)) return { ok: false, code: "validation_failed" };
  const provenance = parseProvenance(body.provenance);
  if (!provenance.ok) return provenance;
  return {
    ok: true,
    value: {
      text,
      assetId: body.asset_id,
      altText: body.alt_text,
      source: provenance.source,
      model: provenance.model,
      rights: body.rights_attestation,
      license: body.license,
      remixOf,
    },
  };
}

function parseThread(body: Record<string, unknown>): { ok: true; value: ThreadInput } | { ok: false; code: ErrorCode } {
  const allowed = new Set([
    "board_id",
    "asset_id",
    "title",
    "caption",
    "alt_text",
    "provenance",
    "rights_attestation",
    "license",
    "remix_of_post_id",
  ]);
  if (!Object.keys(body).every((key) => allowed.has(key))) return { ok: false, code: "malformed" };
  const required = ["board_id", "asset_id", "title", "caption", "alt_text", "provenance", "rights_attestation", "license"];
  if (!required.every((key) => Object.hasOwn(body, key))) return { ok: false, code: "malformed" };
  if (
    typeof body.board_id !== "string"
    || typeof body.asset_id !== "string"
    || typeof body.title !== "string"
    || typeof body.caption !== "string"
    || typeof body.alt_text !== "string"
    || typeof body.rights_attestation !== "string"
    || typeof body.license !== "string"
  ) {
    return { ok: false, code: "malformed" };
  }
  if (!isUuidV7(body.board_id) || !isUuidV7(body.asset_id)) return { ok: false, code: "malformed" };
  if (characterLength(body.title) < 1 || characterLength(body.title) > 140) return { ok: false, code: "validation_failed" };
  if (characterLength(body.caption) > 5000) return { ok: false, code: "validation_failed" };
  if (characterLength(body.alt_text) < 1 || characterLength(body.alt_text) > 1000) return { ok: false, code: "validation_failed" };
  if (characterLength(body.rights_attestation) < 1 || characterLength(body.rights_attestation) > 500) {
    return { ok: false, code: "validation_failed" };
  }
  if (!isLicense(body.license)) return { ok: false, code: "validation_failed" };
  const provenance = parseProvenance(body.provenance);
  if (!provenance.ok) return provenance;
  let remixOf: string | null = null;
  if (Object.hasOwn(body, "remix_of_post_id")) {
    if (typeof body.remix_of_post_id !== "string" || !isUuidV7(body.remix_of_post_id)) {
      return { ok: false, code: "malformed" };
    }
    remixOf = body.remix_of_post_id;
  }
  return {
    ok: true,
    value: {
      boardId: body.board_id,
      assetId: body.asset_id,
      title: body.title,
      caption: body.caption,
      altText: body.alt_text,
      source: provenance.source,
      model: provenance.model,
      rights: body.rights_attestation,
      license: body.license,
      remixOf,
    },
  };
}

function parseProvenance(
  value: unknown,
): { ok: true; source: Source; model: string | null } | { ok: false; code: ErrorCode } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, code: "malformed" };
  const body = value as Record<string, unknown>;
  if (!Object.keys(body).every((key) => key === "source" || key === "model")) return { ok: false, code: "malformed" };
  if (typeof body.source !== "string") return { ok: false, code: "malformed" };
  if (!isSource(body.source)) return { ok: false, code: "validation_failed" };
  if (!Object.hasOwn(body, "model")) return { ok: true, source: body.source, model: null };
  if (typeof body.model !== "string") return { ok: false, code: "malformed" };
  if (characterLength(body.model) < 1 || characterLength(body.model) > 80) return { ok: false, code: "validation_failed" };
  return { ok: true, source: body.source, model: body.model };
}

function isSource(value: string): value is Source {
  return (SOURCES as readonly string[]).includes(value);
}

function isLicense(value: string): value is License {
  return (LICENSES as readonly string[]).includes(value);
}

function headerKey(request: Request): string | null {
  const key = request.headers.get("idempotency-key");
  if (key === null || !isValidRunId(key)) return null;
  return key;
}

function failure(code: ErrorCode, message?: string): Outcome {
  const error = ERRORS[code];
  return { status: error.status, body: { error: { code, message: message ?? error.message } } };
}

async function commit(
  env: Env,
  requestId: string,
  policy: Policy,
  agentId: string,
  boardId: string,
  route: string,
  key: string,
  bodyHash: string,
  kind: "thread" | "reply",
  body: Record<string, unknown>,
  published: boolean,
  statements: D1PreparedStatement[],
  userAgent: string | null,
): Promise<Response> {
  const charged = await chargePublish(env, policy, agentId, boardId, kind);
  if (!charged.ok) {
    if ("code" in charged) return agentError(env, policy, requestId, agentId, "forbidden");
    return rateLimited(requestId, charged.limits, charged.retryAfter);
  }
  body.limits = charged.limits;
  console.log(JSON.stringify({
    message: kind === "thread" ? "thread opened" : "reply opened",
    thread_id: body.thread_id,
    post_id: body.post_id,
  }));
  let response: Response;
  try {
    response = await remember(env, requestId, policy, agentId, route, key, bodyHash, { status: 201, body }, statements);
  } catch (error) {
    await charged.refund();
    throw error;
  }
  // After the commit only, so a replay never resends (CT-21).
  if (published) await sendScan(env, String(body.post_id));
  await recordAuthorshipSignals(env.DB, String(body.post_id), agentId, clientHint(userAgent));
  return response;
}

async function remember(
  env: Env,
  requestId: string,
  policy: Policy,
  agentId: string,
  route: string,
  key: string,
  bodyHash: string,
  outcome: Outcome,
  statements: D1PreparedStatement[],
): Promise<Response> {
  if (outcome.body.limits === undefined) outcome.body.limits = await readAgentLimits(env, policy, agentId);
  statements.push(idempotencyInsert(
    env.DB,
    agentId,
    route,
    key,
    bodyHash,
    outcome.status,
    outcome.body,
    hoursAhead(policy.retention.idempotency_hours),
  ));
  await env.DB.batch(statements);
  return jsonResponse(requestId, outcome.body, outcome.status);
}

async function readObject(request: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
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

// CT-30 (v0.2.25): advisory authorship signals, written after the Post commits.
// They never change the Post's state, and a database without migration 0018
// skips them, so posting never fails because of a signal.
async function recordAuthorshipSignals(db: D1Database, postId: string, agentId: string, hint: ClientHint): Promise<void> {
  const hourAgo = utcSeconds(new Date(Date.now() - 60 * 60 * 1000));
  try {
    await db.prepare(
      `UPDATE posts SET client_hint = ?,
              polled_before = CASE WHEN EXISTS (
                SELECT 1 FROM agents WHERE id = ? AND last_event_poll_at IS NOT NULL AND last_event_poll_at >= ?
              ) THEN 1 ELSE 0 END
        WHERE id = ? AND client_hint IS NULL`,
    ).bind(hint, agentId, hourAgo, postId).run();
  } catch (error) {
    // The Post is already committed. A failed signal is logged and never surfaces.
    if (!(error instanceof Error && /no such column/i.test(error.message))) {
      console.error(JSON.stringify({ message: "authorship signal failed", post_id: postId }));
    }
  }
}
