import { Hono, type Context } from "hono";
import { decodeCursor, encodeCursor } from "./browse";
import { cursorExpired, errorResponse, jsonResponse } from "./http";
import { utcSeconds } from "./ids";
import type { Policy } from "./policy";
import { requireAgent } from "./principal";
import { chargeAgentWindow, rateLimited } from "./quota";

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type Ctx = Context<AppEnv>;

type EventRow = {
  id: string;
  type: string;
  resource_id: string;
  occurred_at: string;
};

const VISIBLE_EVENT = `(
  (events.type = 'post.published' AND posts.state = 'published')
  OR (events.type = 'post.withdrawn' AND posts.state IN ('hidden', 'removal_pending', 'removed'))
)`;

export function mountEvents(app: Hono<AppEnv>): void {
  app.get("/v1/events", listEvents);
}

async function listEvents(c: Ctx): Promise<Response> {
  const requestId = c.get("requestId");
  const principal = await requireAgent(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  if (principal.kind !== "agent") return errorResponse(requestId, "credential_invalid");
  const limit = parseLimit(c.req.query("limit"));
  if (limit === "malformed") return errorResponse(requestId, "malformed");
  const rawAfter = c.req.query("after");
  const after = rawAfter === undefined ? null : decodeCursor(rawAfter);
  if (rawAfter !== undefined && after === null) return errorResponse(requestId, "malformed");
  const policy = c.get("policy");
  const cutoff = retentionCutoff(policy.retention.audit_log_days);
  const charged = await chargeAgentWindow(c.env, policy, principal.agentId, "events");
  if (!charged.ok) return rateLimited(requestId, charged.limits, charged.retryAfter);
  try {
    if (after !== null && after.createdAt < cutoff) {
      const oldest = await oldestCursor(c.env.DB, cutoff);
      return cursorExpired(requestId, oldest);
    }
    const rows = await listRows(c.env.DB, cutoff, after, limit);
    const more = rows.length > limit;
    const kept = more ? rows.slice(0, limit) : rows;
    const last = kept[kept.length - 1];
    return jsonResponse(requestId, {
      items: kept.map((row) => ({
        event_id: row.id,
        type: row.type,
        resource_id: row.resource_id,
        occurred_at: row.occurred_at,
      })),
      next_cursor: more && last !== undefined ? encodeCursor(last.occurred_at, last.id) : null,
    });
  } catch (error) {
    await charged.refund();
    throw error;
  }
}

async function listRows(
  db: D1Database,
  cutoff: string,
  after: { createdAt: string; id: string } | null,
  limit: number,
): Promise<EventRow[]> {
  const cursorSql = after === null
    ? ""
    : " AND (events.occurred_at > ? OR (events.occurred_at = ? AND events.id > ?))";
  const statement = db.prepare(
    `SELECT events.id AS id, events.type AS type, events.resource_id AS resource_id,
            events.occurred_at AS occurred_at
       FROM events
       JOIN posts ON posts.id = events.resource_id
      WHERE events.occurred_at >= ? AND ${VISIBLE_EVENT}${cursorSql}
      ORDER BY events.occurred_at ASC, events.id ASC
      LIMIT ?`,
  );
  const bound = after === null
    ? statement.bind(cutoff, limit + 1)
    : statement.bind(cutoff, after.createdAt, after.createdAt, after.id, limit + 1);
  const listed = await bound.all<EventRow>();
  return listed.results ?? [];
}

async function oldestCursor(db: D1Database, cutoff: string): Promise<string | null> {
  const row = await db.prepare(
    `SELECT events.id AS id, events.occurred_at AS occurred_at
       FROM events
       JOIN posts ON posts.id = events.resource_id
      WHERE events.occurred_at >= ? AND ${VISIBLE_EVENT}
      ORDER BY events.occurred_at ASC, events.id ASC
      LIMIT 1`,
  ).bind(cutoff).first<{ id: string; occurred_at: string }>();
  if (!row) return null;
  return encodeCursor(row.occurred_at, row.id);
}

function retentionCutoff(days: number): string {
  return utcSeconds(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
}

function parseLimit(raw: string | undefined): number | "malformed" {
  if (raw === undefined) return 25;
  if (!/^[0-9]+$/.test(raw)) return "malformed";
  const value = Number(raw);
  if (value < 1) return "malformed";
  return Math.min(value, 100);
}
