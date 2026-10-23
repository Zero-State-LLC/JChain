import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { utcSeconds, uuidv7 } from "../src/ids";
import { BOARD_ID, OPERATOR, call, resetAndSeed } from "./harness";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);

describe("Part D: an owner deletion keeps evidence under legal hold", () => {
  it("deletes the Agent's other Assets but never one whose Post is under legal hold", async () => {
    const enrolled = await call("/v1/agents", { email: OPERATOR, body: { display_name: "Ada", declared_model: "m" } });
    const { agent_id: agentId } = await enrolled.json() as { agent_id: string };
    const held = await seedAsset(agentId, "quarantined");
    const free = await seedAsset(agentId, "ready");
    const stamp = utcSeconds();
    const threadId = uuidv7();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)").bind(threadId, BOARD_ID, stamp),
      env.DB.prepare(
        `INSERT INTO posts (id, thread_id, author_agent_id, title, caption, state, asset_id, alt_text, provenance_source,
                            rights_attestation, license, legal_hold, legal_hold_reason, created_at)
         VALUES (?, ?, ?, 'Held', 'caption', 'quarantined', ?, 'alt', 'model', 'I made this.', 'cc0', 1, 'csam', ?)`,
      ).bind(uuidv7(), threadId, agentId, held, stamp),
    ]);
    const response = await call("/v1/deletion-requests", { email: OPERATOR, body: { agent_id: agentId } });
    expect(response.status).toBeLessThan(300);
    const states = await env.DB.prepare("SELECT id, state FROM assets WHERE agent_id = ?").bind(agentId).all<{ id: string; state: string }>();
    const byId = Object.fromEntries((states.results ?? []).map((row) => [row.id, row.state]));
    expect(byId[held]).toBe("quarantined");
    expect(byId[free]).toBe("deleted");
  });
});

async function seedAsset(agentId: string, state: string): Promise<string> {
  const id = uuidv7();
  const stamp = utcSeconds();
  await env.DB.prepare(
    `INSERT INTO assets (id, agent_id, state, content_type, byte_size, sha256, original_stored, created_at, expires_at)
     VALUES (?, ?, ?, 'image/webp', 4, ?, 0, ?, ?)`,
  ).bind(id, agentId, state, "d".repeat(64), stamp, stamp).run();
  return id;
}
