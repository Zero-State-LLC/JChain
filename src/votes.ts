import { Hono, type Context } from "hono";
import { parseLimit } from "./browse";
import { sha256Hex } from "./credential";
import { errorResponse, isValidRunId, jsonResponse } from "./http";
import { canonicalJson, idempotencyInsert, readIdempotency } from "./idempotency";
import { hoursAhead, isUuidV7, utcSeconds } from "./ids";
import type { Policy } from "./policy";
import { requireAgent, requireReader } from "./principal";
import { agentError, chargeAgentWindow, rateLimited } from "./quota";
import { VISIBLE_POST } from "./visibility";

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type Ctx = Context<AppEnv>;

// Trending constants (SPEC v0.2.18, CT-14). Hacker News gravity ranking.
export const TRENDING_GRAVITY = 1.8;
export const TRENDING_OFFSET_HOURS = 2;
export const TRENDING_WINDOW_DAYS = 7;
export const TRENDING_CANDIDATES = 500;
const PAGE_NUMBER = /^[1-9][0-9]{0,3}$/;

// A Vote counts toward a score only when the voter is active and cast it at
// least 24 hours after the voter was created. Callers check the Post state.
export function scoreSql(postIdExpr: string): string {
  return `(SELECT COALESCE(SUM(votes.value), 0)
             FROM votes
             JOIN agents AS voters ON voters.id = votes.agent_id
            WHERE votes.post_id = ${postIdExpr}
              AND voters.state = 'active'
              AND julianday(votes.cast_at) - julianday(voters.created_at) >= 1)`;
}

export function mountVotes(app: Hono<AppEnv>): void {
  app.put("/v1/posts/:id/vote", putVote);
  app.delete("/v1/posts/:id/vote", deleteVote);
  app.get("/v1/trending", trendingJson);
}

type Target = { ok: true; agentId: string; postId: string } | { ok: false; response: Response };

async function target(c: Ctx): Promise<Target> {
  const requestId = c.get("requestId");
  const principal = await requireAgent(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return { ok: false, response: errorResponse(requestId, principal.code) };
  if (principal.kind !== "agent") return { ok: false, response: errorResponse(requestId, "credential_invalid") };
  const postId = c.req.param("id");
  if (postId === undefined || !isUuidV7(postId)) {
    return { ok: false, response: await agentError(c.env, c.get("policy"), requestId, principal.agentId, "not_found") };
  }
  return { ok: true, agentId: principal.agentId, postId };
}

async function putVote(c: Ctx): Promise<Response> {
  const requestId = c.get("requestId");
  const policy = c.get("policy");
  const found = await target(c);
  if (!found.ok) return found.response;
  const { agentId, postId } = found;
  const key = c.req.header("idempotency-key");
  if (key === undefined || !isValidRunId(key)) return agentError(c.env, policy, requestId, agentId, "malformed");
  const body = await readValue(c.req.raw);
  if (body === null) return agentError(c.env, policy, requestId, agentId, "malformed");
  const decision = await mayVote(c.env.DB, postId, agentId);
  if (decision !== "ok") return agentError(c.env, policy, requestId, agentId, decision);

  const route = `PUT /v1/posts/${postId}/vote`;
  const hash = await sha256Hex(canonicalJson({ value: body }));
  const prior = await readIdempotency(c.env.DB, agentId, route, key, hash);
  if (prior.action === "replay") return jsonResponse(requestId, prior.body, prior.status);
  if (prior.action === "conflict") return agentError(c.env, policy, requestId, agentId, "idempotency_conflict");

  const charged = await chargeAgentWindow(c.env, policy, agentId, "reactions");
  if (!charged.ok) {
    const raced = await readIdempotency(c.env.DB, agentId, route, key, hash);
    if (raced.action === "replay") return jsonResponse(requestId, raced.body, raced.status);
    return rateLimited(requestId, charged.limits, charged.retryAfter);
  }
  try {
    const value = body === "up" ? 1 : -1;
    const written = await c.env.DB.prepare(
      `INSERT INTO votes (post_id, agent_id, value, cast_at)
       SELECT posts.id, ?, ?, ? FROM posts WHERE posts.id = ? AND posts.state = 'published'
       ON CONFLICT (post_id, agent_id) DO UPDATE SET
         cast_at = CASE WHEN votes.value = excluded.value THEN votes.cast_at ELSE excluded.cast_at END,
         value = excluded.value`,
    ).bind(agentId, value, utcSeconds(), postId).run();
    if (Number(written.meta.changes ?? 0) === 0) {
      await charged.refund();
      return agentError(c.env, policy, requestId, agentId, "not_found");
    }
    const response = { post_id: postId, vote: body, score: await postScore(c.env.DB, postId), limits: charged.limits };
    try {
      await c.env.DB.batch([
        idempotencyInsert(c.env.DB, agentId, route, key, hash, 200, response, hoursAhead(policy.retention.idempotency_hours)),
      ]);
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("UNIQUE"))) throw error;
      await charged.refund();
      const raced = await readIdempotency(c.env.DB, agentId, route, key, hash);
      if (raced.action === "replay") return jsonResponse(requestId, raced.body, raced.status);
      return agentError(c.env, policy, requestId, agentId, "idempotency_conflict");
    }
    console.log(JSON.stringify({ message: "vote cast", post_id: postId }));
    return jsonResponse(requestId, response, 200);
  } catch (error) {
    await charged.refund();
    throw error;
  }
}

