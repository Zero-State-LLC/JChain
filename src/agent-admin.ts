import { AUTHORSHIP_RULE_VERSION } from "./authorship";
import { newCredentialSecret, sha256Hex } from "./credential";
import { characterLength } from "./http";
import { isUuidV7, utcSeconds, uuidv7 } from "./ids";
import type { Policy } from "./policy";

// The guarded writes behind CT-01 enrollment and the CT-10 lifecycle routes.
// The JSON routes and the Operator page (CT-27) both call these, so the two
// paths run the same SQL and write the same audit rows.

export type Caller = { email: string; kind: "operator" | "moderator" };

export type AdminFailure = {
  ok: false;
  code: "malformed" | "validation_failed" | "forbidden" | "not_found" | "state_conflict" | "attestation_required" | "roster_full";
  message?: string;
};

type AgentRow = { id: string; state: string; operator_id: string | null };

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export type EnrollInput = { displayName: string; declaredModel: string; expiresAt: string | null };

export function parseEnrollFields(body: Record<string, unknown>): { ok: true; value: EnrollInput } | AdminFailure {
  const keys = Object.keys(body);
  const allowed = new Set(["display_name", "declared_model", "expires_at"]);
  if (!keys.every((key) => allowed.has(key))) return { ok: false, code: "malformed" };
  if (typeof body.display_name !== "string" || typeof body.declared_model !== "string") {
    return { ok: false, code: "malformed" };
  }
  if (characterLength(body.display_name) < 1 || characterLength(body.display_name) > 40) {
    return { ok: false, code: "validation_failed", message: "display_name must be 1 to 40 characters." };
  }
  if (characterLength(body.declared_model) < 1 || characterLength(body.declared_model) > 80) {
    return { ok: false, code: "validation_failed", message: "declared_model must be 1 to 80 characters." };
  }
  if (!Object.hasOwn(body, "expires_at")) {
    return { ok: true, value: { displayName: body.display_name, declaredModel: body.declared_model, expiresAt: null } };
  }
  if (typeof body.expires_at !== "string" || !TIMESTAMP.test(body.expires_at) || Number.isNaN(Date.parse(body.expires_at))) {
    return { ok: false, code: "malformed" };
  }
  return {
    ok: true,
    value: { displayName: body.display_name, declaredModel: body.declared_model, expiresAt: body.expires_at },
  };
}

export async function enrollAgent(
  db: D1Database,
  policy: Policy,
  operatorEmail: string,
  input: EnrollInput,
  attestNow = false,
): Promise<{ ok: true; agentId: string; credential: string } | AdminFailure> {
  const countRow = await db.prepare("SELECT COUNT(*) AS n FROM agents").first<{ n: number }>();
  if (Number(countRow?.n ?? 0) >= policy.max_agents) {
    return { ok: false, code: "forbidden", message: "The agent limit is already reached." };
  }
  const operator = await operatorAttestation(db, operatorEmail);
  if (operator === null) return { ok: false, code: "forbidden" };
  if (!operator.attested && !attestNow) return { ok: false, code: "attestation_required" };
  const agentId = uuidv7();
  const credentialId = uuidv7();
  const createdAt = utcSeconds();
  const secret = await newCredentialSecret();
  const secretHash = await sha256Hex(secret);
  // The count above can go stale. The insert itself refuses a full roster.
  // Agreeing now is the first statement in the batch, so the Agent insert is
  // not always results[0].
  const attesting = !operator.attested;
  const results = await db.batch([
    ...(attesting ? [attestStatement(db, operator.id, createdAt)] : []),
    db.prepare(
      `INSERT INTO agents (id, display_name, declared_model, state, operator_id, created_at)
       SELECT ?, ?, ?, 'active', ?, ?
        WHERE (SELECT COUNT(*) FROM agents) < ?`,
    ).bind(agentId, input.displayName, input.declaredModel, operator.id, createdAt, policy.max_agents),
    db.prepare(
      `INSERT INTO credentials (id, agent_id, secret_hash, state, expires_at, created_at)
       SELECT ?, ?, ?, 'active', ?, ?
        WHERE EXISTS (SELECT 1 FROM agents WHERE id = ?)`,
    ).bind(credentialId, agentId, secretHash, input.expiresAt, createdAt, agentId),
  ]);
  const agentWrite = attesting ? 1 : 0;
  if (Number(results[agentWrite]?.meta.changes ?? 0) !== 1) {
    return { ok: false, code: "roster_full", message: "The agent limit is already reached." };
  }
  if (Number(results[agentWrite + 1]?.meta.changes ?? 0) !== 1) {
    return { ok: false, code: "forbidden" };
  }
  return { ok: true, agentId, credential: secret };
}

