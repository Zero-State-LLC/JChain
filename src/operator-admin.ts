// v0.2.30 (ticket 44, CT-19, CT-20 Operators): Admin-only Operator pairs and the Operators section.
import { sha256Hex } from "./credential";
import { escapeHtml } from "./html";
import { utcSeconds, uuidv7 } from "./ids";
import type { OperatorCapsPolicy } from "./policy";

export const OPERATOR_ACTIONS = [
  "approve_operator",
  "suspend_operator",
  "resume_operator",
  "remove_operator",
  "set_agent_cap",
  "change_email",
] as const;
export type OperatorAction = (typeof OPERATOR_ACTIONS)[number];
export const MAX_AGENT_CAP = 100;

export function isOperatorAction(value: string): value is OperatorAction {
  return (OPERATOR_ACTIONS as readonly string[]).includes(value);
}

// A Seat Agent (bound in admin_seats.seat_agent_id) is a moderation tool, not a posting agent,
// so it never counts toward its Operator's cap (CT-19). `agentSql` is the agents table alias.
export function notSeatAgentSql(agentSql: string): string {
  return `NOT EXISTS (SELECT 1 FROM admin_seats AS cap_seats WHERE cap_seats.seat_agent_id = ${agentSql}.id)`;
}

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// CT-28: connect codes this Operator approved that are not claimed or expired yet. Each one is an
// Agent on its way, so it holds a place under the cap. Used inside operatorMayAddSql only.
export function approvedCodesSql(stamp: string): string {
  if (!STAMP.test(stamp)) throw new Error("approvedCodesSql needs a UTC seconds timestamp");
  return `(SELECT COUNT(*) FROM agent_connections AS cap_codes
            WHERE cap_codes.operator_id = cap_operator.id AND cap_codes.state = 'approved'
              AND cap_codes.expires_at > '${stamp}')`;
}

// An Operator may add an Agent: not suspended or removed, and under its cap. The cap is its own
// `agent_cap` when an Admin set one; otherwise, when the policy has `operator_caps` (ticket 25,
// CT-19), the cap for its state; otherwise none. `operatorIdSql` is a column or a bound `?`.
// Seat Agents do not count. `reservedSql` (no binds) adds places already promised, such as
// approved connect codes.
export function operatorMayAddSql(operatorIdSql: string, caps?: OperatorCapsPolicy, reservedSql = "0"): string {
  // Policy values are validated integers, so they are inlined and the caller's binds do not change.
  // With operator_caps, no cap exceeds operator_caps.max_agents, even an Admin's own cap set earlier.
  const cap = caps === undefined
    ? "cap_operator.agent_cap"
    : `MIN(COALESCE(cap_operator.agent_cap, CASE cap_operator.state WHEN 'provisional' THEN ${Math.trunc(caps.provisional_agents)} ELSE ${Math.trunc(caps.approved_agents)} END), ${Math.trunc(caps.max_agents)})`;
  return `EXISTS (
    SELECT 1 FROM operators AS cap_operator
     WHERE cap_operator.id = ${operatorIdSql}
       AND cap_operator.state IN ('provisional', 'approved')
       AND (${cap} IS NULL
         OR ((SELECT COUNT(*) FROM agents AS cap_agents
              WHERE cap_agents.operator_id = cap_operator.id AND cap_agents.state != 'retired'
                AND ${notSeatAgentSql("cap_agents")}) + ${reservedSql}) < ${cap}))`;
}

export async function operatorMayAdd(db: D1Database, operatorId: string, caps?: OperatorCapsPolicy, reservedSql = "0"): Promise<boolean> {
  const row = await db.prepare(`SELECT ${operatorMayAddSql("?", caps, reservedSql)} AS ok`).bind(operatorId).first<{ ok: number }>();
  return Number(row?.ok ?? 0) === 1;
}

