import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { utcSeconds, uuidv7 } from "../src/ids";
import postpublishFixture from "./fixtures/policy-postpublish.json";
import { ADMIN, ADMIN2, BOARD_ID, OPERATOR, STAFF, call, resetAndSeed } from "./harness";

const POSTPUBLISH = JSON.stringify(postpublishFixture);
const SHA = "c".repeat(64);
const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);

describe("AT-44 appeals of automatic hides", () => {
  it("lets the author appeal a scan hide once, with a replayable key", async () => {
    const ada = await enroll("Ada", OPERATOR);
    const post = await seedHidden(ada.agentId, "scan");
    const review = await expectJson(await call(`/v1/posts/${post.postId}/review`, { bearer: ada.credential, policy: POSTPUBLISH }), 200);
    expect(review).toMatchObject({ post_id: post.postId, state: "hidden", review_state: "hidden", hidden_by: "scan", appeal: null });
    expect(typeof review.appealable_until).toBe("string");

    const first = await appeal(ada.credential, post.postId, "key-1", { detail: "This was a <b>joke</b> about frogs." });
    expect(first.status).toBe(201);
    const body = await first.json() as Record<string, unknown>;
    expect(body).toMatchObject({ post_id: post.postId, appeal: { state: "open", hidden_by: "scan" } });
    const replay = await appeal(ada.credential, post.postId, "key-1", { detail: "This was a <b>joke</b> about frogs." });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toMatchObject({ appeal: (body as { appeal: unknown }).appeal });
    await expectError(await appeal(ada.credential, post.postId, "key-2", {}), 409, "state_conflict");

    const row = await env.DB.prepare("SELECT queue_first FROM posts WHERE id = ?").bind(post.postId).first<{ queue_first: number }>();
    expect(row?.queue_first).toBe(1);
    const after = await expectJson(await call(`/v1/posts/${post.postId}/review`, { bearer: ada.credential, policy: POSTPUBLISH }), 200);
    expect(after).toMatchObject({ appealable_until: null, appeal: { state: "open", outcome: null } });

    const queue = await (await call("/moderation", { email: STAFF })).text();
    const appeals = queue.slice(queue.indexOf('id="queue-appeals"'), queue.indexOf('id="queue-flagged"'));
    expect(appeals).toContain(post.postId);
    expect(appeals).toContain("This was a &lt;b&gt;joke&lt;/b&gt; about frogs.");
    expect(appeals).toContain("Restore image (Admin)");
  });

  it("refuses a Moderator hide, a closed window, another author, and prepublish mode", async () => {
    const ada = await enroll("Ada", OPERATOR);
    const bea = await enroll("Bea", ADMIN2);
    const published = await seedPost(ada.agentId, "published");
    const hidden = await call("/v1/moderation/actions", {
      email: STAFF,
      body: { target_type: "post", target_id: published.postId, action: "hide", reason_code: "rules" },
    });
    expect(hidden.status).toBe(200);
    const review = await expectJson(await call(`/v1/posts/${published.postId}/review`, { bearer: ada.credential, policy: POSTPUBLISH }), 200);
    expect(review).toMatchObject({ hidden_by: "moderator", appealable_until: null });
    await expectError(await appeal(ada.credential, published.postId, "k1", {}), 409, "state_conflict");

    const old = await seedHidden(ada.agentId, "scan", Date.now() - 8 * DAY);
    await expectError(await appeal(ada.credential, old.postId, "k2", {}), 409, "state_conflict");

    const fresh = await seedHidden(ada.agentId, "scan");
    await expectError(await appeal(bea.credential, fresh.postId, "k3", {}), 404, "not_found");
    await expectError(await call(`/v1/posts/${fresh.postId}/review`, { bearer: bea.credential, policy: POSTPUBLISH }), 404, "not_found");
    await expectError(
      await call(`/v1/posts/${fresh.postId}/appeal`, { bearer: ada.credential, headers: { "idempotency-key": "k4" }, body: {} }),
      409,
      "state_conflict",
    );
    await expectError(
      await call(`/v1/posts/${fresh.postId}/appeal`, { bearer: ada.credential, body: {}, policy: POSTPUBLISH }),
      400,
      "malformed",
    );
  });

  it("lets the Operator appeal, and caps appeals a day per Operator", async () => {
    const ada = await enroll("Ada", OPERATOR);
    const posts = [];
    for (let index = 0; index < 4; index += 1) posts.push(await seedHidden(ada.agentId, index % 2 === 0 ? "scan" : "seat_agents"));
    const byOperator = await call(`/v1/posts/${posts[0]?.postId}/appeal`, { email: OPERATOR, body: {}, policy: POSTPUBLISH });
    expect(byOperator.status).toBe(201);
    await expectJson(await appeal(ada.credential, String(posts[1]?.postId), "a", {}), 201);
    await expectJson(await appeal(ada.credential, String(posts[2]?.postId), "b", {}), 201);
    const limited = await appeal(ada.credential, String(posts[3]?.postId), "c", {});
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    // ADMIN2 is a Moderator as well as an Operator: Moderators answer appeals, they do not file them.
    const moderator = await call(`/v1/posts/${posts[3]?.postId}/appeal`, { email: ADMIN2, body: {}, policy: POSTPUBLISH });
    expect(moderator.status).toBe(403);
  });

  it("restores a falsely hidden Post: restore_asset by an Admin, then restore", async () => {
    const ada = await enroll("Ada", OPERATOR);
    const post = await seedHidden(ada.agentId, "scan");
    await expectJson(await appeal(ada.credential, post.postId, "k", { detail: "false hide" }), 201);

    await expectError(await moderate(STAFF, "asset", String(post.assetId), "restore_asset"), 403, "forbidden");
    // The Post's restore needs a ready Asset.
    await expectError(await moderate(STAFF, "post", post.postId, "restore"), 409, "state_conflict");
    expect(await expectJson(await moderate(ADMIN, "asset", String(post.assetId), "restore_asset"), 200)).toMatchObject({ state: "ready" });
    const hashes = await env.DB.prepare("SELECT COUNT(*) AS n FROM blocked_hashes WHERE asset_id = ?").bind(post.assetId).first<{ n: number }>();
    expect(Number(hashes?.n)).toBe(0);
    await expectError(await moderate(ADMIN, "asset", String(post.assetId), "restore_asset"), 409, "state_conflict");

    expect(await expectJson(await moderate(STAFF, "post", post.postId, "restore"), 200)).toMatchObject({ state: "published" });
    const review = await expectJson(await call(`/v1/posts/${post.postId}/review`, { bearer: ada.credential, policy: POSTPUBLISH }), 200);
    expect(review).toMatchObject({ state: "published", review_state: "published", hidden_by: null, appeal: { state: "decided", outcome: "restore" } });
    const audit = await env.DB.prepare(
      "SELECT action FROM moderation_actions WHERE target_id IN (?, ?) ORDER BY created_at, action",
    ).bind(post.postId, post.assetId).all<{ action: string }>();
    expect((audit.results ?? []).map((row) => row.action).sort()).toEqual(["restore", "restore_asset"]);
  });

  it("refuses restore_asset under legal hold or after deletion started", async () => {
    const ada = await enroll("Ada", OPERATOR);
    const held = await seedHidden(ada.agentId, "scan");
    await env.DB.prepare("UPDATE posts SET legal_hold = 1, legal_hold_reason = 'csam' WHERE id = ?").bind(held.postId).run();
    await expectError(await moderate(ADMIN, "asset", String(held.assetId), "restore_asset"), 409, "state_conflict");
    const deleting = await seedHidden(ada.agentId, "scan");
    await env.DB.prepare("UPDATE assets SET state = 'deletion_pending' WHERE id = ?").bind(deleting.assetId).run();
    await expectError(await moderate(ADMIN, "asset", String(deleting.assetId), "restore_asset"), 409, "state_conflict");
  });

  it("upholds a Seat Flag hide and confirms its flags", async () => {
    const ada = await enroll("Ada", OPERATOR);
    const post = await seedHidden(ada.agentId, "seat_agents");
    const review = await expectJson(await call(`/v1/posts/${post.postId}/review`, { bearer: ada.credential, policy: POSTPUBLISH }), 200);
    expect(review).toMatchObject({ state: "flagged", hidden_by: "seat_agents" });
    await expectError(await moderate(STAFF, "post", post.postId, "uphold"), 409, "state_conflict");
    await expectJson(await appeal(ada.credential, post.postId, "k", {}), 201);
    expect(await expectJson(await moderate(STAFF, "post", post.postId, "uphold"), 200)).toMatchObject({ state: "flagged", appeal: "upheld" });
    const flags = await env.DB.prepare("SELECT outcome FROM seat_flags WHERE post_id = ?").bind(post.postId).all<{ outcome: string }>();
    expect(flags.results).toEqual([{ outcome: "confirmed" }]);
    const after = await expectJson(await call(`/v1/posts/${post.postId}/review`, { bearer: ada.credential, policy: POSTPUBLISH }), 200);
    expect(after).toMatchObject({ appeal: { state: "decided", outcome: "uphold" } });
    await expectError(await moderate(STAFF, "post", post.postId, "uphold"), 409, "state_conflict");
  });

  it("dismisses flags on a published Post without hiding it", async () => {
    const ada = await enroll("Ada", OPERATOR);
    const post = await seedPost(ada.agentId, "published");
    await expectError(await moderate(STAFF, "post", post.postId, "dismiss_flags"), 409, "state_conflict");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO post_scans (post_id, result, hidden, published_at, scanned_at) VALUES (?, 'unscanned', 0, ?, ?)",
      ).bind(post.postId, utcSeconds(), utcSeconds()),
      env.DB.prepare(
        "INSERT INTO seat_flags (id, seat, agent_id, post_id, reason, trial, outcome, created_at) VALUES (?, 1, ?, ?, 'off-topic', 0, 'pending', ?)",
      ).bind(uuidv7(), ada.agentId, post.postId, utcSeconds()),
    ]);
    expect(await expectJson(await moderate(STAFF, "post", post.postId, "dismiss_flags"), 200)).toMatchObject({ state: "published", flags: "dismissed" });
    const scan = await env.DB.prepare("SELECT dismissed_at FROM post_scans WHERE post_id = ?").bind(post.postId).first<{ dismissed_at: string | null }>();
    expect(scan?.dismissed_at).not.toBeNull();
    const flags = await env.DB.prepare("SELECT outcome FROM seat_flags WHERE post_id = ?").bind(post.postId).all<{ outcome: string }>();
    expect(flags.results).toEqual([{ outcome: "overturned" }]);
    await expectError(await moderate(STAFF, "post", post.postId, "dismiss_flags"), 409, "state_conflict");
  });
});

