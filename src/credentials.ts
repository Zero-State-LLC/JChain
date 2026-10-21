import { Hono, type Context } from "hono";
import { newCredentialSecret, sha256Hex } from "./credential";
import { errorResponse, jsonResponse } from "./http";
import { isUuidV7, utcSeconds, uuidv7 } from "./ids";
import { sameOrigin } from "./origin";
import type { Policy } from "./policy";
import { requireAgent, requireModerator, requireOperator } from "./principal";

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type App = Hono<AppEnv>;
type Ctx = Context<AppEnv>;
type Caller = { email: string; kind: "operator" | "moderator" };
type AgentRow = { id: string; state: string; operator_id: string | null };

export function mountCredentials(app: App): void {
  app.post("/v1/credentials/:id/revoke", revoke);
  app.post("/v1/agents/:id/credentials", rotate);
  app.post("/v1/agents/:id/suspend", (c) => moveAgent(c, "active", "suspended", "agent suspended", "suspend_agent"));
  app.post("/v1/agents/:id/resume", (c) => moveAgent(c, "suspended", "active", "agent resumed", "resume_agent"));
  app.post("/v1/agents/:id/retire", retire);
}

async function revoke(c: Ctx): Promise<Response> {
  const opened = await gate(c);
  if (opened instanceof Response) return opened;
  const requestId = c.get("requestId");
  const credentialId = c.req.param("id");
  if (credentialId === undefined || !isUuidV7(credentialId)) return errorResponse(requestId, "not_found");
  const row = await c.env.DB.prepare(
    `SELECT credentials.id AS id, credentials.state AS state, credentials.agent_id AS agent_id,
            agents.operator_id AS operator_id
       FROM credentials
       JOIN agents ON agents.id = credentials.agent_id
      WHERE credentials.id = ?`,
  ).bind(credentialId).first<{ id: string; state: string; agent_id: string; operator_id: string | null }>();
  if (!row) return errorResponse(requestId, "not_found");
  if (!(await mayManage(c, opened.caller, row.operator_id))) return errorResponse(requestId, "forbidden");
  if (row.state !== "active") return errorResponse(requestId, "state_conflict");
  const result = await c.env.DB.prepare(
    "UPDATE credentials SET state = 'revoked' WHERE id = ? AND state = 'active'",
  ).bind(credentialId).run();
  if (Number(result.meta.changes ?? 0) !== 1) return errorResponse(requestId, "state_conflict");
  console.log(JSON.stringify({ message: "credential revoked", credential_id: credentialId, agent_id: row.agent_id }));
  return jsonResponse(requestId, { credential_id: credentialId, agent_id: row.agent_id, state: "revoked" });
}

async function rotate(c: Ctx): Promise<Response> {
  const opened = await gate(c);
  if (opened instanceof Response) return opened;
  const requestId = c.get("requestId");
  const agent = await ownedAgent(c, opened.caller);
  if (agent instanceof Response) return agent;
  if (agent.state !== "active" && agent.state !== "suspended") return errorResponse(requestId, "state_conflict");
  const active = await c.env.DB.prepare(
    "SELECT id FROM credentials WHERE agent_id = ? AND state = 'active'",
  ).bind(agent.id).first<{ id: string }>();
  if (!active) return errorResponse(requestId, "state_conflict");
  const secret = await newCredentialSecret();
  const credentialId = uuidv7();
  const createdAt = utcSeconds();
  try {
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE credentials SET state = 'revoked' WHERE id = ? AND state = 'active'",
      ).bind(active.id),
      c.env.DB.prepare(
        `INSERT INTO credentials (id, agent_id, secret_hash, state, expires_at, created_at)
         SELECT ?, ?, ?, 'active', NULL, ?
          WHERE EXISTS (SELECT 1 FROM credentials WHERE id = ? AND state = 'revoked')
            AND NOT EXISTS (SELECT 1 FROM credentials WHERE agent_id = ? AND state = 'active')`,
      ).bind(credentialId, agent.id, await sha256Hex(secret), createdAt, active.id, agent.id),
    ]);
    if (Number(results[0]?.meta.changes ?? 0) !== 1 || Number(results[1]?.meta.changes ?? 0) !== 1) {
      return errorResponse(requestId, "state_conflict");
    }
  } catch (error) {
    if (!isUnique(error)) throw error;
    return errorResponse(requestId, "state_conflict");
  }
  console.log(JSON.stringify({ message: "credential rotated", agent_id: agent.id }));
  return jsonResponse(requestId, { agent_id: agent.id, credential: secret }, 201);
}

