import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HTML_CSP } from "../src/http";
import { oauthSignInPage } from "../src/oauth-pages";
import { TURNSTILE_FAILED } from "../src/signin";
import { TURNSTILE_CSP } from "../src/turnstile";
import target from "./fixtures/policy-signup-open.json";
import { OPERATOR, call, clearSignInQuota, resetAndSeed } from "./harness";
import { SITEVERIFY, TURNSTILE_OK, stubTurnstile, type SiteverifyCall } from "./turnstile-stub";

// v0.2.51 (#61): while sign-up is open, the sign-in forms carry the Turnstile widget and POST
// /signin verifies it before any email is sent, so scripted sign-ups cannot spend the shared
// auth.emails_per_day budget. Closed sign-up keeps the old page and needs no token.

const OPEN = JSON.stringify(target);
const CLOSED = JSON.stringify({ ...target, auth: { ...target.auth, signup_open: false } });
const ORIGIN = target.site_origin;
const FORM = { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN };
const NEWCOMER = "turnstile-newcomer@test.example";

type Sent = { from: string; to: string; subject: string; text: string };

function rig(policy: string, secret?: string | null): { env: Env; sent: Sent[] } {
  const sent: Sent[] = [];
  const mailer = { send: async (message: Sent) => { sent.push(message); return { messageId: "test" }; } };
  const bound = new Proxy(env, {
    get(binding, property) {
      if (property === "POLICY") return policy;
      if (property === "EMAIL") return mailer;
      if (property === "TURNSTILE_SECRET" && secret !== undefined) return secret ?? "";
      const value = Reflect.get(binding, property, binding) as unknown;
      return typeof value === "function" ? value.bind(binding) : value;
    },
  }) as Env;
  return { env: bound, sent };
}

function post(bound: Env, fields: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  const raw = new TextEncoder().encode(new URLSearchParams(fields).toString());
  return call("/signin", { method: "POST", raw, headers: { ...FORM, ...headers }, env: bound });
}