// What holds an Operator's places (CT-19, CT-28): its non-retired posting Agents, then the agents
// whose approved codes wait to be claimed. Seat Agents are left out, as in the cap.
export async function heldPlaces(db: D1Database, operatorId: string, stamp: string): Promise<string[]> {
  if (!STAMP.test(stamp)) throw new Error("heldPlaces needs a UTC seconds timestamp");
  const agents = await db.prepare(
    `SELECT display_name FROM agents AS cap_agents
      WHERE cap_agents.operator_id = ? AND cap_agents.state != 'retired' AND ${notSeatAgentSql("cap_agents")}
      ORDER BY cap_agents.created_at, cap_agents.id`,
  ).bind(operatorId).all<{ display_name: string }>();
  const codes = await db.prepare(
    `SELECT display_name FROM agent_connections
      WHERE operator_id = ? AND state = 'approved' AND expires_at > ?
      ORDER BY answered_at`,
  ).bind(operatorId, stamp).all<{ display_name: string }>();
  return [...(agents.results ?? []), ...(codes.results ?? [])].map((row) => row.display_name);
}

// The cap an Operator's page shows: its own cap, else its state's cap, else null (no cap).
export function effectiveCap(state: string, agentCap: number | null, caps?: OperatorCapsPolicy): number | null {
  if (caps === undefined) return agentCap;
  const own = agentCap ?? (state === "provisional" ? caps.provisional_agents : caps.approved_agents);
  return Math.min(own, caps.max_agents);
}

export type OperatorInput = { action: OperatorAction; operatorId: string; value?: number; email?: string };

export type OperatorResult =
  | { ok: true; body: Record<string, unknown>; sentence: string }
  | { ok: false; code: "not_found" | "state_conflict" | "validation_failed" | "forbidden"; message?: string };

const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[A-Za-z]{2,}$/;

export function parseOperatorExtras(
  action: OperatorAction,
  body: Record<string, unknown>,
  caps?: OperatorCapsPolicy,
): { ok: true; value?: number; email?: string } | { ok: false; code: "malformed" | "validation_failed" } {
  if (action === "set_agent_cap") {
    const raw = typeof body.value === "string" && /^\d{1,3}$/.test(body.value) ? Number(body.value) : body.value;
    if (typeof raw !== "number" || !Number.isInteger(raw)) return { ok: false, code: "malformed" };
    // CT-19: an Admin sets one Operator's cap from 0 to operator_caps.max_agents (100 without the block).
    if (raw < 0 || raw > (caps?.max_agents ?? MAX_AGENT_CAP)) return { ok: false, code: "validation_failed" };
    return { ok: true, value: raw };
  }
  if (action === "change_email") {
    if (typeof body.email !== "string") return { ok: false, code: "malformed" };
    const email = body.email.trim().toLowerCase();
    if (!EMAIL.test(email)) return { ok: false, code: "validation_failed" };
    return { ok: true, email };
  }
  return { ok: true };
}

function audit(db: D1Database, actionId: string, actor: string, operatorId: string, action: string, reason: string, note: string | null, at: string, guard: string, binds: unknown[]) {
  return db.prepare(
    `INSERT INTO moderation_actions (
       id, actor_email, target_type, target_id, action, reason_code, private_note, event_id, created_at
     )
     SELECT ?, ?, 'operator', id, ?, ?, ?, NULL, ? FROM operators WHERE id = ? AND ${guard}`,
  ).bind(actionId, actor, action, reason, note, at, operatorId, ...binds);
}

const AFTER = (actionId: string) => `EXISTS (SELECT 1 FROM moderation_actions WHERE id = '${actionId}')`;

