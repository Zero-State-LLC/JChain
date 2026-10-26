import { approvedCodesSql, operatorMayAdd, operatorMayAddSql } from "./operator-admin";
import { Hono, type Context } from "hono";
import { ROSTER_COUNT, ROSTER_SUBQUERY, parseEnrollFields } from "./agent-admin";
import { newCredentialSecret, newPrefixedSecret, sha256Hex } from "./credential";
import { errorResponse, jsonResponse } from "./http";
import { utcSeconds, uuidv7 } from "./ids";
import type { OperatorCapsPolicy, Policy } from "./policy";
import { chargeHour } from "./quota";

// CT-28 (v0.2.24): connect an agent with a code its Operator approves, after the
// OAuth 2.0 Device Authorization Grant (RFC 8628). The agent never handles a
// copied secret, and no plaintext device code or Credential is stored.

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type Ctx = Context<AppEnv>;

export const CONNECT_EXPIRES_SECONDS = 600;
export const CONNECT_INTERVAL_SECONDS = 5;
export const CONNECT_PER_ADDRESS_HOUR = 20;
export const CONNECT_PER_SERVICE_HOUR = 200;
// RFC 8628 section 6.1: consonants only, so no word and no look-alike digit.
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const DEVICE_CODE = /^dc_[A-Za-z0-9_-]{43}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ConnectionRow = {
  device_hash: string;
  user_code: string;
  display_name: string;
  declared_model: string;
  // v0.2.44 (H2): the optional harness the agent declared when it asked for a code.
  harness_name?: string | null;
  harness_version?: string | null;
  state: "pending" | "approved" | "denied" | "claimed";
  operator_id: string | null;
  agent_id: string | null;
  created_at: string;
  expires_at: string;
  last_poll_at: string | null;
};

export function mountConnect(app: Hono<AppEnv>): void {
  app.post("/v1/connect", start);
  app.post("/v1/connect/token", claim);
}

function newUserCode(): string {
  let code = "";
  while (code.length < 8) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      // 240 is the largest multiple of 20 below 256, so every letter is equally likely.
      if (byte < 240 && code.length < 8) code += USER_CODE_ALPHABET[byte % 20];
    }
  }
  return code;
}

// Accepts "bcdf-ghjk", "BCDF GHJK", or "BCDFGHJK".
export function normalizeUserCode(raw: string): string | null {
  const letters = raw.toUpperCase().replace(/[\s-]/g, "");
  if (letters.length !== 8) return null;
  for (const letter of letters) if (!USER_CODE_ALPHABET.includes(letter)) return null;
  return letters;
}

export function displayUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

async function start(c: Ctx): Promise<Response> {
  const requestId = c.get("requestId");
  const policy = c.get("policy");
  const address = await sha256Hex(c.req.header("cf-connecting-ip") ?? "unknown");
  const perAddress = await chargeHour(c.env, `connect:${address}`, CONNECT_PER_ADDRESS_HOUR);
  if (!perAddress.ok) return limited(requestId, perAddress.retryAfter);
  const service = await chargeHour(c.env, "connect", CONNECT_PER_SERVICE_HOUR);
  if (!service.ok) return limited(requestId, service.retryAfter);
  const body = await readObject(c.req.raw);
  if (!body.ok) return errorResponse(requestId, "malformed");
  const parsed = parseEnrollFields(body.value);
  if (!parsed.ok) return errorResponse(requestId, parsed.code, parsed.message);
  if (parsed.value.expiresAt !== null) return errorResponse(requestId, "malformed");
  const deviceCode = newPrefixedSecret("dc_");
  const now = Date.now();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const userCode = newUserCode();
    try {
      await c.env.DB.prepare(
        `INSERT INTO agent_connections (
           device_hash, user_code, display_name, declared_model, harness_name, harness_version, state, operator_id, agent_id,
           created_at, expires_at, answered_at, last_poll_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, NULL, NULL)`,
      ).bind(
        await sha256Hex(deviceCode),
        userCode,
        parsed.value.displayName,
        parsed.value.declaredModel,
        parsed.value.harness?.name ?? null,
        parsed.value.harness?.version ?? null,
        utcSeconds(new Date(now)),
        utcSeconds(new Date(now + CONNECT_EXPIRES_SECONDS * 1000)),
      ).run();
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) continue;
      throw error;
    }
    const verification = `${policy.site_origin}/operator/connect`;
    return jsonResponse(requestId, {
      device_code: deviceCode,
      user_code: displayUserCode(userCode),
      verification_uri: verification,
      verification_uri_complete: `${verification}?code=${displayUserCode(userCode)}`,
      expires_in: CONNECT_EXPIRES_SECONDS,
      interval: CONNECT_INTERVAL_SECONDS,
    }, 201);
  }
  return errorResponse(requestId, "processing_unavailable");
}

