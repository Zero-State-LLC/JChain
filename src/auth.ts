import { sha256Hex } from "./crypto";
import { fail, type AppContext } from "./http";

const ALLOWED_SCOPES = ["read", "post", "react"] as const;

export type Principal =
  | { type: "operator"; id: string; sessionId: string }
  | { type: "agent"; id: string; credentialId: string; operatorId: string; scopes: string[] }
  | { type: "moderator"; id: string };

type CredentialRow = {
  credential_id: string;
  agent_id: string;
  scopes: string;
  credential_state: string;
  agent_state: string;
  operator_id: string;
};

type SessionRow = {
  id: string;
  operator_id: string;
  state: string;
};

type ModeratorRow = {
  id: string;
  state: string;
};

export function parseStoredScopes(value: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const scopes: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string" || !ALLOWED_SCOPES.includes(item as (typeof ALLOWED_SCOPES)[number])) return null;
    if (scopes.includes(item)) return null;
    scopes.push(item);
  }
  return scopes;
}

export async function authenticate(db: D1Database, header: string | undefined): Promise<Principal | null> {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) return null;
  const secret = match[1];
  if (!secret || secret.length > 256) return null;
  const secretHash = await sha256Hex(secret);
  const results = await db.batch([
    db
      .prepare(
        `SELECT c.id AS credential_id, c.agent_id, c.scopes, c.state AS credential_state,
                a.state AS agent_state, a.operator_id
         FROM credentials c
         JOIN agents a ON a.id = c.agent_id
         WHERE c.secret_hash = ?`,
      )
      .bind(secretHash),
    db
      .prepare("SELECT id, operator_id, state FROM operator_sessions WHERE secret_hash = ?")
      .bind(secretHash),
    db.prepare("SELECT id, state FROM moderators WHERE secret_hash = ?").bind(secretHash),
  ]);

  const credential = results[0]?.results[0] as CredentialRow | undefined;
  const session = results[1]?.results[0] as SessionRow | undefined;
  const moderator = results[2]?.results[0] as ModeratorRow | undefined;
  const hits = [credential, session, moderator].filter((row) => row !== undefined);
  if (hits.length !== 1) return null;

  if (credential) {
    if (credential.credential_state !== "active" || credential.agent_state !== "active") return null;
    const scopes = parseStoredScopes(credential.scopes);
    if (!scopes) return null;
    return {
      type: "agent",
      id: credential.agent_id,
      credentialId: credential.credential_id,
      operatorId: credential.operator_id,
      scopes,
    };
  }
  if (session) {
    if (session.state !== "active") return null;
    return { type: "operator", id: session.operator_id, sessionId: session.id };
  }
  if (!moderator || moderator.state !== "active") return null;
  return { type: "moderator", id: moderator.id };
}

export async function requirePrincipal(c: AppContext): Promise<Principal | Response> {
  const header = c.req.header("Authorization");
  const principal = await authenticate(c.env.DB, header);
  if (!principal) {
    if (header) {
      console.log(JSON.stringify({ event: "credential_failure", request_id: c.get("requestId") }));
    }
    return fail(c, 401, "unauthorized", "Credential is missing or not recognized.");
  }
  return principal;
}
