import { Hono, type Context } from "hono";
import {
  derivativeKey,
  isAnimated,
  originalKey,
  originalThumbKey,
  sniffedType,
  type ReasonCode,
} from "./asset-pipeline";
import { newUploadToken, sha256Hex, sha256HexBytes } from "./credential";
import { ERRORS, type ErrorCode, bytesResponse, errorResponse, isValidRunId, jsonResponse } from "./http";
import { canonicalJson, idempotencyInsert, readIdempotency } from "./idempotency";
import { hoursAhead, isUuidV7, utcSeconds, uuidv7 } from "./ids";
import type { Policy } from "./policy";
import { requireAgent, requireModerator } from "./principal";
import { agentError, logRejected, processingHeadroom, rateLimited, readAgentLimits } from "./quota";
import { type AssetReader, projectAsset } from "./visibility";

type UploadEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type UploadApp = Hono<UploadEnv>;
type Ctx = Context<UploadEnv>;

const RESERVE_ROUTE = "POST /v1/uploads";
const TOKEN_MESSAGE = "The upload token is missing or not valid.";
const SHA256 = /^[0-9a-f]{64}$/;
const UPLOAD_TOKEN = /^up_[A-Za-z0-9_-]{43}$/;

type Outcome = { status: number; body: Record<string, unknown> };

// The display image and the agent's thumbnail arrive the same way, each under its own declared size and hash.
type Part = {
  path: "content" | "thumb";
  stagedKey: (assetId: string) => string;
  sizeColumn: "byte_size" | "thumb_byte_size";
  hashColumn: "sha256" | "thumb_sha256";
  storedColumn: "original_stored" | "thumb_stored";
};

const DISPLAY: Part = {
  path: "content",
  stagedKey: originalKey,
  sizeColumn: "byte_size",
  hashColumn: "sha256",
  storedColumn: "original_stored",
};

const THUMB: Part = {
  path: "thumb",
  stagedKey: originalThumbKey,
  sizeColumn: "thumb_byte_size",
  hashColumn: "thumb_sha256",
  storedColumn: "thumb_stored",
};

export function mountUploads(app: UploadApp): void {
  app.post("/v1/uploads", reserve);
  app.put("/v1/uploads/:id/content", (c) => putPart(c, DISPLAY));
  app.put("/v1/uploads/:id/thumb", (c) => putPart(c, THUMB));
  app.post("/v1/uploads/:id/complete", complete);
  app.get("/v1/assets/:id/status", assetStatus);
  app.get("/v1/assets/:id/content", assetContent);
}