async function claim(c: Ctx): Promise<Response> {
  const requestId = c.get("requestId");
  const policy = c.get("policy");
  const body = await readObject(c.req.raw);
  if (!body.ok) return errorResponse(requestId, "malformed");
  const keys = Object.keys(body.value);
  const deviceCode = body.value.device_code;
  if (keys.length !== 1 || typeof deviceCode !== "string") return errorResponse(requestId, "malformed");
  if (!DEVICE_CODE.test(deviceCode)) return errorResponse(requestId, "not_found");
  const deviceHash = await sha256Hex(deviceCode);
  const row = await c.env.DB.prepare(
    "SELECT * FROM agent_connections WHERE device_hash = ?",
  ).bind(deviceHash).first<ConnectionRow>();
  if (!row) return errorResponse(requestId, "not_found");
  if (row.state === "claimed") return jsonResponse(requestId, { state: "claimed" });
  const now = Date.now();
  const stamp = utcSeconds(new Date(now));
  if (row.expires_at <= stamp) return jsonResponse(requestId, { state: "expired" });
  // One conditional update, keyed by device_hash (the row has no separate id).
  // A second poll in the same window changes nothing and is the RFC slow_down.
  const earliestAllowed = utcSeconds(new Date(now - CONNECT_INTERVAL_SECONDS * 1000));
  const polled = await c.env.DB.prepare(
    `UPDATE agent_connections SET last_poll_at = ?
      WHERE device_hash = ? AND (last_poll_at IS NULL OR last_poll_at <= ?)`,
  ).bind(stamp, deviceHash, earliestAllowed).run();
  if (Number(polled.meta.changes ?? 0) === 0) return limited(requestId, CONNECT_INTERVAL_SECONDS);
  if (row.state === "pending") return jsonResponse(requestId, { state: "pending", interval: CONNECT_INTERVAL_SECONDS });
  if (row.state === "denied") return jsonResponse(requestId, { state: "denied" });
  return issue(c, requestId, policy, row, stamp);
}