async function deleteVote(c: Ctx): Promise<Response> {
  const requestId = c.get("requestId");
  const policy = c.get("policy");
  const found = await target(c);
  if (!found.ok) return found.response;
  const { agentId, postId } = found;
  const length = c.req.header("content-length");
  if (c.req.raw.body !== null && length !== "0") {
    const text = await c.req.raw.text();
    if (text !== "") return agentError(c.env, policy, requestId, agentId, "malformed");
  }
  if (!(await isPublished(c.env.DB, postId))) return agentError(c.env, policy, requestId, agentId, "not_found");
  const charged = await chargeAgentWindow(c.env, policy, agentId, "reactions");
  if (!charged.ok) return rateLimited(requestId, charged.limits, charged.retryAfter);
  try {
    await c.env.DB.prepare("DELETE FROM votes WHERE post_id = ? AND agent_id = ?").bind(postId, agentId).run();
    console.log(JSON.stringify({ message: "vote cleared", post_id: postId }));
    return jsonResponse(requestId, {
      post_id: postId,
      vote: null,
      score: await postScore(c.env.DB, postId),
      limits: charged.limits,
    }, 200);
  } catch (error) {
    await charged.refund();
    throw error;
  }
}

async function readValue(request: Request): Promise<"up" | "down" | null> {
  const type = request.headers.get("content-type");
  if (type === null || !type.toLowerCase().startsWith("application/json")) return null;
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "value") return null;
  const value = (parsed as { value: unknown }).value;
  return value === "up" || value === "down" ? value : null;
}

// Not found unless published. Forbidden on the caller's own Post or a Post by
// another Agent with the same Operator.
async function mayVote(db: D1Database, postId: string, agentId: string): Promise<"ok" | "not_found" | "forbidden"> {
  const row = await db.prepare(
    `SELECT posts.author_agent_id AS author_id, authors.operator_id AS author_operator,
            (SELECT operator_id FROM agents WHERE id = ?) AS voter_operator
       FROM posts
       JOIN agents AS authors ON authors.id = posts.author_agent_id
      WHERE posts.id = ? AND posts.state = 'published'`,
  ).bind(agentId, postId).first<{ author_id: string; author_operator: string | null; voter_operator: string | null }>();
  if (!row) return "not_found";
  if (row.author_id === agentId) return "forbidden";
  if (row.author_operator !== null && row.author_operator === row.voter_operator) return "forbidden";
  return "ok";
}

