import { describe, expect, it } from "vitest";
import { clearPolicy, replacePolicy, useSeed } from "./harness";
import { api, expectError } from "./http";
import { hasKey, includesText } from "./oracle";

const seed = useSeed();

async function agentIds(token: string): Promise<string[]> {
  const result = await api("/v1/agents", { token });
  expect(result.status).toBe(200);
  const agents = result.json?.agents;
  expect(Array.isArray(agents)).toBe(true);
  return (agents as Array<{ id: string }>).map((agent) => agent.id);
}

describe("fail closed when policy config is missing", () => {
  it("refuses writes and still allows a Board read", async () => {
    const world = seed.current();
    const before = await agentIds(world.operator.secret);
    const originalName = world.agents[0].displayName;
    await clearPolicy();

    const enrolled = await api("/v1/agents", {
      method: "POST",
      token: world.operator.secret,
      body: JSON.stringify({ display_name: "Should Not Exist" }),
    });
    expectError(enrolled, 503, "policy_unavailable");
    expect(hasKey(enrolled.json, "secret")).toBe(false);
    expect(includesText(enrolled.json, world.operator.secret)).toBe(false);
    expect(await agentIds(world.operator.secret)).toEqual(before);

    const patched = await api(`/v1/agents/${world.agents[0].id}`, {
      method: "PATCH",
      token: world.operator.secret,
      body: JSON.stringify({ display_name: "Renamed Without Policy" }),
    });
    expectError(patched, 503, "policy_unavailable");

    const revoked = await api(`/v1/credentials/${world.agents[1].credentialId}/revoke`, {
      method: "POST",
      token: world.operator.secret,
    });
    expectError(revoked, 503, "policy_unavailable");
    expect(hasKey(revoked.json, "secret")).toBe(false);

    const boards = await api("/v1/boards", { token: world.agents[0].secret });
    expect(boards.status).toBe(200);
    const rules = await api("/v1/rules", { token: world.agents[0].secret });
    expectError(rules, 503, "policy_unavailable");
    expect(rules.text).not.toContain("untrusted data");

    const profile = await api(`/v1/agents/${world.agents[0].id}`, { token: world.operator.secret });
    expect((profile.json?.agent as { display_name: string }).display_name).toBe(originalName);
    expect((await api("/v1/boards", { token: world.agents[1].secret })).status).toBe(200);
  });

  it("refuses writes when the policy document is invalid", async () => {
    const world = seed.current();
    const before = await agentIds(world.operator.secret);
    for (const document of ["{", JSON.stringify({ schema_version: 1 })] ) {
      await replacePolicy(document);
      const result = await api("/v1/agents", {
        method: "POST",
        token: world.operator.secret,
        body: JSON.stringify({ display_name: "Should Not Exist" }),
      });
      expectError(result, 503, "policy_unavailable");
      expect(hasKey(result.json, "secret")).toBe(false);
    }
    expect(await agentIds(world.operator.secret)).toEqual(before);
  });
});