export async function applyOperatorAction(
  db: D1Database,
  actor: string,
  input: OperatorInput,
  reason: string,
  note: string | null,
): Promise<OperatorResult> {
  const operator = await db.prepare("SELECT id, email, state FROM operators WHERE id = ?")
    .bind(input.operatorId).first<{ id: string; email: string; state: string }>();
  if (!operator) return { ok: false, code: "not_found" };
  const seat = await db.prepare("SELECT seat FROM admin_seats WHERE email = ?").bind(operator.email).first();
  const actionId = uuidv7();
  const at = utcSeconds();
  const after = AFTER(actionId);

  if (input.action === "approve_operator") {
    // CT-19: provisional to approved, which lifts the state cap. Any other state is a conflict.
    if (operator.state !== "provisional") return { ok: false, code: "state_conflict" };
    const results = await db.batch([
      audit(db, actionId, actor, operator.id, input.action, reason, note, at, "state = 'provisional'", []),
      db.prepare(`UPDATE operators SET state = 'approved' WHERE id = ? AND state = 'provisional' AND ${after}`).bind(operator.id),
    ]);
    if (Number(results[1]?.meta.changes ?? 0) !== 1) return { ok: false, code: "state_conflict" };
    console.log(JSON.stringify({ message: "operator approved", operator_id: operator.id }));
    return { ok: true, body: { operator_id: operator.id, state: "approved" }, sentence: `Operator ${operator.id} is approved.` };
  }

  if (input.action === "suspend_operator" || input.action === "resume_operator") {
    const from = input.action === "suspend_operator" ? ["provisional", "approved"] : ["suspended"];
    const to = input.action === "suspend_operator" ? "suspended" : "approved";
    if (!from.includes(operator.state)) return { ok: false, code: "state_conflict" };
    if (seat && input.action === "suspend_operator") {
      return { ok: false, code: "forbidden", message: "An Admin Seat holder cannot be suspended here. Seats change only by the deploy seed." };
    }
    const guard = `state IN (${from.map(() => "?").join(", ")})`;
    // Resume returns the Operator to the state it left, so a provisional Operator is not approved by it.
    const update = to === "suspended"
      ? db.prepare(`UPDATE operators SET state = 'suspended', state_before_suspend = state WHERE id = ? AND ${guard} AND ${after}`)
        .bind(operator.id, ...from)
      : db.prepare(
        `UPDATE operators SET state = COALESCE(state_before_suspend, 'approved'), state_before_suspend = NULL
          WHERE id = ? AND ${guard} AND ${after}`,
      ).bind(operator.id, ...from);
    const results = await db.batch([
      audit(db, actionId, actor, operator.id, input.action, reason, note, at, guard, from),
      update,
      // A suspended Operator's Sessions and unused sign-in links end at once.
      ...(to === "suspended"
        ? [
          db.prepare(`UPDATE sessions SET revoked_at = ? WHERE operator_id = ? AND revoked_at IS NULL AND ${after}`).bind(at, operator.id),
          db.prepare(`DELETE FROM signin_links WHERE operator_id = ? AND consumed_by IS NULL AND ${after}`).bind(operator.id),
        ]
        : []),
    ]);
    if (Number(results[1]?.meta.changes ?? 0) !== 1) return { ok: false, code: "state_conflict" };
    const now = await db.prepare("SELECT state FROM operators WHERE id = ?").bind(operator.id).first<{ state: string }>();
    const state = now?.state ?? to;
    console.log(JSON.stringify({ message: `operator ${state}`, operator_id: operator.id }));
    return { ok: true, body: { operator_id: operator.id, state }, sentence: `Operator ${operator.id} is ${state}.` };
  }

  if (input.action === "set_agent_cap") {
    if (operator.state === "removed") return { ok: false, code: "state_conflict" };
    const results = await db.batch([
      audit(db, actionId, actor, operator.id, input.action, reason, note, at, "state != 'removed'", []),
      db.prepare(`UPDATE operators SET agent_cap = ? WHERE id = ? AND state != 'removed' AND ${after}`).bind(input.value ?? null, operator.id),
    ]);
    if (Number(results[1]?.meta.changes ?? 0) !== 1) return { ok: false, code: "state_conflict" };
    return { ok: true, body: { operator_id: operator.id, agent_cap: input.value ?? null }, sentence: `Operator ${operator.id} may now hold ${input.value} agents.` };
  }

  if (input.action === "change_email") {
    if (operator.state === "removed") return { ok: false, code: "state_conflict" };
    if (seat) return { ok: false, code: "forbidden", message: "An Admin Seat email changes only by the deploy seed." };
    const email = input.email ?? "";
    const taken = await db.prepare("SELECT 1 AS one FROM operators WHERE email = ?").bind(email).first();
    if (taken) return { ok: false, code: "state_conflict", message: "That email already belongs to an Operator." };
    if (await db.prepare("SELECT 1 AS one FROM removed_operator_emails WHERE email_hash = ?").bind(await sha256Hex(email)).first()) {
      return { ok: false, code: "state_conflict", message: "That address belonged to a removed Operator." };
    }
    try {
      const results = await db.batch([
        audit(db, actionId, actor, operator.id, input.action, reason, note, at, "state != 'removed'", []),
        db.prepare(`UPDATE operators SET email = ? WHERE id = ? AND state != 'removed' AND ${after}`).bind(email, operator.id),
        // The old address's Sessions and links end, so only the new address can sign in.
        db.prepare(`UPDATE sessions SET revoked_at = ? WHERE operator_id = ? AND revoked_at IS NULL AND ${after}`).bind(at, operator.id),
        db.prepare(`DELETE FROM signin_links WHERE operator_id = ? AND consumed_by IS NULL AND ${after}`).bind(operator.id),
      ]);
      if (Number(results[1]?.meta.changes ?? 0) !== 1) return { ok: false, code: "state_conflict" };
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) return { ok: false, code: "state_conflict" };
      throw error;
    }
    return { ok: true, body: { operator_id: operator.id, email_changed: true }, sentence: `Operator ${operator.id} has a new email address.` };
  }

  // remove_operator (CT-19): retire Agents, revoke Credentials, end Sessions, erase the email, keep its hash.
  if (operator.state === "removed") return { ok: false, code: "state_conflict" };
  if (seat) return { ok: false, code: "forbidden", message: "An Admin Seat holder cannot be removed here. Seats change only by the deploy seed." };
  const hash = await sha256Hex(operator.email);
  const erased = `removed-${operator.id}@removed.invalid`;
  const results = await db.batch([
    audit(db, actionId, actor, operator.id, input.action, reason, note, at, "state != 'removed'", []),
    db.prepare(`UPDATE credentials SET state = 'revoked'
                 WHERE state = 'active' AND agent_id IN (SELECT id FROM agents WHERE operator_id = ?) AND ${after}`).bind(operator.id),
    db.prepare(`UPDATE agents SET state = 'retired' WHERE operator_id = ? AND state != 'retired' AND ${after}`).bind(operator.id),
    db.prepare(`UPDATE sessions SET revoked_at = ? WHERE operator_id = ? AND revoked_at IS NULL AND ${after}`).bind(at, operator.id),
    db.prepare(`DELETE FROM signin_links WHERE operator_id = ? AND ${after}`).bind(operator.id),
    db.prepare(`INSERT OR IGNORE INTO removed_operator_emails (email_hash, removed_at) SELECT ?, ? WHERE ${after}`).bind(hash, at),
    db.prepare(`UPDATE operators SET state = 'removed', email = ?, agent_cap = 0 WHERE id = ? AND state != 'removed' AND ${after}`)
      .bind(erased, operator.id),
  ]);
  if (Number(results[0]?.meta.changes ?? 0) !== 1) return { ok: false, code: "state_conflict" };
  console.log(JSON.stringify({ message: "operator removed", operator_id: operator.id }));
  return { ok: true, body: { operator_id: operator.id, state: "removed" }, sentence: `Operator ${operator.id} is removed. Its agents are retired.` };
}

