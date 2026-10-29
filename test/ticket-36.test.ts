import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { runRetention } from "../src/retention";
import { call, clearSignInQuota, MODERATOR, OPERATOR, resetAndSeed, STAFF } from "./harness";

// Ticket 36 (spec v0.2.23): site map, Get started, sign-in, and the Operator page.

const ORIGIN = "https://jchain.example.test";
const SAME = { origin: ORIGIN };
const FORM = { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN };

const AUTH = {
  signup_open: false,
  link_minutes: 15,
  session_days: 30,
  idle_days: 7,
  sessions_per_operator: 10,
  links_per_email_hour: 3,
  emails_per_day: 300,
  signups_per_day: 50,
  mail_from: "signin@jchain.example.test",
};

type Sent = { from: string; to: string; subject: string; text: string };

function policyWith(extra: Record<string, unknown>): string {
  return JSON.stringify({ ...JSON.parse(env.POLICY as string), ...extra });
}

// The Worker env with an `auth` block and a stubbed send-email binding.
function signInEnv(sent: Sent[], auth: Record<string, unknown> | null = AUTH, mailer = true): Env {
  const policy = auth === null ? (env.POLICY as string) : policyWith({ auth });
  const binding = { send: async (message: Sent) => { sent.push(message); return { messageId: "test" }; } };
  return new Proxy(env, {
    get(target, property) {
      if (property === "POLICY") return policy;
      if (property === "EMAIL") return mailer ? binding : undefined;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Env;
}

function form(fields: Record<string, string>): Uint8Array {
  return new TextEncoder().encode(new URLSearchParams(fields).toString());
}

async function html(response: Response): Promise<string> {
  return response.text();
}

function linkFrom(message: Sent): string {
  const found = message.text.match(/https:\/\/[^\s]+\/signin\/(sl_[A-Za-z0-9_-]{43})/);
  expect(found).not.toBeNull();
  return found![1]!;
}

function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const found = header.match(/__Host-jc_session=(ss_[A-Za-z0-9_-]{43})/);
  expect(found).not.toBeNull();
  return `__Host-jc_session=${found![1]!}`;
}

async function signIn(bindings: Env, sent: Sent[], email = OPERATOR): Promise<string> {
  await call("/signin", { method: "POST", raw: form({ email }), headers: FORM, env: bindings });
  const token = linkFrom(sent.at(-1)!);
  const done = await call(`/signin/${token}`, { method: "POST", headers: SAME, env: bindings });
  expect(done.status).toBe(303);
  return cookieFrom(done);
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetAndSeed();
  await env.DB.batch([env.DB.prepare("DELETE FROM sessions"), env.DB.prepare("DELETE FROM signin_links")]);
  await clearSignInQuota(OPERATOR);
});

describe("AT-51 one frame on every human page", () => {
  it("renders the header, footer, and the right current link", async () => {
    const pages: Array<[string, string | null, number]> = [
      ["/", null, 200],
      ["/boards", "/boards", 200],
      ["/boards/beta", "/boards", 200],
      ["/trending", "/trending", 200],
      ["/leaderboard", "/leaderboard", 200],
      ["/start", "/start", 200],
      ["/signin", "/signin", 200],
      ["/operator", "/signin", 401],
      ["/threads/01900000-0000-7000-8000-00000000ffff", null, 404],
    ];
    for (const [path, current, status] of pages) {
      const response = await call(path);
      expect(response.status, path).toBe(status);
      const text = await html(response);
      expect(text, path).toContain('<a href="#content">Skip to content</a>');
      const nav = text.match(/<nav class="site-nav" aria-label="Site">(.*?)<\/nav>/)?.[1] ?? "";
      expect([...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1]), path).toEqual(["/boards", "/trending", "/leaderboard", "/start", "/signin"]);
      const marked = [...nav.matchAll(/href="([^"]+)" aria-current="page"/g)].map((m) => m[1]);
      expect(marked, path).toEqual(current === null ? [] : [current]);
      expect(text, path).toContain('<nav aria-labelledby="footer-pages"><h2 id="footer-pages">Pages</h2>');
      expect(text, path).toContain('<nav aria-labelledby="footer-agents"><h2 id="footer-agents">For agents</h2>');
      expect(text, path).toContain('href="/llms.txt"');
      expect(text, path).toContain('<link rel="help" href="/start">');
      expect(text, path).not.toContain("<script");
      expect(text, path).not.toContain("<style");
      expect(text, path).not.toContain(" style=");
      expect(text.match(/<h1\b/g), path).toHaveLength(1);
    }
  });

  it("leads the homepage to the guide and every board", async () => {
    const text = await html(await call("/"));
    expect(text).toContain('<a class="button" href="/start">Get started</a>');
    expect(text).toContain('<a class="button secondary" href="/boards">Browse boards</a>');
    expect(text).toContain('<link rel="alternate" type="text/markdown" href="/llms.txt" title="Agent guide">');
    expect(text.indexOf('<figure class="hero">')).toBeLessThan(text.indexOf('<h2 id="boards-title">Boards</h2>'));
    expect(text.indexOf('<h2 id="boards-title">Boards</h2>')).toBeLessThan(text.indexOf('<h2 id="how-title">How it works</h2>'));
    expect(text).toContain('<a href="/boards">All boards, with activity</a>');
    expect(text).toContain("0 threads, no posts yet");
    await env.DB.prepare("UPDATE boards SET description = ? WHERE slug = 'beta'").bind("<b>Frogs</b> only").run();
    const described = await html(await call("/"));
    expect(described).toContain('<span class="about">&lt;b&gt;Frogs&lt;/b&gt; only</span>');
  });
});

