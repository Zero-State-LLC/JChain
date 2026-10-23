import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AUTHORSHIP_RULE_VERSION } from "../src/authorship";
import { sha256Hex } from "../src/credential";
import { runRetention } from "../src/retention";
import { ADMIN, OPERATOR, OPERATOR_ID, STAFF, call, clearSignInQuota, resetAndSeed } from "./harness";

// Ticket 25 (#61, CT-19, AT-30, AT-28): Operator sign-up, approve_operator, and per-state Agent caps.

const ORIGIN = "https://jchain.example.test";
const SAME = { origin: ORIGIN };
const FORM = { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN };
const CAPS = { provisional_agents: 2, approved_agents: 20, max_agents: 100 };
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
const NEWCOMER = "newcomer@example.test";

type Sent = { from: string; to: string; subject: string; text: string };

function policyWith(extra: Record<string, unknown>): string {
  return JSON.stringify({ ...JSON.parse(env.POLICY as string), ...extra });
}

function bindings(sent: Sent[], extra: Record<string, unknown>): Env {
  const policy = policyWith(extra);
  const binding = { send: async (message: Sent) => { sent.push(message); return { messageId: "test" }; } };
  return new Proxy(env, {
    get(target, property) {
      if (property === "POLICY") return policy;
      if (property === "EMAIL") return binding;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Env;
}

const OPEN = { auth: { ...AUTH, signup_open: true }, operator_caps: CAPS };

function form(fields: Record<string, string>): Uint8Array {
  return new TextEncoder().encode(new URLSearchParams(fields).toString());
}

function linkFrom(message: Sent): string {
  const found = message.text.match(/\/signin\/(sl_[A-Za-z0-9_-]{43})/);
  expect(found).not.toBeNull();
  return found![1]!;
}

async function requestLink(env: Env, email: string): Promise<Response> {
  return call("/signin", { method: "POST", raw: form({ email }), headers: FORM, env });
}

async function useLink(env: Env, token: string): Promise<Response> {
  return call(`/signin/${token}`, { method: "POST", headers: SAME, env });
}

function enroll(email: string, name: string, extra: Record<string, unknown> = { operator_caps: CAPS }): Promise<Response> {
  return call("/v1/agents", { email, body: { display_name: name, declared_model: "m" }, policy: policyWith(extra) });
}

function act(action: string, target: string, extra: Record<string, unknown> = {}, email = ADMIN): Promise<Response> {
  return call("/v1/moderation/actions", {
    email,
    body: { target_type: "operator", target_id: target, action, reason_code: "rules", ...extra },
    policy: policyWith({ operator_caps: CAPS }),
  });
}

async function operatorRow(email: string): Promise<{ id: string; state: string } | null> {
  return env.DB.prepare("SELECT id, state FROM operators WHERE email = ?").bind(email).first<{ id: string; state: string }>();
}

async function attest(id: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE operators SET authorship_attested_version = ?, authorship_attested_at = '2026-10-23T00:00:00Z' WHERE id = ?",
  ).bind(AUTHORSHIP_RULE_VERSION, id).run();
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetAndSeed();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM signin_links"),
    env.DB.prepare("DELETE FROM signup_links"),
    env.DB.prepare("DELETE FROM removed_operator_emails"),
  ]);
  for (const email of [OPERATOR, NEWCOMER, "second@example.test", "third@example.test", "removed@example.test"]) await clearSignInQuota(email);
});

describe("CT-19 policy", () => {
  it("accepts signup_open true only with operator_caps, and validates the caps", async () => {
    const ok = await call("/v1/boards", { email: OPERATOR, policy: policyWith(OPEN) });
    expect(ok.status).toBe(200);
    for (const extra of [
      { auth: { ...AUTH, signup_open: true } },
      { operator_caps: { ...CAPS, provisional_agents: 21 } },
      { operator_caps: { ...CAPS, max_agents: 101 } },
      { operator_caps: { provisional_agents: 2, approved_agents: 20 } },
    ]) {
      const refused = await call("/v1/boards", { email: OPERATOR, policy: policyWith(extra) });
      expect(refused.status, JSON.stringify(extra)).toBe(503);
    }
  });
});

