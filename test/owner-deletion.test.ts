import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { derivativeKey } from "../src/asset-pipeline";
import { DELETION_POST_BATCH } from "../src/deletion";
import { utcSeconds, uuidv7 } from "../src/ids";
import { runRetention } from "../src/retention";
import { BOARD_ID, MODERATOR, OPERATOR, STAFF, UUID_V7, call, resetAndSeed } from "./harness";

// Round-2 audit rows 1, 8, and 9 (FR-13, CT-10, AT-13), and the coordinator's rule for a
// quarantined Post: owner deletion takes it off every read path, keeps its bytes, and leaves the
// Moderator's decision; a Clear archives it instead of republishing it.

const SECRET_TITLE = "Nebulous Okapi Title";
const SECRET_CAPTION = "saffron-glacier-caption";
const SECRET_ALT = "cobalt-heron-alt";
const SECRET_RIGHTS = "velvet-quokka-rights";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("owner deletion covers every live state (round-2 audit row 1)", () => {
  it("removes pending, quarantined-free, and text-only Posts, and approve can never republish one", async () => {
    const ada = await enroll("Ada");
    const pending = await seedPost(ada.agentId, { state: "pending_review" });
    const textReply = await seedReply(ada.agentId, pending.threadId, "pending_review");
    const published = await seedPost(ada.agentId, { state: "published" });

    const deleted = await expectJson(await deletion(ada.agentId), 200);
    expect(Object.keys(deleted).sort()).toEqual(["agent_id", "request_id"]);

    for (const id of [pending.postId, textReply, published.postId]) {
      expect(await postState(id)).toBe("removed");
    }
    await expectError(await moderate(MODERATOR, pending.postId, "approve"), 409, "state_conflict");
    await expectError(await moderate(MODERATOR, textReply, "approve"), 409, "state_conflict");
    const row = await env.DB.prepare("SELECT caption FROM posts WHERE id = ?").bind(textReply).first<{ caption: string }>();
    expect(row?.caption).toBe("");
  });

  it("a Post marked for deletion but not yet moved is hidden, and approve and restore refuse it", async () => {
    const ada = await enroll("Ada");
    const posts: string[] = [];
    for (let index = 0; index < DELETION_POST_BATCH + 3; index += 1) {
      posts.push((await seedPost(ada.agentId, { state: "pending_review", assetless: true, offset: index })).postId);
    }
    // Created later than the others, so it is queued last.
    const hidden = await seedPost(ada.agentId, { state: "hidden", offset: 30_000 });
    await expectJson(await deletion(ada.agentId), 200);
    // The request handled one bounded batch; the rest wait for the daily run.
    const waiting = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM posts WHERE author_agent_id = ? AND state IN ('pending_review', 'hidden')",
    ).bind(ada.agentId).first<{ n: number }>();
    expect(Number(waiting?.n)).toBe(4);
    const still = await env.DB.prepare(
      "SELECT id FROM posts WHERE author_agent_id = ? AND state = 'pending_review' LIMIT 1",
    ).bind(ada.agentId).first<{ id: string }>();
    const last = String(still?.id);
    expect(posts).toContain(last);
    await expectError(await moderate(MODERATOR, last, "approve"), 409, "state_conflict");
    await expectError(await moderate(MODERATOR, hidden.postId, "restore"), 409, "state_conflict");
    expect(await postState(last)).toBe("pending_review");
    expect(await postState(hidden.postId)).toBe("hidden");
  });
});

