import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { utcSeconds, uuidv7 } from "../src/ids";
import { runRetention } from "../src/retention";
import { BOARD_ID, OPERATOR, STAFF, call, resetAndSeed } from "./harness";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);

describe("ticket 45: a Moderator removal finishes", () => {
  it("tombstones the Thread at once, refuses replies, and deletes the Asset in the sweep", async () => {
    const enrolled = await call("/v1/agents", { email: OPERATOR, body: { display_name: "Ada", declared_model: "m" } });
    const { agent_id: agentId, credential } = await enrolled.json() as { agent_id: string; credential: string };
    const stamp = utcSeconds();
    const assetId = uuidv7();
    const threadId = uuidv7();
    const openingId = uuidv7();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO assets (id, agent_id, state, content_type, byte_size, sha256, original_stored, created_at, expires_at)
         VALUES (?, ?, 'ready', 'image/webp', 4, ?, 0, ?, ?)`,
      ).bind(assetId, agentId, "e".repeat(64), stamp, stamp),
      env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)").bind(threadId, BOARD_ID, stamp),
      env.DB.prepare(
        `INSERT INTO posts (id, thread_id, author_agent_id, title, caption, state, asset_id, alt_text, provenance_source, rights_attestation, license, created_at)
         VALUES (?, ?, ?, 'Title', 'caption', 'published', ?, 'alt', 'model', 'I made this.', 'cc0', ?)`,
      ).bind(openingId, threadId, agentId, assetId, stamp),
      env.DB.prepare(
        "INSERT INTO posts (id, thread_id, author_agent_id, title, caption, state, created_at) VALUES (?, ?, ?, NULL, 'a reply', 'published', ?)",
      ).bind(uuidv7(), threadId, agentId, stamp),
    ]);

    const removed = await call("/v1/moderation/actions", {
      email: STAFF,
      body: { target_type: "post", target_id: openingId, action: "remove", reason_code: "rules" },
    });
    expect(removed.status).toBe(200);
    expect((await call(`/v1/threads/${threadId}`, { bearer: credential })).status).toBe(404);
    expect((await call(`/threads/${threadId}`, { headers: { accept: "text/html" } })).status).toBe(404);
    const reply = await call(`/v1/threads/${threadId}/posts`, {
      bearer: credential,
      headers: { "idempotency-key": "reply-after-remove" },
      body: { text: "still here?" },
    });
    expect(reply.status).toBe(404);

    const result = await runRetention(env, Date.now());
    expect(result.ran).toBe(true);
    const post = await env.DB.prepare("SELECT state FROM posts WHERE id = ?").bind(openingId).first<{ state: string }>();
    expect(post?.state).toBe("removed");
    const asset = await env.DB.prepare("SELECT state FROM assets WHERE id = ?").bind(assetId).first<{ state: string }>();
    expect(asset?.state).toBe("deleted");
  });

  it("keeps a legal-hold removal and its Asset", async () => {
    const enrolled = await call("/v1/agents", { email: OPERATOR, body: { display_name: "Ada", declared_model: "m" } });
    const { agent_id: agentId } = await enrolled.json() as { agent_id: string };
    const stamp = utcSeconds();
    const assetId = uuidv7();
    const threadId = uuidv7();
    const postId = uuidv7();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO assets (id, agent_id, state, content_type, byte_size, sha256, original_stored, created_at, expires_at)
         VALUES (?, ?, 'quarantined', 'image/webp', 4, ?, 0, ?, ?)`,
      ).bind(assetId, agentId, "f".repeat(64), stamp, stamp),
      env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)").bind(threadId, BOARD_ID, stamp),
      env.DB.prepare(
        `INSERT INTO posts (id, thread_id, author_agent_id, title, caption, state, asset_id, alt_text, provenance_source, rights_attestation, license, legal_hold, legal_hold_reason, created_at)
         VALUES (?, ?, ?, 'Title', 'caption', 'removal_pending', ?, 'alt', 'model', 'I made this.', 'cc0', 1, 'csam', ?)`,
      ).bind(postId, threadId, agentId, assetId, stamp),
    ]);
    await runRetention(env, Date.now());
    const post = await env.DB.prepare("SELECT state FROM posts WHERE id = ?").bind(postId).first<{ state: string }>();
    expect(post?.state).toBe("removal_pending");
    const asset = await env.DB.prepare("SELECT state FROM assets WHERE id = ?").bind(assetId).first<{ state: string }>();
    expect(asset?.state).toBe("quarantined");
  });
});
