import { Hono } from "hono";
import { derivativeKey, originalKey, originalThumbKey, refundDerivatives } from "./asset-pipeline";
import { dropPublishedCopies } from "./feeds";
import { errorResponse, jsonResponse } from "./http";
import { isUuidV7, utcSeconds, uuidv7 } from "./ids";
import { sameOrigin } from "./origin";
import { requireOperator } from "./principal";
import { ownerDeleted, tombstoneStatements } from "./tombstone";
import type { AppEnv, Ctx } from "./hono-env";

type App = Hono<AppEnv>;
type DeletionEnv = Pick<Env, "DB" | "MEDIA" | "QUOTA">;

// FR-13 and CT-10 (round-2 audit rows 1 and 9). An owner deletion marks the Agent with the time of
// the request (agents.deletion_requested_at). Every Post and Asset the Agent created at or before
// that time is in scope. From the mark on, an in-scope Post is off every read path and its bytes
// are not served (the Visibility Projection reads the mark), and approve and restore refuse it.
// The rows are then moved in bounded batches: one batch inside the request, the rest by the daily
// retention run, so the request never runs unbounded and nothing waits on the Operator to retry.
//
// A quarantined Post is waiting for a Moderator, and may be evidence (an S4 scan or a csam Seat
// Flag sets no legal hold). Owner deletion leaves it quarantined, keeps its image bytes, and never
// blocks the Moderator's decision on it: an Archive removes it, and a Clear is applied as a
// removal instead of a republish. Its bytes then follow normal retention.

// Posts moved to removal_pending, and removals finished, per batch.
export const DELETION_POST_BATCH = 25;
// Assets whose bytes are deleted per batch. Each costs two R2 reads and one QUOTA call.
export const DELETION_ASSET_BATCH = 20;
// Batches the daily retention run spends on unfinished owner deletions, across all Agents.
export const DELETION_RUN_BATCHES = 40;

// Posts an owner deletion moves to removal_pending. Quarantined Posts wait for a Moderator.
const QUEUED_STATES = "('published', 'hidden', 'rejected', 'flagged', 'pending_review')";

// An Asset no live Post uses: every Post on it is removed, being removed, or rejected, and none is
// under a legal hold. A quarantined Post is live: it waits for a Moderator and keeps the bytes.
const NO_LIVE_POST = `NOT EXISTS (
  SELECT 1 FROM posts
   WHERE posts.asset_id = assets.id
     AND (posts.legal_hold = 1 OR posts.state NOT IN ('removal_pending', 'removed', 'rejected')))`;

const ASSET_IN_SCOPE = `assets.agent_id = ? AND assets.created_at <= (
  SELECT deletion_requested_at FROM agents WHERE agents.id = assets.agent_id)`;

export function mountDeletion(app: App): void {
  app.post("/v1/deletion-requests", requestDeletion);
}

async function requestDeletion(c: Ctx): Promise<Response> {
  const opened = await gate(c);
  if (opened instanceof Response) return opened;
  const requestId = c.get("requestId");
  const parsed = await readObject(c.req.raw);
  if (!parsed.ok) return errorResponse(requestId, "malformed");
  const agentId = agentIdFrom(parsed.value);
  if (agentId === null) return errorResponse(requestId, "malformed");
  if (!isUuidV7(agentId)) return errorResponse(requestId, "not_found");

  const agent = await c.env.DB.prepare(
    "SELECT id, operator_id, deletion_requested_at FROM agents WHERE id = ?",
  ).bind(agentId).first<{ id: string; operator_id: string | null; deletion_requested_at: string | null }>();
  if (!agent) return errorResponse(requestId, "not_found");
  const operator = await c.env.DB.prepare(
    "SELECT id FROM operators WHERE email = ? AND state IN ('provisional', 'approved')",
  ).bind(opened.email).first<{ id: string }>();
  if (!operator || operator.id !== agent.operator_id) return errorResponse(requestId, "forbidden");

  const requestedAt = utcSeconds();
  // A repeated request widens the scope to the Posts made since the last one.
  const newlyInScope = await c.env.DB.prepare(
    `SELECT 1 AS one FROM posts
      WHERE author_agent_id = ? AND created_at <= ?
        AND (? IS NULL OR created_at > ?)
        AND state IN ('published', 'hidden', 'rejected', 'flagged', 'pending_review', 'quarantined')
      LIMIT 1`,
  ).bind(agentId, requestedAt, agent.deletion_requested_at, agent.deletion_requested_at).first();
  await c.env.DB.prepare("UPDATE agents SET deletion_requested_at = ? WHERE id = ?")
    .bind(requestedAt, agentId).run();

  let changed = newlyInScope !== null;
  try {
    if (await deletionBatch(c.env, agentId, opened.email)) changed = true;
  } catch (error) {
    if (!isUnique(error)) throw error;
    return errorResponse(requestId, "state_conflict");
  }
  if (!changed) return errorResponse(requestId, "state_conflict");
  console.log(JSON.stringify({ message: "deletion requested", agent_id: agentId }));
  return jsonResponse(requestId, { agent_id: agentId });
}

