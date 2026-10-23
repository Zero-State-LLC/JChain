import { Hono, type Context } from "hono";
import { blockAssetHashes } from "./blocked-hashes";
import { errorResponse, jsonResponse } from "./http";
import { isUuidV7, utcSeconds, uuidv7 } from "./ids";
import { sameOrigin } from "./origin";
import type { Policy } from "./policy";
import { requireAdminSeat, requireAgent } from "./principal";

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type Ctx = Context<AppEnv>;

// Spec default when the optional review block is absent (prepublish beta).
export const DEFAULT_SEAT_TRIAL_ACTIONS = 10;
const DEFAULT_ACCURACY_PERCENT = 70;
const DEFAULT_ACCURACY_MIN_REVIEWED = 5;
const DEFAULT_ACCURACY_WINDOW = 100;

const FLAG_REASONS = ["off-topic", "id-document", "csam"] as const;
const SEAT_ACTIONS = ["bind_seat_agent", "pause_seat_agent", "readmit_seat_agent", "restore_seat_powers"] as const;

type SeatRow = {
  seat: number;
  email: string | null;
  seat_agent_id: string | null;
  seat_state: string;
  seat_trial_count: number;
};

export function mountSeats(app: Hono<AppEnv>): void {
  app.put("/v1/posts/:id/flag", flagPost);
  app.post("/v1/admin/seats/:seat", adminSeat);
}

// CT-22 and the Admin Seats ruling: a Seat Agent is an active Agent owned by that seat's Admin.
export async function seatAgentOwned(db: D1Database, seatEmail: string | null, agentId: string): Promise<boolean> {
  if (seatEmail === null) return false;
  const row = await db.prepare(
    `SELECT 1 AS one FROM agents JOIN operators ON operators.id = agents.operator_id
      WHERE agents.id = ? AND agents.state = 'active' AND operators.email = ?`,
  ).bind(agentId, seatEmail).first();
  return row !== null;
}

// The start state of a seat after a bind, a rebind, or a readmit: the shadow trial restarts.
export function seatStartState(policy: Policy): "trial" | "active" {
  return trialThreshold(policy) > 0 ? "trial" : "active";
}

export function trialThreshold(policy: Policy): number {
  return policy.review?.seat_trial_actions ?? DEFAULT_SEAT_TRIAL_ACTIONS;
}