async function reserve(c: Ctx): Promise<Response> {
  const requestId = c.get("requestId");
  const policy = c.get("policy");
  const principal = await requireAgent(c.env, c.req.raw);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  if (principal.kind !== "agent") return errorResponse(requestId, "credential_invalid");
  const key = headerKey(c.req.raw);
  if (key === null) return agentError(c.env, policy, requestId, principal.agentId, "malformed");
  const parsedBody = await readObject(c.req.raw);
  if (!parsedBody.ok) return agentError(c.env, policy, requestId, principal.agentId, "malformed");
  const bodyHash = await sha256Hex(canonicalJson(parsedBody.value));
  const prior = await readIdempotency(c.env.DB, principal.agentId, RESERVE_ROUTE, key, bodyHash);
  if (prior.action === "replay") {
    if (prior.status === 201 && typeof prior.body.asset_id === "string") {
      return reissueToken(c.env, requestId, policy, principal.agentId, prior.body.asset_id, prior.body);
    }
    return jsonResponse(requestId, prior.body, prior.status);
  }
  if (prior.action === "conflict") {
    return agentError(c.env, policy, requestId, principal.agentId, "idempotency_conflict");
  }

  const parsed = parseReserve(parsedBody.value, policy);
  if (!parsed.ok) return remember(c.env, requestId, policy, principal.agentId, RESERVE_ROUTE, key, bodyHash, failure(parsed.code), []);

  const existing = await c.env.DB.prepare(
    "SELECT id FROM assets WHERE agent_id = ? AND sha256 = ? AND state = 'ready' LIMIT 1",
  ).bind(principal.agentId, parsed.sha256).first<{ id: string }>();
  if (existing) {
    return remember(
      c.env,
      requestId,
      policy,
      principal.agentId,
      RESERVE_ROUTE,
      key,
      bodyHash,
      { status: 200, body: { asset_id: existing.id, deduped: true } },
      [],
    );
  }

  const blocked = await processingHeadroom(c.env, policy);
  if (!blocked.ok) {
    logRejected(principal.agentId, "global", blocked.counter);
    return rateLimited(requestId, await readAgentLimits(c.env, policy, principal.agentId), blocked.retryAfter);
  }

  const assetId = uuidv7();
  const token = await newUploadToken();
  const createdAt = utcSeconds();
  const expiresAt = hoursAhead(policy.retention.reservation_hours);
  // The replay record never holds the token; a replay mints a new one (reissueToken).
  const outcome = { status: 201, body: { asset_id: assetId, expires_at: expiresAt } };
  return remember(c.env, requestId, policy, principal.agentId, RESERVE_ROUTE, key, bodyHash, outcome, [
    c.env.DB.prepare(
      `INSERT INTO assets
         (id, agent_id, state, content_type, byte_size, sha256, thumb_byte_size, thumb_sha256,
          reason_code, original_stored, created_at, expires_at)
       VALUES (?, ?, 'reserved', ?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
    ).bind(
      assetId,
      principal.agentId,
      parsed.contentType,
      parsed.byteSize,
      parsed.sha256,
      parsed.thumb?.byteSize ?? null,
      parsed.thumb?.sha256 ?? null,
      createdAt,
      expiresAt,
    ),
    c.env.DB.prepare(
      "INSERT INTO upload_tokens (asset_id, token_hash, expires_at) VALUES (?, ?, ?)",
    ).bind(assetId, await sha256Hex(token), expiresAt),
  ], { upload_token: token });
}

// Replaces the stored token hash so the earlier token stops working. Only a live reservation is reissued.
async function reissueToken(
  env: Env,
  requestId: string,
  policy: Policy,
  agentId: string,
  assetId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const token = await newUploadToken();
  const rotated = await env.DB.prepare(
    `UPDATE upload_tokens SET token_hash = ?
      WHERE asset_id = ? AND expires_at > ?
        AND EXISTS (SELECT 1 FROM assets WHERE id = ? AND agent_id = ? AND state = 'reserved')`,
  ).bind(await sha256Hex(token), assetId, utcSeconds(), assetId, agentId).run();
  if (Number(rotated.meta.changes ?? 0) !== 1) return agentError(env, policy, requestId, agentId, "state_conflict");
  return jsonResponse(requestId, { ...body, upload_token: token }, 201);
}

async function putPart(c: Ctx, part: Part): Promise<Response> {
  const requestId = c.get("requestId");
  const policy = c.get("policy");
  const assetId = c.req.param("id");
  if (assetId === undefined || !isUuidV7(assetId)) return errorResponse(requestId, "not_found");
  const key = headerKey(c.req.raw);
  if (key === null) return errorResponse(requestId, "malformed");
  const token = c.req.header("upload-token");
  if (token === undefined || !UPLOAD_TOKEN.test(token)) return errorResponse(requestId, "credential_invalid", TOKEN_MESSAGE);
  const reservation = await c.env.DB.prepare(
    `SELECT assets.agent_id AS agent_id, assets.state AS state, assets.content_type AS content_type,
            assets.${part.sizeColumn} AS byte_size, assets.${part.hashColumn} AS sha256,
            assets.${part.storedColumn} AS stored,
            upload_tokens.expires_at AS expires_at, agents.state AS agent_state
       FROM upload_tokens
       JOIN assets ON assets.id = upload_tokens.asset_id
       JOIN agents ON agents.id = assets.agent_id
      WHERE upload_tokens.token_hash = ? AND assets.id = ?`,
  ).bind(await sha256Hex(token), assetId).first<Reservation>();
  if (!reservation || reservation.agent_state !== "active") {
    return errorResponse(requestId, "credential_invalid", TOKEN_MESSAGE);
  }
  const expiry = Date.parse(reservation.expires_at);
  if (Number.isNaN(expiry) || expiry <= Date.now()) return errorResponse(requestId, "credential_invalid", TOKEN_MESSAGE);

  const route = `PUT /v1/uploads/${assetId}/${part.path}`;
  const capped = await readCapped(c.req.raw, policy.upload.max_bytes);
  if (!capped.ok) {
    if (reservation.state === "reserved" && reservation.sha256 !== null && reservation.stored === 0) {
      await rejectStored(c.env, assetId, "too_large");
    }
    return agentError(c.env, policy, requestId, reservation.agent_id, "payload_too_large");
  }

  const bodyHash = await sha256HexBytes(capped.bytes);
  const prior = await readIdempotency(c.env.DB, reservation.agent_id, route, key, bodyHash);
  if (prior.action === "replay") return jsonResponse(requestId, prior.body, prior.status);
  if (prior.action === "conflict") {
    return agentError(c.env, policy, requestId, reservation.agent_id, "idempotency_conflict");
  }
  if (reservation.state !== "reserved" || reservation.sha256 === null) {
    return remember(c.env, requestId, policy, reservation.agent_id, route, key, bodyHash, failure("state_conflict"), []);
  }
  if (capped.bytes.byteLength !== reservation.byte_size || bodyHash !== reservation.sha256) {
    return remember(c.env, requestId, policy, reservation.agent_id, route, key, bodyHash, failure("validation_failed"), []);
  }

  const sniffed = sniffedType(capped.bytes);
  if (sniffed === null) {
    return rejectUpload(c, part, reservation.agent_id, route, key, bodyHash, assetId, "unsupported_type", "unsupported_media", capped.bytes);
  }
  if (sniffed !== reservation.content_type) {
    return rejectUpload(c, part, reservation.agent_id, route, key, bodyHash, assetId, "signature_mismatch", "validation_failed", capped.bytes);
  }
  if (isAnimated(capped.bytes, sniffed)) {
    return rejectUpload(c, part, reservation.agent_id, route, key, bodyHash, assetId, "animated", "validation_failed", capped.bytes);
  }

  const blocked = await processingHeadroom(c.env, policy);
  if (!blocked.ok) {
    logRejected(reservation.agent_id, "global", blocked.counter);
    return rateLimited(requestId, await readAgentLimits(c.env, policy, reservation.agent_id), blocked.retryAfter);
  }

  await c.env.MEDIA.put(part.stagedKey(assetId), capped.bytes, {
    httpMetadata: { contentType: reservation.content_type },
  });
  const outcome = { status: 200, body: { asset_id: assetId, state: "reserved" } };
  return remember(c.env, requestId, policy, reservation.agent_id, route, key, bodyHash, outcome, [
    c.env.DB.prepare(
      `UPDATE assets SET ${part.storedColumn} = 1 WHERE id = ? AND state = 'reserved'`,
    ).bind(assetId),
  ]);
}

async function complete(c: Ctx): Promise<Response> {
  const requestId = c.get("requestId");
  const policy = c.get("policy");
  const assetId = c.req.param("id");
  if (assetId === undefined || !isUuidV7(assetId)) return errorResponse(requestId, "not_found");
  const principal = await requireAgent(c.env, c.req.raw);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  if (principal.kind !== "agent") return errorResponse(requestId, "credential_invalid");
  const key = headerKey(c.req.raw);
  if (key === null) return agentError(c.env, policy, requestId, principal.agentId, "malformed");
  if (await hasBody(c.req.raw)) return agentError(c.env, policy, requestId, principal.agentId, "malformed");

  const route = `POST /v1/uploads/${assetId}/complete`;
  const bodyHash = await sha256Hex("");
  const prior = await readIdempotency(c.env.DB, principal.agentId, route, key, bodyHash);
  if (prior.action === "replay") return jsonResponse(requestId, prior.body, prior.status);
  if (prior.action === "conflict") {
    return agentError(c.env, policy, requestId, principal.agentId, "idempotency_conflict");
  }

  const asset = await c.env.DB.prepare(
    "SELECT state, original_stored, thumb_sha256, thumb_stored FROM assets WHERE id = ? AND agent_id = ?",
  ).bind(assetId, principal.agentId).first<{
    state: string;
    original_stored: number;
    thumb_sha256: string | null;
    thumb_stored: number;
  }>();
  if (!asset) return agentError(c.env, policy, requestId, principal.agentId, "not_found");
  const thumbMissing = asset.thumb_sha256 !== null && asset.thumb_stored !== 1;
  if (asset.state !== "reserved" || asset.original_stored !== 1 || thumbMissing) {
    return remember(c.env, requestId, policy, principal.agentId, route, key, bodyHash, failure("state_conflict"), []);
  }

  const blocked = await processingHeadroom(c.env, policy);
  if (!blocked.ok) {
    logRejected(principal.agentId, "global", blocked.counter);
    return rateLimited(requestId, await readAgentLimits(c.env, policy, principal.agentId), blocked.retryAfter);
  }

  const claimed = await c.env.DB.prepare(
    `UPDATE assets SET state = 'uploaded'
      WHERE id = ? AND agent_id = ? AND state = 'reserved' AND original_stored = 1
        AND (thumb_sha256 IS NULL OR thumb_stored = 1)`,
  ).bind(assetId, principal.agentId).run();
  if (Number(claimed.meta.changes ?? 0) !== 1) {
    return remember(c.env, requestId, policy, principal.agentId, route, key, bodyHash, failure("state_conflict"), []);
  }
  try {
    await c.env.ASSET_UPLOAD.send({ asset_id: assetId });
  } catch {
    await c.env.DB.prepare(
      "UPDATE assets SET state = 'reserved' WHERE id = ? AND agent_id = ? AND state = 'uploaded'",
    ).bind(assetId, principal.agentId).run();
    return agentError(c.env, policy, requestId, principal.agentId, "processing_unavailable");
  }
  const outcome = { status: 202, body: { asset_id: assetId, state: "uploaded" } };
  return remember(c.env, requestId, policy, principal.agentId, route, key, bodyHash, outcome, []);
}

async function assetStatus(c: Ctx): Promise<Response> {
  const requestId = c.get("requestId");
  const assetId = c.req.param("id");
  if (assetId === undefined || !isUuidV7(assetId)) return errorResponse(requestId, "not_found");
  const principal = await requireAgent(c.env, c.req.raw);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  if (principal.kind !== "agent") return errorResponse(requestId, "credential_invalid");
  const asset = await c.env.DB.prepare(
    "SELECT id, state, reason_code, blocked FROM assets WHERE id = ? AND agent_id = ?",
  ).bind(assetId, principal.agentId).first<{ id: string; state: string; reason_code: string | null; blocked: number }>();
  if (!asset) return errorResponse(requestId, "not_found");
  const body: Record<string, unknown> = { asset_id: asset.id, state: asset.state };
  // A Blocked Hash rejection is reported as `blocked` (CT-21). The stored reason_code CHECK predates it.
  if (asset.state === "rejected" && asset.blocked === 1) body.reason_code = "blocked";
  else if (asset.state === "rejected" && asset.reason_code !== null) body.reason_code = asset.reason_code;
  return jsonResponse(requestId, body);
}

async function assetContent(c: Ctx): Promise<Response> {
  const requestId = c.get("requestId");
  const assetId = c.req.param("id");
  if (assetId === undefined || !isUuidV7(assetId)) return errorResponse(requestId, "not_found");
  const variant = c.req.query("variant");
  if (variant !== "display" && variant !== "thumb") return errorResponse(requestId, "malformed");
  const reader = await assetReader(c);
  if ("error" in reader) {
    const published = await projectAsset(c.env.DB, assetId, { kind: "anonymous" });
    if (published === "allow") return derivativeResponse(c.env, requestId, assetId, variant);
    return errorResponse(requestId, reader.error);
  }
  const decision = await projectAsset(c.env.DB, assetId, reader);
  if (decision !== "allow") return errorResponse(requestId, decision);
  return derivativeResponse(c.env, requestId, assetId, variant);
}

async function assetReader(c: Ctx): Promise<AssetReader | { error: ErrorCode }> {
  if (c.req.raw.headers.get("authorization") !== null) {
    const principal = await requireAgent(c.env, c.req.raw);
    if (!principal.ok) return { error: principal.code };
    if (principal.kind !== "agent") return { error: "credential_invalid" };
    return { kind: "agent", agentId: principal.agentId };
  }
  const moderator = await requireModerator(c.env, c.req.raw, c.executionCtx);
  if (moderator.ok && moderator.kind === "moderator") return { kind: "moderator" };
  return { kind: "anonymous" };
}

async function derivativeResponse(
  env: Env,
  requestId: string,
  assetId: string,
  variant: "display" | "thumb",
): Promise<Response> {
  const object = await env.MEDIA.get(derivativeKey(assetId, variant));
  if (!object) return errorResponse(requestId, "not_found");
  return bytesResponse(requestId, new Uint8Array(await object.arrayBuffer()), "image/webp");
}

type Reservation = {
  agent_id: string;
  state: string;
  content_type: string;
  byte_size: number | null;
  sha256: string | null;
  stored: number;
  expires_at: string;
  agent_state: string;
};

type Declared = { byteSize: number; sha256: string };

type ReserveResult =
  | { ok: true; contentType: string; byteSize: number; sha256: string; thumb: Declared | null }
  | { ok: false; code: ErrorCode };

function parseReserve(body: Record<string, unknown>, policy: Policy): ReserveResult {
  const allowed = new Set(["content_type", "byte_size", "sha256", "thumb"]);
  if (!Object.keys(body).every((key) => allowed.has(key))) return { ok: false, code: "malformed" };
  if (typeof body.content_type !== "string") return { ok: false, code: "malformed" };
  const display = parseDeclared(body.byte_size, body.sha256);
  if (!display.ok) return display;
  let thumb: Declared | null = null;
  if (body.thumb !== undefined) {
    const value = body.thumb;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, code: "malformed" };
    const fields = value as Record<string, unknown>;
    if (!Object.keys(fields).every((key) => key === "byte_size" || key === "sha256")) return { ok: false, code: "malformed" };
    const parsed = parseDeclared(fields.byte_size, fields.sha256);
    if (!parsed.ok) return parsed;
    thumb = { byteSize: parsed.byteSize, sha256: parsed.sha256 };
  }
  if (!policy.upload.allowed_types.includes(body.content_type)) return { ok: false, code: "unsupported_media" };
  if (display.byteSize > policy.upload.max_bytes) return { ok: false, code: "payload_too_large" };
  if (display.byteSize < 1) return { ok: false, code: "validation_failed" };
  if (!SHA256.test(display.sha256)) return { ok: false, code: "validation_failed" };
  if (thumb) {
    if (thumb.byteSize > policy.upload.max_bytes) return { ok: false, code: "payload_too_large" };
    if (thumb.byteSize < 1 || !SHA256.test(thumb.sha256)) return { ok: false, code: "validation_failed" };
  }
  return { ok: true, contentType: body.content_type, byteSize: display.byteSize, sha256: display.sha256, thumb };
}

function parseDeclared(byteSize: unknown, sha256: unknown): { ok: true; byteSize: number; sha256: string } | { ok: false; code: ErrorCode } {
  if (typeof sha256 !== "string" || typeof byteSize !== "number") return { ok: false, code: "malformed" };
  if (!Number.isInteger(byteSize)) return { ok: false, code: "malformed" };
  return { ok: true, byteSize, sha256 };
}

function headerKey(request: Request): string | null {
  const key = request.headers.get("idempotency-key");
  if (key === null || !isValidRunId(key)) return null;
  return key;
}

function failure(code: ErrorCode): Outcome {
  const error = ERRORS[code];
  return { status: error.status, body: { error: { code, message: error.message } } };
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
  reveal: Record<string, unknown> = {},
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
  return jsonResponse(requestId, { ...outcome.body, ...reveal }, outcome.status);
}

async function rejectUpload(
  c: Ctx,
  part: Part,
  agentId: string,
  route: string,
  key: string,
  bodyHash: string,
  assetId: string,
  reason: ReasonCode,
  code: ErrorCode,
  bytes: Uint8Array,
): Promise<Response> {
  await c.env.MEDIA.put(part.stagedKey(assetId), bytes, { httpMetadata: { contentType: "application/octet-stream" } });
  const requestId = c.get("requestId");
  const outcome = failure(code);
  return remember(c.env, requestId, c.get("policy"), agentId, route, key, bodyHash, outcome, [
    c.env.DB.prepare(
      `UPDATE assets SET state = 'rejected', reason_code = ?, rejected_at = ?, ${part.storedColumn} = 1 WHERE id = ? AND state = 'reserved'`,
    ).bind(reason, utcSeconds(), assetId),
  ]);
}

async function rejectStored(env: Env, assetId: string, reason: ReasonCode): Promise<void> {
  await env.DB.prepare(
    "UPDATE assets SET state = 'rejected', reason_code = ?, rejected_at = ? WHERE id = ? AND state = 'reserved'",
  ).bind(reason, utcSeconds(), assetId).run();
  console.log(JSON.stringify({ message: "asset rejected", asset_id: assetId, reason_code: reason }));
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

async function readCapped(
  request: Request,
  cap: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > cap) return { ok: false };
  const reader = request.body?.getReader();
  if (!reader) return { ok: true, bytes: new Uint8Array() };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    const value = step.value;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

async function hasBody(request: Request): Promise<boolean> {
  const declared = request.headers.get("content-length");
  if (declared !== null && declared !== "0") return true;
  const reader = request.body?.getReader();
  if (!reader) return false;
  const step = await reader.read();
  if (step.done || step.value === undefined || step.value.byteLength === 0) return false;
  await reader.cancel();
  return true;
}
