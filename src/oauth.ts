// v0.2.50 M2: the Worker is the OAuth 2.1 authorization server for its own MCP endpoint (/mcp).
// Public clients only (PKCE S256, no secret), registered by Client ID Metadata Document or by
// Dynamic Client Registration. An approved grant acts as one Operator's one Agent. Only SHA-256
// hashes of codes and tokens are stored, and nothing here ever reveals an Agent Credential.
import type { Hono } from "hono";
import { AUTHORSHIP_RULE_VERSION } from "./authorship";
import { newPrefixedSecret, sha256Hex } from "./credential";
import { readForm } from "./forms";
import { HTML_CSP, htmlResponse } from "./http";
import { sameOrigin } from "./origin";
import { utcSeconds, uuidv7, isUuidV7 } from "./ids";
import { oauthApprovalPage, oauthErrorPage, oauthSignInPage } from "./oauth-pages";
import { operatorAttestation } from "./agent-admin";
import { notSeatAgentSql } from "./operator-admin";
import { requireOperator } from "./principal";
import { emailSignIn, policyOf } from "./session";
import { operatorOnly } from "./account-pages";
import type { AppEnv, Ctx } from "./hono-env";


export const SCOPE = "agent";
const REQUEST_MS = 10 * 60 * 1000;
export const ACCESS_SECONDS = 60 * 60;
const REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
const REGISTRATIONS_PER_HOUR = 100;
const METADATA_MAX_BYTES = 64 * 1024;

export type Client = { clientId: string; clientName: string | null; redirectUris: string[] };

export function mountOAuth(app: Hono<AppEnv>): void {
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);
  app.get("/.well-known/oauth-authorization-server", authorizationServer);
  app.post("/oauth/register", register);
  app.get("/oauth/authorize", authorize);
  app.get("/oauth/authorize/:id", approvalPage);
  app.post("/oauth/authorize/:id", decide);
  app.post("/oauth/token", token);
}

export function resourceUrl(origin: string): string {
  return `${origin}/mcp`;
}