// The approved code becomes an Agent and a Credential in one guarded batch.
// Only the first claim changes the row, so only one Agent can come of it.
// The approval already held a place under the Operator's cap, so the cap guard below
// refuses only an unusual path (an Admin lowered the cap, or suspended the Operator,
// after the approval). It stays as the last line of defence.
async function issue(c: Ctx, requestId: string, policy: Policy, row: ConnectionRow, stamp: string): Promise<Response> {
  const db = c.env.DB;
  const count = await db.prepare(ROSTER_COUNT).first<{ n: number }>();
  if (Number(count?.n ?? 0) >= policy.max_agents) {
    return errorResponse(requestId, "forbidden", "The agent limit is already reached.");
  }
  const agentId = uuidv7();
  const credential = await newCredentialSecret();
  const results = await db.batch([
    db.prepare(
      `UPDATE agent_connections SET state = 'claimed', agent_id = ?
        WHERE device_hash = ? AND state = 'approved' AND operator_id IS NOT NULL
          AND (${ROSTER_SUBQUERY}) < ?
          AND ${operatorMayAddSql("agent_connections.operator_id", policy.operator_caps)}`,
    ).bind(agentId, row.device_hash, policy.max_agents),
    db.prepare(
      `INSERT INTO agents (id, display_name, declared_model, harness_name, harness_version, state, operator_id, created_at)
       SELECT ?, display_name, declared_model, harness_name, harness_version, 'active', operator_id, ?
         FROM agent_connections WHERE device_hash = ? AND agent_id = ? AND state = 'claimed'`,
    ).bind(agentId, stamp, row.device_hash, agentId),
    db.prepare(
      `INSERT INTO credentials (id, agent_id, secret_hash, state, expires_at, created_at)
       SELECT ?, ?, ?, 'active', NULL, ? WHERE EXISTS (SELECT 1 FROM agents WHERE id = ?)`,
    ).bind(uuidv7(), agentId, await sha256Hex(credential), stamp, agentId),
  ]);
  if (Number(results[0]?.meta.changes ?? 0) !== 1 || Number(results[2]?.meta.changes ?? 0) !== 1) {
    if (Number(results[0]?.meta.changes ?? 0) !== 1) {
      const fresh = await db.prepare(
        "SELECT state FROM agent_connections WHERE device_hash = ?",
      ).bind(row.device_hash).first<{ state: string }>();
      const count = await db.prepare(ROSTER_COUNT).first<{ n: number }>();
      if (fresh?.state === "approved" && Number(count?.n ?? 0) >= policy.max_agents) {
        return errorResponse(requestId, "roster_full", "The agent limit is already reached.");
      }
      // v0.2.30 (CT-19): the approving Operator is suspended or at its own agent cap.
      if (fresh?.state === "approved" && row.operator_id !== null && !(await operatorMayAdd(db, row.operator_id, policy.operator_caps))) {
        return errorResponse(requestId, "forbidden", "Your Operator cannot add an agent now: it is suspended or at its agent cap.");
      }
    }
    return jsonResponse(requestId, { state: "claimed" });
  }
  console.log(JSON.stringify({ message: "agent connected", agent_id: agentId }));
  return jsonResponse(requestId, { state: "approved", agent_id: agentId, credential });
}

export async function findPending(db: D1Database, userCode: string, now = Date.now()): Promise<ConnectionRow | null> {
  return db.prepare(
    "SELECT * FROM agent_connections WHERE user_code = ? AND state = 'pending' AND expires_at > ?",
  ).bind(userCode, utcSeconds(new Date(now))).first<ConnectionRow>();
}

export async function answerConnection(
  db: D1Database,
  userCode: string,
  operatorId: string,
  decision: "approve" | "deny",
  now = Date.now(),
  // CT-29: statements that commit in the same batch, after the answer (the attestation).
  alongside: D1PreparedStatement[] = [],
  caps?: OperatorCapsPolicy,
): Promise<boolean> {
  const stamp = utcSeconds(new Date(now));
  // CT-19, CT-28: an approval holds one of the Operator's places until it is claimed or expires,
  // so it lands only while the Operator may add an Agent, counting codes it already approved.
  // A refused approval leaves the code pending. A deny always lands.
  const answer = decision === "approve"
    ? db.prepare(
      `UPDATE agent_connections SET state = 'approved', operator_id = ?, answered_at = ?
        WHERE user_code = ? AND state = 'pending' AND expires_at > ?
          AND ${operatorMayAddSql("?", caps, approvedCodesSql(stamp))}`,
    ).bind(operatorId, stamp, userCode, stamp, operatorId)
    : db.prepare(
      `UPDATE agent_connections SET state = 'denied', operator_id = ?, answered_at = ?
        WHERE user_code = ? AND state = 'pending' AND expires_at > ?`,
    ).bind(operatorId, stamp, userCode, stamp);
  const results = await db.batch([answer, ...alongside]);
  return Number(results[0]?.meta.changes ?? 0) === 1;
}

// Retention: a request is deleted one day after it expires. Codes live ten minutes.
export async function purgeConnections(db: D1Database, now: number, limit = 500): Promise<number> {
  const result = await db.prepare(
    `DELETE FROM agent_connections WHERE device_hash IN (
       SELECT device_hash FROM agent_connections WHERE expires_at <= ? LIMIT ?)`,
  ).bind(utcSeconds(new Date(now - DAY_MS)), limit).run();
  return Number(result.meta.changes ?? 0);
}

function limited(requestId: string, retryAfter: number): Response {
  const response = errorResponse(requestId, "rate_limited");
  response.headers.set("retry-after", String(retryAfter));
  return response;
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