async function flagPost(c: Ctx): Promise<Response> {
  const requestId = c.get("requestId");
  const postId = c.req.param("id");
  if (postId === undefined || !isUuidV7(postId)) return errorResponse(requestId, "not_found");
  const principal = await requireAgent(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  if (principal.kind !== "agent") return errorResponse(requestId, "credential_invalid");
  const seat = await c.env.DB.prepare(
    `SELECT seat, email, seat_agent_id, seat_state, seat_trial_count
       FROM admin_seats WHERE seat_agent_id = ?`,
  ).bind(principal.agentId).first<SeatRow>();
  if (!seat) return errorResponse(requestId, "forbidden");
  if (seat.seat_state === "paused") return errorResponse(requestId, "forbidden");

  const body = await readObject(c.req.raw);
  if (!body.ok) return errorResponse(requestId, "malformed");
  const reason = body.value.reason;
  if (typeof reason !== "string" || !(FLAG_REASONS as readonly string[]).includes(reason)) {
    return errorResponse(requestId, "validation_failed");
  }
  if (Object.keys(body.value).some((key) => key !== "reason")) return errorResponse(requestId, "malformed");

  const post = await c.env.DB.prepare(
    `SELECT posts.state AS state, posts.asset_id AS asset_id,
            author.operator_id AS author_operator, seat_agent.operator_id AS seat_operator
       FROM posts
       JOIN agents AS author ON author.id = posts.author_agent_id
       JOIN agents AS seat_agent ON seat_agent.id = ?
      WHERE posts.id = ?`,
  ).bind(principal.agentId, postId).first<{
    state: string;
    asset_id: string | null;
    author_operator: string | null;
    seat_operator: string | null;
  }>();
  if (!post || post.state !== "published") return errorResponse(requestId, "not_found");
  if (post.author_operator !== null && post.author_operator === post.seat_operator) {
    return errorResponse(requestId, "forbidden");
  }
  const existingFlag = await c.env.DB.prepare(
    "SELECT id FROM seat_flags WHERE seat = ? AND post_id = ? LIMIT 1",
  ).bind(seat.seat, postId).first<{ id: string }>();
  if (existingFlag) return errorResponse(requestId, "state_conflict");

  const threshold = trialThreshold(c.get("policy"));
  const trial = seat.seat_state === "trial" || seat.seat_trial_count < threshold;
  const now = utcSeconds();
  const flagId = uuidv7();
  if (trial) {
    // Shadow trial (Open Question 17): recorded, counted, and the Post stays published.
    const results = await c.env.DB.batch([
      insertFlag(c.env.DB, flagId, seat.seat, principal.agentId, postId, reason, true, now),
      flagEvent(c.env.DB, "post.flagged_trial", postId, flagId, now),
      c.env.DB.prepare(
        `UPDATE admin_seats
            SET seat_trial_count = seat_trial_count + 1,
                seat_state = CASE WHEN seat_trial_count + 1 >= ? THEN 'active' ELSE seat_state END
          WHERE seat = ? AND EXISTS (SELECT 1 FROM seat_flags WHERE id = ?)`,
      ).bind(threshold, seat.seat, flagId),
    ]);
    if (Number(results[0]?.meta.changes ?? 0) !== 1) return errorResponse(requestId, "state_conflict");
    console.log(JSON.stringify({ message: "seat flag trial", post_id: postId, seat: seat.seat, trial: 1 }));
    return jsonResponse(requestId, { post_id: postId, state: "published", trial: 1, event_type: "post.flagged_trial" });
  }

  // C-12b, Part F item 5, AT-42: either Seat Agent hides and quarantines prohibited content at once.
  // An off-topic hide needs a pending non-trial off-topic flag from the other seat; one alone only
  // queues the Post first. Neither removes. Every write sits in one batch, keyed on this flag's row.
  const prohibited = reason === "id-document" || reason === "csam";
  const hideWhere = prohibited
    ? "posts.id = ? AND posts.state = 'published' AND EXISTS (SELECT 1 FROM seat_flags AS mine WHERE mine.id = ?)"
    : `posts.id = ? AND posts.state = 'published' AND EXISTS (SELECT 1 FROM seat_flags AS mine WHERE mine.id = ?)
       AND EXISTS (
         SELECT 1 FROM seat_flags AS other
          WHERE other.post_id = posts.id AND other.seat != ? AND other.reason = 'off-topic'
            AND other.trial = 0 AND other.outcome = 'pending'
       )`;
  const hideBinds: unknown[] = prohibited ? [postId, flagId] : [postId, flagId, seat.seat];
  const withdrawnId = uuidv7();
  const actionId = uuidv7();
  const statements: D1PreparedStatement[] = [
    insertFlag(c.env.DB, flagId, seat.seat, principal.agentId, postId, reason, false, now),
    flagEvent(c.env.DB, "post.flagged", postId, flagId, now),
    c.env.DB.prepare(
      `INSERT INTO events (id, type, resource_id, occurred_at)
       SELECT ?, 'post.withdrawn', posts.id, ? FROM posts WHERE ${hideWhere}`,
    ).bind(withdrawnId, now, ...hideBinds),
    // Audit actor seat_agent, as the scan's hide records actor system.
    c.env.DB.prepare(
      `INSERT INTO moderation_actions (
         id, actor_email, target_type, target_id, action, reason_code, private_note, event_id, created_at
       )
       SELECT ?, 'seat_agent', 'post', posts.id, 'hide', ?, NULL, ?, ? FROM posts WHERE ${hideWhere}`,
    ).bind(actionId, reason, withdrawnId, now, ...hideBinds),
  ];
  if (prohibited) {
    // Runs before the Post update, which the guard reads.
    statements.push(c.env.DB.prepare(
      `UPDATE assets SET state = 'quarantined', quarantined_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE state = 'ready' AND id = (SELECT posts.asset_id FROM posts WHERE ${hideWhere})`,
    ).bind(...hideBinds));
  }
  const hideIndex = statements.length;
  statements.push(
    c.env.DB.prepare(
      `UPDATE posts SET state = 'hidden', hidden_by = 'seat_agents', queue_first = 1 WHERE ${hideWhere}`,
    ).bind(...hideBinds),
    // One off-topic flag: the Post stays published and goes first in line.
    c.env.DB.prepare(
      `UPDATE posts SET queue_first = 1
        WHERE id = ? AND state = 'published' AND EXISTS (SELECT 1 FROM seat_flags WHERE id = ?)`,
    ).bind(postId, flagId),
  );
  if (prohibited && post.asset_id !== null) {
    // CT-21: a prohibited hide's quarantine adds the Asset's hashes, marked prohibited.
    statements.push(blockAssetHashes(c.env.DB, post.asset_id, true, now, actionId));
  }
  const results = await c.env.DB.batch(statements);
  if (Number(results[0]?.meta.changes ?? 0) !== 1) return errorResponse(requestId, "state_conflict");
  const hidden = Number(results[hideIndex]?.meta.changes ?? 0) === 1;
  if (prohibited && !hidden) return errorResponse(requestId, "state_conflict");
  console.log(JSON.stringify({
    message: hidden ? "seat hide" : "seat flag queued",
    post_id: postId,
    seat: seat.seat,
    trial: 0,
  }));
  return jsonResponse(requestId, {
    post_id: postId,
    state: hidden ? "hidden" : "published",
    trial: 0,
    event_type: "post.flagged",
  });
}

// The flag row is written only while the Post is published, so a raced flag writes nothing.
function insertFlag(
  db: D1Database,
  flagId: string,
  seat: number,
  agentId: string,
  postId: string,
  reason: string,
  trial: boolean,
  at: string,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO seat_flags (id, seat, agent_id, post_id, reason, trial, outcome, created_at)
     SELECT ?, ?, ?, ?, ?, ?, 'pending', ?
      WHERE EXISTS (SELECT 1 FROM posts WHERE id = ? AND state = 'published')`,
  ).bind(flagId, seat, agentId, postId, reason, trial ? 1 : 0, at, postId);
}

function flagEvent(db: D1Database, type: string, postId: string, flagId: string, at: string): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO events (id, type, resource_id, occurred_at)
     SELECT ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM seat_flags WHERE id = ?)
        AND NOT EXISTS (SELECT 1 FROM events WHERE type = ? AND resource_id = ?)`,
  ).bind(uuidv7(), type, postId, at, flagId, type, postId);
}