async function enroll(name: string, email: string): Promise<{ agentId: string; credential: string }> {
  const body = await expectJson(await call("/v1/agents", {
    email,
    body: { display_name: name, declared_model: "fixture-model" },
  }), 201);
  return { agentId: String(body.agent_id), credential: String(body.credential) };
}

async function seedPost(authorId: string, state: string, assetId: string | null = null): Promise<{ threadId: string; postId: string }> {
  const threadId = uuidv7();
  const postId = uuidv7();
  const stamp = utcSeconds();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)").bind(threadId, BOARD_ID, stamp),
    env.DB.prepare(
      `INSERT INTO posts (id, thread_id, author_agent_id, title, caption, state, asset_id, alt_text, provenance_source, rights_attestation, license, created_at)
       VALUES (?, ?, ?, 'Title', 'caption', ?, ?, 'alt', 'model', 'I made this.', 'cc0', ?)`,
    ).bind(postId, threadId, authorId, state, assetId, stamp),
  ]);
  return { threadId, postId };
}

// An automatic hide: the scan hides and quarantines; a Seat Flag moves the Post to flagged.
async function seedHidden(
  authorId: string,
  by: "scan" | "seat_agents",
  at = Date.now(),
): Promise<{ postId: string; assetId: string | null }> {
  const stamp = utcSeconds(new Date(at));
  let assetId: string | null = null;
  if (by === "scan") {
    assetId = uuidv7();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO assets (id, agent_id, state, content_type, byte_size, sha256, original_stored, created_at, expires_at)
         VALUES (?, ?, 'quarantined', 'image/webp', 4, ?, 0, ?, ?)`,
      ).bind(assetId, authorId, SHA, stamp, stamp),
      env.DB.prepare("INSERT INTO blocked_hashes (sha256, prohibited, asset_id, created_at) VALUES (?, 1, ?, ?)")
        .bind(uuidv7().replaceAll("-", "").padEnd(64, "0").slice(0, 64), assetId, stamp),
    ]);
  }
  const post = await seedPost(authorId, by === "scan" ? "hidden" : "flagged", assetId);
  const statements = [
    env.DB.prepare("INSERT INTO events (id, type, resource_id, occurred_at) VALUES (?, ?, ?, ?)")
      .bind(uuidv7(), by === "scan" ? "post.withdrawn" : "post.flagged", post.postId, stamp),
  ];
  if (by === "scan") {
    statements.push(env.DB.prepare("UPDATE posts SET hidden_by = 'scan' WHERE id = ?").bind(post.postId));
  } else {
    statements.push(env.DB.prepare(
      "INSERT INTO seat_flags (id, seat, agent_id, post_id, reason, trial, outcome, created_at) VALUES (?, 1, ?, ?, 'off-topic', 0, 'pending', ?)",
    ).bind(uuidv7(), authorId, post.postId, stamp));
  }
  await env.DB.batch(statements);
  return { postId: post.postId, assetId };
}

function appeal(credential: string, postId: string, key: string, body: Record<string, unknown>): Promise<Response> {
  return call(`/v1/posts/${postId}/appeal`, {
    bearer: credential,
    headers: { "idempotency-key": key },
    body,
    policy: POSTPUBLISH,
  });
}

function moderate(email: string, targetType: string, targetId: string, action: string): Promise<Response> {
  return call("/v1/moderation/actions", {
    email,
    body: { target_type: targetType, target_id: targetId, action, reason_code: "other" },
  });
}

async function expectJson(response: Response, status: number): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body;
}

async function expectError(response: Response, status: number, code: string): Promise<void> {
  const body = await response.json() as { error: { code: string } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(body.error.code).toBe(code);
}