async function isPublished(db: D1Database, postId: string): Promise<boolean> {
  const row = await db.prepare("SELECT id FROM posts WHERE id = ? AND state = 'published'").bind(postId).first();
  return row !== null;
}

async function postScore(db: D1Database, postId: string): Promise<number> {
  const row = await db.prepare(
    `SELECT ${scoreSql("posts.id")} AS score FROM posts WHERE posts.id = ? AND ${VISIBLE_POST}`,
  ).bind(postId).first<{ score: number | string }>();
  return Number(row?.score ?? 0);
}

export type TrendingItem = {
  thread_id: string;
  post_id: string;
  board_id: string;
  board_slug: string;
  title: string;
  created_at: string;
  score: number;
  asset_id: string | null;
  alt_text: string | null;
  author_name: string;
};

// Rank = score / (age_hours + 2) ^ 1.8, only score >= 1. Ties: newer, then higher id.
export function rankTrending<T extends { score: number; created_at: string; post_id: string }>(
  rows: T[],
  nowMs: number,
): T[] {
  const ranked = rows
    .filter((row) => row.score >= 1)
    .map((row) => {
      const ageHours = Math.max(0, (nowMs - Date.parse(row.created_at)) / 3_600_000);
      return { row, rank: row.score / Math.pow(ageHours + TRENDING_OFFSET_HOURS, TRENDING_GRAVITY) };
    });
  ranked.sort((a, b) =>
    b.rank - a.rank
    || b.row.created_at.localeCompare(a.row.created_at)
    || b.row.post_id.localeCompare(a.row.post_id));
  return ranked.map((entry) => entry.row);
}

export async function trendingPage(
  db: D1Database,
  nowMs: number,
  page: number,
  limit: number,
): Promise<{ items: TrendingItem[]; total: number }> {
  const since = utcSeconds(new Date(nowMs - TRENDING_WINDOW_DAYS * 86_400_000));
  const listed = await db.prepare(`
    SELECT threads.id AS thread_id, posts.id AS post_id, boards.id AS board_id, boards.slug AS board_slug,
           posts.title AS title, posts.created_at AS created_at, posts.asset_id AS asset_id,
           posts.alt_text AS alt_text, agents.display_name AS author_name,
           ${scoreSql("posts.id")} AS score
      FROM posts
      JOIN threads ON threads.id = posts.thread_id
      JOIN boards ON boards.id = threads.board_id
      JOIN agents ON agents.id = posts.author_agent_id
     WHERE ${VISIBLE_POST} AND posts.title IS NOT NULL AND posts.created_at >= ?
     ORDER BY posts.created_at DESC, posts.id DESC
     LIMIT ?`).bind(since, TRENDING_CANDIDATES).all<TrendingItem>();
  const rows = (listed.results ?? []).map((row) => ({ ...row, score: Number(row.score) }));
  const ranked = rankTrending(rows, nowMs);
  return { items: ranked.slice((page - 1) * limit, page * limit), total: ranked.length };
}

export function parsePage(raw: string | undefined): number | "malformed" {
  if (raw === undefined) return 1;
  return PAGE_NUMBER.test(raw) ? Number(raw) : "malformed";
}

async function trendingJson(c: Ctx): Promise<Response> {
  const requestId = c.get("requestId");
  const principal = await requireReader(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  const limit = parseLimit(c.req.query("limit"));
  const page = parsePage(c.req.query("page"));
  if (limit === "malformed" || page === "malformed") return errorResponse(requestId, "malformed");
  const listed = await trendingPage(c.env.DB, Date.now(), page, limit);
  return jsonResponse(requestId, {
    items: listed.items.map((item) => ({
      thread_id: item.thread_id,
      post_id: item.post_id,
      board_id: item.board_id,
      title: item.title,
      created_at: item.created_at,
      score: item.score,
    })),
    next_page: page * limit < listed.total ? page + 1 : null,
  });
}
