import { applyD1Migrations, createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { VALID_WEBP } from "./fixtures/bytes";
import { BOARD_ID, MODERATOR, OPERATOR, UUID_V7, call, resetAndSeed } from "./harness";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const NON_PUBLISHED_STATES = [
  "pending_review",
  "rejected",
  "hidden",
  "flagged",
  "quarantined",
  "removal_pending",
  "removed",
] as const;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);
afterEach(() => {
  vi.restoreAllMocks();
});

describe("ticket 46: opening post visibility gates replies, thread reads, and reports (AT-07)", () => {
  it("requires a published Opening Post before accepting a reply", async () => {
    const author = await enroll("Author");
    const replier = await enroll("Replier");
    const assetId = await readyAsset(author.credential);
    const opened = await expectSuccess(await call("/v1/threads", {
      bearer: author.credential,
      headers: { "idempotency-key": "open-46-1" },
      body: {
        board_id: BOARD_ID,
        title: "Opening visibility gate",
        caption: "opening gate body",
        asset_id: assetId,
        alt_text: "square",
        provenance: { source: "human" },
        rights_attestation: "I made this.",
        license: "cc0",
      },
    }), 201);
    const threadId = String(opened.thread_id);
    const openingId = String(opened.post_id);

    for (const state of NON_PUBLISHED_STATES) {
      await env.DB.prepare("UPDATE posts SET state = ? WHERE id = ?").bind(state, openingId).run();
      const res = await call(`/v1/threads/${threadId}/posts`, {
        bearer: replier.credential,
        headers: { "idempotency-key": `reply-${state}` },
        body: { text: `blocked while ${state}` },
      });
      await expectError(res, 404, "not_found");
    }

    const replyCount = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM posts WHERE thread_id = ? AND title IS NULL",
    ).bind(threadId).first<{ n: number }>();
    expect(Number(replyCount?.n ?? 0)).toBe(0);

    await env.DB.prepare("UPDATE posts SET state = 'published' WHERE id = ?").bind(openingId).run();
    const accepted = await expectSuccess(await call(`/v1/threads/${threadId}/posts`, {
      bearer: replier.credential,
      headers: { "idempotency-key": "reply-published" },
      body: { text: "accepted once published" },
    }), 201);
    expect(accepted.post_id).toMatch(UUID_V7);

    await env.DB.prepare("UPDATE posts SET state = 'hidden' WHERE id = ?").bind(openingId).run();
    const replayedWhileHidden = await call(`/v1/threads/${threadId}/posts`, {
      bearer: replier.credential,
      headers: { "idempotency-key": "reply-published" },
      body: { text: "accepted once published" },
    });
    await expectError(replayedWhileHidden, 404, "not_found");
  });

  it("hides a Thread and its published Replies when the Opening Post is not published, keeping the CT-10 tombstone for Moderators", async () => {
    const author = await enroll("Author");
    const replier = await enroll("Replier");
    const assetId = await readyAsset(author.credential);
    const opened = await expectSuccess(await call("/v1/threads", {
      bearer: author.credential,
      headers: { "idempotency-key": "open-46-2" },
      body: {
        board_id: BOARD_ID,
        title: "Thread header text",
        caption: "opening body words",
        asset_id: assetId,
        alt_text: "square",
        provenance: { source: "human" },
        rights_attestation: "I made this.",
        license: "cc0",
      },
    }), 201);
    const threadId = String(opened.thread_id);
    const openingId = String(opened.post_id);
    await approve(openingId);

    const replyWords = "published reply stays hidden with opening";
    const replied = await expectSuccess(await call(`/v1/threads/${threadId}/posts`, {
      bearer: replier.credential,
      headers: { "idempotency-key": "reply-46-2" },
      body: { text: replyWords },
    }), 201);
    await approve(String(replied.post_id));

    for (const state of ["pending_review", "rejected", "hidden", "flagged", "quarantined"] as const) {
      await env.DB.prepare("UPDATE posts SET state = ? WHERE id = ?").bind(state, openingId).run();
      await expectError(await call(`/v1/threads/${threadId}`, { bearer: author.credential }), 404, "not_found");
      await expectError(await call(`/v1/threads/${threadId}`, { email: MODERATOR }), 404, "not_found");
      const agentPosts = await call(`/v1/threads/${threadId}/posts`, { bearer: author.credential });
      const agentPostsBody = await agentPosts.clone().text();
      await expectError(agentPosts, 404, "not_found");
      expect(agentPostsBody).not.toContain(replyWords);
      const modPosts = await call(`/v1/threads/${threadId}/posts`, { email: MODERATOR });
      const modPostsBody = await modPosts.clone().text();
      await expectError(modPosts, 404, "not_found");
      expect(modPostsBody).not.toContain(replyWords);
      const page = await call(`/threads/${threadId}`);
      expect(page.status).toBe(404);
      const html = await page.text();
      expect(html).not.toContain("Thread header text");
      expect(html).not.toContain(replyWords);
    }

    for (const state of ["removal_pending", "removed"] as const) {
      await env.DB.prepare("UPDATE posts SET state = ? WHERE id = ?").bind(state, openingId).run();
      await expectError(await call(`/v1/threads/${threadId}`, { bearer: author.credential }), 404, "not_found");
      await expectError(await call(`/v1/threads/${threadId}/posts`, { bearer: author.credential }), 404, "not_found");
      const modThread = await expectSuccess(await call(`/v1/threads/${threadId}`, { email: MODERATOR }));
      expect(modThread).toMatchObject({ thread_id: threadId, state: "removed" });
      const modPosts = await expectSuccess(await call(`/v1/threads/${threadId}/posts`, { email: MODERATOR }));
      expect(JSON.stringify(modPosts)).toContain(replyWords);
      expect(JSON.stringify(modPosts)).not.toContain("opening body words");
      const page = await call(`/threads/${threadId}`);
      expect(page.status).toBe(404);
      expect(await page.text()).not.toContain(replyWords);
    }
  });

  it("returns not_found when reporting a post, thread, or agent the reporter cannot see", async () => {
    stubSiteverify();
    const author = await enroll("Author");
    const replier = await enroll("Replier");
    const assetId = await readyAsset(author.credential);
    const opened = await expectSuccess(await call("/v1/threads", {
      bearer: author.credential,
      headers: { "idempotency-key": "open-46-3" },
      body: {
        board_id: BOARD_ID,
        title: "Report visibility gate",
        caption: "report gate body",
        asset_id: assetId,
        alt_text: "square",
        provenance: { source: "human" },
        rights_attestation: "I made this.",
        license: "cc0",
      },
    }), 201);
    const threadId = String(opened.thread_id);
    const openingId = String(opened.post_id);
    await approve(openingId);

    const replied = await expectSuccess(await call(`/v1/threads/${threadId}/posts`, {
      bearer: replier.credential,
      headers: { "idempotency-key": "reply-46-3" },
      body: { text: "reply under opening" },
    }), 201);
    const replyId = String(replied.post_id);
    await approve(replyId);

    for (const state of NON_PUBLISHED_STATES) {
      await env.DB.prepare("UPDATE posts SET state = ? WHERE id = ?").bind(state, replyId).run();
      await expectError(await call("/v1/reports", {
        email: OPERATOR,
        body: { target_type: "post", target_id: replyId, reason_code: "spam" },
      }), 404, "not_found");
      const htmlRes = await call("/reports", {
        method: "POST",
        email: OPERATOR,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://jchain.example.test",
        },
        raw: new TextEncoder().encode(new URLSearchParams({
          target_type: "post",
          target_id: replyId,
          reason_code: "spam",
        }).toString()),
      });
      expect(htmlRes.status).toBe(404);
    }

    await env.DB.prepare("UPDATE posts SET state = 'published' WHERE id = ?").bind(replyId).run();
    for (const state of ["hidden", "flagged", "pending_review", "quarantined", "removed"] as const) {
      await env.DB.prepare("UPDATE posts SET state = ? WHERE id = ?").bind(state, openingId).run();
      await expectError(await call("/v1/reports", {
        email: OPERATOR,
        body: { target_type: "post", target_id: replyId, reason_code: "spam" },
      }), 404, "not_found");
      await expectError(await call("/v1/reports", {
        email: OPERATOR,
        body: { target_type: "thread", target_id: threadId, reason_code: "spam" },
      }), 404, "not_found");
    }

    for (const state of ["invited", "retired"] as const) {
      await env.DB.prepare("UPDATE agents SET state = ? WHERE id = ?").bind(state, author.agentId).run();
      await expectError(await call("/v1/reports", {
        email: OPERATOR,
        body: { target_type: "agent", target_id: author.agentId, reason_code: "rules" },
      }), 404, "not_found");
    }

    const beforeCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM reports").first<{ n: number }>();
    expect(Number(beforeCount?.n ?? 0)).toBe(0);

    for (const state of ["active", "suspended"] as const) {
      await env.DB.prepare("UPDATE agents SET state = ? WHERE id = ?").bind(state, author.agentId).run();
      await expectSuccess(await call("/v1/reports", {
        email: OPERATOR,
        body: { target_type: "agent", target_id: author.agentId, reason_code: "rules" },
      }), 201);
    }
  });
});

