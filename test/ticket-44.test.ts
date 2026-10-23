import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/credential";
import { ADMIN, ADMIN2, ADMIN2_OPERATOR_ID, OPERATOR, OPERATOR_ID, STAFF, call, resetAndSeed } from "./harness";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);

function act(email: string, action: string, extra: Record<string, unknown> = {}, target = OPERATOR_ID): Promise<Response> {
  return call("/v1/moderation/actions", {
    email,
    body: { target_type: "operator", target_id: target, action, reason_code: "rules", ...extra },
  });
}

function enroll(email: string, name = "Ada"): Promise<Response> {
  return call("/v1/agents", { email, body: { display_name: name, declared_model: "m" } });
}

async function json(response: Response, status: number): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body;
}

describe("AT-31 the admin Operators section (ticket 44)", () => {
  it("lists Operators with shortened emails and Admin-only forms", async () => {
    const html = await (await call("/admin", { email: ADMIN })).text();
    const section = html.slice(html.indexOf('id="admin-operators"'));
    expect(section).toContain("o…@example.test");
    expect(section).toContain('<span class="tag">Seat 2</span>');
    expect(section).toContain('value="suspend_operator"');
    expect(html).not.toContain(OPERATOR);
    expect((await act(STAFF, "suspend_operator")).status).toBe(403);
  });

  it("suspends and resumes an Operator", async () => {
    expect(await json(await act(ADMIN, "suspend_operator"), 200)).toMatchObject({ state: "suspended" });
    expect((await enroll(OPERATOR)).status).toBe(403);
    await json(await act(ADMIN, "suspend_operator"), 409);
    expect(await json(await act(ADMIN, "resume_operator"), 200)).toMatchObject({ state: "approved" });
    expect((await enroll(OPERATOR)).status).toBe(201);
    const audit = await env.DB.prepare("SELECT action FROM moderation_actions WHERE target_type = 'operator' ORDER BY created_at, action")
      .all<{ action: string }>();
    expect((audit.results ?? []).map((row) => row.action).sort()).toEqual(["resume_operator", "suspend_operator"]);
  });

  it("caps an Operator's agents", async () => {
    await json(await act(ADMIN, "set_agent_cap", { value: 1 }), 200);
    expect((await enroll(OPERATOR, "One")).status).toBe(201);
    const second = await json(await enroll(OPERATOR, "Two"), 403);
    expect(JSON.stringify(second)).toContain("agent cap");
    await json(await act(ADMIN, "set_agent_cap", { value: 101 }), 422);
    await json(await act(ADMIN, "set_agent_cap", {}), 400);
  });

  it("changes an Operator's email, but never a seat holder's", async () => {
    await json(await act(ADMIN, "change_email", { email: "New@Example.test" }), 200);
    expect((await enroll(OPERATOR)).status).toBe(403);
    expect((await enroll("new@example.test")).status).toBe(201);
    await json(await act(ADMIN, "change_email", { email: "x@example.test" }, ADMIN2_OPERATOR_ID), 403);
    await json(await act(ADMIN, "change_email", { email: "not-an-email" }), 422);
  });

  it("removes an Operator: agents retired, Credentials revoked, email erased", async () => {
    const enrolled = await json(await enroll(OPERATOR), 201);
    const credential = String(enrolled.credential);
    expect((await call("/v1/agents/me", { bearer: credential })).status).toBe(200);
    expect(await json(await act(ADMIN, "remove_operator"), 200)).toMatchObject({ state: "removed" });
    expect((await call("/v1/agents/me", { bearer: credential })).status).toBe(401);
    const agent = await env.DB.prepare("SELECT state FROM agents WHERE id = ?").bind(String(enrolled.agent_id)).first<{ state: string }>();
    expect(agent?.state).toBe("retired");
    const row = await env.DB.prepare("SELECT email, state FROM operators WHERE id = ?").bind(OPERATOR_ID).first<{ email: string; state: string }>();
    expect(row?.state).toBe("removed");
    expect(row?.email).not.toContain("operator@");
    const kept = await env.DB.prepare("SELECT 1 AS one FROM removed_operator_emails WHERE email_hash = ?").bind(await sha256Hex(OPERATOR)).first();
    expect(kept).not.toBeNull();
    expect((await enroll(OPERATOR)).status).toBe(403);
    await json(await act(ADMIN, "remove_operator"), 409);
    await json(await act(ADMIN, "remove_operator", {}, ADMIN2_OPERATOR_ID), 403);
    expect(ADMIN2).toBeTruthy();
  });
});