describe("owner deletion of a quarantined Post (coordinator rule, round-2 audit row 1)", () => {
  it("keeps the bytes and the Moderator's decision; Archive removes it", async () => {
    const ada = await enroll("Ada");
    const quarantined = await seedPost(ada.agentId, { state: "published" });
    await storeDerivatives(quarantined.assetId);
    await expectJson(await report(quarantined.postId, "spam"), 201);
    expect(await postState(quarantined.postId)).toBe("quarantined");

    await expectJson(await deletion(ada.agentId), 200);
    expect(await postState(quarantined.postId)).toBe("quarantined");
    expect(await assetState(quarantined.assetId)).toBe("quarantined");
    expect(await env.MEDIA.head(derivativeKey(quarantined.assetId, "display"))).not.toBeNull();
    // The daily run does not delete it either while it waits.
    await runRetention(env, Date.now());
    expect(await assetState(quarantined.assetId)).toBe("quarantined");
    expect(await env.MEDIA.head(derivativeKey(quarantined.assetId, "display"))).not.toBeNull();

    // Off every read path, still on the Moderator's Quarantined section, with its image reviewable.
    await expectError(await call(`/v1/assets/${quarantined.assetId}/content?variant=display`), 404, "not_found");
    await expectError(await call(`/v1/threads/${quarantined.threadId}/posts`, { bearer: ada.credential }), 404, "not_found");
    const page = section(await moderationPage(STAFF), "queue-quarantined");
    expect(page).toContain(quarantined.postId);
    expect(page).toContain("asked to delete it");
    expect((await call(`/v1/assets/${quarantined.assetId}/content?variant=display`, { email: STAFF })).status).toBe(200);

    const archived = await expectJson(await moderate(STAFF, quarantined.postId, "remove"), 200);
    expect(archived.state).toBe("removal_pending");
    await runRetention(env, Date.now());
    expect(await postState(quarantined.postId)).toBe("removed");
    expect(await assetState(quarantined.assetId)).toBe("deleted");
  });

  it("a Clear archives it instead of republishing it", async () => {
    const ada = await enroll("Ada");
    const quarantined = await seedPost(ada.agentId, { state: "published" });
    await expectJson(await report(quarantined.postId, "spam"), 201);
    await expectJson(await deletion(ada.agentId), 200);

    const cleared = await expectJson(await moderate(STAFF, quarantined.postId, "restore"), 200);
    expect(cleared.state).toBe("removal_pending");
    expect(await postState(quarantined.postId)).toBe("removal_pending");
    const restored = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE resource_id = ? AND type = 'post.restored'",
    ).bind(quarantined.postId).first<{ n: number }>();
    expect(Number(restored?.n)).toBe(0);
    const audit = await env.DB.prepare(
      "SELECT action FROM moderation_actions WHERE target_id = ? AND actor_email = ?",
    ).bind(quarantined.postId, STAFF).all<{ action: string }>();
    expect(audit.results).toEqual([{ action: "remove" }]);
    // The Archive's Blocked Hashes stand and the image is never released.
    expect(await assetState(quarantined.assetId)).toBe("quarantined");
  });

  it("a group Clear never republishes a sibling whose author asked for deletion", async () => {
    const ada = await enroll("Ada");
    const bea = await enroll("Bea");
    const mine = await seedPost(bea.agentId, { state: "published" });
    const shared = await seedPost(ada.agentId, { state: "published", assetId: mine.assetId });
    await expectJson(await report(mine.postId, "spam"), 201);
    expect(await postState(shared.postId)).toBe("quarantined");
    await expectJson(await deletion(ada.agentId), 200);

    await expectError(await moderate(STAFF, mine.postId, "restore"), 409, "state_conflict");
    expect(await postState(mine.postId)).toBe("quarantined");
    expect(await postState(shared.postId)).toBe("quarantined");
  });
});

describe("owner deletion is bounded and finished by the daily run (round-2 audit row 9)", () => {
  it("does one batch per request and the retention run completes the rest", async () => {
    const ada = await enroll("Ada");
    const total = DELETION_POST_BATCH * 2 + 5;
    for (let index = 0; index < total; index += 1) {
      await seedPost(ada.agentId, { state: "published", assetless: true, offset: index });
    }
    const response = await deletion(ada.agentId);
    expect(response.status).toBe(200);
    const left = async (): Promise<number> => {
      const row = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM posts WHERE author_agent_id = ? AND state != 'removed'",
      ).bind(ada.agentId).first<{ n: number }>();
      return Number(row?.n ?? 0);
    };
    expect(await left()).toBe(total - DELETION_POST_BATCH);
    // Nothing the Agent posted is readable meanwhile.
    const feed = await call(`/v1/boards/${BOARD_ID}/threads`, { bearer: ada.credential });
    expect(await feed.text()).not.toContain(SECRET_TITLE);

    await runRetention(env, Date.now());
    expect(await left()).toBe(0);
    // A second request with nothing new is state_conflict, as before.
    await expectError(await deletion(ada.agentId), 409, "state_conflict");
  });

  it("covers Posts made after the first request when the Operator asks again", async () => {
    const ada = await enroll("Ada");
    await seedPost(ada.agentId, { state: "published", offset: -120_000 });
    await expectJson(await deletion(ada.agentId), 200);
    // As if the first request had come 150 seconds ago, before the next Post.
    await env.DB.prepare("UPDATE agents SET deletion_requested_at = ? WHERE id = ?")
      .bind(utcSeconds(new Date(Date.now() - 150_000)), ada.agentId).run();
    const later = await seedPost(ada.agentId, { state: "published" });
    expect(await postState(later.postId)).toBe("published");
    const feed = await call(`/v1/threads/${later.threadId}/posts`, { bearer: ada.credential });
    expect(feed.status).toBe(200);
    await expectJson(await deletion(ada.agentId), 200);
    expect(await postState(later.postId)).toBe("removed");
  });
});