async function moveAgent(c: Ctx, from: string, to: string, message: string, action: string): Promise<Response> {
  const opened = await gate(c);
  if (opened instanceof Response) return opened;
  const requestId = c.get("requestId");
  const agent = await ownedAgent(c, opened.caller);
  if (agent instanceof Response) return agent;
  const results = await c.env.DB.batch([
    auditStatement(c, opened.caller.email, action, "id = ? AND state = ?", [agent.id, from]),
    c.env.DB.prepare("UPDATE agents SET state = ? WHERE id = ? AND state = ?").bind(to, agent.id, from),
  ]);
  if (Number(results[0]?.meta.changes ?? 0) !== 1 || Number(results[1]?.meta.changes ?? 0) !== 1) {
    return errorResponse(requestId, "state_conflict");
  }
  console.log(JSON.stringify({ message, agent_id: agent.id }));
  return jsonResponse(requestId, { agent_id: agent.id, state: to });
}

async function retire(c: Ctx): Promise<Response> {
  const opened = await gate(c);
  if (opened instanceof Response) return opened;
  const requestId = c.get("requestId");
  const agent = await ownedAgent(c, opened.caller);
  if (agent instanceof Response) return agent;
  if (agent.state === "retired") return errorResponse(requestId, "state_conflict");
  const actionId = uuidv7();
  const results = await c.env.DB.batch([
    auditStatement(
      c,
      opened.caller.email,
      "retire_agent",
      "id = ? AND state IN ('invited', 'active', 'suspended')",
      [agent.id],
      actionId,
    ),
    c.env.DB.prepare(
      "UPDATE agents SET state = 'retired' WHERE id = ? AND state IN ('invited', 'active', 'suspended')",
    ).bind(agent.id),
    c.env.DB.prepare(
      `UPDATE credentials SET state = 'revoked'
        WHERE agent_id = ? AND state = 'active'
          AND EXISTS (SELECT 1 FROM moderation_actions WHERE id = ?)`,
    ).bind(agent.id, actionId),
  ]);
  if (Number(results[0]?.meta.changes ?? 0) !== 1 || Number(results[1]?.meta.changes ?? 0) !== 1) {
    return errorResponse(requestId, "state_conflict");
  }
  console.log(JSON.stringify({ message: "agent retired", agent_id: agent.id }));
  return jsonResponse(requestId, { agent_id: agent.id, state: "retired" });
}

async function gate(c: Ctx): Promise<{ caller: Caller } | Response> {
  const requestId = c.get("requestId");
  if (c.req.raw.headers.get("authorization") !== null) {
    const agent = await requireAgent(c.env, c.req.raw);
    if (!agent.ok) return errorResponse(requestId, agent.code);
    return errorResponse(requestId, "forbidden");
  }
  const moderator = await requireModerator(c.env, c.req.raw, c.executionCtx);
  if (moderator.ok && moderator.kind === "moderator") {
    if (!sameOrigin(c.req.raw, c.get("policy").site_origin)) return errorResponse(requestId, "forbidden");
    return { caller: { email: moderator.email, kind: "moderator" } };
  }
  const operator = await requireOperator(c.env, c.req.raw, c.executionCtx);
  if (!operator.ok) return errorResponse(requestId, operator.code);
  if (operator.kind !== "operator") return errorResponse(requestId, "forbidden");
  if (!sameOrigin(c.req.raw, c.get("policy").site_origin)) return errorResponse(requestId, "forbidden");
  return { caller: { email: operator.email, kind: "operator" } };
}

async function ownedAgent(c: Ctx, caller: Caller): Promise<AgentRow | Response> {
  const requestId = c.get("requestId");
  const agentId = c.req.param("id");
  if (agentId === undefined || !isUuidV7(agentId)) return errorResponse(requestId, "not_found");
  const agent = await c.env.DB.prepare(
    "SELECT id, state, operator_id FROM agents WHERE id = ?",
  ).bind(agentId).first<AgentRow>();
  if (!agent) return errorResponse(requestId, "not_found");
  if (!(await mayManage(c, caller, agent.operator_id))) return errorResponse(requestId, "forbidden");
  return agent;
}

function auditStatement(
  c: Ctx,
  email: string,
  action: string,
  guard: string,
  guardBinds: string[],
  actionId = uuidv7(),
): D1PreparedStatement {
  return c.env.DB.prepare(
    `INSERT INTO moderation_actions (
       id, actor_email, target_type, target_id, action, reason_code, private_note, event_id, created_at
     )
     SELECT ?, ?, 'agent', id, ?, 'other', NULL, NULL, ? FROM agents WHERE ${guard}`,
  ).bind(actionId, email, action, utcSeconds(), ...guardBinds);
}

async function mayManage(c: Ctx, caller: Caller, operatorId: string | null): Promise<boolean> {
  if (caller.kind === "moderator") return true;
  const operator = await c.env.DB.prepare(
    "SELECT id FROM operators WHERE email = ?",
  ).bind(caller.email).first<{ id: string | null }>();
  return operator?.id != null && operator.id === operatorId;
}

function isUnique(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE");
}