export function resourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource`;
}

function originOf(c: Ctx): string | null {
  return policyOf(c.env)?.site_origin ?? null;
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status);
}

function protectedResource(c: Ctx): Response {
  const origin = originOf(c);
  if (origin === null) return oauthError("server_error", "Policy missing.", 503);
  return json({
    resource: resourceUrl(origin),
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "j-chain.net",
  });
}

function authorizationServer(c: Ctx): Response {
  const origin = originOf(c);
  if (origin === null) return oauthError("server_error", "Policy missing.", 503);
  return json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
  });
}

// A redirect URI is https, or http on the loopback host, with no fragment.
export function validRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2000) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash !== "" || url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

async function register(c: Ctx): Promise<Response> {
  if (originOf(c) === null) return oauthError("server_error", "Policy missing.", 503);
  let body: Record<string, unknown>;
  try {
    body = await c.req.raw.json() as Record<string, unknown>;
  } catch {
    return oauthError("invalid_client_metadata", "The body must be JSON.");
  }
  if (typeof body !== "object" || body === null) return oauthError("invalid_client_metadata", "The body must be a JSON object.");
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every(validRedirectUri)) {
    return oauthError("invalid_redirect_uri", "Send one to ten https redirect URIs (http only on localhost).");
  }
  const method = body.token_endpoint_auth_method;
  if (method !== undefined && method !== "none") {
    return oauthError("invalid_client_metadata", "Only public clients are supported: token_endpoint_auth_method none.");
  }
  const name = typeof body.client_name === "string" ? body.client_name.trim().slice(0, 100) : null;
  const hour = Math.floor(Date.now() / 3_600_000);
  const charged = await c.env.QUOTA.getByName("oauth").apply([
    { key: `register:${hour}`, amount: 1, limit: REGISTRATIONS_PER_HOUR, reset_at: new Date((hour + 1) * 3_600_000).toISOString(), counter: "registrations" },
  ]);
  if (!charged.ok) return oauthError("temporarily_unavailable", "Too many registrations. Try again later.", 429);
  const clientId = newPrefixedSecret("mc_");
  const at = utcSeconds();
  await c.env.DB.prepare(
    "INSERT INTO oauth_clients (client_id, client_name, redirect_uris, kind, created_at, last_used_at) VALUES (?, ?, ?, 'registered', ?, ?)",
  ).bind(clientId, name || null, JSON.stringify(uris), at, at).run();
  return json({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.parse(at) / 1000),
    client_name: name || undefined,
    redirect_uris: uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }, 201);
}

// A Client ID Metadata Document, or a connector image URL, is fetched from a public https host only.
// A metadata document also needs a path; an image URL may be any path.
export function publicHttpsUrl(value: string, anyPath = false): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.hash !== "") return null;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return null;
  if (/^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) return null;
  if (!anyPath && (url.pathname === "/" || url.pathname === "")) return null;
  return url;
}

export async function resolveClient(env: Env, clientId: string): Promise<Client | null> {
  if (clientId.length > 2000) return null;
  const row = await env.DB.prepare("SELECT client_id, client_name, redirect_uris, kind, last_used_at FROM oauth_clients WHERE client_id = ?")
    .bind(clientId).first<{ client_id: string; client_name: string | null; redirect_uris: string; kind: string; last_used_at: string }>();
  const fresh = row !== null && (row.kind === "registered" || Date.now() - Date.parse(row.last_used_at) < 24 * 60 * 60 * 1000);
  if (row !== null && fresh) {
    return { clientId: row.client_id, clientName: row.client_name, redirectUris: JSON.parse(row.redirect_uris) as string[] };
  }
  if (clientId.startsWith("mc_")) return null;
  const url = publicHttpsUrl(clientId);
  if (url === null) return null;
  const document = await fetchMetadata(url);
  if (document === null || document.client_id !== clientId) return null;
  const uris = document.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every(validRedirectUri)) return null;
  const name = typeof document.client_name === "string" ? document.client_name.trim().slice(0, 100) || null : null;
  const at = utcSeconds();
  await env.DB.prepare(
    `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, kind, created_at, last_used_at) VALUES (?, ?, ?, 'metadata', ?, ?)
     ON CONFLICT (client_id) DO UPDATE SET client_name = excluded.client_name, redirect_uris = excluded.redirect_uris, last_used_at = excluded.last_used_at`,
  ).bind(clientId, name, JSON.stringify(uris), at, at).run();
  return { clientId, clientName: name, redirectUris: uris };
}

async function fetchMetadata(url: URL): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url.toString(), {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || response.body === null) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > METADATA_MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const text = new TextDecoder().decode(concat(chunks, size));
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

function redirectWith(uri: string, params: Record<string, string | null | undefined>): Response {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) if (value !== null && value !== undefined) url.searchParams.set(key, value);
  return new Response(null, { status: 302, headers: { location: url.toString(), "cache-control": "no-store" } });
}

async function authorize(c: Ctx): Promise<Response> {
  const requestId = uuidv7();
  const policy = policyOf(c.env);
  if (policy === null) return htmlResponse(requestId, oauthErrorPage("j-chain.net is not configured."), 503);
  const q = (name: string) => c.req.query(name) ?? null;
  const clientId = q("client_id");
  const redirectUri = q("redirect_uri");
  const client = clientId === null ? null : await resolveClient(c.env, clientId);
  // Never redirect to a URI that the client did not register.
  if (client === null) return htmlResponse(requestId, oauthErrorPage("This app is not registered with j-chain.net."), 400);
  if (redirectUri === null || !client.redirectUris.includes(redirectUri)) {
    return htmlResponse(requestId, oauthErrorPage("This app sent a redirect address it did not register."), 400);
  }
  const state = q("state");
  const fail = (error: string, description: string) => redirectWith(redirectUri, { error, error_description: description, state, iss: policy.site_origin });
  if (q("response_type") !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
  const challenge = q("code_challenge");
  if (challenge === null || q("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
    return fail("invalid_request", "PKCE with code_challenge_method S256 is required.");
  }
  const resource = q("resource");
  if (resource !== null && resource.replace(/\/$/, "") !== resourceUrl(policy.site_origin)) {
    return fail("invalid_target", "The resource must be this server's /mcp endpoint.");
  }
  const scope = q("scope");
  if (scope !== null && scope.split(" ").some((item) => item !== "" && item !== SCOPE)) return fail("invalid_scope", "The only scope is agent.");
  const id = uuidv7();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO oauth_requests (id, client_id, redirect_uri, code_challenge, state, scope, status, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).bind(id, client.clientId, redirectUri, challenge, state, SCOPE, utcSeconds(new Date(now + REQUEST_MS)), utcSeconds(new Date(now))).run();
  return new Response(null, { status: 302, headers: { location: `/oauth/authorize/${id}`, "cache-control": "no-store" } });
}

type RequestRow = {
  id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string | null;
  status: string;
  expires_at: string;
  grant_id: string | null;
};

async function pendingRequest(env: Env, id: string): Promise<RequestRow | null> {
  if (!isUuidV7(id)) return null;
  return env.DB.prepare(
    "SELECT id, client_id, redirect_uri, code_challenge, state, status, expires_at, grant_id FROM oauth_requests WHERE id = ? AND status = 'pending' AND expires_at > ?",
  ).bind(id, utcSeconds()).first<RequestRow>();
}

// The Operator's active Agent that a new grant acts as, or null when `join` will make one.
async function currentAgent(db: D1Database, operatorId: string): Promise<{ id: string; display_name: string } | null> {
  return db.prepare(
    `SELECT id, display_name FROM agents WHERE operator_id = ? AND state IN ('active', 'suspended') AND ${notSeatAgentSql("agents")}
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(operatorId).first<{ id: string; display_name: string }>();
}

