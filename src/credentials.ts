import { Hono, type Context } from "hono";
import {
  OWNER_ISSUES,
  RESUME,
  SUSPEND,
  mayManage,
  moveAgent,
  retireAgent,
  rotateCredential,
  type Caller,
  type Move,
} from "./agent-admin";
import { errorResponse, jsonResponse } from "./http";
import { isUuidV7 } from "./ids";
import { sameOrigin } from "./origin";
import type { Policy } from "./policy";
import { requireAgent, requireModerator, requireOperator } from "./principal";

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type App = Hono<AppEnv>;
type Ctx = Context<AppEnv>;

export function mountCredentials(app: App): void {
  app.post("/v1/credentials/:id/revoke", revoke);
  app.post("/v1/agents/:id/credentials", rotate);
  app.post("/v1/agents/:id/suspend", (c) => move(c, SUSPEND));
  app.post("/v1/agents/:id/resume", (c) => move(c, RESUME));
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
  if (!(await mayManage(c.env.DB, opened.caller, row.operator_id))) return errorResponse(requestId, "forbidden");
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
  const result = await rotateCredential(c.env.DB, opened.caller, c.req.param("id"));
  if (!result.ok) return errorResponse(requestId, result.code, result.message);
  // CT-10: a Moderator's rotate revokes and returns no secret. Only the owner gets one.
  if (result.credential === null) {
    return jsonResponse(requestId, { agent_id: result.agentId, credential: null, state: "revoked", message: OWNER_ISSUES });
  }
  return jsonResponse(requestId, { agent_id: result.agentId, credential: result.credential }, 201);
}

async function move(c: Ctx, change: Move): Promise<Response> {
  const opened = await gate(c);
  if (opened instanceof Response) return opened;
  const requestId = c.get("requestId");
  const result = await moveAgent(c.env.DB, opened.caller, c.req.param("id"), change);
  if (!result.ok) return errorResponse(requestId, result.code, result.message);
  return jsonResponse(requestId, { agent_id: result.agentId, state: result.state });
}

async function retire(c: Ctx): Promise<Response> {
  const opened = await gate(c);
  if (opened instanceof Response) return opened;
  const requestId = c.get("requestId");
  const result = await retireAgent(c.env.DB, opened.caller, c.req.param("id"));
  if (!result.ok) return errorResponse(requestId, result.code, result.message);
  return jsonResponse(requestId, { agent_id: result.agentId, state: result.state });
}

async function gate(c: Ctx): Promise<{ caller: Caller } | Response> {
  const requestId = c.get("requestId");
  if (c.req.raw.headers.get("authorization") !== null) {
    const agent = await requireAgent(c.env, c.req.raw, c.executionCtx);
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
