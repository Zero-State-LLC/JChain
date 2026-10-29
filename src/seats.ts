import { Hono } from "hono";
import { dropPublishedCopies } from "./feeds";
import { errorResponse, jsonResponse } from "./http";
import { isUuidV7, utcSeconds, uuidv7 } from "./ids";
import { alertAfterResponse } from "./moderator-alert";
import { sameOrigin } from "./origin";
import type { Policy } from "./policy";
import { requireAdminSeat, requireAgent } from "./principal";
import { quarantineStatements } from "./quarantine";
import type { AppEnv, Ctx } from "./hono-env";

// Spec default when the optional review block is absent (prepublish beta).
export const DEFAULT_SEAT_TRIAL_ACTIONS = 10;
export const DEFAULT_ACCURACY_PERCENT = 70;
export const DEFAULT_ACCURACY_MIN_REVIEWED = 5;
export const DEFAULT_ACCURACY_WINDOW = 100;

export const FLAG_REASONS = ["off-topic", "id-document", "csam"] as const;
export const SEAT_ACTIONS = ["bind_seat_agent", "pause_seat_agent", "readmit_seat_agent", "restore_seat_powers"] as const;

type SeatRow = {
  seat: number;
  email: string | null;
  seat_agent_id: string | null;
  seat_state: string;
  seat_trial_count: number;
  // 1 after a pause or readmit until the other Admin restores the seat's powers.
  powers_held?: number;
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
  // CT-22: a human principal (no bearer) is forbidden. A bad bearer stays credential_invalid.
  if (c.req.raw.headers.get("authorization") === null) return errorResponse(requestId, "forbidden");
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
  if (!post) return errorResponse(requestId, "not_found");
  // A second flag by the same seat is state_conflict even after its first flag quarantined the Post.
  const existingFlag = await c.env.DB.prepare(
    "SELECT id FROM seat_flags WHERE seat = ? AND post_id = ? LIMIT 1",
  ).bind(seat.seat, postId).first<{ id: string }>();
  if (existingFlag) return errorResponse(requestId, "state_conflict");
  if (post.state !== "published") return errorResponse(requestId, "not_found");
  if (post.author_operator !== null && post.author_operator === post.seat_operator) {
    return errorResponse(requestId, "forbidden");
  }

  const threshold = trialThreshold(c.get("policy"));
  const trial = seat.seat_state === "trial" || seat.seat_trial_count < threshold;
  const now = utcSeconds();
  const flagId = uuidv7();
  if (trial) {
    // Shadow trial (Open Question 17): recorded, counted, and the Post stays published.
    // A seat whose powers are held (after a pause or readmit) does not promote (AT-43).
    const results = await uniqueBatch(c.env.DB, [
      insertFlag(c.env.DB, flagId, seat.seat, principal.agentId, postId, reason, true, now),
      flagEvent(c.env.DB, "post.flagged_trial", postId, flagId, now),
      c.env.DB.prepare(
        `UPDATE admin_seats
            SET seat_trial_count = seat_trial_count + 1,
                seat_state = CASE WHEN seat_trial_count + 1 >= ? AND powers_held = 0 THEN 'active' ELSE seat_state END
          WHERE seat = ? AND EXISTS (SELECT 1 FROM seat_flags WHERE id = ?)`,
      ).bind(threshold, seat.seat, flagId),
    ]);
    if (results === null) return errorResponse(requestId, "state_conflict");
    if (Number(results[0]?.meta.changes ?? 0) !== 1) return errorResponse(requestId, "state_conflict");
    console.log(JSON.stringify({ message: "seat flag trial", post_id: postId, seat: seat.seat, trial: 1 }));
    return jsonResponse(requestId, { post_id: postId, state: "published", trial: 1, event_type: "post.flagged_trial" });
  }

  // v0.2.36 (quarantine-first): any flag from an active seat quarantines the Post through the
  // shared helper, whatever its reason. Only a prohibited reason blocks the Asset's hashes, and a
  // Seat Flag never sets a legal hold. Nothing removes. Every write sits in one batch, keyed on
  // this flag's row, so a raced flag writes nothing.
  const prohibited = reason === "id-document" || reason === "csam";
  const plan = await quarantineStatements(c.env.DB, {
    postId,
    assetId: post.asset_id,
    source: "seat_agents",
    actor: "seat_agent",
    reasonCode: reason,
    prohibited,
    legalHold: false,
    at: now,
    guard: { sql: "EXISTS (SELECT 1 FROM seat_flags AS mine WHERE mine.id = ?)", binds: [flagId] },
  });
  const statements: D1PreparedStatement[] = [
    insertFlag(c.env.DB, flagId, seat.seat, principal.agentId, postId, reason, false, now),
    flagEvent(c.env.DB, "post.flagged", postId, flagId, now),
    ...plan.statements,
  ];
  const quarantineIndex = 2 + plan.updateIndex;
  const results = await uniqueBatch(c.env.DB, statements);
  if (results === null) return errorResponse(requestId, "state_conflict");
  if (Number(results[0]?.meta.changes ?? 0) !== 1) return errorResponse(requestId, "state_conflict");
  if (Number(results[quarantineIndex]?.meta.changes ?? 0) !== 1) return errorResponse(requestId, "state_conflict");
  console.log(JSON.stringify({ message: "seat quarantine", post_id: postId, seat: seat.seat, trial: 0 }));
  await dropPublishedCopies(c.env, [postId, ...plan.siblingIds]);
  await alertAfterResponse(c.env, () => c.executionCtx, c.get("policy"));
  return jsonResponse(requestId, {
    post_id: postId,
    state: "quarantined",
    trial: 0,
    event_type: "post.flagged",
  });
}