let siteverify: SiteverifyCall[] = [];

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetAndSeed();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM signin_links"),
    env.DB.prepare("DELETE FROM signup_links"),
  ]);
  for (const email of [OPERATOR, NEWCOMER]) await clearSignInQuota(email);
  siteverify = stubTurnstile();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("#61 Turnstile on sign-up", () => {
  it("renders the widget and its CSP exception on /signin only while sign-up is open", async () => {
    const open = await call("/signin", { env: rig(OPEN).env });
    const html = await open.text();
    expect(open.status).toBe(200);
    expect(html).toContain(`<div class="cf-turnstile" data-sitekey="${target.turnstile_site_key}"></div>`);
    expect(html).toContain('<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>');
    const csp = open.headers.get("content-security-policy") ?? "";
    expect(csp).toBe(TURNSTILE_CSP);
    expect(csp).toContain("script-src https://challenges.cloudflare.com");
    expect(csp).toContain("frame-src https://challenges.cloudflare.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe");

    const closed = await call("/signin", { env: rig(CLOSED).env });
    const closedHtml = await closed.text();
    expect(closedHtml).not.toContain("cf-turnstile");
    expect(closedHtml).not.toContain("<script");
    expect(closed.headers.get("content-security-policy")).toBe(HTML_CSP);
  });

  it("sends a sign-up link only after a passing token", async () => {
    const open = rig(OPEN);
    const missing = await post(open.env, { email: NEWCOMER });
    expect(missing.status).toBe(422);
    expect(await missing.text()).toContain(TURNSTILE_FAILED);
    expect(siteverify).toHaveLength(0);

    const bad = await post(open.env, { email: NEWCOMER, "cf-turnstile-response": "nope" });
    expect(bad.status).toBe(422);
    const badHtml = await bad.text();
    expect(badHtml).toContain(TURNSTILE_FAILED);
    expect(badHtml).toContain("cf-turnstile");
    expect(bad.headers.get("content-security-policy")).toBe(TURNSTILE_CSP);
    expect(siteverify).toHaveLength(1);

    const long = await post(open.env, { email: NEWCOMER, "cf-turnstile-response": "x".repeat(2049) });
    expect(long.status).toBe(422);
    expect(siteverify).toHaveLength(1);
    expect(open.sent).toHaveLength(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM signup_links").first<{ n: number }>()).toEqual({ n: 0 });

    const passed = await post(open.env, { email: NEWCOMER, "cf-turnstile-response": TURNSTILE_OK }, { "cf-connecting-ip": "203.0.113.7" });
    expect(passed.status).toBe(200);
    expect(await passed.text()).toContain("If that address can sign in, a link is on its way.");
    expect(siteverify.at(-1)).toEqual({ secret: "turnstile-secret-test", response: TURNSTILE_OK, remoteip: "203.0.113.7" });
    expect(open.sent).toHaveLength(1);
    expect(open.sent[0]!.to).toBe(NEWCOMER);
    expect(open.sent[0]!.subject).toBe("Your j-chain.net sign-up link");
  });

  it("asks an existing Operator for the token too, so the check says nothing about who has an account", async () => {
    const open = rig(OPEN);
    const missing = await post(open.env, { email: OPERATOR });
    expect(missing.status).toBe(422);
    expect(await missing.text()).toContain(TURNSTILE_FAILED);
    expect(open.sent).toHaveLength(0);
    const passed = await post(open.env, { email: OPERATOR, "cf-turnstile-response": TURNSTILE_OK });
    expect(passed.status).toBe(200);
    expect(open.sent).toHaveLength(1);
    expect(open.sent[0]!.to).toBe(OPERATOR);
  });

  it("keeps a connect code on the form after a failed check", async () => {
    const open = rig(OPEN);
    const failed = await post(open.env, { email: NEWCOMER, connect: "BCDFGHJK" });
    expect(failed.status).toBe(422);
    const html = await failed.text();
    expect(html).toContain('name="connect" value="BCDFGHJK"');
    expect(html).toContain("cf-turnstile");
    expect(open.sent).toHaveLength(0);
  });

  it("fails closed without the Turnstile secret while sign-up is open", async () => {
    vi.restoreAllMocks();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("siteverify was called");
    });
    const open = rig(OPEN, null);
    const blocked = await post(open.env, { email: NEWCOMER, "cf-turnstile-response": TURNSTILE_OK });
    expect(blocked.status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalledWith(SITEVERIFY, expect.anything());
    expect(open.sent).toHaveLength(0);
  });

  it("needs no token while sign-up is closed", async () => {
    const closed = rig(CLOSED);
    const sent = await post(closed.env, { email: OPERATOR });
    expect(sent.status).toBe(200);
    expect(siteverify).toHaveLength(0);
    expect(closed.sent).toHaveLength(1);
  });

  it("puts the widget on the agent connect and chat app sign-in forms while sign-up is open", async () => {
    const open = await call("/operator/connect?code=BCDF-GHJK", { env: rig(OPEN).env });
    expect(open.status).toBe(401);
    expect(await open.text()).toContain(`data-sitekey="${target.turnstile_site_key}"`);
    expect(open.headers.get("content-security-policy")).toBe(TURNSTILE_CSP);
    const closed = await call("/operator/connect?code=BCDF-GHJK", { env: rig(CLOSED).env });
    expect(await closed.text()).not.toContain("cf-turnstile");
    expect(closed.headers.get("content-security-policy")).toBe(HTML_CSP);

    const page = oauthSignInPage({
      requestId: "01900000-0000-7000-8000-0000000000aa",
      appName: null,
      emailOn: true,
      turnstileSiteKey: "site-key",
    });
    expect(page).toContain('<div class="cf-turnstile" data-sitekey="site-key"></div>');
    expect(oauthSignInPage({ requestId: "01900000-0000-7000-8000-0000000000aa", appName: null, emailOn: true })).not.toContain("cf-turnstile");
  });
});
