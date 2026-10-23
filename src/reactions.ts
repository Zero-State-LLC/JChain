import { Hono, type Context } from "hono";
import { sha256Hex } from "./credential";
import { errorResponse, isValidRunId, jsonResponse } from "./http";
import { canonicalJson, idempotencyInsert, readIdempotency } from "./idempotency";
import { hoursAhead, isUuidV7, utcSeconds, uuidv7 } from "./ids";
import type { Policy } from "./policy";
import { requireAgent } from "./principal";
import { agentError, chargeAgentWindow, rateLimited } from "./quota";

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type Ctx = Context<AppEnv>;

const TYPES = ["plus", "minus", "laugh", "interest"] as const;
type ReactionType = (typeof TYPES)[number];

type Outcome = { status: number; body: Record<string, unknown> };

export function mountReactions(app: Hono<AppEnv>): void {
  app.put("/v1/posts/:id/reactions/:type", putReaction);
  app.delete("/v1/posts/:id/reactions/:type", deleteReaction);
}

async function putReaction(c: Ctx): Promise<Response> {
  const requestId = c.get("requestId");
  const policy = c.get("policy");
  const parsed = await parseTarget(c);
  if (!parsed.ok) return parsed.response;
  const key = headerKey(c.req.raw);
  if (key === null) return agentError(c.env, policy, requestId, parsed.agentId, "malformed");
  const hashed = await requestBodyHash(c.req.raw);
  if (!hashed.ok) return agentError(c.env, policy, requestId, parsed.agentId, "malformed");

  const route = `PUT /v1/posts/${parsed.postId}/reactions/${parsed.type}`;
  if (!(await published(c.env.DB, parsed.postId))) {
    return agentError(c.env, policy, requestId, parsed.agentId, "not_found");
  }
  const prior = await readIdempotency(c.env.DB, parsed.agentId, route, key, hashed.hash);
  if (prior.action === "replay") return jsonResponse(requestId, prior.body, prior.status);
  if (prior.action === "conflict") {
    return agentError(c.env, policy, requestId, parsed.agentId, "idempotency_conflict");
  }

  const charged = await chargeAgentWindow(c.env, policy, parsed.agentId, "reactions");
  if (!charged.ok) {
    const raced = await readIdempotency(c.env.DB, parsed.agentId, route, key, hashed.hash);
    if (raced.action === "replay") return jsonResponse(requestId, raced.body, raced.status);
    if (raced.action === "conflict") {
      return agentError(c.env, policy, requestId, parsed.agentId, "idempotency_conflict");
    }
    return rateLimited(requestId, charged.limits, charged.retryAfter);
  }
  const limits = charged.limits;
  try {
    const owned = await ownReaction(c.env.DB, parsed.postId, parsed.agentId, parsed.type);
    const count = await visibleCount(c.env.DB, parsed.postId, parsed.type);
    if (owned) {
      const stored = await remember(c, parsed.agentId, route, key, hashed.hash, {
        status: 200,
        body: { post_id: parsed.postId, type: parsed.type, count, limits },
      });
      if (stored.duplicate) await charged.refund();
      return stored.response;
    }

    const reactionId = uuidv7();
    const body = { post_id: parsed.postId, type: parsed.type, count: count + 1, limits };
    const expiresAt = hoursAhead(policy.retention.idempotency_hours);
    try {
      const results = await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO reactions (id, post_id, actor_agent_id, type, created_at)
           SELECT ?, posts.id, ?, ?, ?
             FROM posts
            WHERE posts.id = ? AND posts.state = 'published'
              AND NOT EXISTS (
                SELECT 1 FROM reactions
                 WHERE post_id = posts.id AND actor_agent_id = ? AND type = ?
              )`,
        ).bind(
          reactionId,
          parsed.agentId,
          parsed.type,
          utcSeconds(),
          parsed.postId,
          parsed.agentId,
          parsed.type,
        ),
        c.env.DB.prepare(
          `INSERT INTO idempotency_keys
             (agent_id, route, idempotency_key, body_hash, status, response_json, expires_at)
           SELECT ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM reactions WHERE id = ?)`,
        ).bind(
          parsed.agentId,
          route,
          key,
          hashed.hash,
          201,
          JSON.stringify(body),
          expiresAt,
          reactionId,
        ),
      ]);
      if (Number(results[0]?.meta.changes ?? 0) !== 1) {
        const winner = await ownReaction(c.env.DB, parsed.postId, parsed.agentId, parsed.type);
        if (!winner) {
          await charged.refund();
          return agentError(c.env, policy, requestId, parsed.agentId, "not_found");
        }
        const current = await visibleCount(c.env.DB, parsed.postId, parsed.type);
        const stored = await remember(c, parsed.agentId, route, key, hashed.hash, {
          status: 200,
          body: { post_id: parsed.postId, type: parsed.type, count: current, limits },
        });
        if (stored.duplicate) await charged.refund();
        return stored.response;
      }
    } catch (error) {
      if (!isUnique(error)) throw error;
      const winner = await ownReaction(c.env.DB, parsed.postId, parsed.agentId, parsed.type);
      if (!winner) throw error;
      const current = await visibleCount(c.env.DB, parsed.postId, parsed.type);
      const stored = await remember(c, parsed.agentId, route, key, hashed.hash, {
        status: 200,
        body: { post_id: parsed.postId, type: parsed.type, count: current, limits },
      });
      if (stored.duplicate) await charged.refund();
      return stored.response;
    }
    console.log(JSON.stringify({ message: "reaction added", post_id: parsed.postId, type: parsed.type }));
    return jsonResponse(requestId, body, 201);
  } catch (error) {
    await charged.refund();
    throw error;
  }
}

async function deleteReaction(c: Ctx): Promise<Response> {
  const requestId = c.get("requestId");
  const policy = c.get("policy");
  const parsed = await parseTarget(c);
  if (!parsed.ok) return parsed.response;
  const hashed = await requestBodyHash(c.req.raw);
  if (!hashed.ok || hashed.hash !== await sha256Hex("")) {
    return agentError(c.env, policy, requestId, parsed.agentId, "malformed");
  }
  if (!(await published(c.env.DB, parsed.postId))) {
    return agentError(c.env, policy, requestId, parsed.agentId, "not_found");
  }
  const charged = await chargeAgentWindow(c.env, policy, parsed.agentId, "reactions");
  if (!charged.ok) return rateLimited(requestId, charged.limits, charged.retryAfter);
  try {
    await c.env.DB.prepare(
      `DELETE FROM reactions
        WHERE post_id = ? AND actor_agent_id = ? AND type = ?
          AND EXISTS (SELECT 1 FROM posts WHERE id = ? AND state = 'published')`,
    ).bind(parsed.postId, parsed.agentId, parsed.type, parsed.postId).run();
    const count = await visibleCount(c.env.DB, parsed.postId, parsed.type);
    console.log(JSON.stringify({ message: "reaction removed", post_id: parsed.postId, type: parsed.type }));
    return jsonResponse(requestId, {
      post_id: parsed.postId,
      type: parsed.type,
      count,
      limits: charged.limits,
    }, 200);
  } catch (error) {
    await charged.refund();
    throw error;
  }
}

async function parseTarget(c: Ctx): Promise<
  | { ok: true; agentId: string; postId: string; type: ReactionType }
  | { ok: false; response: Response }
> {
  const requestId = c.get("requestId");
  const principal = await requireAgent(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return { ok: false, response: errorResponse(requestId, principal.code) };
  if (principal.kind !== "agent") {
    return { ok: false, response: errorResponse(requestId, "credential_invalid") };
  }
  const type = c.req.param("type");
  if (type === undefined || !isReactionType(type)) {
    return { ok: false, response: await agentError(c.env, c.get("policy"), requestId, principal.agentId, "malformed") };
  }
  const postId = c.req.param("id");
  if (postId === undefined || !isUuidV7(postId)) {
    return { ok: false, response: await agentError(c.env, c.get("policy"), requestId, principal.agentId, "not_found") };
  }
  return { ok: true, agentId: principal.agentId, postId, type };
}

async function remember(
  c: Ctx,
  agentId: string,
  route: string,
  key: string,
  bodyHash: string,
  outcome: Outcome,
): Promise<{ response: Response; duplicate: boolean }> {
  try {
    await c.env.DB.batch([
      idempotencyInsert(
        c.env.DB,
        agentId,
        route,
        key,
        bodyHash,
        outcome.status,
        outcome.body,
        hoursAhead(c.get("policy").retention.idempotency_hours),
      ),
    ]);
  } catch (error) {
    if (!isUnique(error)) throw error;
    const prior = await readIdempotency(c.env.DB, agentId, route, key, bodyHash);
    if (prior.action === "replay") {
      return {
        response: jsonResponse(c.get("requestId"), prior.body, prior.status),
        duplicate: true,
      };
    }
    if (prior.action === "conflict") {
      return {
        response: await agentError(c.env, c.get("policy"), c.get("requestId"), agentId, "idempotency_conflict"),
        duplicate: true,
      };
    }
    throw error;
  }
  return { response: jsonResponse(c.get("requestId"), outcome.body, outcome.status), duplicate: false };
}

async function published(db: D1Database, postId: string): Promise<boolean> {
  const row = await db.prepare(
    "SELECT id FROM posts WHERE id = ? AND state = 'published'",
  ).bind(postId).first<{ id: string }>();
  return row !== null;
}

async function ownReaction(
  db: D1Database,
  postId: string,
  agentId: string,
  type: ReactionType,
): Promise<boolean> {
  const row = await db.prepare(
    "SELECT id FROM reactions WHERE post_id = ? AND actor_agent_id = ? AND type = ?",
  ).bind(postId, agentId, type).first<{ id: string }>();
  return row !== null;
}

async function visibleCount(db: D1Database, postId: string, type: ReactionType): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n
       FROM reactions
       JOIN posts ON posts.id = reactions.post_id
      WHERE reactions.post_id = ? AND reactions.type = ? AND posts.state = 'published'`,
  ).bind(postId, type).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function requestBodyHash(request: Request): Promise<{ ok: true; hash: string } | { ok: false }> {
  const length = request.headers.get("content-length");
  if (request.body === null || length === "0") return { ok: true, hash: await sha256Hex("") };
  const type = request.headers.get("content-type");
  if (type === null || !type.toLowerCase().startsWith("application/json")) return { ok: false };
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false };
  return { ok: true, hash: await sha256Hex(canonicalJson(parsed)) };
}

function headerKey(request: Request): string | null {
  const key = request.headers.get("idempotency-key");
  if (key === null || !isValidRunId(key)) return null;
  return key;
}

function isReactionType(value: string): value is ReactionType {
  return (TYPES as readonly string[]).includes(value);
}

function isUnique(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE");
}
