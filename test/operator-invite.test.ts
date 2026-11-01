import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/credential";
import { ADMIN, OPERATOR, STAFF, call, clearSignInQuota, resetAndSeed } from "./harness";

// v0.2.49 (proposed): Admins invite Operators, and mail goes through Resend when its key is set.

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
const INVITEE = "invitee@example.test";
const FORM = { "content-type": "application/x-www-form-urlencoded", origin: "https://jchain.example.test" };

type Sent = { from: string; to: string; subject: string; text: string };

// The Worker env with an `auth` block, an optional stubbed EMAIL binding, and an optional Resend key.
function mailEnv(sent: Sent[], options: { binding?: boolean; resendKey?: string; auth?: boolean } = {}): Env {
  const base = JSON.parse(env.POLICY as string) as Record<string, unknown>;
  const policy = JSON.stringify(options.auth === false ? base : { ...base, auth: AUTH });
  const binding = { send: async (message: Sent) => { sent.push(message); return { messageId: "test" }; } };
  return new Proxy(env, {
    get(target, property) {
      if (property === "POLICY") return policy;
      if (property === "EMAIL") return options.binding === false ? undefined : binding;
      if (property === "RESEND_API_KEY") return options.resendKey;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Env;
}

function invite(bindings: Env, email: string, body: Record<string, unknown> = {}, as = ADMIN): Promise<Response> {
  return call("/v1/moderation/actions", {
    email: as,
    env: bindings,
    body: { target_type: "operator", action: "invite_operator", reason_code: "other", email, ...body },
  });
}

async function json(response: Response, status: number): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body;
}

function resendStub(status = 200) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== "https://api.resend.com/emails") throw new Error(`unexpected fetch ${url} ${init?.method ?? ""}`);
    return new Response(JSON.stringify(status === 200 ? { id: "re_test" } : { message: "nope" }), { status });
  });
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Admin invites an Operator", () => {
  it("adds an approved Operator, audits it, and emails the invite", async () => {
    const sent: Sent[] = [];
    const body = await json(await invite(mailEnv(sent), " Invitee@Example.test "), 200);
    expect(body).toMatchObject({ state: "approved", invite_sent: true });
    const row = await env.DB.prepare("SELECT id, state FROM operators WHERE email = ?").bind(INVITEE)
      .first<{ id: string; state: string }>();
    expect(row?.state).toBe("approved");
    expect(body.operator_id).toBe(row?.id);
    const audit = await env.DB.prepare("SELECT action, actor_email FROM moderation_actions WHERE target_id = ?")
      .bind(row?.id).all<{ action: string; actor_email: string }>();
    expect(audit.results).toEqual([{ action: "invite_operator", actor_email: ADMIN }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: AUTH.mail_from, to: INVITEE });
    expect(sent[0]!.subject).toContain("invite");
    expect(sent[0]!.text).toContain("https://jchain.example.test/signin");
  });

  it("is Admin only", async () => {
    const sent: Sent[] = [];
    await json(await invite(mailEnv(sent), INVITEE, {}, STAFF), 403);
    expect(sent).toHaveLength(0);
    expect(await env.DB.prepare("SELECT 1 FROM operators WHERE email = ?").bind(INVITEE).first()).toBeNull();
  });

  it("refuses an address that is or was an Operator", async () => {
    const sent: Sent[] = [];
    await json(await invite(mailEnv(sent), OPERATOR), 409);
    // resetAndSeed keeps removed hashes, so this uses an address no other test invites.
    const removed = "removed-invitee@example.test";
    await env.DB.prepare("INSERT OR IGNORE INTO removed_operator_emails (email_hash, removed_at) VALUES (?, ?)")
      .bind(await sha256Hex(removed), "2026-11-01T00:00:00Z").run();
    await json(await invite(mailEnv(sent), removed), 409);
    expect(sent).toHaveLength(0);
  });

  it("validates the email", async () => {
    const sent: Sent[] = [];
    await json(await invite(mailEnv(sent), "not-an-email"), 422);
    await json(await call("/v1/moderation/actions", {
      email: ADMIN,
      env: mailEnv(sent),
      body: { target_type: "operator", action: "invite_operator", reason_code: "other" },
    }), 400);
    expect(sent).toHaveLength(0);
  });

  it("still adds the Operator when no mail is configured", async () => {
    const sent: Sent[] = [];
    const body = await json(await invite(mailEnv(sent, { binding: false }), INVITEE), 200);
    expect(body).toMatchObject({ state: "approved", invite_sent: false });
    expect(sent).toHaveLength(0);
  });

  it("shows the invite form on /admin", async () => {
    const html = await (await call("/admin", { email: ADMIN })).text();
    const section = html.slice(html.indexOf('id="admin-operators"'));
    expect(section).toContain('value="invite_operator"');
    expect(section).toContain('name="email"');
  });

  it("publishes the invite request in the OpenAPI document", async () => {
    const spec = await (await call("/v1/openapi.json", { email: OPERATOR })).json() as {
      paths: Record<string, { post: { requestBody: { content: { "application/json": { schema: { oneOf: Array<Record<string, unknown>> } } } } } }>;
    };
    const variants = spec.paths["/v1/moderation/actions"]!.post.requestBody.content["application/json"].schema.oneOf;
    const inviteVariant = variants.find((variant) => JSON.stringify(variant).includes('"invite_operator"'));
    expect(inviteVariant?.required).toEqual(["target_type", "action", "reason_code", "email"]);
    expect(Object.keys(inviteVariant?.properties as object)).not.toContain("target_id");
  });

  it("accepts the invite form from /admin", async () => {
    const sent: Sent[] = [];
    const response = await call("/moderation/actions", {
      email: ADMIN,
      env: mailEnv(sent),
      headers: FORM,
      raw: new TextEncoder().encode(new URLSearchParams({ target_type: "operator", action: "invite_operator", reason_code: "other", email: INVITEE }).toString()),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Invited");
    expect(sent).toHaveLength(1);
  });
});

describe("Resend mailer", () => {
  it("sends through Resend when RESEND_API_KEY is set, not the EMAIL binding", async () => {
    const sent: Sent[] = [];
    const fetchSpy = resendStub();
    await json(await invite(mailEnv(sent, { resendKey: "re_key" }), INVITEE), 200);
    expect(sent).toHaveLength(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer re_key");
    expect(JSON.parse(String(init?.body))).toMatchObject({ from: AUTH.mail_from, to: [INVITEE] });
  });

  it("reports a failed Resend send without logging the address", async () => {
    const sent: Sent[] = [];
    resendStub(500);
    const errors = vi.spyOn(console, "error");
    const body = await json(await invite(mailEnv(sent, { resendKey: "re_key" }), INVITEE), 200);
    expect(body).toMatchObject({ state: "approved", invite_sent: false });
    expect(JSON.stringify(errors.mock.calls)).not.toContain(INVITEE);
  });

  it("turns email sign-in on with only a Resend key", async () => {
    const sent: Sent[] = [];
    const fetchSpy = resendStub();
    await clearSignInQuota(OPERATOR);
    const response = await call("/signin", {
      env: mailEnv(sent, { binding: false, resendKey: "re_key" }),
      headers: FORM,
      raw: new TextEncoder().encode(new URLSearchParams({ email: OPERATOR }).toString()),
    });
    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body)).text).toContain("/signin/sl_");
  });
});
