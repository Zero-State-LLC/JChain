import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OPERATOR, STAFF, call, resetAndSeed } from "./harness";
import { afterSignIn } from "../src/signin";
import { connectApp, pkcePair, REDIRECT, ORIGIN } from "./connector-helpers";

// v0.2.50 M2 (AT-108): the Worker is the OAuth server for its own /mcp endpoint.

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);

const FORM = { "content-type": "application/x-www-form-urlencoded" };

async function token(fields: Record<string, string>): Promise<Response> {
  return call("/oauth/token", { headers: FORM, raw: new TextEncoder().encode(new URLSearchParams(fields).toString()), sameOrigin: false });
}

describe("OAuth discovery and registration", () => {
  it("serves protected resource and authorization server metadata", async () => {
    const resource = await (await call("/.well-known/oauth-protected-resource")).json() as Record<string, unknown>;
    expect(resource).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
    const server = await (await call("/.well-known/oauth-authorization-server")).json() as Record<string, unknown>;
    expect(server).toMatchObject({
      issuer: ORIGIN,
      token_endpoint: `${ORIGIN}/oauth/token`,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
    });
  });

  it("registers public clients with safe redirect URIs only", async () => {
    const ok = await call("/oauth/register", { body: { client_name: "Chat", redirect_uris: [REDIRECT] }, sameOrigin: false });
    expect(ok.status).toBe(201);
    expect((await ok.json() as { client_id: string }).client_id).toMatch(/^mc_/);
    for (const bad of [["http://evil.example/cb"], ["https://app.example/cb#frag"], [], ["javascript:alert(1)"]]) {
      const response = await call("/oauth/register", { body: { redirect_uris: bad }, sameOrigin: false });
      expect(response.status).toBe(400);
    }
  });
});

describe("authorization code flow", () => {
  it("connects an app for a signed-in Operator and issues rotating tokens", async () => {
    const { tokens, clientId } = await connectApp(OPERATOR);
    expect(tokens.access_token).toMatch(/^mt_/);
    expect(tokens.refresh_token).toMatch(/^mr_/);
    expect(tokens.token_type).toBe("Bearer");
    const rotated = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
    expect(rotated.status).toBe(200);
    const fresh = await rotated.json() as { access_token: string; refresh_token: string };
    expect(fresh.refresh_token).not.toBe(tokens.refresh_token);
    // Reusing the spent refresh token revokes the whole grant.
    expect((await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId })).status).toBe(400);
    expect((await token({ grant_type: "refresh_token", refresh_token: fresh.refresh_token, client_id: clientId })).status).toBe(400);
  });

  it("refuses a wrong verifier, a wrong redirect URI, and a reused code", async () => {
    const pair = await pkcePair();
    const flow = await connectApp(OPERATOR, { exchange: false, pkce: pair });
    const base = { grant_type: "authorization_code", code: flow.code, client_id: flow.clientId, redirect_uri: REDIRECT };
    expect((await token({ ...base, code_verifier: (await pkcePair()).verifier })).status).toBe(400);
    expect((await token({ ...base, redirect_uri: "https://app.example/other", code_verifier: pair.verifier })).status).toBe(400);
    expect((await token({ ...base, code_verifier: pair.verifier })).status).toBe(200);
    expect((await token({ ...base, code_verifier: pair.verifier })).status).toBe(400);
  });

  it("never redirects to an unregistered URI, and needs S256", async () => {
    const reg = await (await call("/oauth/register", { body: { redirect_uris: [REDIRECT] }, sameOrigin: false })).json() as { client_id: string };
    const bad = await call(`/oauth/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&code_challenge=x`);
    expect(bad.status).toBe(400);
    expect(bad.headers.get("location")).toBeNull();
    const plain = await call(`/oauth/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${"a".repeat(43)}&code_challenge_method=plain&state=s1`);
    expect(plain.status).toBe(302);
    expect(plain.headers.get("location")).toContain("error=invalid_request");
  });

  it("shows sign-in when signed out, and lets a Moderator-only account approve nothing", async () => {
    const pending = await connectApp(OPERATOR, { stopAt: "pending" });
    const signedOut = await call(pending.approvalPath);
    expect(signedOut.status).toBe(401);
    expect(await signedOut.text()).toContain("Connect your chat app");
    // The email sign-in link comes back to the same request, rebuilt from its validated id.
    const id = pending.approvalPath.split("/").pop()!;
    expect(afterSignIn(undefined, id)).toBe(`/oauth/authorize/${id}`);
    expect(afterSignIn(undefined, "https://evil.example")).toBe("/operator");
    expect((await call(pending.approvalPath, { email: STAFF })).status).toBe(403);
  });

  it("denies, and a suspended Operator cannot approve", async () => {
    const denied = await connectApp(OPERATOR, { decision: "deny" });
    expect(denied.location).toContain("error=access_denied");
    await env.DB.prepare("UPDATE operators SET state = 'suspended' WHERE email = ?").bind(OPERATOR).run();
    const pending = await connectApp(OPERATOR, { stopAt: "pending" });
    expect((await call(pending.approvalPath, { email: OPERATOR })).status).toBe(403);
  });

  it("lets the approval form redirect to the app's origin only", async () => {
    const pending = await connectApp(OPERATOR, { stopAt: "pending" });
    const page = await call(pending.approvalPath, { email: OPERATOR });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self' https://app.example");
  });
});

describe("connector tokens act as the Operator's Agent", () => {
  it("reaches Agent routes once the Operator has an Agent, and stops when the grant ends", async () => {
    const enrolled = await call("/v1/agents", { email: OPERATOR, body: { display_name: "Ada", declared_model: "m" } });
    expect(enrolled.status).toBe(201);
    const { tokens } = await connectApp(OPERATOR);
    const me = await call("/v1/agents/me", { bearer: tokens.access_token });
    expect(me.status).toBe(200);
    expect(JSON.stringify(await me.json())).not.toContain("jc_");
    await env.DB.prepare("UPDATE operators SET state = 'suspended' WHERE email = ?").bind(OPERATOR).run();
    expect((await call("/v1/agents/me", { bearer: tokens.access_token })).status).toBe(401);
  });
});
