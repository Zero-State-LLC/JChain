import { describe, expect, it } from "vitest";
import { createOperator, useSeed } from "./harness";
import { api, expectError, expectRequestId } from "./http";
import { hasKey, includesText } from "./oracle";

const seed = useSeed();

async function nameOf(operatorSecret: string, agentId: string): Promise<string> {
  const result = await api(`/v1/agents/${agentId}`, { token: operatorSecret });
  expect(result.status).toBe(200);
  return (result.json?.agent as { display_name: string }).display_name;
}

describe("AT-01 missing, revoked, and cross-agent Credentials", () => {
  it("does not change state or return a secret when the Credential is missing", async () => {
    const world = seed.current();
    const agent = world.agents[0];
    const before = await nameOf(world.operator.secret, agent.id);
    const result = await api(`/v1/agents/${agent.id}`, {
      method: "PATCH",
      body: JSON.stringify({ display_name: "Hijacked" }),
    });
    expectError(result, 401, "unauthorized");
    expect(hasKey(result.json, "secret")).toBe(false);
    expect(await nameOf(world.operator.secret, agent.id)).toBe(before);

    const presented = await api(`/v1/agents/${agent.id}`, {
      method: "PATCH",
      token: "jcag_not-a-real-secret",
      body: JSON.stringify({ display_name: "Hijacked" }),
    });
    expectError(presented, 401, "unauthorized");
    expect(includesText(presented.json, "jcag_not-a-real-secret")).toBe(false);
    expect(await nameOf(world.operator.secret, agent.id)).toBe(before);
  });

  it("does not change state or return a secret for a revoked or expired Credential", async () => {
    const world = seed.current();
    const agent = world.agents[0];
    const before = await nameOf(world.operator.secret, agent.id);

    for (const secret of [world.revoked.secret, world.expired.secret]) {
      const result = await api(`/v1/agents/${agent.id}`, {
        method: "PATCH",
        token: secret,
        body: JSON.stringify({ display_name: "Hijacked" }),
      });
      expectError(result, 401, "unauthorized");
      expect(hasKey(result.json, "secret")).toBe(false);
      expect(includesText(result.json, secret)).toBe(false);
      expect(includesText(result.json, agent.secret)).toBe(false);
      expect(await nameOf(world.operator.secret, agent.id)).toBe(before);
    }
  });

  it("stops a cross-agent Credential from changing another Agent or revealing a secret", async () => {
    const world = seed.current();
    const [actor, target] = world.agents;
    const before = await nameOf(world.operator.secret, target.id);

    const patched = await api(`/v1/agents/${target.id}`, {
      method: "PATCH",
      token: actor.secret,
      body: JSON.stringify({ display_name: "Taken Over" }),
    });
    expectError(patched, 404, "not_found");
    expect(hasKey(patched.json, "secret")).toBe(false);
    expect(includesText(patched.json, actor.secret)).toBe(false);
    expect(includesText(patched.json, target.secret)).toBe(false);
    expect(includesText(patched.json, target.displayName)).toBe(false);
    expect(await nameOf(world.operator.secret, target.id)).toBe(before);

    const unknown = await api("/v1/agents/agt_does-not-exist", { token: actor.secret });
    expectError(unknown, 404, "not_found");
    expect(unknown.json?.error).toEqual(patched.json?.error);

    const own = await api(`/v1/agents/${actor.id}`, {
      method: "PATCH",
      token: actor.secret,
      body: JSON.stringify({ display_name: "Chosen Name" }),
    });
    expect(own.status).toBe(200);
    expectRequestId(own);
    expect(hasKey(own.json, "secret")).toBe(false);
    expect(await nameOf(world.operator.secret, actor.id)).toBe("Chosen Name");
    expect(await nameOf(world.operator.secret, target.id)).toBe(before);

    const credentials = await api(`/v1/agents/${target.id}/credentials`, { token: actor.secret });
    expectError(credentials, 404, "not_found");
    expect(hasKey(credentials.json, "secret")).toBe(false);
    expect(includesText(credentials.json, target.secret)).toBe(false);
  });

  it("lets only the owning Operator revoke, and a revoked Credential cannot authenticate", async () => {
    const world = seed.current();
    const [kept, target] = world.agents;

    const byAgent = await api(`/v1/credentials/${target.credentialId}/revoke`, {
      method: "POST",
      token: kept.secret,
    });
    expectError(byAgent, 403, "forbidden");
    expect(hasKey(byAgent.json, "secret")).toBe(false);
    expect(includesText(byAgent.json, target.secret)).toBe(false);
    expect((await api("/v1/boards", { token: target.secret })).status).toBe(200);

    const other = await createOperator("Other Operator");
    const byOther = await api(`/v1/credentials/${target.credentialId}/revoke`, {
      method: "POST",
      token: other.secret,
    });
    expectError(byOther, 404, "not_found");
    expect(includesText(byOther.json, target.secret)).toBe(false);
    expect((await api("/v1/boards", { token: target.secret })).status).toBe(200);

    const revoked = await api(`/v1/credentials/${target.credentialId}/revoke`, {
      method: "POST",
      token: world.operator.secret,
    });
    expect(revoked.status).toBe(200);
    expectRequestId(revoked);
    expect(revoked.json?.credential).toMatchObject({
      id: target.credentialId,
      agent_id: target.id,
      state: "revoked",
    });
    expect(hasKey(revoked.json, "secret")).toBe(false);
    expect(includesText(revoked.json, target.secret)).toBe(false);

    const after = await api("/v1/boards", { token: target.secret });
    expectError(after, 401, "unauthorized");
    expect(includesText(after.json, target.secret)).toBe(false);
    expect((await api("/v1/boards", { token: kept.secret })).status).toBe(200);

    const listed = await api(`/v1/agents/${target.id}/credentials`, { token: world.operator.secret });
    expect(listed.status).toBe(200);
    expect(hasKey(listed.json, "secret")).toBe(false);
    expect(includesText(listed.json, target.secret)).toBe(false);
    expect(listed.json?.credentials).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: target.credentialId, state: "revoked" })]),
    );

    const again = await api(`/v1/credentials/${target.credentialId}/revoke`, {
      method: "POST",
      token: world.operator.secret,
    });
    expectError(again, 409, "conflict");
    expect(hasKey(again.json, "secret")).toBe(false);
  });
});
