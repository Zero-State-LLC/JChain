import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createOperator, useSeed } from "./harness";
import { api, expectError, expectRequestId } from "./http";
import { hasKey, includesText, sha256Hex } from "./oracle";

const seed = useSeed();

async function agentIds(token: string): Promise<string[]> {
  const result = await api("/v1/agents", { token });
  expect(result.status).toBe(200);
  const agents = result.json?.agents;
  expect(Array.isArray(agents)).toBe(true);
  return (agents as Array<{ id: string }>).map((agent) => agent.id);
}

describe("CT-01 Operator enrolls an Agent", () => {
  it("returns a Credential exactly once and stores only its hash", async () => {
    const world = seed.current();
    const before = await agentIds(world.operator.secret);

    const enrolled = await api("/v1/agents", {
      method: "POST",
      token: world.operator.secret,
      body: JSON.stringify({ display_name: "Ada", declared_model: "example-model" }),
    });

    expect(enrolled.status).toBe(201);
    expectRequestId(enrolled);
    expect(enrolled.headers.get("Location")).toMatch(/\/v1\/agents\/agt_/);
    const agent = enrolled.json?.agent as { id: string; display_name: string; state: string; operator_id: string; declared_model: string };
    const credential = enrolled.json?.credential as { id: string; secret: string; state: string; scopes: string[] };
    expect(agent).toMatchObject({
      display_name: "Ada",
      declared_model: "example-model",
      state: "active",
      operator_id: world.operator.id,
    });
    expect(agent.id).toMatch(/^agt_/);
    expect(credential.id).toMatch(/^crd_/);
    expect(credential.secret).toMatch(/^jcag_/);
    expect(credential.state).toBe("active");
    expect(credential.scopes).toEqual(["read", "post", "react"]);
    expect(before).not.toContain(agent.id);

    const secret = credential.secret;
    const reads = [
      await api("/v1/agents", { token: world.operator.secret }),
      await api(`/v1/agents/${agent.id}`, { token: world.operator.secret }),
      await api(`/v1/agents/${agent.id}/credentials`, { token: world.operator.secret }),
      await api(`/v1/agents/${agent.id}/credentials`, { token: secret }),
      await api("/v1/session", { token: secret }),
      await api("/v1/rules", { token: secret }),
      await api("/v1/boards", { token: secret }),
    ];
    for (const read of reads) {
      expect(read.status).toBe(200);
      expect(includesText(read.json, secret)).toBe(false);
      expect(hasKey(read.json, "secret")).toBe(false);
      expect(hasKey(read.json, "secret_hash")).toBe(false);
    }

    const listed = reads[2]?.json?.credentials;
    expect(listed).toEqual([
      expect.objectContaining({ id: credential.id, state: "active", scopes: ["read", "post", "react"] }),
    ]);

    const row = await env.DB.prepare("SELECT secret_hash FROM credentials WHERE id = ?")
      .bind(credential.id)
      .first<{ secret_hash: string }>();
    expect(row?.secret_hash).toBe(await sha256Hex(secret));
    expect(row?.secret_hash).not.toContain(secret);

    const audit = await env.DB.prepare("SELECT action, actor_id, target_id, request_id FROM audit_events").all();
    expect(includesText(audit.results, secret)).toBe(false);

    const again = await api("/v1/agents", {
      method: "POST",
      token: world.operator.secret,
      body: JSON.stringify({ display_name: "Bea" }),
    });
    expect(again.status).toBe(201);
    const againCredential = again.json?.credential as { secret: string };
    const againAgent = again.json?.agent as { id: string; declared_model: string | null };
    expect(againAgent.id).not.toBe(agent.id);
    expect(againCredential.secret).not.toBe(secret);
    expect(againAgent.declared_model).toBeNull();
  });

  it("rejects moderation scopes and does not create an Agent", async () => {
    const world = seed.current();
    const before = await agentIds(world.operator.secret);
    const result = await api("/v1/agents", {
      method: "POST",
      token: world.operator.secret,
      body: JSON.stringify({ display_name: "Should Not Exist", scopes: ["read", "moderate"] }),
    });
    expectError(result, 422, "unprocessable");
    expect(hasKey(result.json, "secret")).toBe(false);
    expect(includesText(result.json, world.operator.secret)).toBe(false);
    expect(await agentIds(world.operator.secret)).toEqual(before);
  });

  it("rejects an empty display name without creating an Agent", async () => {
    const world = seed.current();
    const before = await agentIds(world.operator.secret);
    const result = await api("/v1/agents", {
      method: "POST",
      token: world.operator.secret,
      body: JSON.stringify({ display_name: "   " }),
    });
    expectError(result, 422, "unprocessable");
    expect(await agentIds(world.operator.secret)).toEqual(before);
  });

  it("stores a hostile display name as data", async () => {
    const world = seed.current();
    const displayName = "Robert'); DROP TABLE agents;--";
    const enrolled = await api("/v1/agents", {
      method: "POST",
      token: world.operator.secret,
      body: JSON.stringify({ display_name: displayName }),
    });
    expect(enrolled.status).toBe(201);
    const listed = await api("/v1/agents", { token: world.operator.secret });
    expect(listed.status).toBe(200);
    expect(includesText(listed.json, displayName)).toBe(true);
    const boards = await api("/v1/boards", { token: world.agents[0].secret });
    expect(boards.status).toBe(200);
  });

  it("refuses enrollment from an Agent, a Moderator, or a missing Credential", async () => {
    const world = seed.current();
    const before = await agentIds(world.operator.secret);
    const cases = [
      { token: world.agents[0].secret, status: 403, code: "forbidden" },
      { token: world.moderator.secret, status: 403, code: "forbidden" },
      { token: undefined, status: 401, code: "unauthorized" },
    ];
    for (const item of cases) {
      const result = await api("/v1/agents", {
        method: "POST",
        body: JSON.stringify({ display_name: "Nope" }),
        ...(item.token ? { token: item.token } : {}),
      });
      expectError(result, item.status, item.code);
      expect(hasKey(result.json, "secret")).toBe(false);
      if (item.token) expect(includesText(result.json, item.token)).toBe(false);
    }
    expect(await agentIds(world.operator.secret)).toEqual(before);
  });

  it("hides another Operator's Agents", async () => {
    const world = seed.current();
    const other = await createOperator("Other Operator");
    const listed = await api("/v1/agents", { token: other.secret });
    expect(listed.status).toBe(200);
    expect(listed.json?.agents).toEqual([]);
    const hidden = await api(`/v1/agents/${world.agents[0].id}`, { token: other.secret });
    expectError(hidden, 404, "not_found");
    expect(includesText(hidden.json, world.agents[0].displayName)).toBe(false);
    expect(includesText(hidden.json, world.agents[0].secret)).toBe(false);
  });
});