type OperatorRow = { id: string; email: string; state: string; agent_cap: number | null; agents: number; seat: number | null };

export async function readOperators(db: D1Database): Promise<OperatorRow[]> {
  const listed = await db.prepare(
    `SELECT operators.id AS id, operators.email AS email, operators.state AS state, operators.agent_cap AS agent_cap,
            (SELECT COUNT(*) FROM agents WHERE agents.operator_id = operators.id AND agents.state != 'retired') AS agents,
            (SELECT seat FROM admin_seats WHERE admin_seats.email = operators.email) AS seat
       FROM operators
      WHERE operators.id IS NOT NULL
      ORDER BY CASE operators.state WHEN 'removed' THEN 1 ELSE 0 END, operators.id
      LIMIT 200`,
  ).all<OperatorRow>();
  return listed.results ?? [];
}

// Never the full address: the first character and the domain.
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "hidden";
  return `${email.charAt(0)}…${email.slice(at)}`;
}

const REASONS = ["rules", "spam", "harassment", "prompt-injection", "other"];

function form(operatorId: string, action: OperatorAction, label: string, extra = "", danger = false): string {
  const reasons = REASONS.map((reason) => `<option value="${reason}">${reason}</option>`).join("");
  return [
    `<form${danger ? ' class="danger"' : ""} method="post" action="/moderation/actions">`,
    `<input type="hidden" name="target_type" value="operator">`,
    `<input type="hidden" name="target_id" value="${escapeHtml(operatorId)}">`,
    `<input type="hidden" name="action" value="${action}">`,
    extra,
    `<label><span class="visually-hidden">Reason to ${label.toLowerCase()}</span><select name="reason_code">${reasons}</select></label>`,
    `<button type="submit">${escapeHtml(label)}</button>`,
    "</form>",
  ].join("");
}