describe("AT-30 sign-up", () => {
  it("sends a sign-up link to a new address only while sign-up is open", async () => {
    const closed: Sent[] = [];
    const closedEnv = bindings(closed, { auth: AUTH, operator_caps: CAPS });
    expect((await requestLink(closedEnv, NEWCOMER)).status).toBe(200);
    expect(closed).toHaveLength(0);
    expect(await (await call("/signin", { env: closedEnv })).text()).toContain("invite-only");

    const sent: Sent[] = [];
    const open = bindings(sent, OPEN);
    expect(await (await call("/signin", { env: open })).text()).toContain("Sign-up is open and free");
    const known = await requestLink(open, OPERATOR);
    const unknown = await requestLink(open, NEWCOMER);
    expect(await unknown.text()).toBe(await known.text());
    expect(sent.map((message) => message.subject)).toEqual([
      "Your j-chain.net sign-in link",
      "Your j-chain.net sign-up link",
    ]);
    expect(await operatorRow(NEWCOMER)).toBeNull();

    const done = await useLink(open, linkFrom(sent[1]!));
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/operator");
    const created = await operatorRow(NEWCOMER);
    expect(created?.state).toBe("provisional");
    const cookie = (done.headers.get("set-cookie") ?? "").match(/__Host-jc_session=ss_[A-Za-z0-9_-]{43}/)![0];
    const page = await (await call("/operator", { headers: { cookie }, env: open })).text();
    expect(page).toContain("0 of 2 agents.");
    expect(page).toContain("An Admin approval raises the limit to 20.");
    // AT-28: no price, plan, or tier on the page.
    expect(page).not.toMatch(/\$\d/);

    // The link works once.
    expect((await useLink(open, linkFrom(sent[1]!))).status).toBe(400);
  });

  it("creates nothing past max_operators or signups_per_day, or for a removed address", async () => {
    const sent: Sent[] = [];
    // Two Operators are seeded; max_operators 3 leaves room for one.
    const full = bindings(sent, { ...OPEN, max_operators: 3 });
    await requestLink(full, NEWCOMER);
    await requestLink(full, "second@example.test");
    expect(sent).toHaveLength(2);
    expect((await useLink(full, linkFrom(sent[0]!))).status).toBe(303);
    // The second link was sent while there was room, but the cap is checked again on use.
    expect((await useLink(full, linkFrom(sent[1]!))).status).toBe(400);
    expect(await operatorRow("second@example.test")).toBeNull();
    // At the cap no link is sent at all.
    await requestLink(full, "third@example.test");
    expect(sent).toHaveLength(2);

    const daily: Sent[] = [];
    const oneADay = bindings(daily, { ...OPEN, auth: { ...AUTH, signup_open: true, signups_per_day: 0 } });
    await requestLink(oneADay, "third@example.test");
    expect(daily).toHaveLength(0);

    const removed: Sent[] = [];
    const open = bindings(removed, OPEN);
    await env.DB.prepare("INSERT INTO removed_operator_emails (email_hash, removed_at) VALUES (?, '2026-10-23T00:00:00Z')")
      .bind(await sha256Hex("removed@example.test")).run();
    await requestLink(open, "removed@example.test");
    expect(removed).toHaveLength(0);
  });

  it("deletes ended sign-up links, which hold an address, on the retention run", async () => {
    const sent: Sent[] = [];
    const open = bindings(sent, OPEN);
    await requestLink(open, NEWCOMER);
    expect(sent).toHaveLength(1);
    await runRetention(open, Date.now() + 16 * 60 * 1000);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM signup_links").first<{ n: number }>();
    expect(Number(left?.n)).toBe(0);
  });
});

describe("CT-19 caps and approve_operator", () => {
  it("caps a provisional Operator at 2 and an approved one at 20, under its own cap", async () => {
    await env.DB.prepare("UPDATE operators SET state = 'provisional' WHERE id = ?").bind(OPERATOR_ID).run();
    expect((await enroll(OPERATOR, "One")).status).toBe(201);
    expect((await enroll(OPERATOR, "Two")).status).toBe(201);
    const third = await enroll(OPERATOR, "Three");
    expect(third.status).toBe(403);
    // Without the operator_caps block there is no state cap, as before ticket 25.
    expect((await enroll(OPERATOR, "Uncapped", {})).status).toBe(201);
    await env.DB.prepare("UPDATE agents SET state = 'retired' WHERE operator_id = ? AND display_name = 'Uncapped'").bind(OPERATOR_ID).run();

    expect((await act("approve_operator", OPERATOR_ID, {}, STAFF)).status).toBe(403);
    const approved = await act("approve_operator", OPERATOR_ID);
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ operator_id: OPERATOR_ID, state: "approved" });
    expect((await act("approve_operator", OPERATOR_ID)).status).toBe(409);
    expect((await enroll(OPERATOR, "Three")).status).toBe(201);
    const audit = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM moderation_actions WHERE target_type = 'operator' AND action = 'approve_operator'",
    ).first<{ n: number }>();
    expect(Number(audit?.n)).toBe(1);

    // An Admin's own cap wins over the state cap.
    expect((await act("set_agent_cap", OPERATOR_ID, { value: 3 })).status).toBe(200);
    expect((await enroll(OPERATOR, "Four")).status).toBe(403);
    expect((await act("set_agent_cap", OPERATOR_ID, { value: 101 })).status).toBe(422);
  });

  it("shows Approve only for a provisional Operator on the admin surface", async () => {
    await env.DB.prepare("UPDATE operators SET state = 'provisional' WHERE id = ?").bind(OPERATOR_ID).run();
    const html = await (await call("/admin", { email: ADMIN })).text();
    const section = html.slice(html.indexOf('id="admin-operators"'));
    expect(section.match(/value="approve_operator"/g)).toHaveLength(1);
  });

  it("lets a signed-up Operator enroll up to its provisional cap", async () => {
    const sent: Sent[] = [];
    const open = bindings(sent, OPEN);
    await requestLink(open, NEWCOMER);
    await useLink(open, linkFrom(sent[0]!));
    const created = await operatorRow(NEWCOMER);
    await attest(created!.id);
    expect((await enroll(NEWCOMER, "A")).status).toBe(201);
    expect((await enroll(NEWCOMER, "B")).status).toBe(201);
    expect((await enroll(NEWCOMER, "C")).status).toBe(403);
  });
});
