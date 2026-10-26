import { applyD1Migrations, createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { VALID_WEBP } from "./fixtures/bytes";
import { BOARD_ID, MODERATOR, OPERATOR, UUID_V7, call, releaseThread, resetAndSeed } from "./harness";

const MISSING_ID = "01900000-0000-7000-8000-000000000099";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);
afterEach(() => {
  vi.restoreAllMocks();
});

describe("reply", () => {
  it("accepts text on an open thread, replays the post, and conflicts on a different body", async () => {
    const author = await enroll();
    const other = await enroll("Bea");
    const assetId = await readyAsset(author.credential);
    const opened = await expectSuccess(await openThread(author.credential, threadBody(assetId)), 201);
    await approve(String(opened.post_id));
    const threadId = String(opened.thread_id);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    const text = "a second voice";
    const body = { text };
    const created = await expectSuccess(await reply(other.credential, threadId, body, "bea-reply"), 201);
    expect(created.thread_id).toBe(threadId);
    expect(created.post_id).toMatch(UUID_V7);
    expect(created.state).toBe("pending_review");
    expect(created.text).toBe(text);
    expect(created.asset_id).toBeUndefined();
    expect(created.limits).toMatchObject({
      threads: { remaining: 1 },
      replies: { remaining: 5 },
      mutations: { remaining: 19 },
    });
    expect(logs.join("\n")).not.toContain(text);

    const replayed = await expectSuccess(await reply(other.credential, threadId, body, "bea-reply"), 201);
    expect(replayed.post_id).toBe(created.post_id);
    expect(replayed.limits).toEqual(created.limits);
    expect(replayed.request_id).not.toBe(created.request_id);
    expect(await postCount(threadId)).toBe(2);
    await expectError(await reply(other.credential, threadId, { text: "a different voice" }, "bea-reply"), 409, "idempotency_conflict");

    await releaseThread(author.credential);
    const second = await expectSuccess(await openThread(author.credential, threadBody(assetId, { title: "Another" }), "another"), 201);
    await approve(String(second.post_id));
    const elsewhere = await expectSuccess(await reply(other.credential, String(second.thread_id), body, "bea-reply"), 201);
    expect(elsewhere.post_id).not.toBe(created.post_id);

    const stored = await env.DB.prepare(
      "SELECT title, caption, asset_id, provenance_source, author_agent_id FROM posts WHERE id = ?",
    ).bind(created.post_id).first<{
      title: string | null;
      caption: string;
      asset_id: string | null;
      provenance_source: string | null;
      author_agent_id: string;
    }>();
    expect(stored?.title).toBeNull();
    expect(stored?.caption).toBe(text);
    expect(stored?.asset_id).toBeNull();
    expect(stored?.provenance_source).toBeNull();
    expect(stored?.author_agent_id).not.toBe("");

    const queue = await call("/moderation", { email: MODERATOR });
    const queueHtml = await queue.text();
    expect(queueHtml).toContain("<h3>Reply</h3>");
    expect(queueHtml).toContain(text);
    const shown = await call(`/threads/${threadId}`);
    expect(shown.status).toBe(200);
    expect(await shown.text()).not.toContain(text);
  });

  it("accepts an image, text with an image, and rejects a reply that is not one", async () => {
    const author = await enroll();
    const other = await enroll("Bea");
    const assetId = await readyAsset(author.credential);
    const opened = await expectSuccess(await openThread(author.credential, threadBody(assetId)), 201);
    await approve(String(opened.post_id));
    const threadId = String(opened.thread_id);
    const image = {
      asset_id: assetId,
      alt_text: "a square reply",
      provenance: { source: "model", model: "fixture-model" },
      rights_attestation: "I made this.",
      license: "cc0",
    };
    const imageOnly = await expectSuccess(await reply(author.credential, threadId, image), 201);
    expect(imageOnly.text).toBe("");
    expect(imageOnly.asset_id).toBe(assetId);
    expect(imageOnly.alt_text).toBe("a square reply");
    expect(imageOnly.provenance).toEqual({ source: "model", model: "fixture-model" });
    expect(imageOnly.rights_attestation).toBe("I made this.");
    expect(imageOnly.license).toBe("cc0");
    expect(imageOnly.limits).toMatchObject({
      threads: { remaining: 0 },
      replies: { remaining: 5 },
      mutations: { remaining: 18 },
    });

    const both = await expectSuccess(await reply(author.credential, threadId, { ...image, text: "with picture" }), 201);
    expect(both.text).toBe("with picture");
    expect(both.asset_id).toBe(assetId);

    await expectError(await reply(author.credential, threadId, { text: "nope", alt_text: "extra" }), 400, "malformed");
    await expectError(await reply(author.credential, threadId, { text: "" }), 422, "validation_failed");
    await expectError(await reply(author.credential, threadId, {}), 422, "validation_failed");
    await expectError(
      await call(`/v1/threads/${threadId}/posts`, { method: "POST", bearer: author.credential, body: { text: "missing key" } }),
      400,
      "malformed",
    );
    await expectError(await reply(author.credential, MISSING_ID, { text: "nowhere" }), 404, "not_found");
    await expectError(
      await call("/v1/threads/not-a-thread/posts", { method: "POST", bearer: author.credential, body: { text: "bad id" }, headers: { "idempotency-key": "bad-id" } }),
      404,
      "not_found",
    );

    const reserved = await expectSuccess(await call("/v1/uploads", {
      bearer: author.credential,
      headers: { "idempotency-key": crypto.randomUUID() },
      body: { content_type: "image/webp", byte_size: 1, sha256: "a".repeat(64) },
    }), 201);
    await expectError(
      await reply(author.credential, threadId, { ...image, asset_id: String(reserved.asset_id) }),
      409,
      "state_conflict",
    );
    const foreign = await readyAsset(other.credential);
    await expectError(await reply(author.credential, threadId, { ...image, asset_id: foreign }), 404, "not_found");
  });

  it("keeps one event id after approval and shows the reply under the opening post", async () => {
    const author = await enroll();
    const assetId = await readyAsset(author.credential);
    const opened = await expectSuccess(await openThread(author.credential, threadBody(assetId, {
      title: "On the board",
      caption: "opening words",
    })), 201);
    const threadId = String(opened.thread_id);
    const postId = String(opened.post_id);
    await expectError(
      await reply(author.credential, threadId, { text: "too soon", remix_of_post_id: postId }, "early-remix"),
      404,
      "not_found",
    );
    await approve(postId);
    const published = await call(`/threads/${threadId}`);
    expect(await published.text()).toContain("On the board");

    const text = "later reply words";
    const body = { text, remix_of_post_id: postId };
    const created = await expectSuccess(await reply(author.credential, threadId, body, "same-reply"), 201);
    expect(created.remix_of_post_id).toBe(postId);
    expect(created.state).toBe("pending_review");
    const pendingPage = await call(`/threads/${threadId}`);
    const pendingHtml = await pendingPage.text();
    expect(pendingHtml).toContain("opening words");
    expect(pendingHtml).not.toContain(text);
    const pendingFeed = await call("/boards/beta");
    expect(await pendingFeed.text()).not.toContain(text);

    const approved = await expectSuccess(await approve(String(created.post_id)));
    expect(approved.event_id).toMatch(UUID_V7);
    await expectError(await approve(String(created.post_id)), 409, "state_conflict");
    const replayed = await expectSuccess(await reply(author.credential, threadId, body, "same-reply"), 201);
    expect(replayed.post_id).toBe(created.post_id);
    expect(replayed.state).toBe("published");
    expect(replayed.event_id).toBe(approved.event_id);
    expect(replayed.request_id).not.toBe(created.request_id);

    const pageHtml = await (await call(`/threads/${threadId}`)).text();
    expect(pageHtml.indexOf("opening words")).toBeGreaterThan(-1);
    expect(pageHtml.indexOf("opening words")).toBeLessThan(pageHtml.indexOf(text));
    expect(pageHtml).toContain("<h2>Reply</h2>");
    const feedHtml = await (await call("/boards/beta")).text();
    expect(feedHtml).toContain("On the board");
    expect(feedHtml).not.toContain(text);
    expect(feedHtml.match(/\/threads\//g)?.length).toBe(1);
  });

  it("rejects secret text and alt text without echoing them or storing a post", async () => {
    const author = await enroll();
    const assetId = await readyAsset(author.credential);
    const opened = await expectSuccess(await openThread(author.credential, threadBody(assetId)), 201);
    const threadId = String(opened.thread_id);
    const secretText = `jc_${"a".repeat(20)}`;
    const rejected = await expectError(await reply(author.credential, threadId, { text: secretText }, "secret-text"), 422, "secret_in_caption");
    expect(JSON.stringify(rejected)).not.toContain(secretText);
    expect(await postCount(threadId)).toBe(1);
    await expectError(await reply(author.credential, threadId, { text: "safe instead" }, "secret-text"), 409, "idempotency_conflict");
    const again = await expectError(await reply(author.credential, threadId, { text: secretText }, "secret-text"), 422, "secret_in_caption");
    expect(JSON.stringify(again)).not.toContain(secretText);

    const secretAlt = `up_${"b".repeat(20)}`;
    const image = {
      asset_id: assetId,
      alt_text: secretAlt,
      provenance: { source: "human" },
      rights_attestation: "I made this.",
      license: "cc0",
    };
    const altRejected = await expectError(await reply(author.credential, threadId, image, "secret-alt"), 422, "secret_in_caption");
    expect(JSON.stringify(altRejected)).not.toContain(secretAlt);
    expect(await postCount(threadId)).toBe(1);
    const queueHtml = await (await call("/moderation", { email: MODERATOR })).text();
    expect(queueHtml).not.toContain(secretText);
    expect(queueHtml).not.toContain(secretAlt);
  });

  it("leaves no post when the thread is locked or archived", async () => {
    const author = await enroll();
    const assetId = await readyAsset(author.credential);
    const locked = await expectSuccess(await openThread(author.credential, threadBody(assetId, { title: "Locked" })), 201);
    await releaseThread(author.credential);
    const archived = await expectSuccess(await openThread(author.credential, threadBody(assetId, { title: "Archived" }), "arch"), 201);
    // The Opening Posts are published, so the lock and archive checks are what refuse the reply.
    await approve(String(locked.post_id));
    await approve(String(archived.post_id));
    await env.DB.prepare("UPDATE threads SET state = 'locked' WHERE id = ?").bind(locked.thread_id).run();
    await env.DB.prepare("UPDATE threads SET state = 'archived' WHERE id = ?").bind(archived.thread_id).run();
    const lockedText = "cannot enter a locked thread";
    const archivedText = "cannot enter an archived thread";
    await expectError(await reply(author.credential, String(locked.thread_id), { text: lockedText }), 409, "state_conflict");
    await expectError(await reply(author.credential, String(archived.thread_id), { text: archivedText }), 409, "state_conflict");
    expect(await postCount(String(locked.thread_id))).toBe(1);
    expect(await postCount(String(archived.thread_id))).toBe(1);
    const queueHtml = await (await call("/moderation", { email: MODERATOR })).text();
    expect(queueHtml).not.toContain(lockedText);
    expect(queueHtml).not.toContain(archivedText);
  });
});

describe("P0 agent run", () => {
  it("reads rules, uploads, opens a thread, and replies after approval", async () => {
    const author = await enroll();
    const rules = await call(`/v1/boards/${BOARD_ID}/rules`, { bearer: author.credential });
    expect(rules.status).toBe(200);
    const assetId = await readyAsset(author.credential);
    const opened = await expectSuccess(await openThread(author.credential, threadBody(assetId, {
      title: "P0 thread",
      caption: "published before the reply",
    })), 201);
    await approve(String(opened.post_id));
    const visible = await (await call(`/threads/${String(opened.thread_id)}`)).text();
    expect(visible).toContain("P0 thread");
    expect(visible).toContain("published before the reply");
    const created = await expectSuccess(await reply(author.credential, String(opened.thread_id), { text: "the reply itself" }), 201);
    expect(created.state).toBe("pending_review");
    const after = await (await call(`/threads/${String(opened.thread_id)}`)).text();
    expect(after).toContain("published before the reply");
    expect(after).not.toContain("the reply itself");
  });
});

function threadBody(assetId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    board_id: BOARD_ID,
    asset_id: assetId,
    title: "Hello",
    caption: "A caption",
    alt_text: "A square",
    provenance: { source: "model", model: "fixture-model" },
    rights_attestation: "I made this.",
    license: "cc0",
    ...extra,
  };
}

function openThread(credential: string, body: Record<string, unknown>, key = crypto.randomUUID()): Promise<Response> {
  return call("/v1/threads", {
    bearer: credential,
    headers: { "idempotency-key": key },
    body,
  });
}

function reply(
  credential: string,
  threadId: string,
  body: Record<string, unknown>,
  key = crypto.randomUUID(),
): Promise<Response> {
  return call(`/v1/threads/${threadId}/posts`, {
    bearer: credential,
    headers: key === "" ? {} : { "idempotency-key": key },
    body,
  });
}

function approve(postId: string): Promise<Response> {
  return call("/v1/moderation/actions", {
    email: MODERATOR,
    body: {
      target_type: "post",
      target_id: postId,
      action: "approve",
      reason_code: "rules",
    },
  });
}

async function postCount(threadId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE thread_id = ?").bind(threadId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function readyAsset(credential: string): Promise<string> {
  const reserved = await expectSuccess(await call("/v1/uploads", {
    bearer: credential,
    headers: { "idempotency-key": crypto.randomUUID() },
    body: {
      content_type: "image/webp",
      byte_size: VALID_WEBP.byteLength,
      sha256: await sha256HexBytes(VALID_WEBP),
    },
  }), 201);
  await expectSuccess(await call(`/v1/uploads/${String(reserved.asset_id)}/content`, {
    method: "PUT",
    raw: VALID_WEBP,
    headers: {
      "idempotency-key": crypto.randomUUID(),
      "upload-token": String(reserved.upload_token),
    },
  }));
  await expectSuccess(await call(`/v1/uploads/${String(reserved.asset_id)}/complete`, {
    method: "POST",
    bearer: credential,
    headers: { "idempotency-key": crypto.randomUUID() },
  }), 202);
  await settle(String(reserved.asset_id));
  const status = await expectSuccess(await call(`/v1/assets/${String(reserved.asset_id)}/status`, {
    bearer: credential,
  }));
  expect(status.state).toBe("ready");
  return String(reserved.asset_id);
}

async function settle(assetId: string): Promise<void> {
  const ctx = createExecutionContext();
  const batch = createMessageBatch("asset-upload", [{
    id: `msg-${assetId}`,
    timestamp: new Date(),
    attempts: 1,
    body: { asset_id: assetId },
  }]);
  if (!worker.queue) throw new Error("queue handler missing");
  await worker.queue(batch, env, ctx);
  await getQueueResult(batch, ctx);
}

async function enroll(name = "Ada"): Promise<{ credential: string }> {
  const response = await call("/v1/agents", {
    email: OPERATOR,
    body: { display_name: name, declared_model: "fixture-model" },
  });
  const body = await expectSuccess(response, 201);
  return { credential: String(body.credential) };
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function expectError(response: Response, status: number, code: string): Promise<ErrorBody> {
  const body = await response.json() as ErrorBody;
  expect(response.status).toBe(status);
  expect(body.error.code).toBe(code);
  expect(body.request_id).toMatch(UUID_V7);
  return body;
}

async function expectSuccess(response: Response, status = 200): Promise<SuccessBody> {
  const body = await response.json() as SuccessBody;
  expect(response.status).toBe(status);
  expect(body.request_id).toMatch(UUID_V7);
  return body;
}

type ErrorBody = { request_id: string; error: { code: string; message: string } };
type SuccessBody = Record<string, unknown>;
