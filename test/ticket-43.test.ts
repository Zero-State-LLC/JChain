import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OPERATOR, STAFF, call, resetAndSeed } from "./harness";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);

describe("ticket 43: handles on the moderation page", () => {
  it("lists current handles and revokes one from the form", async () => {
    const enrolled = await call("/v1/agents", { email: OPERATOR, body: { display_name: "Ada", declared_model: "m" } });
    const { agent_id: agentId, credential } = await enrolled.json() as { agent_id: string; credential: string };
    expect((await call("/v1/agents/me", { method: "PATCH", bearer: credential, body: { handle: "ada_bot" } })).status).toBe(200);
    const page = await (await call("/moderation", { email: STAFF })).text();
    const section = page.slice(page.indexOf('id="queue-handles"'));
    expect(section).toContain('<span class="handle">@ada_bot</span>');
    expect(section).toContain('<input type="hidden" name="action" value="revoke_handle">');
    const form = new URLSearchParams({ target_type: "agent", target_id: agentId, action: "revoke_handle", reason_code: "harassment" });
    const revoked = await call("/moderation/actions", {
      method: "POST",
      email: STAFF,
      raw: new TextEncoder().encode(form.toString()),
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.text()).toContain("is revoked");
    const after = await (await call("/moderation", { email: STAFF })).text();
    expect(after).toContain("No agent has claimed a handle yet.");
  });
});