// Gap row 23: the unique (seat, post_id) index refuses a concurrent second flag by the same
// seat. The batch is rolled back, and the caller answers state_conflict.
async function uniqueBatch(db: D1Database, statements: D1PreparedStatement[]): Promise<D1Result[] | null> {
  try {
    return await db.batch(statements);
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) return null;
    throw error;
  }
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
  if (!isSeatAction(action)) return errorResponse(requestId, "validation_failed");
  const seat = await c.env.DB.prepare(
    "SELECT seat, email, seat_agent_id, seat_state, seat_trial_count, powers_held FROM admin_seats WHERE seat = ?",
  ).bind(seatNumber).first<SeatRow>();
  if (!seat) return errorResponse(requestId, "not_found");

  if (action === "bind_seat_agent") {
    if (Object.keys(body.value).some((key) => key !== "action" && key !== "agent_id")) {
      return errorResponse(requestId, "malformed");
    }
    const agentId = body.value.agent_id;
    if (typeof agentId !== "string" || !isUuidV7(agentId)) return errorResponse(requestId, "validation_failed");
  } else if (Object.keys(body.value).some((key) => key !== "action")) {
    return errorResponse(requestId, "malformed");
  }
  const applied = await applySeatAction(
    c.env.DB,
    c.get("policy"),
    seat,
    principal.email,
    action,
    typeof body.value.agent_id === "string" ? body.value.agent_id : undefined,
  );
  if (!applied.ok) return errorResponse(requestId, applied.code, applied.message);
  return jsonResponse(requestId, {
    seat: seatNumber,
    seat_state: applied.seatState,
    seat_agent_id: applied.seatAgentId,
    seat_trial_count: applied.trialCount,
  });
}

export type SeatAction = (typeof SEAT_ACTIONS)[number];

export function isSeatAction(value: unknown): value is SeatAction {
  return typeof value === "string" && (SEAT_ACTIONS as readonly string[]).includes(value);
}

type SeatApplied =
  | { ok: true; seatState: string; seatAgentId: string | null; trialCount: number }
  | { ok: false; code: "forbidden" | "not_found" | "validation_failed" | "state_conflict"; message?: string };