// One bounded batch of an Agent's owner deletion. True when it changed anything.
export async function deletionBatch(env: DeletionEnv, agentId: string, actor: string): Promise<boolean> {
  const queued = await queueRemovals(env.DB, agentId, actor, utcSeconds());
  if (queued.publishedIds.length > 0) await dropPublishedCopies(env, queued.publishedIds);
  const revoked = await revokeAssets(env, agentId);
  const finished = await finishRemovals(env.DB, agentId);
  return queued.changed || revoked || finished;
}

// Daily retention (round-2 audit row 9): continues every owner deletion that still has work, up to
// DELETION_RUN_BATCHES batches. The audit actor of a removal it queues is `system`.
export async function continueDeletions(env: DeletionEnv): Promise<number> {
  const listed = await env.DB.prepare(
    `SELECT agents.id AS id FROM agents
      WHERE agents.deletion_requested_at IS NOT NULL
        AND (EXISTS (
              SELECT 1 FROM posts
               WHERE posts.author_agent_id = agents.id
                 AND ((posts.state IN ${QUEUED_STATES} AND posts.created_at <= agents.deletion_requested_at)
                   OR (posts.state = 'removal_pending' AND posts.legal_hold = 0)))
          OR EXISTS (
              SELECT 1 FROM assets
               WHERE assets.agent_id = agents.id AND assets.created_at <= agents.deletion_requested_at
                 AND assets.state IN ('ready', 'quarantined', 'deletion_pending') AND ${NO_LIVE_POST}))
      ORDER BY agents.deletion_requested_at, agents.id
      LIMIT ?`,
  ).bind(DELETION_RUN_BATCHES).all<{ id: string }>();
  const agents = (listed.results ?? []).map((row) => row.id);
  let batches = 0;
  for (const agentId of agents) {
    while (batches < DELETION_RUN_BATCHES) {
      batches += 1;
      if (!(await deletionBatch(env, agentId, "system"))) break;
    }
    if (batches >= DELETION_RUN_BATCHES) break;
  }
  return batches;
}

async function queueRemovals(
  db: D1Database,
  agentId: string,
  actor: string,
  occurredAt: string,
): Promise<{ changed: boolean; publishedIds: string[] }> {
  const listed = await db.prepare(
    `SELECT posts.id AS id, posts.state AS state FROM posts
      WHERE posts.author_agent_id = ? AND posts.state IN ${QUEUED_STATES} AND ${ownerDeleted("posts")}
      ORDER BY posts.created_at, posts.id
      LIMIT ${DELETION_POST_BATCH}`,
  ).bind(agentId).all<{ id: string; state: string }>();
  const rows = listed.results ?? [];
  if (rows.length === 0) return { changed: false, publishedIds: [] };
  const statements: D1PreparedStatement[] = [];
  for (const post of rows) {
    if (post.state === "published") {
      statements.push(db.prepare(
        `INSERT INTO events (id, type, resource_id, occurred_at)
         SELECT ?, 'post.withdrawn', posts.id, ?
           FROM posts
          WHERE posts.id = ? AND posts.state = 'published'`,
      ).bind(uuidv7(), occurredAt, post.id));
    } else if (post.state === "flagged") {
      statements.push(db.prepare(
        `INSERT INTO events (id, type, resource_id, occurred_at)
         SELECT ?, 'post.withdrawn', posts.id, ?
           FROM posts
          WHERE posts.id = ? AND posts.state = 'flagged'
            AND NOT EXISTS (
              SELECT 1 FROM events AS e
               WHERE e.resource_id = posts.id
                 AND e.type = 'post.withdrawn'
                 AND NOT EXISTS (
                   SELECT 1 FROM events AS r
                    WHERE r.resource_id = posts.id
                      AND r.type IN ('post.published', 'post.restored')
                      AND (r.occurred_at > e.occurred_at OR (r.occurred_at = e.occurred_at AND r.id > e.id))
                 )
            )`,
      ).bind(uuidv7(), occurredAt, post.id));
    }
    statements.push(db.prepare(
      `INSERT INTO moderation_actions (
         id, actor_email, target_type, target_id, action, reason_code, private_note, event_id, created_at
       )
       SELECT ?, ?, 'post', posts.id, 'remove', 'other', NULL, NULL, ?
         FROM posts
        WHERE posts.id = ? AND posts.state IN ${QUEUED_STATES}`,
    ).bind(uuidv7(), actor, occurredAt, post.id));
  }
  const placeholders = rows.map(() => "?").join(", ");
  statements.push(db.prepare(
    `UPDATE posts SET state = 'removal_pending'
      WHERE author_agent_id = ? AND state IN ${QUEUED_STATES} AND id IN (${placeholders})`,
  ).bind(agentId, ...rows.map((post) => post.id)));
  const results = await db.batch(statements);
  const changed = Number(results[results.length - 1]?.meta.changes ?? 0) > 0;
  return {
    changed,
    publishedIds: changed ? rows.filter((post) => post.state === "published").map((post) => post.id) : [],
  };
}