// The approval page may submit to the app's redirect origin, so the 302 after Approve is allowed.
function approvalCsp(redirectUri: string): string {
  return HTML_CSP.replace("form-action 'self'", `form-action 'self' ${new URL(redirectUri).origin}`);
}

async function approvalPage(c: Ctx): Promise<Response> {
  const requestId = uuidv7();
  const request = await pendingRequest(c.env, c.req.param("id") ?? "");
  if (request === null) return htmlResponse(requestId, oauthErrorPage("This sign-in request expired or was already answered. Start again from your app."), 404);
  const client = await resolveClient(c.env, request.client_id);
  if (client === null) return htmlResponse(requestId, oauthErrorPage("This app is not registered with j-chain.net."), 400);
  const principal = await requireOperator(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) {
    if (principal.code === "access_required") {
      const enabled = emailSignIn(c.env, policyOf(c.env));
      return htmlResponse(requestId, oauthSignInPage({
        requestId: request.id,
        appName: client.clientName,
        emailOn: enabled !== null,
        linkMinutes: enabled?.auth.link_minutes,
      }), 401);
    }
    return htmlResponse(requestId, operatorOnly(), 403);
  }
  if (principal.kind !== "operator") return htmlResponse(requestId, operatorOnly(), 403);
  const operator = await operatorAttestation(c.env.DB, principal.email);
  if (operator === null) return htmlResponse(requestId, oauthErrorPage("This Operator account cannot connect apps now."), 403);
  const agent = await currentAgent(c.env.DB, operator.id);
  return htmlResponse(requestId, oauthApprovalPage({
    requestId: request.id,
    appName: client.clientName,
    redirectHost: new URL(request.redirect_uri).host,
    agentName: agent?.display_name ?? null,
    attested: operator.attested,
  }), 200, approvalCsp(request.redirect_uri));
}

async function decide(c: Ctx): Promise<Response> {
  const requestId = uuidv7();
  const policy = policyOf(c.env);
  if (policy === null) return htmlResponse(requestId, oauthErrorPage("j-chain.net is not configured."), 503);
  if (!sameOrigin(c.req.raw, policy.site_origin)) return htmlResponse(requestId, oauthErrorPage("That request came from another site."), 403);
  const request = await pendingRequest(c.env, c.req.param("id") ?? "");
  if (request === null) return htmlResponse(requestId, oauthErrorPage("This sign-in request expired or was already answered. Start again from your app."), 404);
  const principal = await requireOperator(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok || principal.kind !== "operator") return htmlResponse(requestId, oauthErrorPage("Sign in as an Operator to answer this request."), 401);
  const operator = await operatorAttestation(c.env.DB, principal.email);
  if (operator === null) return htmlResponse(requestId, oauthErrorPage("This Operator account cannot connect apps now."), 403);
  const form = await readForm(c.req.raw);
  if (!form.ok) return htmlResponse(requestId, oauthErrorPage("The form could not be read."), 400);
  const decision = form.value.decision;
  if (decision === "deny") {
    await c.env.DB.prepare("UPDATE oauth_requests SET status = 'denied' WHERE id = ? AND status = 'pending'").bind(request.id).run();
    return redirectWith(request.redirect_uri, { error: "access_denied", error_description: "The Operator denied the request.", state: request.state, iss: policy.site_origin });
  }
  if (decision !== "approve") return htmlResponse(requestId, oauthErrorPage("Choose Approve or Deny."), 400);
  // CT-29: connecting an app can create an Agent, so it needs the Authorship Rule.
  const attesting = !operator.attested;
  if (attesting && form.value.attest !== "yes") {
    return htmlResponse(requestId, oauthErrorPage("Agree to the Authorship Rule to connect an app. Go back and tick the box."), 400);
  }
  const client = await resolveClient(c.env, request.client_id);
  const agent = await currentAgent(c.env.DB, operator.id);
  const grantId = uuidv7();
  const code = newPrefixedSecret("oc_");
  const at = utcSeconds();
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `UPDATE oauth_requests SET status = 'approved', code_hash = ?, grant_id = ?, expires_at = ?
        WHERE id = ? AND status = 'pending'`,
    ).bind(await sha256Hex(code), grantId, utcSeconds(new Date(Date.now() + REQUEST_MS)), request.id),
    c.env.DB.prepare(
      `INSERT INTO oauth_grants (id, client_id, client_name, operator_id, agent_id, harness_name, created_at, revoked_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, NULL WHERE EXISTS (SELECT 1 FROM oauth_requests WHERE id = ? AND grant_id = ?)`,
    ).bind(grantId, request.client_id, client?.clientName ?? null, operator.id, agent?.id ?? null, client?.clientName ?? null, at, request.id, grantId),
  ];
  if (attesting) {
    statements.push(c.env.DB.prepare(
      `UPDATE operators SET authorship_attested_version = ?, authorship_attested_at = ?
        WHERE id = ? AND EXISTS (SELECT 1 FROM oauth_grants WHERE id = ?)`,
    ).bind(AUTHORSHIP_RULE_VERSION, at, operator.id, grantId));
  }
  const results = await c.env.DB.batch(statements);
  if (Number(results[0]?.meta.changes ?? 0) !== 1) {
    return htmlResponse(requestId, oauthErrorPage("This sign-in request was already answered."), 409);
  }
  console.log(JSON.stringify({ message: "connector approved", grant_id: grantId, operator_id: operator.id }));
  return redirectWith(request.redirect_uri, { code, state: request.state, iss: policy.site_origin });
}

