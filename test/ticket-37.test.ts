import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ADMIN2, call, clearConnectQuota, OPERATOR, OPERATOR_ID, resetAndSeed } from "./harness";

// Ticket 37 (spec v0.2.24): connect once with a code, last active, scheduled runs.

const FORM = { "content-type": "application/x-www-form-urlencoded" };

type Started = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

function form(fields: Record<string, string>): Uint8Array {
  return new TextEncoder().encode(new URLSearchParams(fields).toString());
}

async function startConnect(name = "Ada"): Promise<Started> {
  const response = await call("/v1/connect", { body: { display_name: name, declared_model: "my-model-1" } });
  expect(response.status).toBe(201);
  return response.json() as Promise<Started>;
}

async function poll(deviceCode: string): Promise<Response> {
  return call("/v1/connect/token", { body: { device_code: deviceCode } });
}

async function rewindPoll(): Promise<void> {
  await env.DB.prepare("UPDATE agent_connections SET last_poll_at = '2000-01-01T00:00:00Z'").run();
}

async function answer(code: string, decision: "approve" | "deny", email = OPERATOR): Promise<Response> {
  return call("/operator/connect", { email, raw: form({ code, decision }), headers: FORM });
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetAndSeed();
  await env.DB.prepare("DELETE FROM agent_connections").run();
  await clearConnectQuota();
});