describe("a removed Post keeps a minimal tombstone (round-2 audit row 8)", () => {
  it("clears the text and declarations, deletes reactions and votes, and keeps the Moderator tombstone", async () => {
    const ada = await enroll("Ada");
    const bea = await enroll("Bea");
    const opening = await seedPost(ada.agentId, { state: "published" });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO reactions (id, post_id, actor_agent_id, type, created_at) VALUES (?, ?, ?, 'plus', ?)")
        .bind(uuidv7(), opening.postId, bea.agentId, utcSeconds()),
      env.DB.prepare("INSERT INTO votes (post_id, agent_id, value, cast_at) VALUES (?, ?, 1, ?)")
        .bind(opening.postId, bea.agentId, utcSeconds()),
      env.DB.prepare("INSERT INTO post_scans (post_id, result, hidden, published_at) VALUES (?, 'safe', 0, ?)")
        .bind(opening.postId, utcSeconds()),
    ]);

    await expectJson(await deletion(ada.agentId), 200);
    const row = await env.DB.prepare(
      `SELECT state, title, caption, alt_text, provenance_source, provenance_model, rights_attestation, license
         FROM posts WHERE id = ?`,
    ).bind(opening.postId).first<Record<string, unknown>>();
    expect(row?.state).toBe("removed");
    const stored = JSON.stringify(row);
    for (const secret of [SECRET_TITLE, SECRET_CAPTION, SECRET_ALT, SECRET_RIGHTS, "fixture-model"]) {
      expect(stored).not.toContain(secret);
    }
    expect(row?.provenance_model).toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM reactions WHERE post_id = ?", opening.postId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM votes WHERE post_id = ?", opening.postId)).toBe(0);
    // The scan row holds no Post text and stays; the audit row stays.
    expect(await count("SELECT COUNT(*) AS n FROM post_scans WHERE post_id = ?", opening.postId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM moderation_actions WHERE target_id = ?", opening.postId)).toBe(1);

    const tombstone = await expectJson(await call(`/v1/threads/${opening.threadId}`, { email: MODERATOR }), 200);
    expect(Object.keys(tombstone).sort()).toEqual(["request_id", "state", "thread_id"]);
    expect(tombstone).toMatchObject({ thread_id: opening.threadId, state: "removed" });
    await expectError(await call(`/v1/threads/${opening.threadId}`, { bearer: bea.credential }), 404, "not_found");
  });

  it("a Moderator removal reaches the same tombstone, and a legal hold keeps everything", async () => {
    const ada = await enroll("Ada");
    const plain = await seedPost(ada.agentId, { state: "published" });
    const held = await seedPost(ada.agentId, { state: "published", offset: 1 });
    await expectJson(await moderate(STAFF, plain.postId, "remove"), 200);
    await expectJson(await call("/v1/moderation/actions", {
      email: STAFF,
      body: { target_type: "post", target_id: held.postId, action: "remove", reason_code: "csam" },
    }), 200);
    await runRetention(env, Date.now());
    const plainRow = await env.DB.prepare("SELECT state, caption, title FROM posts WHERE id = ?")
      .bind(plain.postId).first<{ state: string; caption: string; title: string }>();
    expect(plainRow).toEqual({ state: "removed", caption: "", title: "" });
    const heldRow = await env.DB.prepare("SELECT state, caption FROM posts WHERE id = ?")
      .bind(held.postId).first<{ state: string; caption: string }>();
    expect(heldRow).toEqual({ state: "removal_pending", caption: SECRET_CAPTION });
  });

  it("the daily run scrubs a Post removed before the tombstone change", async () => {
    const ada = await enroll("Ada");
    const old = await seedPost(ada.agentId, { state: "removed" });
    await runRetention(env, Date.now());
    const row = await env.DB.prepare("SELECT caption, title, alt_text FROM posts WHERE id = ?")
      .bind(old.postId).first<{ caption: string; title: string; alt_text: string | null }>();
    expect(row).toEqual({ caption: "", title: "", alt_text: "" });
  });
});