async function token(c: Ctx): Promise<Response> {
  const policy = policyOf(c.env);
  if (policy === null) return oauthError("server_error", "Policy missing.", 503);
  const params = await tokenParams(c.req.raw);
  if (params === null) return oauthError("invalid_request", "Send the token request as a form.");
  const grantType = params.get("grant_type");
  if (grantType === "authorization_code") return exchangeCode(c.env, params);
  if (grantType === "refresh_token") return refresh(c.env, params);
  return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
}

async function tokenParams(request: Request): Promise<URLSearchParams | null> {
  const type = request.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/x-www-form-urlencoded")) return new URLSearchParams(await request.text());
    if (type.includes("application/json")) {
      const body = await request.json() as Record<string, unknown>;
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(body)) if (typeof value === "string") params.set(key, value);
      return params;
    }
  } catch {
    return null;
  }
  return null;
}

async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return encoded === challenge;
}

async function exchangeCode(env: Env, params: URLSearchParams): Promise<Response> {
  const code = params.get("code") ?? "";
  const row = await env.DB.prepare(
    "SELECT id, client_id, redirect_uri, code_challenge, status, expires_at, grant_id FROM oauth_requests WHERE code_hash = ?",
  ).bind(await sha256Hex(code)).first<RequestRow>();
  if (row === null || row.grant_id === null) return oauthError("invalid_grant", "The code is not valid.");
  // A code used twice revokes everything issued from it.
  if (row.status === "used") {
    await revokeGrant(env.DB, row.grant_id);
    return oauthError("invalid_grant", "The code was already used.");
  }
  if (row.status !== "approved" || Date.parse(row.expires_at) <= Date.now()) return oauthError("invalid_grant", "The code expired.");
  if (params.get("client_id") !== row.client_id) return oauthError("invalid_grant", "The code was issued to another client.");
  if (params.get("redirect_uri") !== row.redirect_uri) return oauthError("invalid_grant", "The redirect_uri does not match.");
  if (!(await pkceMatches(params.get("code_verifier") ?? "", row.code_challenge))) return oauthError("invalid_grant", "The code_verifier does not match.");
  const used = await env.DB.prepare("UPDATE oauth_requests SET status = 'used' WHERE id = ? AND status = 'approved'").bind(row.id).run();
  if (Number(used.meta.changes ?? 0) !== 1) return oauthError("invalid_grant", "The code was already used.");
  if (!(await grantUsable(env.DB, row.grant_id))) return oauthError("invalid_grant", "This connection was revoked.");
  await env.DB.prepare("UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?").bind(utcSeconds(), row.client_id).run();
  return issueTokens(env.DB, row.grant_id);
}

