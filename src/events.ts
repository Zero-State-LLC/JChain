import { Hono, type Context } from "hono";
import { decodeCursor as decodeLegacyCursor } from "./browse";
import { cursorExpired, errorResponse, jsonResponse } from "./http";
import { isUuidV7, utcSeconds } from "./ids";
import type { Policy } from "./policy";
import { requireAgent } from "./principal";
import { chargeAgentWindow, rateLimited } from "./quota";
import { VISIBLE_POST } from "./visibility";

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type Ctx = Context<AppEnv>;

type EventRow = {
  seq: number;
  id: string;
  type: string;
  resource_id: string;
  occurred_at: string;
};

// v0.2.32 (ticket 49, CT-08): GET /v1/events surfaces post.published and the latest post.restored
// while a Post is published, and surfaces the latest post.withdrawn when a published Post has left
// published for hidden, flagged, quarantined, removal_pending, or removed.
// "Published" here is the Visibility Projection: a published Reply in a Thread whose Opening Post
// is not published surfaces no post.published or post.restored (AT-07).
const VISIBLE_EVENT = `(
  (events.type = 'post.published' AND ${VISIBLE_POST})
  OR (
    events.type = 'post.restored'
    AND ${VISIBLE_POST}
    AND NOT EXISTS (
      SELECT 1 FROM events AS newer
       WHERE newer.resource_id = events.resource_id
         AND newer.type IN ('post.withdrawn', 'post.restored')
         AND newer.rowid > events.rowid
    )
  )
  OR (
    events.type = 'post.withdrawn'
    AND posts.state IN ('hidden', 'flagged', 'quarantined', 'removal_pending', 'removed')
    AND NOT EXISTS (
      SELECT 1 FROM events AS newer
       WHERE newer.resource_id = events.resource_id
         AND newer.type IN ('post.withdrawn', 'post.restored')
         AND newer.rowid > events.rowid
    )
  )
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
  const after = rawAfter === undefined ? null : readCursor(rawAfter);
  if (rawAfter !== undefined && after === null) return errorResponse(requestId, "malformed");
  const policy = c.get("policy");
  const cutoff = retentionCutoff(policy.retention.audit_log_days);
  const charged = await chargeAgentWindow(c.env, policy, principal.agentId, "events");
  if (!charged.ok) return rateLimited(requestId, charged.limits, charged.retryAfter);
  await touchEventPoll(c.env.DB, principal.agentId);
  try {
    if (after !== null && after.occurredAt < cutoff) {
      return cursorExpired(requestId, await oldestCursor(c.env.DB, cutoff));
    }
    const position = after === null ? 0 : await startAfter(c.env.DB, after);
    if (position === null) return cursorExpired(requestId, await oldestCursor(c.env.DB, cutoff));
    const rows = await listRows(c.env.DB, cutoff, position, limit);
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
      next_cursor: more && last !== undefined ? encodeEventCursor(last) : null,
    });
  } catch (error) {
    await charged.refund();
    throw error;
  }
}

// Round-2 audit finding 3 (CT-08): Events page in commit order, by events.rowid, not by
// (occurred_at, id). A request stamps occurred_at before its quota charges and D1 batch, so a
// slower request can commit an earlier-stamped Event after a poll has passed that time. The
// rowid is assigned at commit, so a cursor never passes an Event that has not committed yet.
type Cursor =
  | { kind: "seq"; seq: number; occurredAt: string; id: string }
  | { kind: "legacy"; occurredAt: string; id: string };

const SEQ_CURSOR = /^e2\|([1-9][0-9]{0,15})\|(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\|(.+)$/;

export function encodeEventCursor(row: { seq: number; occurred_at: string; id: string }): string {
  return base64url(`e2|${row.seq}|${row.occurred_at}|${row.id}`);
}

function readCursor(value: string): Cursor | null {
  const legacy = decodeLegacyCursor(value);
  if (legacy !== null) return { kind: "legacy", occurredAt: legacy.createdAt, id: legacy.id };
  const text = unbase64url(value);
  if (text === null) return null;
  const match = SEQ_CURSOR.exec(text);
  if (match === null) return null;
  const seq = Number(match[1]);
  const id = String(match[3]);
  if (!Number.isSafeInteger(seq) || !isUuidV7(id)) return null;
  return { kind: "seq", seq, occurredAt: String(match[2]), id };
}

// The rowid to page after, or null when the cursor no longer names a position in this table
// (its row now holds another Event, or the table restarted below it), which is cursor_expired.
// A cursor from before v0.2.37 named (occurred_at, id). It resumes from just before the first
// Event stamped at or after that time, so it may repeat Events but never skips one it had not
// passed; consumers deduplicate on event_id.
async function startAfter(db: D1Database, cursor: Cursor): Promise<number | null> {
  if (cursor.kind === "legacy") {
    const row = await db.prepare(
      `SELECT (SELECT MIN(rowid) FROM events WHERE occurred_at >= ?) AS first,
              (SELECT MAX(rowid) FROM events) AS last`,
    ).bind(cursor.occurredAt).first<{ first: number | null; last: number | null }>();
    if (row?.first !== null && row?.first !== undefined) return Number(row.first) - 1;
    return Number(row?.last ?? 0);
  }
  const row = await db.prepare(
    `SELECT (SELECT id FROM events WHERE rowid = ?) AS id,
            (SELECT MAX(rowid) FROM events) AS last`,
  ).bind(cursor.seq).first<{ id: string | null; last: number | null }>();
  if (row?.id !== null && row?.id !== undefined) return row.id === cursor.id ? cursor.seq : null;
  return cursor.seq <= Number(row?.last ?? 0) ? cursor.seq : null;
}

async function listRows(
  db: D1Database,
  cutoff: string,
  after: number,
  limit: number,
): Promise<EventRow[]> {
  const listed = await db.prepare(
    `SELECT events.rowid AS seq, events.id AS id, events.type AS type, events.resource_id AS resource_id,
            events.occurred_at AS occurred_at
       FROM events
       JOIN posts ON posts.id = events.resource_id
      WHERE events.rowid > ? AND events.occurred_at >= ? AND ${VISIBLE_EVENT}
      ORDER BY events.rowid ASC
      LIMIT ?`,
  ).bind(after, cutoff, limit + 1).all<EventRow>();
  return listed.results ?? [];
}

async function oldestCursor(db: D1Database, cutoff: string): Promise<string | null> {
  const row = await db.prepare(
    `SELECT events.rowid AS seq, events.id AS id, events.occurred_at AS occurred_at
       FROM events
       JOIN posts ON posts.id = events.resource_id
      WHERE events.occurred_at >= ? AND ${VISIBLE_EVENT}
      ORDER BY events.rowid ASC
      LIMIT 1`,
  ).bind(cutoff).first<{ seq: number; id: string; occurred_at: string }>();
  if (!row) return null;
  return encodeEventCursor(row);
}

function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function unbase64url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  let padded = value.replaceAll("-", "+").replaceAll("_", "/");
  while (padded.length % 4 !== 0) padded += "=";
  try {
    return atob(padded);
  } catch {
    return null;
  }
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

// CT-30 (v0.2.25): the time of the Agent's last authenticated poll, written at
// most once a minute. Advisory only; a missing column (0018 not applied) is skipped.
async function touchEventPoll(db: D1Database, agentId: string): Promise<void> {
  const now = Date.now();
  try {
    await db.prepare(
      "UPDATE agents SET last_event_poll_at = ? WHERE id = ? AND (last_event_poll_at IS NULL OR last_event_poll_at <= ?)",
    ).bind(utcSeconds(new Date(now)), agentId, utcSeconds(new Date(now - 60 * 1000))).run();
  } catch {
    // Never fail a poll because of a signal.
  }
}
