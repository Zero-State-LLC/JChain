import { parseStoredScopes, requirePrincipal, type Principal } from "./auth";
import { newId, newSecret, sha256Hex } from "./crypto";
import { fail, isResponse, ok, parseResourceId, readJson, type App, type ErrorStatus } from "./http";

const ALLOWED_SCOPES = ["read", "post", "react"] as const;
const CONTROL = /[\u0000-\u001F\u007F]/;

type Failure = { ok: false; status: ErrorStatus; code: string; message: string };

type AgentRow = {
  id: string;
  operator_id: string;
  display_name: string;
  declared_model: string | null;
  state: string;
};

type CredentialRow = {
  id: string;
  agent_id: string;
  scopes: string;
  state: string;
  operator_id: string;
};

function publicAgent(row: AgentRow): Record<string, unknown> {
  return {
    id: row.id,
    operator_id: row.operator_id,
    display_name: row.display_name,
    declared_model: row.declared_model,
    state: row.state,
  };
}

function canReadAgent(principal: Principal, agent: AgentRow): boolean {
  if (principal.type === "operator") return principal.id === agent.operator_id;
  if (principal.type === "agent") return principal.id === agent.id;
  return false;
}

function resolveDisplayName(input: unknown): string | Failure {
  if (typeof input !== "string") {
    return { ok: false, status: 422, code: "unprocessable", message: "Display name must be 1 to 64 characters without control characters." };
  }
  const trimmed = input.trim();
  if (trimmed.length < 1 || trimmed.length > 64 || CONTROL.test(trimmed)) {
    return { ok: false, status: 422, code: "unprocessable", message: "Display name must be 1 to 64 characters without control characters." };
  }
  return trimmed;
}

function resolveModel(input: unknown): string | null | Failure {
  if (input === undefined || input === null) return null;
  if (typeof input !== "string") {
    return { ok: false, status: 422, code: "unprocessable", message: "Declared model must be 1 to 120 characters without control characters." };
  }
  const trimmed = input.trim();
  if (trimmed.length < 1 || trimmed.length > 120 || CONTROL.test(trimmed)) {
    return { ok: false, status: 422, code: "unprocessable", message: "Declared model must be 1 to 120 characters without control characters." };
  }
  return trimmed;
}

function resolveScopes(input: unknown): string[] | Failure {
  if (input === undefined) return [...ALLOWED_SCOPES];
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, status: 422, code: "unprocessable", message: "Credential scopes can only include read, post, and react." };
  }
  const requested: string[] = [];
  for (const item of input) {
    if (typeof item !== "string" || requested.includes(item)) {
      return { ok: false, status: 422, code: "unprocessable", message: "Credential scopes can only include read, post, and react." };
    }
    requested.push(item);
  }
  if (requested.some((item) => !ALLOWED_SCOPES.includes(item as (typeof ALLOWED_SCOPES)[number]))) {
    return { ok: false, status: 422, code: "unprocessable", message: "Credential scopes can only include read, post, and react." };
  }
  return ALLOWED_SCOPES.filter((item) => requested.includes(item));
}

function isFailure(value: unknown): value is Failure {
  return typeof value === "object" && value !== null && "ok" in value && (value as Failure).ok === false;
}

async function findAgent(db: D1Database, id: string): Promise<AgentRow | null> {
  return db
    .prepare(
      "SELECT id, operator_id, display_name, declared_model, state FROM agents WHERE id = ?",
    )
    .bind(id)
    .first<AgentRow>();
}

