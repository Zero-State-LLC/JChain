import { accessJwtFromRequest, emailForAccessToken } from "./access-jwt";
import { sha256Hex } from "./credential";
import { utcSeconds } from "./ids";
import { currentSession } from "./session";

export type AuthFailure = "access_required" | "credential_invalid" | "not_enrolled" | "forbidden";

export type Principal =
  | { ok: true; kind: "operator"; email: string; via?: "access" | "session" }
  | { ok: true; kind: "moderator"; email: string }
  | { ok: true; kind: "admin"; email: string }
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
  const email = await humanEmail(ctx, request);
  if (email === null) {
    // v0.2.23: an Operator Session, while email sign-in is on. It never makes
    // anyone a Moderator or an Admin and never reaches an Agent route.
    const session = await currentSession(env, request);
    if (session === null) return { ok: false, code: "access_required" };
    return { ok: true, kind: "operator", email: session.email, via: "session" };
  }
  const enrolled = await enrollment(env, email);
  if (enrolled === "operator" || enrolled === "both") return { ok: true, kind: "operator", email, via: "access" };
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
  const email = await humanEmail(ctx, request);
  if (email === null) return { ok: false, code: "access_required" };
  const enrolled = await enrollment(env, email);
  if (enrolled === "moderator" || enrolled === "both") return { ok: true, kind: "moderator", email };
  if (enrolled === "operator") return { ok: false, code: "forbidden" };
  return { ok: false, code: "not_enrolled" };
}

// v0.2.21: an Admin is a Moderator whose verified Access email holds one of
// the two Admin Seats. A bearer Credential is never an Admin. Seat emails live
// only in D1, written by the deploy seed. A missing seat table fails closed.
export async function requireAdmin(env: Env, request: Request, ctx: object): Promise<Principal> {
  const header = request.headers.get("authorization");
  if (header !== null) {
    const agent = await authenticateAgent(env, header);
    if (!agent.ok) return agent;
    return { ok: false, code: "forbidden" };
  }
  const email = await humanEmail(ctx, request);
  if (email === null) return { ok: false, code: "access_required" };
  const enrolled = await enrollment(env, email);
  if (enrolled === "none") return { ok: false, code: "not_enrolled" };
  if (enrolled === "operator") return { ok: false, code: "forbidden" };
  if (!(await holdsAdminSeat(env, email))) return { ok: false, code: "forbidden" };
  return { ok: true, kind: "admin", email };
}

export async function isAdminEmail(env: Env, email: string): Promise<boolean> {
  const enrolled = await enrollment(env, email);
  if (enrolled !== "moderator" && enrolled !== "both") return false;
  return holdsAdminSeat(env, email);
}

async function holdsAdminSeat(env: Env, email: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare("SELECT seat FROM admin_seats WHERE email = ?").bind(email).first();
    return row !== null;
  } catch {
    return false;
  }
}

export async function requireReader(env: Env, request: Request, ctx: object): Promise<Principal> {
  const header = request.headers.get("authorization");
  if (header !== null) return authenticateAgent(env, header);
  const email = await humanEmail(ctx, request);
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
  await touchLastSeen(env.DB, row.agent_id);
  return { ok: true, kind: "agent", agentId: row.agent_id, displayName: row.display_name };
}

// v0.2.24 (K2): last active, written at most once an hour per Agent. A database
// without the column yet (migration 0016 not applied) skips the write.
async function touchLastSeen(db: D1Database, agentId: string): Promise<void> {
  const now = Date.now();
  const stamp = utcSeconds(new Date(now));
  const hourAgo = utcSeconds(new Date(now - 60 * 60 * 1000));
  try {
    await db.prepare(
      "UPDATE agents SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at <= ?)",
    ).bind(stamp, agentId, hourAgo).run();
  } catch {
    // Last active is advisory. Authentication never fails because of it.
  }
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

export async function accessEmail(ctx: object, request: Request): Promise<string | null> {
  return humanEmail(ctx, request);
}

async function humanEmail(ctx: object, request: Request): Promise<string | null> {
  const bound = await boundEmail(ctx);
  if (bound !== null) return bound;
  const token = accessJwtFromRequest(request);
  if (token === null) return null;
  return emailForAccessToken(token);
}

async function boundEmail(ctx: object): Promise<string | null> {
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
