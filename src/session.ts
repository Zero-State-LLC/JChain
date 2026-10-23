import { newPrefixedSecret, sha256Hex } from "./credential";
import { utcSeconds, uuidv7 } from "./ids";
import { parsePolicy, type AuthPolicy, type Policy } from "./policy";

// CT-18 as amended in v0.2.23: Sign-in Links and Operator Sessions.
// Only SHA-256 hashes are stored. No email, token, or secret is logged.

export const SESSION_COOKIE = "__Host-jc_session";
const LINK_TOKEN = /^sl_[A-Za-z0-9_-]{43}$/;
const SESSION_SECRET = /^ss_[A-Za-z0-9_-]{43}$/;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export type MailMessage = { from: string; to: string; subject: string; text: string };
export type Mailer = { send(message: MailMessage): Promise<unknown> };

export type EmailSignIn = { auth: AuthPolicy; mailer: Mailer };

export type SessionInfo = { id: string; operatorId: string; email: string };

// The optional send-email binding. It is not in the Wrangler config: Danny adds
// it with Email Sending. Read defensively, like the optional AI binding.
export function mailerOf(env: Env): Mailer | null {
  const binding = (env as Env & { EMAIL?: unknown }).EMAIL;
  if (typeof binding !== "object" || binding === null) return null;
  const send = (binding as { send?: unknown }).send;
  if (typeof send !== "function") return null;
  return { send: (message) => Promise.resolve(send.call(binding, message)) };
}

// Email sign-in is on only with a valid `auth` block and the EMAIL binding.
export function emailSignIn(env: Env, policy: Policy | null): EmailSignIn | null {
  if (policy === null || policy.auth === undefined) return null;
  const mailer = mailerOf(env);
  if (mailer === null) return null;
  return { auth: policy.auth, mailer };
}

export function policyOf(env: Env): Policy | null {
  return parsePolicy(typeof env.POLICY === "string" ? env.POLICY : undefined);
}

export function isLinkToken(value: string): boolean {
  return LINK_TOKEN.test(value);
}

export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    return SESSION_SECRET.test(value) ? value : null;
  }
  return null;
}

export function sessionCookie(secret: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${secret}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;
}