function audit(
  db: D1Database,
  event: {
    actorType: string;
    actorId: string;
    action: string;
    targetType: string;
    targetId: string;
    requestId: string;
    createdAt: string;
  },
) {
  return db
    .prepare(
      `INSERT INTO audit_events
        (id, actor_type, actor_id, action, target_type, target_id, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId("aud"),
      event.actorType,
      event.actorId,
      event.action,
      event.targetType,
      event.targetId,
      event.requestId,
      event.createdAt,
    );
}

export function registerAgentRoutes(app: App): void {
  app.post("/v1/agents", async (c) => {
    const principal = await requirePrincipal(c);
    if (isResponse(principal)) return principal;
    if (principal.type !== "operator") {
      return fail(c, 403, "forbidden", "Operator authority is required.");
    }
    const body = await readJson(c);
    if (isResponse(body)) return body;

    const displayName = resolveDisplayName(body.display_name);
    if (isFailure(displayName)) return fail(c, displayName.status, displayName.code, displayName.message);
    const declaredModel = resolveModel(body.declared_model);
    if (isFailure(declaredModel)) return fail(c, declaredModel.status, declaredModel.code, declaredModel.message);
    const scopes = resolveScopes(body.scopes);
    if (isFailure(scopes)) return fail(c, scopes.status, scopes.code, scopes.message);

    const now = new Date().toISOString();
    const agentId = newId("agt");
    const credentialId = newId("crd");
    const secret = newSecret("jcag_");
    const secretHash = await sha256Hex(secret);
    const requestId = c.get("requestId");
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO agents (id, operator_id, display_name, declared_model, state, created_at)
         VALUES (?, ?, ?, ?, 'active', ?)`,
      ).bind(agentId, principal.id, displayName, declaredModel, now),
      c.env.DB.prepare(
        `INSERT INTO credentials (id, agent_id, secret_hash, scopes, state, created_at, revoked_at)
         VALUES (?, ?, ?, ?, 'active', ?, NULL)`,
      ).bind(credentialId, agentId, secretHash, JSON.stringify(scopes), now),
      audit(c.env.DB, {
        actorType: "operator",
        actorId: principal.id,
        action: "agent.enrolled",
        targetType: "agent",
        targetId: agentId,
        requestId,
        createdAt: now,
      }),
      audit(c.env.DB, {
        actorType: "operator",
        actorId: principal.id,
        action: "credential.issued",
        targetType: "credential",
        targetId: credentialId,
        requestId,
        createdAt: now,
      }),
    ]);

    return ok(
      c,
      201,
      {
        agent: {
          id: agentId,
          operator_id: principal.id,
          display_name: displayName,
          declared_model: declaredModel,
          state: "active",
        },
        credential: {
          id: credentialId,
          secret,
          scopes,
          state: "active",
        },
      },
      { Location: `/v1/agents/${agentId}` },
    );
  });

  app.get("/v1/agents", async (c) => {
    const principal = await requirePrincipal(c);
    if (isResponse(principal)) return principal;
    if (principal.type !== "operator") {
      return fail(c, 403, "forbidden", "Operator authority is required.");
    }
    const listed = await c.env.DB.prepare(
      `SELECT id, operator_id, display_name, declared_model, state
       FROM agents
       WHERE operator_id = ?
       ORDER BY created_at ASC, id ASC
       LIMIT 100`,
    )
      .bind(principal.id)
      .all<AgentRow>();
    return ok(c, 200, { agents: listed.results.map(publicAgent) });
  });

  app.get("/v1/agents/:agent_id", async (c) => {
    const principal = await requirePrincipal(c);
    if (isResponse(principal)) return principal;
    const agent = await visibleAgent(c.env.DB, principal, c.req.param("agent_id"));
    if (isFailure(agent)) return fail(c, agent.status, agent.code, agent.message);
    return ok(c, 200, { agent: publicAgent(agent) });
  });

  app.patch("/v1/agents/:agent_id", async (c) => {
    const principal = await requirePrincipal(c);
    if (isResponse(principal)) return principal;
    const agent = await visibleAgent(c.env.DB, principal, c.req.param("agent_id"));
    if (isFailure(agent)) return fail(c, agent.status, agent.code, agent.message);
    if (agent.state !== "active") {
      return fail(c, 409, "conflict", "Agent cannot be changed.");
    }
    const body = await readJson(c);
    if (isResponse(body)) return body;
    const displayName = resolveDisplayName(body.display_name);
    if (isFailure(displayName)) return fail(c, displayName.status, displayName.code, displayName.message);
    const now = new Date().toISOString();
    const actorType = principal.type === "operator" ? "operator" : "agent";
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE agents SET display_name = ? WHERE id = ? AND state = 'active'").bind(displayName, agent.id),
      audit(c.env.DB, {
        actorType,
        actorId: principal.id,
        action: "agent.display_name_updated",
        targetType: "agent",
        targetId: agent.id,
        requestId: c.get("requestId"),
        createdAt: now,
      }),
    ]);
    return ok(c, 200, { agent: publicAgent({ ...agent, display_name: displayName }) });
  });

  app.get("/v1/agents/:agent_id/credentials", async (c) => {
    const principal = await requirePrincipal(c);
    if (isResponse(principal)) return principal;
    const agent = await visibleAgent(c.env.DB, principal, c.req.param("agent_id"));
    if (isFailure(agent)) return fail(c, agent.status, agent.code, agent.message);
    const listed = await c.env.DB.prepare(
      `SELECT id, state, scopes, created_at
       FROM credentials
       WHERE agent_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
      .bind(agent.id)
      .all<{ id: string; state: string; scopes: string; created_at: string }>();
    const credentials = listed.results.map((row) => {
      const scopes = parseStoredScopes(row.scopes);
      if (!scopes) throw new Error("credential scopes are invalid");
      return { id: row.id, state: row.state, scopes, created_at: row.created_at };
    });
    return ok(c, 200, { credentials });
  });

  app.post("/v1/credentials/:credential_id/revoke", async (c) => {
    const principal = await requirePrincipal(c);
    if (isResponse(principal)) return principal;
    if (principal.type !== "operator") {
      return fail(c, 403, "forbidden", "Operator authority is required.");
    }
    const credentialId = parseResourceId(c.req.param("credential_id"));
    if (!credentialId) return fail(c, 404, "not_found", "Resource not found.");
    const credential = await c.env.DB.prepare(
      `SELECT c.id, c.agent_id, c.scopes, c.state, a.operator_id
       FROM credentials c
       JOIN agents a ON a.id = c.agent_id
       WHERE c.id = ?`,
    )
      .bind(credentialId)
      .first<CredentialRow>();
    if (!credential || credential.operator_id !== principal.id) {
      return fail(c, 404, "not_found", "Resource not found.");
    }
    if (credential.state !== "active") {
      return fail(c, 409, "conflict", "Credential is already inactive.");
    }
    const scopes = parseStoredScopes(credential.scopes);
    if (!scopes) return fail(c, 404, "not_found", "Resource not found.");
    const now = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE credentials SET state = 'revoked', revoked_at = ? WHERE id = ? AND state = 'active'",
      ).bind(now, credential.id),
      audit(c.env.DB, {
        actorType: "operator",
        actorId: principal.id,
        action: "credential.revoked",
        targetType: "credential",
        targetId: credential.id,
        requestId: c.get("requestId"),
        createdAt: now,
      }),
    ]);
    return ok(c, 200, {
      credential: {
        id: credential.id,
        agent_id: credential.agent_id,
        state: "revoked",
        scopes,
      },
    });
  });

  app.get("/v1/session", async (c) => {
    const principal = await requirePrincipal(c);
    if (isResponse(principal)) return principal;
    if (principal.type === "agent") {
      return ok(c, 200, {
        principal: { type: "agent", id: principal.id, scopes: principal.scopes },
      });
    }
    return ok(c, 200, { principal: { type: principal.type, id: principal.id } });
  });
}

async function visibleAgent(db: D1Database, principal: Principal, rawId: string): Promise<AgentRow | Failure> {
  const id = parseResourceId(rawId);
  const agent = id ? await findAgent(db, id) : null;
  if (!agent || !canReadAgent(principal, agent)) {
    return { ok: false, status: 404, code: "not_found", message: "Resource not found." };
  }
  return agent;
}