async function adminSeat(c: Ctx): Promise<Response> {
  const requestId = c.get("requestId");
  const seatNumber = Number(c.req.param("seat"));
  if (seatNumber !== 1 && seatNumber !== 2) return errorResponse(requestId, "not_found");
  const principal = await requireAdminSeat(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  if (principal.kind !== "admin") return errorResponse(requestId, "forbidden");
  if (!sameOrigin(c.req.raw, c.get("policy").site_origin)) return errorResponse(requestId, "forbidden");
  const body = await readObject(c.req.raw);
  if (!body.ok) return errorResponse(requestId, "malformed");
  const action = body.value.action;
  if (typeof action !== "string" || !(SEAT_ACTIONS as readonly string[]).includes(action)) {
    return errorResponse(requestId, "validation_failed");
  }
  const seat = await c.env.DB.prepare(
    "SELECT seat, email, seat_agent_id, seat_state, seat_trial_count FROM admin_seats WHERE seat = ?",
  ).bind(seatNumber).first<SeatRow>();
  if (!seat) return errorResponse(requestId, "not_found");

  const threshold = trialThreshold(c.get("policy"));
  const now = utcSeconds();
  let nextState = seat.seat_state;
  let nextAgent = seat.seat_agent_id;
  let trialCount = seat.seat_trial_count;
  if (action === "bind_seat_agent") {
    const agentId = body.value.agent_id;
    if (typeof agentId !== "string" || !isUuidV7(agentId)) return errorResponse(requestId, "validation_failed");
    const agent = await c.env.DB.prepare(
      "SELECT id FROM agents WHERE id = ? AND state = 'active'",
    ).bind(agentId).first<{ id: string }>();
    if (!agent) return errorResponse(requestId, "not_found");
    if (!(await seatAgentOwned(c.env.DB, seat.email, agentId))) {
      return errorResponse(requestId, "validation_failed", "A Seat Agent must be an active Agent of that seat's own Admin.");
    }
    nextAgent = agentId;
    nextState = seatStartState(c.get("policy"));
    trialCount = 0;
  } else if (Object.keys(body.value).some((key) => key !== "action")) {
    return errorResponse(requestId, "malformed");
  }
  if (action === "bind_seat_agent" && Object.keys(body.value).some((key) => key !== "action" && key !== "agent_id")) {
    return errorResponse(requestId, "malformed");
  }
  if (action === "pause_seat_agent") nextState = "paused";
  if (action === "readmit_seat_agent") {
    // CT-22: readmit returns the seat to its start state, so the trial restarts.
    nextState = threshold > 0 ? "trial" : "active";
    trialCount = 0;
  }
  if (action === "restore_seat_powers") {
    if (seat.email === null || seat.email === principal.email) return errorResponse(requestId, "forbidden");
    nextState = "active";
  }

  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE admin_seats SET seat_agent_id = ?, seat_state = ?, seat_trial_count = ? WHERE seat = ?",
    ).bind(nextAgent, nextState, trialCount, seatNumber),
    c.env.DB.prepare(
      `INSERT INTO moderation_actions (
         id, actor_email, target_type, target_id, action, reason_code, private_note, event_id, created_at
       ) VALUES (?, ?, 'admin_seat', ?, ?, 'rules', NULL, NULL, ?)`,
    ).bind(uuidv7(), principal.email, String(seatNumber), action, now),
  ]);
  return jsonResponse(requestId, {
    seat: seatNumber,
    seat_state: nextState,
    seat_agent_id: nextAgent,
    seat_trial_count: trialCount,
  });
}

