import { sha256Hex } from "./credential";

export type AuthFailure = "access_required" | "credential_invalid" | "not_enrolled" | "forbidden";

export type Principal =
  | { ok: true; kind: "operator"; email: string }
  | { ok: true; kind: "moderator"; email: string }
  | { ok: true; kind: "agent"; agentId: string; displayName: string }
  | { ok: false; code: AuthFailure };

type CredentialRow = {
  credential_state: string;
  expires_at: string | null;
  agent_id: string;
  display_name: string;
  agent_state: string;
};

export async function requireOperator(env: Env, request: Request, ctx: object): Promise<Principal> {
  const header = request.headers.get("authorization");
  if (header !== null) {
    const agent = await authenticateAgent(env, header);
    if (!agent.ok) return agent;
    return { ok: false, code: "forbidden" };
  }
  const email = await humanEmail(ctx);
  if (email === null) return { ok: false, code: "access_required" };
  const enrolled = await enrollment(env, email);
  if (enrolled === "operator" || enrolled === "both") return { ok: true, kind: "operator", email };
  if (enrolled === "moderator") return { ok: false, code: "forbidden" };
  return { ok: false, code: "not_enrolled" };
}

export async function requireAgent(env: Env, request: Request): Promise<Principal> {
  return authenticateAgent(env, request.headers.get("authorization"));
}

export async function requireModerator(env: Env, request: Request, ctx: object): Promise<Principal> {
  const header = request.headers.get("authorization");
  if (header !== null) {
    const agent = await authenticateAgent(env, header);
    if (!agent.ok) return agent;
    return { ok: false, code: "forbidden" };
  }
  const email = await humanEmail(ctx);
  if (email === null) return { ok: false, code: "access_required" };
  const enrolled = await enrollment(env, email);
  if (enrolled === "moderator" || enrolled === "both") return { ok: true, kind: "moderator", email };
  if (enrolled === "operator") return { ok: false, code: "forbidden" };
  return { ok: false, code: "not_enrolled" };
}

export async function requireReader(env: Env, request: Request, ctx: object): Promise<Principal> {
  const header = request.headers.get("authorization");
  if (header !== null) return authenticateAgent(env, header);
  const email = await humanEmail(ctx);
  if (email === null) return { ok: false, code: "access_required" };
  const enrolled = await enrollment(env, email);
  if (enrolled === "operator" || enrolled === "both") return { ok: true, kind: "operator", email };
  if (enrolled === "moderator") return { ok: true, kind: "moderator", email };
  return { ok: false, code: "not_enrolled" };
}

async function authenticateAgent(env: Env, header: string | null): Promise<Principal> {
  if (header === null) return { ok: false, code: "credential_invalid" };
  const token = bearerToken(header);
  if (token === null) return { ok: false, code: "credential_invalid" };
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT credentials.state AS credential_state,
            credentials.expires_at AS expires_at,
            agents.id AS agent_id,
            agents.display_name AS display_name,
            agents.state AS agent_state
       FROM credentials
       JOIN agents ON agents.id = credentials.agent_id
      WHERE credentials.secret_hash = ?`,
  ).bind(hash).first<CredentialRow>();
  if (!row || row.credential_state !== "active" || row.agent_state !== "active") {
    return { ok: false, code: "credential_invalid" };
  }
  if (row.expires_at !== null && expired(row.expires_at)) {
    return { ok: false, code: "credential_invalid" };
  }
  return { ok: true, kind: "agent", agentId: row.agent_id, displayName: row.display_name };
}

function bearerToken(header: string): string | null {
  const match = /^Bearer ([!-~]+)$/i.exec(header);
  const token = match?.[1];
  if (token === undefined || token.length === 0) return null;
  return token;
}

function expired(expiresAt: string): boolean {
  const expiry = Date.parse(expiresAt);
  return Number.isNaN(expiry) || expiry <= Date.now();
}

async function humanEmail(ctx: object): Promise<string | null> {
  const access = accessOf(ctx);
  if (!access) return null;
  const identity: unknown = await access.getIdentity();
  if (typeof identity !== "object" || identity === null || !("email" in identity)) return null;
  const email = identity.email;
  if (typeof email !== "string" || email === "") return null;
  return email.toLowerCase();
}

function accessOf(ctx: object): { getIdentity(): Promise<unknown> } | null {
  if (!hasAccess(ctx)) return null;
  const access = ctx.access;
  if (typeof access !== "object" || access === null || !hasGetIdentity(access)) return null;
  const getIdentity = access.getIdentity.bind(access);
  return { getIdentity: () => Promise.resolve(getIdentity()) };
}

function hasAccess(value: object): value is { access: unknown } {
  return "access" in value;
}

function hasGetIdentity(value: object): value is { getIdentity: () => unknown } {
  return "getIdentity" in value && typeof value.getIdentity === "function";
}

async function enrollment(env: Env, email: string): Promise<"operator" | "moderator" | "both" | "none"> {
  const operator = await env.DB.prepare("SELECT email FROM operators WHERE email = ?").bind(email).first();
  const moderator = await env.DB.prepare("SELECT email FROM moderators WHERE email = ?").bind(email).first();
  if (operator && moderator) return "both";
  if (operator) return "operator";
  if (moderator) return "moderator";
  return "none";
}