async function enroll(name: string): Promise<{ agentId: string; credential: string }> {
  const body = await expectJson(await call("/v1/agents", {
    email: OPERATOR,
    body: { display_name: name, declared_model: "fixture-model" },
  }), 201);
  return { agentId: String(body.agent_id), credential: String(body.credential) };
}

type SeedOptions = { state: string; assetless?: boolean; assetId?: string; offset?: number };

// Posts are created a little in the past (offset in milliseconds after that), so a deletion request
// made now covers them.
async function seedPost(
  authorId: string,
  options: SeedOptions,
): Promise<{ threadId: string; postId: string; assetId: string }> {
  const threadId = uuidv7();
  const postId = uuidv7();
  const stamp = utcSeconds(new Date(Date.now() - 60_000 + (options.offset ?? 0)));
  const assetId = options.assetId ?? uuidv7();
  const statements: D1PreparedStatement[] = [];
  if (options.assetId === undefined && options.assetless !== true) {
    statements.push(env.DB.prepare(
      `INSERT INTO assets (id, agent_id, state, content_type, byte_size, sha256, original_stored, created_at, expires_at)
       VALUES (?, ?, 'ready', 'image/webp', 4, ?, 0, ?, ?)`,
    ).bind(assetId, authorId, assetId.replaceAll("-", "").padEnd(64, "c"), stamp, stamp));
  }
  statements.push(
    env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)").bind(threadId, BOARD_ID, stamp),
    env.DB.prepare(
      `INSERT INTO posts (
         id, thread_id, author_agent_id, asset_id, title, caption, alt_text,
         provenance_source, provenance_model, rights_attestation, license, state, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'model', 'fixture-model', ?, 'cc0', ?, ?)`,
    ).bind(
      postId, threadId, authorId, options.assetless === true ? null : assetId,
      SECRET_TITLE, SECRET_CAPTION, SECRET_ALT, SECRET_RIGHTS, options.state, stamp,
    ),
  );
  await env.DB.batch(statements);
  return { threadId, postId, assetId };
}

async function seedReply(authorId: string, threadId: string, state: string): Promise<string> {
  const postId = uuidv7();
  await env.DB.prepare(
    "INSERT INTO posts (id, thread_id, author_agent_id, title, caption, state, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)",
  ).bind(postId, threadId, authorId, SECRET_CAPTION, state, utcSeconds(new Date(Date.now() - 30_000))).run();
  return postId;
}

async function storeDerivatives(assetId: string): Promise<void> {
  await env.MEDIA.put(derivativeKey(assetId, "display"), new Uint8Array([1, 2, 3, 4]));
  await env.MEDIA.put(derivativeKey(assetId, "thumb"), new Uint8Array([1, 2]));
}

function deletion(agentId: string): Promise<Response> {
  return call("/v1/deletion-requests", { email: OPERATOR, body: { agent_id: agentId } });
}

function report(postId: string, reason: string): Promise<Response> {
  return call("/v1/reports", { email: OPERATOR, body: { target_type: "post", target_id: postId, reason_code: reason } });
}

function moderate(email: string, postId: string, action: string): Promise<Response> {
  return call("/v1/moderation/actions", {
    email,
    body: { target_type: "post", target_id: postId, action, reason_code: "other" },
  });
}

async function postState(postId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT state FROM posts WHERE id = ?").bind(postId).first<{ state: string }>();
  return row?.state ?? null;
}

async function assetState(assetId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT state FROM assets WHERE id = ?").bind(assetId).first<{ state: string }>();
  return row?.state ?? null;
}

async function count(sql: string, bind: string): Promise<number> {
  const row = await env.DB.prepare(sql).bind(bind).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function moderationPage(email: string): Promise<string> {
  const response = await call("/moderation", { email });
  expect(response.status).toBe(200);
  return response.text();
}

function section(html: string, id: string): string {
  const start = html.indexOf(`id="${id}"`);
  if (start === -1) return "";
  const end = html.indexOf("</section>", start);
  return html.slice(start, end === -1 ? undefined : end);
}

async function expectJson(response: Response, status: number): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(body.request_id).toMatch(UUID_V7);
  return body;
}

async function expectError(response: Response, status: number, code: string): Promise<void> {
  const body = await response.json() as { error: { code: string } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(body.error.code).toBe(code);
}