describe("AT-58 connect an agent with a code", () => {
  it("issues a code, waits for the Operator, and returns the Credential once", async () => {
    const started = await startConnect();
    expect(started.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(started.device_code).toMatch(/^dc_[A-Za-z0-9_-]{43}$/);
    expect(started.verification_uri).toBe("https://jchain.example.test/operator/connect");
    expect(started.verification_uri_complete).toBe(`https://jchain.example.test/operator/connect?code=${started.user_code}`);
    expect(started.expires_in).toBe(600);
    expect(started.interval).toBe(5);
    expect(Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM agents").first<{ n: number }>())?.n)).toBe(0);

    const pending = await poll(started.device_code);
    expect(await pending.json()).toMatchObject({ state: "pending" });
    const tooSoon = await poll(started.device_code);
    expect(tooSoon.status).toBe(429);
    expect(Number(tooSoon.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);

    const formPage = await call(`/operator/connect?code=${started.user_code}`, { email: OPERATOR });
    expect(formPage.status).toBe(200);
    expect(await formPage.text()).toContain(`value="${started.user_code}"`);
    const confirm = await call("/operator/connect", { email: OPERATOR, raw: form({ code: started.user_code.toLowerCase() }), headers: FORM });
    expect(confirm.status).toBe(200);
    const confirmText = await confirm.text();
    expect(confirmText).toContain("<dd>Ada</dd>");
    expect(confirmText).toContain('name="decision" value="approve"');
    expect((await answer(started.user_code, "approve")).status).toBe(200);

    await rewindPoll();
    const approved = await poll(started.device_code);
    expect(approved.status).toBe(200);
    const body = await approved.json() as { state: string; agent_id: string; credential: string };
    expect(body.state).toBe("approved");
    expect(body.credential).toMatch(/^jc_[A-Za-z0-9_-]{43}$/);
    const me = await call("/v1/agents/me", { bearer: body.credential });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ agent_id: body.agent_id, display_name: "Ada" });
    const owner = await env.DB.prepare("SELECT operator_id FROM agents WHERE id = ?").bind(body.agent_id).first<{ operator_id: string }>();
    expect(owner?.operator_id).toBe(OPERATOR_ID);

    await rewindPoll();
    expect(await (await poll(started.device_code)).json()).toMatchObject({ state: "claimed" });
    expect(Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM agents").first<{ n: number }>())?.n)).toBe(1);

    const dump = JSON.stringify((await env.DB.prepare("SELECT * FROM agent_connections").all()).results);
    expect(dump).not.toContain(started.device_code);
    expect(dump).not.toContain(body.credential);
    const listed = await (await call("/operator", { email: OPERATOR })).text();
    expect(listed).toContain(">Ada</a>");
  });

  it("denies, expires, and conceals answered or unknown codes", async () => {
    const denied = await startConnect("Denied");
    expect((await answer(denied.user_code, "deny")).status).toBe(200);
    expect(await (await poll(denied.device_code)).json()).toMatchObject({ state: "denied" });
    expect((await answer(denied.user_code, "approve")).status).toBe(404);

    const late = await startConnect("Late");
    await env.DB.prepare("UPDATE agent_connections SET expires_at = '2000-01-01T00:00:00Z' WHERE display_name = 'Late'").run();
    expect(await (await poll(late.device_code)).json()).toMatchObject({ state: "expired" });
    expect((await answer(late.user_code, "approve")).status).toBe(404);

    expect((await answer("ZZZZ-ZZZZ", "approve")).status).toBe(404);
    expect((await poll(`dc_${"A".repeat(43)}`)).status).toBe(404);
    expect(Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM agents").first<{ n: number }>())?.n)).toBe(0);
  });

  it("needs an Operator to answer and limits starts per address", async () => {
    const started = await startConnect();
    const anonymous = await call("/operator/connect");
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("content-type")).toContain("text/html");
    const crossSite = await call("/operator/connect", {
      email: OPERATOR,
      raw: form({ code: started.user_code, decision: "approve" }),
      headers: { ...FORM, origin: "https://evil.example" },
    });
    expect(crossSite.status).toBe(403);
    // The approving Operator owns the Agent, not whoever started it.
    expect((await answer(started.user_code, "approve", ADMIN2)).status).toBe(200);

    for (let i = 1; i < 20; i += 1) {
      expect((await call("/v1/connect", { body: { display_name: `A${i}`, declared_model: "m" } })).status).toBe(201);
    }
    const over = await call("/v1/connect", { body: { display_name: "Over", declared_model: "m" } });
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).not.toBeNull();
    const elsewhere = await call("/v1/connect", {
      body: { display_name: "Elsewhere", declared_model: "m" },
      headers: { "cf-connecting-ip": "203.0.113.9" },
    });
    expect(elsewhere.status).toBe(201);
    await clearConnectQuota("203.0.113.9");
  });
});

describe("AT-59 last active", () => {
  it("records the first call in an hour and shows it to the Operator", async () => {
    const enrolled = await call("/v1/agents", { email: OPERATOR, body: { display_name: "Bo", declared_model: "m" } });
    const { agent_id: agentId, credential } = await enrolled.json() as { agent_id: string; credential: string };
    expect(await (await call("/operator", { email: OPERATOR })).text()).toContain("Never");
    await call("/v1/agents/me", { bearer: credential });
    const first = await env.DB.prepare("SELECT last_seen_at FROM agents WHERE id = ?").bind(agentId).first<{ last_seen_at: string }>();
    expect(first?.last_seen_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    await env.DB.prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?").bind(first!.last_seen_at.slice(0, 17) + "00Z", agentId).run();
    const pinned = await env.DB.prepare("SELECT last_seen_at FROM agents WHERE id = ?").bind(agentId).first<{ last_seen_at: string }>();
    await call("/v1/agents/me", { bearer: credential });
    const second = await env.DB.prepare("SELECT last_seen_at FROM agents WHERE id = ?").bind(agentId).first<{ last_seen_at: string }>();
    expect(second?.last_seen_at).toBe(pinned?.last_seen_at);
    const page = await (await call("/operator", { email: OPERATOR })).text();
    expect(page).toContain("<th scope=\"col\">Last active</th>");
    expect(page).toContain(`<time datetime="${pinned!.last_seen_at}">`);
  });
});

describe("AT-60 running on a schedule", () => {
  it("documents scheduled runs for people and agents", async () => {
    const page = await (await call("/start", { policy: null })).text();
    expect(page).toContain('<section id="schedule"');
    expect(page).toContain("<code>POST /v1/connect</code>");
    const guide = await (await call("/llms.txt", { policy: null })).text();
    expect(guide).toContain("## Run on a schedule");
    expect(guide).toContain("X-Run-Id");
    expect(guide).toContain("next_cursor");
    expect(guide).toContain("`401`");
  });
});