function stubSiteverify(): void {
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === SITEVERIFY) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input, init);
  });
}

async function enroll(displayName: string): Promise<{ agentId: string; credential: string }> {
  const body = await expectSuccess(await call("/v1/agents", {
    email: OPERATOR,
    body: { display_name: displayName, declared_model: "fixture-model" },
  }), 201);
  return { agentId: String(body.agent_id), credential: String(body.credential) };
}

async function readyAsset(credential: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", VALID_WEBP);
  const sha = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const reserved = await expectSuccess(await call("/v1/uploads", {
    bearer: credential,
    headers: { "idempotency-key": crypto.randomUUID() },
    body: { sha256: sha, byte_size: VALID_WEBP.byteLength, content_type: "image/webp" },
  }), 201);
  const assetId = String(reserved.asset_id);
  await expectSuccess(await call(`/v1/uploads/${assetId}/content`, {
    method: "PUT",
    raw: VALID_WEBP,
    headers: {
      "idempotency-key": crypto.randomUUID(),
      "upload-token": String(reserved.upload_token),
    },
  }));
  await expectSuccess(await call(`/v1/uploads/${assetId}/complete`, {
    method: "POST",
    bearer: credential,
    headers: { "idempotency-key": crypto.randomUUID() },
  }), 202);
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
  return assetId;
}

async function approve(postId: string): Promise<void> {
  await expectSuccess(await call("/v1/moderation/actions", {
    email: MODERATOR,
    body: { target_type: "post", target_id: postId, action: "approve", reason_code: "rules" },
  }));
}

async function expectError(response: Response, status: number, code: string): Promise<void> {
  const body = await response.json() as { error?: { code?: string } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(body.error?.code).toBe(code);
}

async function expectSuccess(response: Response, status = 200): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body;
}
