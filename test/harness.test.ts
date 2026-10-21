import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { useSeed } from "./harness";
import { api, expectError, expectRequestId } from "./http";
import { includesText, sha256Hex } from "./oracle";

const seed = useSeed();

describe("API test harness", () => {
  it("seeds an Operator, two Agents, and a Moderator on a fresh database", async () => {
    const world = seed.current();
    expect(world.agents[0].id).not.toBe(world.agents[1].id);
    expect(world.agents[0].secret).not.toBe(world.agents[1].secret);

    const operator = await api("/v1/session", { token: world.operator.secret });
    expect(operator.status).toBe(200);
    expectRequestId(operator);
    expect(operator.json?.principal).toEqual({ type: "operator", id: world.operator.id });

    const moderator = await api("/v1/session", { token: world.moderator.secret });
    expect(moderator.status).toBe(200);
    expect(moderator.json?.principal).toEqual({ type: "moderator", id: world.moderator.id });

    for (const agent of world.agents) {
      const session = await api("/v1/session", { token: agent.secret });
      expect(session.status).toBe(200);
      expect(session.json?.principal).toMatchObject({
        type: "agent",
        id: agent.id,
        scopes: ["read", "post", "react"],
      });
      expect(includesText(session.json, agent.secret)).toBe(false);
    }

    const boards = await api("/v1/boards", { token: world.agents[0].secret });
    expect(boards.status).toBe(200);
    expect(boards.json?.boards).toEqual([
      expect.objectContaining({
        id: world.board.id,
        slug: world.board.slug,
        title: world.board.title,
        visibility: "private",
      }),
    ]);
  });

  it("stores seeded secrets as hashes", async () => {
    const world = seed.current();
    const secrets = [
      world.operator.secret,
      world.moderator.secret,
      world.agents[0].secret,
      world.agents[1].secret,
      world.revoked.secret,
      world.expired.secret,
    ];
    const stored = await env.DB.prepare(
      `SELECT secret_hash AS hash FROM operator_sessions
       UNION ALL SELECT secret_hash FROM moderators
       UNION ALL SELECT secret_hash FROM credentials`,
    ).all<{ hash: string }>();

    const hashes = stored.results.map((row) => row.hash);
    expect(hashes).toHaveLength(secrets.length);
    for (const secret of secrets) {
      expect(hashes).toContain(await sha256Hex(secret));
      expect(hashes.some((hash) => hash.includes(secret) || hash === secret)).toBe(false);
    }
  });

  it("echoes a safe request id and replaces an unsafe one", async () => {
    const world = seed.current();
    const supplied = await api("/v1/session", {
      token: world.operator.secret,
      headers: { "X-Request-Id": "req_client_supplied_id" },
    });
    expect(supplied.status).toBe(200);
    expect(supplied.json?.request_id).toBe("req_client_supplied_id");

    const injected = await api("/v1/session", {
      token: world.operator.secret,
      headers: { "X-Request-Id": "not-a-request-id" },
    });
    expect(injected.status).toBe(200);
    const requestId = expectRequestId(injected);
    expect(requestId).not.toBe("not-a-request-id");
  });

  it("rejects a revoked or expired seeded Credential", async () => {
    const world = seed.current();
    const revoked = await api("/v1/boards", { token: world.revoked.secret });
    expectError(revoked, 401, "unauthorized");
    expect(includesText(revoked.json, world.revoked.secret)).toBe(false);
    expect(includesText(revoked.json, world.agents[0].secret)).toBe(false);

    const expired = await api("/v1/boards", { token: world.expired.secret });
    expectError(expired, 401, "unauthorized");
    expect(includesText(expired.json, world.expired.secret)).toBe(false);
  });
});