// CT-29 (v0.2.25): whether the Operator agreed to the current Authorship Rule.
export async function operatorAttestation(
  db: D1Database,
  email: string,
): Promise<{ id: string; attested: boolean; version: string | null; at: string | null } | null> {
  const row = await db.prepare(
    "SELECT id, authorship_attested_version AS version, authorship_attested_at AS at FROM operators WHERE email = ?",
  ).bind(email).first<{ id: string | null; version: string | null; at: string | null }>();
  if (!row?.id) return null;
  return { id: row.id, attested: row.version === AUTHORSHIP_RULE_VERSION, version: row.version, at: row.at };
}

export function attestStatement(db: D1Database, operatorId: string, at: string): D1PreparedStatement {
  return db.prepare(
    "UPDATE operators SET authorship_attested_version = ?, authorship_attested_at = ? WHERE id = ?",
  ).bind(AUTHORSHIP_RULE_VERSION, at, operatorId);
}

export async function rotateCredential(
  db: D1Database,
  caller: Caller,
  agentId: string | undefined,
): Promise<{ ok: true; agentId: string; credential: string } | AdminFailure> {
  const agent = await ownedAgent(db, caller, agentId);
  if (!agent.ok) return agent;
  const { row } = agent;
  if (row.state !== "active" && row.state !== "suspended") return { ok: false, code: "state_conflict" };
  const active = await db.prepare(
    "SELECT id FROM credentials WHERE agent_id = ? AND state = 'active'",
  ).bind(row.id).first<{ id: string }>();
  if (!active) return { ok: false, code: "state_conflict" };
  const secret = await newCredentialSecret();
  const credentialId = uuidv7();
  const createdAt = utcSeconds();
  try {
    const results = await db.batch([
      db.prepare(
        "UPDATE credentials SET state = 'revoked' WHERE id = ? AND state = 'active'",
      ).bind(active.id),
      db.prepare(
        `INSERT INTO credentials (id, agent_id, secret_hash, state, expires_at, created_at)
         SELECT ?, ?, ?, 'active', NULL, ?
          WHERE EXISTS (SELECT 1 FROM credentials WHERE id = ? AND state = 'revoked')
            AND NOT EXISTS (SELECT 1 FROM credentials WHERE agent_id = ? AND state = 'active')`,
      ).bind(credentialId, row.id, await sha256Hex(secret), createdAt, active.id, row.id),
    ]);
    if (Number(results[0]?.meta.changes ?? 0) !== 1 || Number(results[1]?.meta.changes ?? 0) !== 1) {
      return { ok: false, code: "state_conflict" };
    }
  } catch (error) {
    if (!isUnique(error)) throw error;
    return { ok: false, code: "state_conflict" };
  }
  console.log(JSON.stringify({ message: "credential rotated", agent_id: row.id }));
  return { ok: true, agentId: row.id, credential: secret };
}

export type Move = { from: string; to: string; message: string; action: string };

export const SUSPEND: Move = { from: "active", to: "suspended", message: "agent suspended", action: "suspend_agent" };
export const RESUME: Move = { from: "suspended", to: "active", message: "agent resumed", action: "resume_agent" };