export const CLEAR_SESSION_COOKIE = `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

// The signed-in Operator for this request, or null. A Session counts only while
// email sign-in is on, so turning it off ends every Session without a write.
export async function currentSession(env: Env, request: Request, now = Date.now()): Promise<SessionInfo | null> {
  const secret = readSessionCookie(request);
  if (secret === null) return null;
  const enabled = emailSignIn(env, policyOf(env));
  if (enabled === null) return null;
  const row = await env.DB.prepare(
    `SELECT sessions.id AS id, sessions.operator_id AS operator_id, sessions.created_at AS created_at,
            sessions.last_used_at AS last_used_at, operators.email AS email
       FROM sessions
       JOIN operators ON operators.id = sessions.operator_id
      WHERE sessions.secret_hash = ? AND sessions.revoked_at IS NULL
        AND operators.state IN ('provisional', 'approved')`,
  ).bind(await sha256Hex(secret)).first<{
    id: string;
    operator_id: string;
    created_at: string;
    last_used_at: string;
    email: string;
  }>();
  if (!row) return null;
  const { auth } = enabled;
  const created = Date.parse(row.created_at);
  const lastUsed = Date.parse(row.last_used_at);
  if (!Number.isFinite(created) || !Number.isFinite(lastUsed)) return null;
  if (now >= created + auth.session_days * DAY_MS) return null;
  if (now >= lastUsed + auth.idle_days * DAY_MS) return null;
  // Last use is written at most once an hour.
  if (now - lastUsed >= HOUR_MS) {
    await env.DB.prepare(
      "UPDATE sessions SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL",
    ).bind(utcSeconds(new Date(now)), row.id).run();
  }
  return { id: row.id, operatorId: row.operator_id, email: row.email };
}

// A new single-use link for an existing Operator. Returns the plaintext token,
// which goes only into the email.
export async function issueLink(db: D1Database, operatorId: string, auth: AuthPolicy, now = Date.now()): Promise<string> {
  const token = newPrefixedSecret("sl_");
  await db.batch([
    // Links of this Operator that ended are dropped first, so they never pile up.
    db.prepare(
      "DELETE FROM signin_links WHERE operator_id = ? AND (consumed_by IS NOT NULL OR expires_at <= ?)",
    ).bind(operatorId, utcSeconds(new Date(now))),
    db.prepare(
      "INSERT INTO signin_links (token_hash, operator_id, created_at, expires_at, consumed_by) VALUES (?, ?, ?, ?, NULL)",
    ).bind(
      await sha256Hex(token),
      operatorId,
      utcSeconds(new Date(now)),
      utcSeconds(new Date(now + auth.link_minutes * MINUTE_MS)),
    ),
  ]);
  return token;
}

// Consumes a link and starts a Session in one D1 batch. Returns the Session
// secret, or null for a used, expired, or unknown link.
export async function consumeLink(
  db: D1Database,
  token: string,
  auth: AuthPolicy,
  now = Date.now(),
): Promise<{ secret: string; maxAge: number } | null> {
  if (!isLinkToken(token)) return null;
  const tokenHash = await sha256Hex(token);
  const stamp = utcSeconds(new Date(now));
  const link = await db.prepare(
    "SELECT operator_id FROM signin_links WHERE token_hash = ? AND consumed_by IS NULL AND expires_at > ?",
  ).bind(tokenHash, stamp).first<{ operator_id: string }>();
  if (!link) return null;
  const sessionId = uuidv7(now);
  const secret = newPrefixedSecret("ss_");
  const results = await db.batch([
    db.prepare(
      "UPDATE signin_links SET consumed_by = ? WHERE token_hash = ? AND consumed_by IS NULL AND expires_at > ?",
    ).bind(sessionId, tokenHash, stamp),
    db.prepare(
      `INSERT INTO sessions (id, secret_hash, operator_id, created_at, last_used_at, revoked_at)
       SELECT ?, ?, operator_id, ?, ?, NULL FROM signin_links WHERE token_hash = ? AND consumed_by = ?`,
    ).bind(sessionId, await sha256Hex(secret), stamp, stamp, tokenHash, sessionId),
    // An Operator holds at most sessions_per_operator Sessions; the oldest end first.
    db.prepare(
      `UPDATE sessions SET revoked_at = ?
        WHERE operator_id = ? AND revoked_at IS NULL
          AND id NOT IN (
            SELECT id FROM sessions WHERE operator_id = ? AND revoked_at IS NULL
             ORDER BY created_at DESC, id DESC LIMIT ?)`,
    ).bind(stamp, link.operator_id, link.operator_id, auth.sessions_per_operator),
  ]);
  if (Number(results[1]?.meta.changes ?? 0) !== 1) return null;
  console.log(JSON.stringify({ message: "session started", session_id: sessionId }));
  return { secret, maxAge: auth.session_days * 24 * 60 * 60 };
}

// Ticket 25 (CT-19, AT-30): sign-up while auth.signup_open is true.

// A UTC day starts at 00:00:00Z; sign-ups are counted from it.
function dayStart(now: number): string {
  const date = new Date(now);
  return utcSeconds(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())));
}

// SQL guards that refuse a new Operator past max_operators or signups_per_day. Binds: dayStart.
function signupRoomSql(policy: Policy, auth: AuthPolicy): string {
  return `(SELECT COUNT(*) FROM operators WHERE state != 'removed') < ${Math.trunc(policy.max_operators)}
      AND (SELECT COUNT(*) FROM operators WHERE created_at >= ?) < ${Math.trunc(auth.signups_per_day)}`;
}

// May this address sign up now? Not an Operator, never removed, and inside both caps.
// Checked before a link is sent, and again inside the batch that creates the Operator.
export async function signupAllowed(db: D1Database, policy: Policy, auth: AuthPolicy, email: string, now = Date.now()): Promise<boolean> {
  if (!auth.signup_open || policy.operator_caps === undefined) return false;
  const row = await db.prepare(
    `SELECT (NOT EXISTS (SELECT 1 FROM operators WHERE email = ?)
             AND NOT EXISTS (SELECT 1 FROM removed_operator_emails WHERE email_hash = ?)
             AND ${signupRoomSql(policy, auth)}) AS ok`,
  ).bind(email, await sha256Hex(email), dayStart(now)).first<{ ok: number }>();
  return Number(row?.ok ?? 0) === 1;
}

// A new single-use sign-up link. The address is stored only until the link ends.
export async function issueSignupLink(db: D1Database, email: string, auth: AuthPolicy, now = Date.now()): Promise<string> {
  const token = newPrefixedSecret("sl_");
  await db.batch([
    db.prepare(
      "DELETE FROM signup_links WHERE email = ? AND (consumed_by IS NOT NULL OR expires_at <= ?)",
    ).bind(email, utcSeconds(new Date(now))),
    db.prepare(
      "INSERT INTO signup_links (token_hash, email, created_at, expires_at, consumed_by) VALUES (?, ?, ?, ?, NULL)",
    ).bind(
      await sha256Hex(token),
      email,
      utcSeconds(new Date(now)),
      utcSeconds(new Date(now + auth.link_minutes * MINUTE_MS)),
    ),
  ]);
  return token;
}

// Consumes a sign-up link: creates a provisional Operator and its first Session in one D1
// batch, under the same guards as signupAllowed. Null for a used, expired, or unknown link,
// or when sign-up closed or a cap was reached since the link was sent.
export async function consumeSignupLink(
  db: D1Database,
  token: string,
  policy: Policy,
  auth: AuthPolicy,
  now = Date.now(),
): Promise<{ secret: string; maxAge: number } | null> {
  if (!isLinkToken(token) || !auth.signup_open || policy.operator_caps === undefined) return null;
  const tokenHash = await sha256Hex(token);
  const stamp = utcSeconds(new Date(now));
  const link = await db.prepare(
    "SELECT email FROM signup_links WHERE token_hash = ? AND consumed_by IS NULL AND expires_at > ?",
  ).bind(tokenHash, stamp).first<{ email: string }>();
  if (!link) return null;
  const operatorId = uuidv7(now);
  const sessionId = uuidv7(now);
  const secret = newPrefixedSecret("ss_");
  const results = await db.batch([
    db.prepare(
      "UPDATE signup_links SET consumed_by = ? WHERE token_hash = ? AND consumed_by IS NULL AND expires_at > ?",
    ).bind(sessionId, tokenHash, stamp),
    db.prepare(
      `INSERT INTO operators (email, id, state, created_at)
       SELECT email, ?, 'provisional', ? FROM signup_links
        WHERE token_hash = ? AND consumed_by = ?
          AND NOT EXISTS (SELECT 1 FROM operators WHERE email = signup_links.email)
          AND NOT EXISTS (SELECT 1 FROM removed_operator_emails WHERE email_hash = ?)
          AND ${signupRoomSql(policy, auth)}`,
    ).bind(operatorId, stamp, tokenHash, sessionId, await sha256Hex(link.email), dayStart(now)),
    db.prepare(
      `INSERT INTO sessions (id, secret_hash, operator_id, created_at, last_used_at, revoked_at)
       SELECT ?, ?, id, ?, ?, NULL FROM operators WHERE id = ?`,
    ).bind(sessionId, await sha256Hex(secret), stamp, stamp, operatorId),
  ]);
  if (Number(results[1]?.meta.changes ?? 0) !== 1 || Number(results[2]?.meta.changes ?? 0) !== 1) return null;
  console.log(JSON.stringify({ message: "operator signed up", operator_id: operatorId, session_id: sessionId }));
  return { secret, maxAge: auth.session_days * 24 * 60 * 60 };
}

export async function revokeSession(db: D1Database, secret: string, now = Date.now()): Promise<void> {
  await db.prepare(
    "UPDATE sessions SET revoked_at = ? WHERE secret_hash = ? AND revoked_at IS NULL",
  ).bind(utcSeconds(new Date(now)), await sha256Hex(secret)).run();
}

export async function revokeOperatorSessions(db: D1Database, operatorId: string, now = Date.now()): Promise<number> {
  const result = await db.prepare(
    "UPDATE sessions SET revoked_at = ? WHERE operator_id = ? AND revoked_at IS NULL",
  ).bind(utcSeconds(new Date(now)), operatorId).run();
  return Number(result.meta.changes ?? 0);
}

// Retention (v0.2.23): ended Sessions and ended links are deleted within a day
// of their end. Bounded per run like the other retention steps.
// `enabled` is false when the auth block or the EMAIL binding is missing. Then no
// Session is honored (currentSession), so every Session row has ended.
export async function purgeEndedSignIns(
  db: D1Database,
  policy: Policy,
  now: number,
  enabled: boolean,
  limit = 500,
): Promise<number> {
  const dayAgo = utcSeconds(new Date(now - DAY_MS));
  const stamp = utcSeconds(new Date(now));
  const statements = [
    db.prepare(
      `DELETE FROM signin_links WHERE token_hash IN (
         SELECT token_hash FROM signin_links WHERE consumed_by IS NOT NULL OR expires_at <= ? LIMIT ?)`,
    ).bind(stamp, limit),
    db.prepare(
      `DELETE FROM sessions WHERE id IN (
         SELECT id FROM sessions WHERE revoked_at IS NOT NULL AND revoked_at <= ? LIMIT ?)`,
    ).bind(dayAgo, limit),
    // Ticket 25: a sign-up link holds an address, so it goes as soon as it has ended.
    db.prepare(
      `DELETE FROM signup_links WHERE token_hash IN (
         SELECT token_hash FROM signup_links WHERE consumed_by IS NOT NULL OR expires_at <= ? LIMIT ?)`,
    ).bind(stamp, limit),
  ];
  const auth = policy.auth;
  if (!enabled || auth === undefined) {
    statements.push(db.prepare(
      "DELETE FROM sessions WHERE id IN (SELECT id FROM sessions LIMIT ?)",
    ).bind(limit));
  } else {
    const absolute = utcSeconds(new Date(now - auth.session_days * DAY_MS - DAY_MS));
    const idle = utcSeconds(new Date(now - auth.idle_days * DAY_MS - DAY_MS));
    statements.push(db.prepare(
      `DELETE FROM sessions WHERE id IN (
         SELECT id FROM sessions WHERE created_at <= ? OR last_used_at <= ? LIMIT ?)`,
    ).bind(absolute, idle, limit));
  }
  const results = await db.batch(statements);
  return results.reduce((sum, result) => sum + Number(result.meta.changes ?? 0), 0);
}

export function signInEmail(auth: AuthPolicy, to: string, link: string, signup = false): MailMessage {
  return {
    from: auth.mail_from,
    to,
    subject: signup ? "Your j-chain.net sign-up link" : "Your j-chain.net sign-in link",
    text: [
      signup
        ? "Use this link to create your j-chain.net Operator account and sign in. A new account can add a small number of agents until an Admin approves it:"
        : "Use this link to sign in to j-chain.net:",
      "",
      link,
      "",
      `It works once and expires in ${auth.link_minutes} minutes. It opens a page with a Sign in button.`,
      "",
      "If you did not ask to sign in, ignore this email. Nobody can sign in without the link.",
      "",
      "j-chain.net is run by Zero State LLC.",
    ].join("\n"),
  };
}
