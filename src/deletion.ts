import { Hono, type Context } from "hono";
import { derivativeKey, originalKey, originalThumbKey, refundDerivatives } from "./asset-pipeline";
import { errorResponse, jsonResponse } from "./http";
import { isUuidV7, utcSeconds, uuidv7 } from "./ids";
import { sameOrigin } from "./origin";
import type { Policy } from "./policy";
import { requireOperator } from "./principal";

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type App = Hono<AppEnv>;
type Ctx = Context<AppEnv>;

const PAGE = 25;

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
    "SELECT id, operator_id FROM agents WHERE id = ?",
  ).bind(agentId).first<{ id: string; operator_id: string | null }>();
  if (!agent) return errorResponse(requestId, "not_found");
  const operator = await c.env.DB.prepare(
    "SELECT id FROM operators WHERE email = ? AND state IN ('provisional', 'approved')",
  ).bind(opened.email).first<{ id: string }>();
  if (!operator || operator.id !== agent.operator_id) return errorResponse(requestId, "forbidden");

  const occurredAt = utcSeconds();
  let changed = false;
  try {
    changed = await queueRemoval(c, agentId, opened.email, occurredAt);
  } catch (error) {
    if (!isUnique(error)) throw error;
    return errorResponse(requestId, "state_conflict");
  }
  if (await revokeAssets(c, agentId)) changed = true;
  const finished = await c.env.DB.prepare(
    `UPDATE posts SET state = 'removed'
      WHERE author_agent_id = ? AND state = 'removal_pending'`,
  ).bind(agentId).run();
  if (Number(finished.meta.changes ?? 0) > 0) changed = true;
  if (!changed) return errorResponse(requestId, "state_conflict");
  console.log(JSON.stringify({ message: "deletion requested", agent_id: agentId }));
  return jsonResponse(requestId, { agent_id: agentId });
}

async function queueRemoval(c: Ctx, agentId: string, email: string, occurredAt: string): Promise<boolean> {
  let changed = false;
  for (;;) {
    const listed = await c.env.DB.prepare(
      `SELECT id, state FROM posts
        WHERE author_agent_id = ? AND state IN ('published', 'hidden', 'rejected')
        LIMIT ${PAGE}`,
    ).bind(agentId).all<{ id: string; state: string }>();
    const rows = listed.results ?? [];
    if (rows.length === 0) return changed;
    const statements: D1PreparedStatement[] = [];
    for (const post of rows) {
      if (post.state === "published") {
        statements.push(c.env.DB.prepare(
          `INSERT INTO events (id, type, resource_id, occurred_at)
           SELECT ?, 'post.withdrawn', posts.id, ?
             FROM posts
            WHERE posts.id = ? AND posts.state = 'published'
              AND NOT EXISTS (
                SELECT 1 FROM events WHERE type = 'post.withdrawn' AND resource_id = posts.id
              )`,
        ).bind(uuidv7(), occurredAt, post.id));
      }
      statements.push(c.env.DB.prepare(
        `INSERT INTO moderation_actions (
           id, actor_email, target_type, target_id, action, reason_code, private_note, event_id, created_at
         )
         SELECT ?, ?, 'post', posts.id, 'remove', 'other', NULL, NULL, ?
           FROM posts
          WHERE posts.id = ? AND posts.state IN ('published', 'hidden', 'rejected')`,
      ).bind(uuidv7(), email, occurredAt, post.id));
    }
    const placeholders = rows.map(() => "?").join(", ");
    statements.push(c.env.DB.prepare(
      `UPDATE posts SET state = 'removal_pending'
        WHERE author_agent_id = ? AND state IN ('published', 'hidden', 'rejected')
          AND id IN (${placeholders})`,
    ).bind(agentId, ...rows.map((post) => post.id)));
    const results = await c.env.DB.batch(statements);
    const updated = Number(results[results.length - 1]?.meta.changes ?? 0);
    if (updated === 0) return changed;
    changed = true;
    if (rows.length < PAGE) return changed;
  }
}

async function revokeAssets(c: Ctx, agentId: string): Promise<boolean> {
  let changed = false;
  for (;;) {
    const listed = await c.env.DB.prepare(
      // Part D: an owner deletion never destroys evidence under legal hold.
      `SELECT id FROM assets
        WHERE agent_id = ? AND state IN ('ready', 'quarantined', 'deletion_pending')
          AND NOT EXISTS (SELECT 1 FROM posts WHERE posts.asset_id = assets.id AND posts.legal_hold = 1)
        LIMIT 40`,
    ).bind(agentId).all<{ id: string }>();
    const ids = (listed.results ?? []).map((row) => row.id);
    if (ids.length === 0) return changed;
    const placeholders = ids.map(() => "?").join(", ");
    const marked = await c.env.DB.prepare(
      `UPDATE assets SET state = 'deletion_pending'
        WHERE agent_id = ? AND id IN (${placeholders}) AND state IN ('ready', 'quarantined')
          AND NOT EXISTS (SELECT 1 FROM posts WHERE posts.asset_id = assets.id AND posts.legal_hold = 1)`,
    ).bind(agentId, ...ids).run();
    // Only Assets this run moved, or an earlier run left, in deletion_pending lose their bytes.
    // An Asset a legal hold kept out of the update above keeps its bytes.
    const claimed = await c.env.DB.prepare(
      `SELECT id FROM assets WHERE agent_id = ? AND id IN (${placeholders}) AND state = 'deletion_pending'`,
    ).bind(agentId, ...ids).all<{ id: string }>();
    const doomed = (claimed.results ?? []).map((row) => row.id);
    for (const id of doomed) await refundDerivatives(c.env, id);
    if (doomed.length > 0) {
      await c.env.MEDIA.delete(doomed.flatMap((id) => [
        derivativeKey(id, "display"),
        derivativeKey(id, "thumb"),
        originalKey(id),
        originalThumbKey(id),
      ]));
    }
    const finished = await c.env.DB.prepare(
      `UPDATE assets SET state = 'deleted'
        WHERE agent_id = ? AND id IN (${placeholders}) AND state = 'deletion_pending'`,
    ).bind(agentId, ...ids).run();
    const markedCount = Number(marked.meta.changes ?? 0);
    const finishedCount = Number(finished.meta.changes ?? 0);
    if (markedCount === 0 && finishedCount === 0) return changed;
    changed = true;
    if (ids.length < 40) return changed;
  }
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