// Called after a Moderator decides a Post with pending Seat Flags: a seat-hidden Post, a published
// Post one off-topic flag queued, or a legacy 'flagged' Post. Hide, quarantine, remove, and uphold
// confirm. Approve, restore (including a restore that answers an appeal), and dismiss_flags overturn.
// Accuracy uses the last review.seat_accuracy_window flags the other Admin Seat decided.
export async function settleSeatFlags(
  db: D1Database,
  postId: string,
  action: string,
  at: string,
  actorEmail?: string,
  policy?: Policy | null,
): Promise<void> {
  // v0.2.29: upholding an appealed hide confirms its flags. Dismissing them overturns them.
  const outcome = action === "hide" || action === "quarantine" || action === "remove" || action === "uphold"
    ? "confirmed"
    : action === "approve" || action === "restore" || action === "dismiss_flags"
      ? "overturned"
      : null;
  if (outcome === null) return;
  const pending = await db.prepare(
    "SELECT DISTINCT seat FROM seat_flags WHERE post_id = ? AND outcome = 'pending'",
  ).bind(postId).all<{ seat: number }>();
  const seats = pending.results ?? [];
  if (seats.length === 0) return;
  await db.prepare(
    "UPDATE seat_flags SET outcome = ?, resolved_at = ? WHERE post_id = ? AND outcome = 'pending'",
  ).bind(outcome, at, postId).run();
  let scorerSeat: number | null = null;
  if (actorEmail !== undefined) {
    const row = await db.prepare(
      "SELECT seat FROM admin_seats WHERE lower(email) = lower(?)",
    ).bind(actorEmail).first<{ seat: number }>();
    if (!row) return;
    scorerSeat = Number(row.seat);
  }
  for (const row of seats) {
    if (scorerSeat !== null && Number(row.seat) === scorerSeat) continue;
    await maybePauseSeat(db, Number(row.seat), policy);
  }
}

async function maybePauseSeat(db: D1Database, seat: number, policy?: Policy | null): Promise<void> {
  const accuracyWindow = policy?.review?.seat_accuracy_window ?? DEFAULT_ACCURACY_WINDOW;
  const minReviewed = policy?.review?.seat_accuracy_min_reviewed ?? DEFAULT_ACCURACY_MIN_REVIEWED;
  const accuracyPercent = policy?.review?.seat_accuracy_percent ?? DEFAULT_ACCURACY_PERCENT;
  const listed = await db.prepare(
    `SELECT seat_flags.outcome AS outcome
       FROM seat_flags
      WHERE seat_flags.seat = ?
        AND seat_flags.trial = 0
        AND seat_flags.outcome IN ('confirmed', 'overturned')
        AND EXISTS (
          SELECT 1
            FROM moderation_actions
            JOIN admin_seats ON lower(admin_seats.email) = lower(moderation_actions.actor_email)
           WHERE moderation_actions.target_type = 'post'
             AND moderation_actions.target_id = seat_flags.post_id
             AND moderation_actions.created_at = seat_flags.resolved_at
             AND admin_seats.seat != seat_flags.seat
        )
      ORDER BY seat_flags.resolved_at DESC, seat_flags.id DESC
      LIMIT ?`,
  ).bind(seat, accuracyWindow).all<{ outcome: string }>();
  const rows = listed.results ?? [];
  if (rows.length <= minReviewed) return;
  const confirmed = rows.filter((row) => row.outcome === "confirmed").length;
  if (confirmed * 100 < accuracyPercent * rows.length) {
    await db.prepare("UPDATE admin_seats SET seat_state = 'paused' WHERE seat = ?").bind(seat).run();
  }
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