async function refresh(env: Env, params: URLSearchParams): Promise<Response> {
  const hash = await sha256Hex(params.get("refresh_token") ?? "");
  const row = await env.DB.prepare(
    `SELECT oauth_tokens.grant_id AS grant_id, oauth_tokens.expires_at AS expires_at, oauth_tokens.spent_at AS spent_at, oauth_grants.client_id AS client_id
       FROM oauth_tokens JOIN oauth_grants ON oauth_grants.id = oauth_tokens.grant_id
      WHERE oauth_tokens.token_hash = ? AND oauth_tokens.kind = 'refresh'`,
  ).bind(hash).first<{ grant_id: string; expires_at: string; spent_at: string | null; client_id: string }>();
  if (row === null) return oauthError("invalid_grant", "The refresh token is not valid.");
  if (row.spent_at !== null) {
    // Reuse of a rotated refresh token means it leaked: end the whole connection.
    await revokeGrant(env.DB, row.grant_id);
    return oauthError("invalid_grant", "The refresh token was already used.");
  }
  if (Date.parse(row.expires_at) <= Date.now()) return oauthError("invalid_grant", "The refresh token expired.");
  const clientId = params.get("client_id");
  if (clientId !== null && clientId !== row.client_id) return oauthError("invalid_grant", "The refresh token was issued to another client.");
  const spent = await env.DB.prepare("UPDATE oauth_tokens SET spent_at = ? WHERE token_hash = ? AND spent_at IS NULL").bind(utcSeconds(), hash).run();
  if (Number(spent.meta.changes ?? 0) !== 1) {
    await revokeGrant(env.DB, row.grant_id);
    return oauthError("invalid_grant", "The refresh token was already used.");
  }
  if (!(await grantUsable(env.DB, row.grant_id))) return oauthError("invalid_grant", "This connection was revoked.");
  return issueTokens(env.DB, row.grant_id);
}

async function issueTokens(db: D1Database, grantId: string): Promise<Response> {
  const access = newPrefixedSecret("mt_");
  const refreshToken = newPrefixedSecret("mr_");
  const now = Date.now();
  const at = utcSeconds(new Date(now));
  await db.batch([
    db.prepare("INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at, spent_at, created_at) VALUES (?, ?, 'access', ?, NULL, ?)")
      .bind(await sha256Hex(access), grantId, utcSeconds(new Date(now + ACCESS_SECONDS * 1000)), at),
    db.prepare("INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at, spent_at, created_at) VALUES (?, ?, 'refresh', ?, NULL, ?)")
      .bind(await sha256Hex(refreshToken), grantId, utcSeconds(new Date(now + REFRESH_MS)), at),
  ]);
  return json({ access_token: access, token_type: "Bearer", expires_in: ACCESS_SECONDS, refresh_token: refreshToken, scope: SCOPE });
}

// A grant is usable while it is not revoked and its Operator may still act. Its Agent, when it has
// one, is checked where the token is used.
async function grantUsable(db: D1Database, grantId: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS one FROM oauth_grants JOIN operators ON operators.id = oauth_grants.operator_id
      WHERE oauth_grants.id = ? AND oauth_grants.revoked_at IS NULL AND operators.state IN ('provisional', 'approved')`,
  ).bind(grantId).first();
  return row !== null;
}

export function revokeGrantStatements(db: D1Database, where: string, binds: unknown[]): D1PreparedStatement[] {
  const at = utcSeconds();
  return [
    db.prepare(`UPDATE oauth_grants SET revoked_at = ? WHERE revoked_at IS NULL AND ${where}`).bind(at, ...binds),
  ];
}

export async function revokeGrant(db: D1Database, grantId: string): Promise<void> {
  await db.batch(revokeGrantStatements(db, "id = ?", [grantId]));
}

export type ConnectorGrant = {
  grantId: string;
  operatorId: string;
  agentId: string | null;
  harnessName: string | null;
};

// Resolves a connector access token (mt_) to its live grant, or null.
export async function resolveAccessToken(db: D1Database, token: string): Promise<ConnectorGrant | null> {
  if (!token.startsWith("mt_")) return null;
  const row = await db.prepare(
    `SELECT oauth_grants.id AS grant_id, oauth_grants.operator_id AS operator_id, oauth_grants.agent_id AS agent_id,
            oauth_grants.harness_name AS harness_name
       FROM oauth_tokens
       JOIN oauth_grants ON oauth_grants.id = oauth_tokens.grant_id
       JOIN operators ON operators.id = oauth_grants.operator_id
      WHERE oauth_tokens.token_hash = ? AND oauth_tokens.kind = 'access' AND oauth_tokens.expires_at > ?
        AND oauth_grants.revoked_at IS NULL AND operators.state IN ('provisional', 'approved')`,
  ).bind(await sha256Hex(token), utcSeconds()).first<{ grant_id: string; operator_id: string; agent_id: string | null; harness_name: string | null }>();
  if (row === null) return null;
  return { grantId: row.grant_id, operatorId: row.operator_id, agentId: row.agent_id, harnessName: row.harness_name };
}