describe("AT-52 Get started, the agent guide, and robots", () => {
  it("serves the guide with no policy", async () => {
    const start = await call("/start", { policy: null });
    expect(start.status).toBe(200);
    expect(start.headers.get("cache-control")).toBe("public, max-age=300");
    const page = await html(start);
    for (const id of ["observers", "operators", "agents", "staff"]) expect(page).toContain(`<section id="${id}"`);
    expect(page).toContain("<code>GET /v1/boards/{id}/rules</code>");

    const guide = await call("/llms.txt", { policy: null });
    expect(guide.status).toBe(200);
    expect(guide.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const text = await guide.text();
    expect(text.startsWith("# j-chain.net\n\n> ")).toBe(true);
    expect(text).toContain(`${ORIGIN}/start`);
    expect(text).toContain("/v1/boards/{id}/rules");
    expect(text).toContain("/v1/openapi.json");
    expect(text).not.toMatch(/jc_[A-Za-z0-9_-]{20,}/);
    expect(text).not.toContain("@example");
    expect(text).not.toMatch(/per (UTC )?(hour|day|minute)/);

    const robots = await call("/robots.txt", { policy: null });
    expect(robots.status).toBe(200);
    const rules = await robots.text();
    for (const path of ["/moderation", "/reports", "/operator", "/signin/"]) expect(rules).toContain(`Disallow: ${path}\n`);
  });
});

describe("AT-53 sign-in is off without the auth block or the binding", () => {
  it("shows the Access door and refuses the email routes", async () => {
    const page = await html(await call("/signin"));
    expect(page).toContain('<a class="button" href="/signin/access">Sign in with Cloudflare Access</a>');
    const door = await call("/signin/access");
    expect(door.status).toBe(303);
    expect(door.headers.get("location")).toBe("/operator");
    const disabled = await call(`/signin/sl_${"A".repeat(43)}`);
    expect(disabled.status).toBe(503);
    expect(disabled.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page).not.toContain('name="email"');
    const posted = await call("/signin", { method: "POST", raw: form({ email: OPERATOR }), headers: FORM });
    expect(posted.status).toBe(503);
    const sent: Sent[] = [];
    const noBinding = signInEnv(sent, AUTH, false);
    expect(await html(await call("/signin", { env: noBinding }))).not.toContain('name="email"');
    expect((await call("/signin", { method: "POST", raw: form({ email: OPERATOR }), headers: FORM, env: noBinding })).status).toBe(503);
    expect(sent).toHaveLength(0);
  });

  it("fails the policy closed for a bad auth block", async () => {
    for (const auth of [
      { ...AUTH, signup_open: true },
      { ...AUTH, extra: 1 },
      { ...AUTH, link_minutes: 61 },
      { ...AUTH, mail_from: "nobody" },
    ]) {
      const response = await call("/v1/boards", { email: OPERATOR, policy: policyWith({ auth }) });
      expect(response.status).toBe(503);
      expect((await response.json() as { error: { code: string } }).error.code).toBe("policy_missing");
    }
    expect((await call("/v1/boards", { email: OPERATOR, policy: policyWith({ auth: AUTH }) })).status).toBe(200);
  });
});

describe("AT-54 email links and Sessions", () => {
  it("answers the same for known, unknown, and limited addresses and sends once", async () => {
    const sent: Sent[] = [];
    const bindings = signInEnv(sent);
    const page = await html(await call("/signin", { env: bindings }));
    expect(page).toContain('name="email"');
    const known = await call("/signin", { method: "POST", raw: form({ email: "  Operator@Example.test " }), headers: FORM, env: bindings });
    const unknown = await call("/signin", { method: "POST", raw: form({ email: "stranger@example.test" }), headers: FORM, env: bindings });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    const knownText = await known.text();
    expect(knownText).toContain("If that address can sign in, a link is on its way.");
    expect(await unknown.text()).toBe(knownText.replace(/x-request-id/g, "x-request-id"));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(OPERATOR);
    expect(sent[0]!.from).toBe(AUTH.mail_from);
    linkFrom(sent[0]!);
    for (let i = 0; i < 3; i += 1) {
      const again = await call("/signin", { method: "POST", raw: form({ email: OPERATOR }), headers: FORM, env: bindings });
      expect(again.status).toBe(200);
    }
    expect(sent).toHaveLength(3);
    const malformed = await call("/signin", { method: "POST", raw: form({ email: "nope" }), headers: FORM, env: bindings });
    expect(malformed.status).toBe(422);
    const crossSite = await call("/signin", {
      method: "POST",
      raw: form({ email: OPERATOR }),
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      env: bindings,
    });
    expect(crossSite.status).toBe(403);
    expect(sent).toHaveLength(3);
  });

  it("signs in once by POST, stores only hashes, and signs out", async () => {
    const sent: Sent[] = [];
    const bindings = signInEnv(sent);
    await call("/signin", { method: "POST", raw: form({ email: OPERATOR }), headers: FORM, env: bindings });
    const token = linkFrom(sent[0]!);
    const confirm = await call(`/signin/${token}`, { env: bindings });
    expect(confirm.status).toBe(200);
    expect(confirm.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await confirm.text()).toContain(`<form method="post" action="/signin/${token}">`);
    const unconsumed = await env.DB.prepare("SELECT consumed_by FROM signin_links").first<{ consumed_by: string | null }>();
    expect(unconsumed?.consumed_by).toBeNull();

    const crossSite = await call(`/signin/${token}`, { method: "POST", headers: { origin: "https://evil.example" }, env: bindings });
    expect(crossSite.status).toBe(403);
    const done = await call(`/signin/${token}`, { method: "POST", headers: SAME, env: bindings });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/operator");
    const setCookie = done.headers.get("set-cookie") ?? "";
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) expect(setCookie).toContain(attribute);
    expect(setCookie).not.toContain("Domain");
    const cookie = cookieFrom(done);
    const replay = await call(`/signin/${token}`, { method: "POST", headers: SAME, env: bindings });
    expect(replay.status).toBe(400);

    const secret = cookie.split("=")[1]!;
    const dump = JSON.stringify([
      (await env.DB.prepare("SELECT * FROM sessions").all()).results,
      (await env.DB.prepare("SELECT * FROM signin_links").all()).results,
    ]);
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain(token);

    const page = await call("/operator", { headers: { cookie }, env: bindings });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`Signed in as <strong>${OPERATOR}</strong>`);

    // A Session is not a Credential and not a Moderator.
    expect((await call("/v1/agents/me", { headers: { cookie }, env: bindings })).status).toBe(401);
    const moderation = await call("/v1/admin/publishing-stop", { method: "POST", body: { engaged: true }, headers: { cookie, ...SAME }, env: bindings });
    expect(moderation.status).toBe(401);

    const out = await call("/signout", { method: "POST", headers: { cookie, ...SAME }, env: bindings });
    expect(out.status).toBe(303);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await call("/operator", { headers: { cookie }, env: bindings })).status).toBe(401);
  });

  it("signs out everywhere and honors the idle and absolute limits", async () => {
    const sent: Sent[] = [];
    const bindings = signInEnv(sent);
    const first = await signIn(bindings, sent);
    const second = await signIn(bindings, sent);
    const everywhere = await call("/signout/all", { method: "POST", headers: { cookie: first, ...SAME }, env: bindings });
    expect(everywhere.status).toBe(200);
    expect((await call("/operator", { headers: { cookie: second }, env: bindings })).status).toBe(401);

    await clearSignInQuota(OPERATOR);
    const idle = await signIn(bindings, sent);
    await env.DB.prepare("UPDATE sessions SET last_used_at = '2000-01-01T00:00:00Z' WHERE revoked_at IS NULL").run();
    expect((await call("/operator", { headers: { cookie: idle }, env: bindings })).status).toBe(401);
    const old = await signIn(bindings, sent);
    await env.DB.prepare("UPDATE sessions SET created_at = '2000-01-01T00:00:00Z' WHERE revoked_at IS NULL").run();
    expect((await call("/operator", { headers: { cookie: old }, env: bindings })).status).toBe(401);

    // Turning email sign-in off ends every Session without a write.
    await clearSignInQuota(OPERATOR);
    const live = await signIn(bindings, sent);
    expect((await call("/operator", { headers: { cookie: live }, env: bindings })).status).toBe(200);
    expect((await call("/operator", { headers: { cookie: live } })).status).toBe(401);
  });
});

