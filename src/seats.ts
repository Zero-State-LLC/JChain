import { Hono, type Context } from "hono";
import { errorResponse, jsonResponse } from "./http";
import { isUuidV7, utcSeconds, uuidv7 } from "./ids";
import { sameOrigin } from "./origin";
import type { Policy } from "./policy";
import { requireAdminSeat, requireAgent } from "./principal";

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type Ctx = Context<AppEnv>;

// Spec default when the optional review block is absent (prepublish beta).
export const DEFAULT_SEAT_TRIAL_ACTIONS = 10;
const ACCURACY_FLOOR = 0.7;
const ACCURACY_MIN = 20;
const ACCURACY_WINDOW = 100;

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
    `SELECT posts.state AS state, author.operator_id AS author_operator, seat_agent.operator_id AS seat_operator
       FROM posts
       JOIN agents AS author ON author.id = posts.author_agent_id
       JOIN agents AS seat_agent ON seat_agent.id = ?
      WHERE posts.id = ?`,
  ).bind(principal.agentId, postId).first<{
    state: string;
    author_operator: string | null;
    seat_operator: string | null;
  }>();
  if (!post || post.state !== "published") return errorResponse(requestId, "not_found");
  if (post.author_operator !== null && post.author_operator === post.seat_operator) {
    return errorResponse(requestId, "forbidden");
  }

  const threshold = trialThreshold(c.get("policy"));
  const trial = seat.seat_state === "trial" || seat.seat_trial_count < threshold;
  const now = utcSeconds();
  const flagId = uuidv7();
  const eventId = uuidv7();
  const eventType = trial ? "post.flagged_trial" : "post.flagged";
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO seat_flags (id, seat, agent_id, post_id, reason, trial, outcome, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).bind(flagId, seat.seat, principal.agentId, postId, reason, trial ? 1 : 0, now),
    c.env.DB.prepare(
      `INSERT INTO events (id, type, resource_id, occurred_at)
       SELECT ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM events WHERE type = ? AND resource_id = ?)`,
    ).bind(eventId, eventType, postId, now, eventType, postId),
  ];
  if (trial) {
    statements.push(c.env.DB.prepare(
      `UPDATE admin_seats
          SET seat_trial_count = seat_trial_count + 1,
              seat_state = CASE WHEN seat_trial_count + 1 >= ? THEN 'active' ELSE seat_state END
        WHERE seat = ?`,
    ).bind(threshold, seat.seat));
  } else {
    statements.push(c.env.DB.prepare(
      "UPDATE posts SET state = 'flagged' WHERE id = ? AND state = 'published'",
    ).bind(postId));
  }
  const results = await c.env.DB.batch(statements);
  if (!trial && Number(results[results.length - 1]?.meta.changes ?? 0) !== 1) {
    return errorResponse(requestId, "state_conflict");
  }
  const next = trial
    ? "published"
    : "flagged";
  console.log(JSON.stringify({
    message: trial ? "seat flag trial" : "seat flag",
    post_id: postId,
    seat: seat.seat,
    trial: trial ? 1 : 0,
  }));
  return jsonResponse(requestId, {
    post_id: postId,
    state: next,
    trial: trial ? 1 : 0,
    event_type: eventType,
  });
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
  if (action === "bind_seat_agent") {
    const agentId = body.value.agent_id;
    if (typeof agentId !== "string" || !isUuidV7(agentId)) return errorResponse(requestId, "validation_failed");
    const agent = await c.env.DB.prepare(
      "SELECT id FROM agents WHERE id = ? AND state = 'active'",
    ).bind(agentId).first<{ id: string }>();
    if (!agent) return errorResponse(requestId, "not_found");
    nextAgent = agentId;
  } else if (Object.keys(body.value).some((key) => key !== "action")) {
    return errorResponse(requestId, "malformed");
  }
  if (action === "bind_seat_agent" && Object.keys(body.value).some((key) => key !== "action" && key !== "agent_id")) {
    return errorResponse(requestId, "malformed");
  }
  if (action === "pause_seat_agent") nextState = "paused";
  if (action === "readmit_seat_agent") {
    nextState = seat.seat_trial_count < threshold ? "trial" : "active";
  }
  if (action === "restore_seat_powers") {
    if (seat.email === null || seat.email === principal.email) return errorResponse(requestId, "forbidden");
    nextState = "active";
  }

  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE admin_seats SET seat_agent_id = ?, seat_state = ? WHERE seat = ?",
    ).bind(nextAgent, nextState, seatNumber),
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
    seat_trial_count: seat.seat_trial_count,
  });
}

// Called after a Moderator resolves a flagged Post. Quarantine and remove confirm.
// Approve and restore overturn. Accuracy uses the last 100 resolved non-trial flags.
export async function settleSeatFlags(
  db: D1Database,
  postId: string,
  action: string,
  at: string,
): Promise<void> {
  // v0.2.29: upholding an appealed hide confirms its flags. Dismissing them overturns them.
  const outcome = action === "quarantine" || action === "remove" || action === "uphold"
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
  for (const row of seats) await maybePauseSeat(db, row.seat);
}

async function maybePauseSeat(db: D1Database, seat: number): Promise<void> {
  const listed = await db.prepare(
    `SELECT outcome FROM seat_flags
      WHERE seat = ? AND trial = 0 AND outcome IN ('confirmed', 'overturned')
      ORDER BY resolved_at DESC, id DESC
      LIMIT ?`,
  ).bind(seat, ACCURACY_WINDOW).all<{ outcome: string }>();
  const rows = listed.results ?? [];
  if (rows.length < ACCURACY_MIN) return;
  const confirmed = rows.filter((row) => row.outcome === "confirmed").length;
  if (confirmed / rows.length < ACCURACY_FLOOR) {
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