export async function moveAgent(
  db: D1Database,
  caller: Caller,
  agentId: string | undefined,
  move: Move,
): Promise<{ ok: true; agentId: string; state: string } | AdminFailure> {
  const agent = await ownedAgent(db, caller, agentId);
  if (!agent.ok) return agent;
  const { row } = agent;
  const results = await db.batch([
    auditStatement(db, caller.email, move.action, "id = ? AND state = ?", [row.id, move.from]),
    db.prepare("UPDATE agents SET state = ? WHERE id = ? AND state = ?").bind(move.to, row.id, move.from),
  ]);
  if (Number(results[0]?.meta.changes ?? 0) !== 1 || Number(results[1]?.meta.changes ?? 0) !== 1) {
    return { ok: false, code: "state_conflict" };
  }
  console.log(JSON.stringify({ message: move.message, agent_id: row.id }));
  return { ok: true, agentId: row.id, state: move.to };
}

export async function retireAgent(
  db: D1Database,
  caller: Caller,
  agentId: string | undefined,
): Promise<{ ok: true; agentId: string; state: string } | AdminFailure> {
  const agent = await ownedAgent(db, caller, agentId);
  if (!agent.ok) return agent;
  const { row } = agent;
  if (row.state === "retired") return { ok: false, code: "state_conflict" };
  const actionId = uuidv7();
  const results = await db.batch([
    auditStatement(
      db,
      caller.email,
      "retire_agent",
      "id = ? AND state IN ('invited', 'active', 'suspended')",
      [row.id],
      actionId,
    ),
    db.prepare(
      "UPDATE agents SET state = 'retired' WHERE id = ? AND state IN ('invited', 'active', 'suspended')",
    ).bind(row.id),
    db.prepare(
      `UPDATE credentials SET state = 'revoked'
        WHERE agent_id = ? AND state = 'active'
          AND EXISTS (SELECT 1 FROM moderation_actions WHERE id = ?)`,
    ).bind(row.id, actionId),
  ]);
  if (Number(results[0]?.meta.changes ?? 0) !== 1 || Number(results[1]?.meta.changes ?? 0) !== 1) {
    return { ok: false, code: "state_conflict" };
  }
  console.log(JSON.stringify({ message: "agent retired", agent_id: row.id }));
  return { ok: true, agentId: row.id, state: "retired" };
}

export async function mayManage(db: D1Database, caller: Caller, operatorId: string | null): Promise<boolean> {
  if (caller.kind === "moderator") return true;
  const operator = await db.prepare(
    "SELECT id FROM operators WHERE email = ?",
  ).bind(caller.email).first<{ id: string | null }>();
  return operator?.id != null && operator.id === operatorId;
}

async function ownedAgent(
  db: D1Database,
  caller: Caller,
  agentId: string | undefined,
): Promise<{ ok: true; row: AgentRow } | AdminFailure> {
  if (agentId === undefined || !isUuidV7(agentId)) return { ok: false, code: "not_found" };
  const row = await db.prepare(
    "SELECT id, state, operator_id FROM agents WHERE id = ?",
  ).bind(agentId).first<AgentRow>();
  if (!row) return { ok: false, code: "not_found" };
  if (!(await mayManage(db, caller, row.operator_id))) return { ok: false, code: "forbidden" };
  return { ok: true, row };
}

function auditStatement(
  db: D1Database,
  email: string,
  action: string,
  guard: string,
  guardBinds: string[],
  actionId = uuidv7(),
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO moderation_actions (
       id, actor_email, target_type, target_id, action, reason_code, private_note, event_id, created_at
     )
     SELECT ?, ?, 'agent', id, ?, 'other', NULL, NULL, ? FROM agents WHERE ${guard}`,
  ).bind(actionId, email, action, utcSeconds(), ...guardBinds);
}

function isUnique(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE");
}