// CT-22 Admin controls, shared by the JSON route and the admin form (AT-43, Part F item 8).
// A pause or a readmit holds the seat's powers: the readmitted seat runs its trial again and
// stays flag-only after it, until the other seat's Admin restores its powers. Restore needs a
// paused or held seat, so a fresh trial cannot be skipped. Binding never lifts a hold.
export async function applySeatAction(
  db: D1Database,
  policy: Policy,
  seat: SeatRow,
  actorEmail: string,
  action: SeatAction,
  agentId?: string,
): Promise<SeatApplied> {
  const threshold = trialThreshold(policy);
  let nextState = seat.seat_state;
  let nextAgent = seat.seat_agent_id;
  let trialCount = seat.seat_trial_count;
  let held = seat.powers_held === 1 ? 1 : 0;
  if (action === "bind_seat_agent") {
    if (agentId === undefined || agentId === "") return { ok: false, code: "validation_failed" };
    const agent = await db.prepare("SELECT id FROM agents WHERE id = ? AND state = 'active'").bind(agentId).first();
    if (!agent) return { ok: false, code: "not_found" };
    if (!(await seatAgentOwned(db, seat.email, agentId))) {
      return { ok: false, code: "validation_failed", message: "A Seat Agent must be an active Agent of that seat's own Admin." };
    }
    nextAgent = agentId;
    nextState = held === 1 ? "trial" : seatStartState(policy);
    trialCount = 0;
  } else if (action === "pause_seat_agent") {
    nextState = "paused";
    held = 1;
  } else if (action === "readmit_seat_agent") {
    // Readmit restarts the trial, and the seat stays flag-only until the other Admin restores it.
    nextState = "trial";
    trialCount = 0;
    held = 1;
  } else {
    if (seat.email === null || seat.email === actorEmail) return { ok: false, code: "forbidden" };
    if (seat.seat_state !== "paused" && held !== 1) {
      return { ok: false, code: "state_conflict", message: "Only a paused or readmitted seat can have its powers restored." };
    }
    // A readmitted seat still finishes its trial; one that finished it is active at once.
    nextState = trialCount >= threshold ? "active" : "trial";
    held = 0;
  }
  const actionId = uuidv7();
  const guard = "seat = ? AND seat_state = ? AND powers_held = ? AND seat_trial_count = ?";
  const guardBinds = [seat.seat, seat.seat_state, seat.powers_held === 1 ? 1 : 0, seat.seat_trial_count];
  const results = await db.batch([
    db.prepare(
      `INSERT INTO moderation_actions (
         id, actor_email, target_type, target_id, action, reason_code, private_note, event_id, created_at
       ) SELECT ?, ?, 'admin_seat', ?, ?, 'rules', NULL, NULL, ? FROM admin_seats WHERE ${guard}`,
    ).bind(actionId, actorEmail, String(seat.seat), action, utcSeconds(), ...guardBinds),
    db.prepare(
      `UPDATE admin_seats SET seat_agent_id = ?, seat_state = ?, seat_trial_count = ?, powers_held = ?
        WHERE ${guard} AND EXISTS (SELECT 1 FROM moderation_actions WHERE id = ?)`,
    ).bind(nextAgent, nextState, trialCount, held, ...guardBinds, actionId),
  ]);
  if (Number(results[1]?.meta.changes ?? 0) !== 1) return { ok: false, code: "state_conflict" };
  return { ok: true, seatState: nextState, seatAgentId: nextAgent, trialCount };
}

// Called after a Moderator decides a Post with pending Seat Flags: a seat-quarantined Post (v0.2.36),
// an older seat-hidden or 'flagged' Post, or a published Post with a trial flag. Hide, quarantine,
// remove, and uphold confirm. Approve, restore (including a restore that answers an appeal), and dismiss_flags overturn.
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
    await db.prepare("UPDATE admin_seats SET seat_state = 'paused', powers_held = 1 WHERE seat = ?").bind(seat).run();
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