describe("AT-55 the Operator page", () => {
  it("enrolls, rotates, suspends, resumes, and retires through Access", async () => {
    const enrolled = await call("/operator/agents", {
      email: OPERATOR,
      raw: form({ display_name: "Ada", declared_model: "my-model-1" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(enrolled.status).toBe(201);
    expect(enrolled.headers.get("cache-control")).toBe("no-store");
    const shown = await enrolled.text();
    const credential = shown.match(/<output id="credential" class="secret">(jc_[A-Za-z0-9_-]{43})<\/output>/)?.[1];
    expect(credential).toBeDefined();
    const me = await call("/v1/agents/me", { bearer: credential! });
    expect(me.status).toBe(200);
    const agentId = (await me.json() as { agent_id: string }).agent_id;

    const listed = await html(await call("/operator", { email: OPERATOR }));
    expect(listed).toContain(`<a href="/agents/${agentId}">Ada</a>`);
    expect(listed).toContain('<a href="/operator" aria-current="page">Your agents</a>');

    const rotated = await call(`/operator/agents/${agentId}/credentials`, { email: OPERATOR, method: "POST" });
    expect(rotated.status).toBe(201);
    const fresh = (await rotated.text()).match(/class="secret">(jc_[A-Za-z0-9_-]{43})</)?.[1];
    expect(fresh).toBeDefined();
    expect((await call("/v1/agents/me", { bearer: credential! })).status).toBe(401);
    expect((await call("/v1/agents/me", { bearer: fresh! })).status).toBe(200);

    expect((await call(`/operator/agents/${agentId}/suspend`, { email: OPERATOR, method: "POST" })).status).toBe(200);
    expect((await call("/v1/agents/me", { bearer: fresh! })).status).toBe(401);
    expect((await call(`/operator/agents/${agentId}/resume`, { email: OPERATOR, method: "POST" })).status).toBe(200);
    const unconfirmed = await call(`/operator/agents/${agentId}/retire`, {
      email: OPERATOR,
      raw: form({}),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(unconfirmed.status).toBe(422);
    expect((await call("/v1/agents/me", { bearer: fresh! })).status).toBe(200);
    const retired = await call(`/operator/agents/${agentId}/retire`, {
      email: OPERATOR,
      raw: form({ confirm: "yes" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(retired.status).toBe(200);
    expect((await call("/v1/agents/me", { bearer: fresh! })).status).toBe(401);
    const audit = await env.DB.prepare(
      "SELECT action FROM moderation_actions WHERE target_id = ? ORDER BY created_at, id",
    ).bind(agentId).all<{ action: string }>();
    expect((audit.results ?? []).map((row) => row.action)).toEqual(["suspend_agent", "resume_agent", "retire_agent"]);
  });

  it("enrolls through a Session and hides other Operators' agents", async () => {
    const sent: Sent[] = [];
    const bindings = signInEnv(sent);
    const cookie = await signIn(bindings, sent);
    const enrolled = await call("/operator/agents", {
      raw: form({ display_name: "Bo", declared_model: "m" }),
      headers: { ...FORM, cookie },
      env: bindings,
    });
    expect(enrolled.status).toBe(201);
    const cross = await call("/operator/agents", {
      raw: form({ display_name: "Bo", declared_model: "m" }),
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example", cookie },
      env: bindings,
    });
    expect(cross.status).toBe(403);

    const other = await call("/v1/agents", { email: "admin2@example.test", body: { display_name: "Theirs", declared_model: "m" } });
    const theirs = (await other.json() as { agent_id: string }).agent_id;
    const mine = await html(await call("/operator", { headers: { cookie }, env: bindings }));
    expect(mine).toContain(">Bo</a>");
    expect(mine).not.toContain("Theirs");
    const poke = await call(`/operator/agents/${theirs}/suspend`, { method: "POST", headers: { cookie, ...SAME }, env: bindings });
    expect(poke.status).toBe(404);
    // The JSON enrollment route accepts the Session too.
    const json = await call("/v1/agents", { body: { display_name: "Cy", declared_model: "m" }, headers: { cookie, ...SAME }, env: bindings });
    expect(json.status).toBe(201);
  });

  it("answers in HTML without an Operator", async () => {
    const anonymous = await call("/operator");
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("content-type")).toContain("text/html");
    expect(await anonymous.text()).toContain('<a class="button" href="/signin">Sign in</a>');
    const staff = await call("/operator", { email: STAFF });
    expect(staff.status).toBe(403);
    expect(await staff.text()).toContain("This page is for Operators.");
    expect((await call("/operator", { email: MODERATOR })).status).toBe(403);
  });
});

describe("AT-57 not found, for people", () => {
  it("answers a browser in HTML and everyone else in JSON", async () => {
    const browser = await call("/no-such-page", { headers: { accept: "text/html,application/xhtml+xml" } });
    expect(browser.status).toBe(404);
    expect(browser.headers.get("content-type")).toContain("text/html");
    const text = await browser.text();
    expect(text).toContain("<h1>Not found</h1>");
    expect(text).toContain('<nav class="site-nav" aria-label="Site">');
    expect(text).toContain('<a href="/start">Get started</a>');
    const script = await call("/no-such-page");
    expect(script.status).toBe(404);
    expect(script.headers.get("content-type")).toContain("application/json");
    const api = await call("/v1/no-such-route", { headers: { accept: "text/html" } });
    expect(api.status).toBe(404);
    expect(api.headers.get("content-type")).toContain("application/json");
  });
});

describe("review fixes (v0.2.25)", () => {
  it("does not let unknown addresses spend the daily email cap", async () => {
    const sent: Sent[] = [];
    const bindings = signInEnv(sent, { ...AUTH, emails_per_day: 2 });
    for (let i = 0; i < 5; i += 1) {
      const stranger = await call("/signin", { method: "POST", raw: form({ email: `stranger${i}@example.test` }), headers: FORM, env: bindings });
      expect(stranger.status).toBe(200);
    }
    const known = await call("/signin", { method: "POST", raw: form({ email: OPERATOR }), headers: FORM, env: bindings });
    expect(known.status).toBe(200);
    expect(sent).toHaveLength(1);
    await call("/signin", { method: "POST", raw: form({ email: OPERATOR }), headers: FORM, env: bindings });
    const capped = await call("/signin", { method: "POST", raw: form({ email: OPERATOR }), headers: FORM, env: bindings });
    expect(capped.status).toBe(200);
    expect(await capped.text()).toContain("If that address can sign in, a link is on its way.");
    expect(sent).toHaveLength(2);
    for (let i = 0; i < 5; i += 1) await clearSignInQuota(`stranger${i}@example.test`);
  });

  it("deletes Session rows once email sign-in is off", async () => {
    const sent: Sent[] = [];
    const bindings = signInEnv(sent);
    await signIn(bindings, sent);
    expect(Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())?.n)).toBe(1);
    await runRetention(bindings, Date.now());
    expect(Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())?.n)).toBe(1);
    await runRetention(env, Date.now());
    expect(Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())?.n)).toBe(0);
  });

  it("returns the confirmation page before the email send finishes", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent: Sent[] = [];
    const bindings = signInEnv(sent);
    const mailer = bindings.EMAIL as { send: (message: Sent) => Promise<{ messageId: string }> };
    mailer.send = async (message) => {
      await gate;
      sent.push(message);
      return { messageId: "test" };
    };
    const ctx = createExecutionContext();
    const pending = worker.fetch(new Request(`${ORIGIN}/signin`, {
      method: "POST",
      headers: FORM,
      body: form({ email: OPERATOR }),
    }), bindings, ctx);
    try {
      const response = await Promise.race([
        pending,
        new Promise<Response>((_, reject) => {
          setTimeout(() => reject(new Error("signin waited on the email send")), 2_000);
        }),
      ]);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("If that address can sign in, a link is on its way.");
      expect(sent).toHaveLength(0);
    } finally {
      release();
      await waitOnExecutionContext(ctx);
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(OPERATOR);
  });
});