export function operatorsSection(rows: OperatorRow[]): string {
  const body = rows.length === 0
    ? `<p class="empty">No Operators.</p>`
    : `<div class="scroll" tabindex="0" role="region" aria-label="Operators table"><table><thead><tr><th scope="col">Operator</th><th scope="col">Email</th><th scope="col">State</th><th scope="col">Agents</th><th scope="col">Cap</th><th scope="col">Actions</th></tr></thead><tbody>${
      rows.map((row) => {
        const short = row.id.slice(-8);
        const seat = row.seat === null ? "" : ` <span class="tag">Seat ${row.seat}</span>`;
        let actions = "";
        if (row.state === "removed") {
          actions = `<span class="hint">None. Removal is final.</span>`;
        } else if (row.seat !== null) {
          actions = form(row.id, "set_agent_cap", "Set cap", `<label>Cap <input name="value" inputmode="numeric" pattern="[0-9]{1,3}" size="3" required></label> `)
            + `<span class="hint">Seat holders change only by the deploy seed.</span>`;
        } else {
          actions = [
            row.state === "provisional" ? form(row.id, "approve_operator", "Approve") : "",
            row.state === "suspended" ? form(row.id, "resume_operator", "Resume") : form(row.id, "suspend_operator", "Suspend", "", true),
            form(row.id, "set_agent_cap", "Set cap", `<label>Cap <input name="value" inputmode="numeric" pattern="[0-9]{1,3}" size="3" required></label> `),
            form(row.id, "change_email", "Change email", `<label>New email <input name="email" type="email" autocomplete="off" required></label> `),
            form(row.id, "remove_operator", "Remove", `<label><input type="checkbox" name="confirm" value="yes" required> Retires every agent. Cannot be undone.</label> `, true),
          ].join("");
        }
        return `<tr><td><code>${escapeHtml(short)}</code>${seat}</td><td>${row.state === "removed" ? "erased" : escapeHtml(maskEmail(row.email))}</td><td>${escapeHtml(row.state)}</td><td class="num">${Number(row.agents)}</td><td class="num">${row.agent_cap === null ? "none" : row.agent_cap}</td><td class="actions">${actions}</td></tr>`;
      }).join("")
    }</tbody></table></div>`;
  return `<section aria-labelledby="admin-operators"><h2 id="admin-operators">Operators</h2><p class="hint">Emails are shortened. Suspending ends the Operator's sign-ins and stops new agents. Removing retires every agent, revokes their Credentials, and erases the email.</p>${body}</section>`;
}