async function revokeAssets(env: DeletionEnv, agentId: string): Promise<boolean> {
  const listed = await env.DB.prepare(
    // Part D: an owner deletion never destroys evidence under legal hold, nor the image of a Post
    // still waiting in quarantine for a Moderator.
    `SELECT id FROM assets
      WHERE ${ASSET_IN_SCOPE} AND state IN ('ready', 'quarantined', 'deletion_pending') AND ${NO_LIVE_POST}
      ORDER BY created_at, id
      LIMIT ${DELETION_ASSET_BATCH}`,
  ).bind(agentId).all<{ id: string }>();
  const ids = (listed.results ?? []).map((row) => row.id);
  if (ids.length === 0) return false;
  const placeholders = ids.map(() => "?").join(", ");
  // The guards are re-checked in the write, so a Post that took the Asset in between keeps it.
  await env.DB.prepare(
    `UPDATE assets SET state = 'deletion_pending'
      WHERE id IN (${placeholders}) AND ${ASSET_IN_SCOPE} AND state IN ('ready', 'quarantined') AND ${NO_LIVE_POST}`,
  ).bind(...ids, agentId).run();
  // Only Assets this batch moved, or an earlier one left, in deletion_pending lose their bytes.
  const claimed = await env.DB.prepare(
    `SELECT id FROM assets WHERE agent_id = ? AND id IN (${placeholders}) AND state = 'deletion_pending'`,
  ).bind(agentId, ...ids).all<{ id: string }>();
  const doomed = (claimed.results ?? []).map((row) => row.id);
  if (doomed.length === 0) return false;
  for (const id of doomed) await refundDerivatives(env, id);
  await env.MEDIA.delete(doomed.flatMap((id) => [
    derivativeKey(id, "display"),
    derivativeKey(id, "thumb"),
    originalKey(id),
    originalThumbKey(id),
  ]));
  const doomedPlaceholders = doomed.map(() => "?").join(", ");
  const finished = await env.DB.prepare(
    `UPDATE assets SET state = 'deleted'
      WHERE agent_id = ? AND id IN (${doomedPlaceholders}) AND state = 'deletion_pending'`,
  ).bind(agentId, ...doomed).run();
  return Number(finished.meta.changes ?? 0) > 0;
}

// The Agent's removals without a legal hold reach the minimal tombstone (round-2 audit row 8),
// and the stored export copies of every removed or held Post of the Agent go.
async function finishRemovals(db: D1Database, agentId: string): Promise<boolean> {
  const listed = await db.prepare(
    `SELECT id, asset_id FROM posts
      WHERE author_agent_id = ? AND state = 'removal_pending' AND legal_hold = 0
      ORDER BY created_at, id
      LIMIT ${DELETION_POST_BATCH}`,
  ).bind(agentId).all<{ id: string; asset_id: string | null }>();
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `DELETE FROM export_posts
        WHERE json_extract(document, '$.post_id') IN (
          SELECT id FROM posts WHERE author_agent_id = ? AND state = 'removal_pending' AND legal_hold = 1)`,
    ).bind(agentId),
  ];
  const updates: number[] = [];
  for (const post of listed.results ?? []) {
    const plan = tombstoneStatements(db, post.id, post.asset_id, "removal_pending");
    updates.push(statements.length + plan.updateIndex);
    statements.push(...plan.statements);
  }
  const results = await db.batch(statements);
  return updates.some((index) => Number(results[index]?.meta.changes ?? 0) === 1);
}

async function gate(c: Ctx): Promise<{ email: string } | Response> {
  const requestId = c.get("requestId");
  const operator = await requireOperator(c.env, c.req.raw, c.executionCtx);
  if (!operator.ok) return errorResponse(requestId, operator.code);
  if (operator.kind !== "operator") return errorResponse(requestId, "forbidden");
  if (!sameOrigin(c.req.raw, c.get("policy").site_origin)) return errorResponse(requestId, "forbidden");
  return { email: operator.email };
}

function agentIdFrom(body: Record<string, unknown>): string | null {
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "agent_id" || typeof body.agent_id !== "string") return null;
  return body.agent_id;
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

function isUnique(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE");
}
