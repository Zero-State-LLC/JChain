import { applyD1Migrations, createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { VALID_WEBP } from "./fixtures/bytes";
import { uuidv7 } from "../src/ids";
import postpublishFixture from "./fixtures/policy-postpublish.json";
import { ADMIN, ADMIN2, BOARD_ID, MODERATOR, OPERATOR, UUID_V7, call, resetAndSeed } from "./harness";

const POSTPUBLISH = JSON.stringify({
  ...postpublishFixture,
  review: {
    ...postpublishFixture.review,
    seat_trial_actions: 0,
  },
});

type EventRow = {
  event_id: string;
  type: "post.published" | "post.withdrawn" | "post.restored";
  resource_id: string;
  occurred_at: string;
};

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);
afterEach(() => {
  vi.restoreAllMocks();
});

describe("Ticket 49: Event stream carries hides, flags, quarantines, and restores (CT-08)", () => {
  it("surfaces post.withdrawn on Moderator hide and post.restored on restore across multiple cycles", async () => {
    const author = await enroll("Ada", OPERATOR);
    const { postId, publishedEventId } = await publishOpeningPost(author.credential);

    const initialEvents = await pollEvents(author.credential);
    expect(initialEvents).toEqual([
      expect.objectContaining({ event_id: publishedEventId, type: "post.published", resource_id: postId }),
    ]);

    // First Moderator hide -> post.withdrawn
    const hidden1 = await expectSuccess(await moderate(MODERATOR, "post", postId, "hide"));
    expect(hidden1.state).toBe("hidden");
    const afterHide1 = await pollEvents(author.credential);
    expect(afterHide1).toHaveLength(1);
    expect(afterHide1[0]).toMatchObject({ type: "post.withdrawn", resource_id: postId });
    const withdrawnEventId1 = String(afterHide1[0]?.event_id);

    // First restore -> post.restored (and original post.published remains visible)
    const restored1 = await expectSuccess(await moderate(MODERATOR, "post", postId, "restore"));
    expect(restored1.state).toBe("published");
    expect(restored1.event_id).toMatch(UUID_V7);
    expect(restored1.event_id).not.toBe(publishedEventId);
    const restoredEventId1 = String(restored1.event_id);

    const afterRestore1 = await pollEvents(author.credential);
    expect(afterRestore1.map((e) => ({ event_id: e.event_id, type: e.type, resource_id: e.resource_id }))).toEqual([
      { event_id: publishedEventId, type: "post.published", resource_id: postId },
      { event_id: restoredEventId1, type: "post.restored", resource_id: postId },
    ]);

    // Second Moderator hide -> new post.withdrawn
    await expectSuccess(await moderate(MODERATOR, "post", postId, "hide"));
    const afterHide2 = await pollEvents(author.credential);
    expect(afterHide2).toHaveLength(1);
    expect(afterHide2[0]).toMatchObject({ type: "post.withdrawn", resource_id: postId });
    expect(afterHide2[0]?.event_id).not.toBe(withdrawnEventId1);

    // Second restore -> only the latest post.restored is surfaced alongside post.published
    const restored2 = await expectSuccess(await moderate(MODERATOR, "post", postId, "restore"));
    const restoredEventId2 = String(restored2.event_id);
    expect(restoredEventId2).not.toBe(restoredEventId1);
    const afterRestore2 = await pollEvents(author.credential);
    expect(afterRestore2.map((e) => ({ event_id: e.event_id, type: e.type, resource_id: e.resource_id }))).toEqual([
      { event_id: publishedEventId, type: "post.published", resource_id: postId },
      { event_id: restoredEventId2, type: "post.restored", resource_id: postId },
    ]);
  });

  it("surfaces post.withdrawn when one Seat Agent's off-topic flag quarantines a Post, and post.restored on Clear", async () => {
    const author = await enroll("Ada", OPERATOR);
    // Seat 1's Admin needs an Operator row to own its Seat Agent.
    await env.DB.prepare(
      "INSERT INTO operators (email, id, authorship_attested_version, authorship_attested_at) VALUES (?, ?, '2026-10-22', '2026-10-22T00:00:00Z')",
    ).bind(ADMIN, uuidv7()).run();
    const seatOne = await enroll("SeatOne", ADMIN);
    const seatTwo = await enroll("SeatTwo", ADMIN2);
    await expectSuccess(await call("/v1/admin/seats/1", {
      email: ADMIN2,
      body: { action: "bind_seat_agent", agent_id: seatOne.agentId },
      policy: POSTPUBLISH,
    }));
    await expectSuccess(await call("/v1/admin/seats/2", {
      email: ADMIN,
      body: { action: "bind_seat_agent", agent_id: seatTwo.agentId },
      policy: POSTPUBLISH,
    }));

    const { postId, publishedEventId } = await publishOpeningPost(author.credential);
    const flag = (credential: string) => call(`/v1/posts/${postId}/flag`, {
      method: "PUT",
      bearer: credential,
      body: { reason: "off-topic" },
      policy: POSTPUBLISH,
    });

    // v0.2.36: one active off-topic flag (trial actions = 0 in POSTPUBLISH above) quarantines the Post.
    expect((await expectSuccess(await flag(seatTwo.credential))).state).toBe("quarantined");
    // The other seat can no longer flag it: it is not published.
    expect((await flag(seatOne.credential)).status).toBe(404);
    const afterFlag = await pollEvents(author.credential);
    expect(afterFlag).toHaveLength(1);
    expect(afterFlag[0]).toMatchObject({ type: "post.withdrawn", resource_id: postId });

    // A Moderator clears the seat-quarantined Post -> post.restored
    const restored = await expectSuccess(await moderate(MODERATOR, "post", postId, "restore"));
    expect(restored.state).toBe("published");
    expect(restored.event_id).toMatch(UUID_V7);
    expect(restored.event_id).not.toBe(publishedEventId);

    const afterRestore = await pollEvents(author.credential);
    expect(afterRestore.map((e) => ({ event_id: e.event_id, type: e.type }))).toEqual([
      { event_id: publishedEventId, type: "post.published" },
      { event_id: String(restored.event_id), type: "post.restored" },
    ]);
  });

  it("surfaces post.withdrawn when an Operator legal-hold report or Moderator quarantine quarantines a Post", async () => {
    const author = await enroll("Ada", OPERATOR);
    const { threadId, postId: reportPostId } = await publishOpeningPost(author.credential);

    // Publish a Reply in the same Thread before quarantining the Opening Post
    const replyOpened = await expectSuccess(await call(`/v1/threads/${threadId}/posts`, {
      bearer: author.credential,
      headers: { "idempotency-key": crypto.randomUUID() },
      body: { text: "Reply for moderator quarantine test" },
    }), 201);
    const modQuarantineId = String(replyOpened.post_id);
    await expectSuccess(await moderate(MODERATOR, "post", modQuarantineId, "approve"));

    // Authenticated Operator legal-hold report (id-document) quarantines the Opening Post
    const reported = await expectSuccess(await call("/v1/reports", {
      email: OPERATOR,
      body: { target_type: "post", target_id: reportPostId, reason_code: "id-document", detail: "contains id" },
    }), 201);
    expect(reported.report_id).toMatch(UUID_V7);

    const afterReport = await pollEvents(author.credential);
    expect(afterReport.find((e) => e.resource_id === reportPostId)).toMatchObject({
      type: "post.withdrawn",
      resource_id: reportPostId,
    });

    // Moderator quarantine on the second published Post
    const quarantined = await expectSuccess(await moderate(MODERATOR, "post", modQuarantineId, "quarantine"));
    expect(quarantined.state).toBe("quarantined");

    const afterModQuarantine = await pollEvents(author.credential);
    expect(afterModQuarantine.find((e) => e.resource_id === modQuarantineId)).toMatchObject({
      type: "post.withdrawn",
      resource_id: modQuarantineId,
    });
  });

  it("orders same-millisecond hide and restore transitions by insertion order even when UUID suffixes invert", async () => {
    const author = await enroll("Ada", OPERATOR);
    const { postId, publishedEventId } = await publishOpeningPost(author.credential);
    const stamp = "2099-01-01T00:00:00Z";
    const withdrawnHighId = "01b00000-0000-7fff-bfff-ffffffffffff";
    const restoredLowId = "01b00000-0000-7000-8000-000000000001";

    await env.DB.prepare("INSERT INTO events (id, type, resource_id, occurred_at) VALUES (?, 'post.withdrawn', ?, ?)")
      .bind(withdrawnHighId, postId, stamp)
      .run();
    await env.DB.prepare("INSERT INTO events (id, type, resource_id, occurred_at) VALUES (?, 'post.restored', ?, ?)")
      .bind(restoredLowId, postId, stamp)
      .run();

    const events = await pollEvents(author.credential);
    expect(events.map((e) => ({ event_id: e.event_id, type: e.type }))).toEqual([
      { event_id: publishedEventId, type: "post.published" },
      { event_id: restoredLowId, type: "post.restored" },
    ]);
  });
});

async function publishOpeningPost(credential: string): Promise<{ threadId: string; postId: string; publishedEventId: string }> {
  const assetId = await readyAsset(credential);
  const opened = await expectSuccess(await call("/v1/threads", {
    bearer: credential,
    headers: { "idempotency-key": crypto.randomUUID() },
    body: {
      board_id: BOARD_ID,
      asset_id: assetId,
      title: "Event lifecycle thread",
      caption: "Event lifecycle caption",
      alt_text: "A green frog",
      provenance: { source: "model", model: "fixture-model" },
      rights_attestation: "Owned by test.",
      license: "cc0",
    },
  }), 201);
  const threadId = String(opened.thread_id);
  const postId = String(opened.post_id);
  const approved = await expectSuccess(await moderate(MODERATOR, "post", postId, "approve"));
  return { threadId, postId, publishedEventId: String(approved.event_id) };
}

async function pollEvents(credential: string): Promise<EventRow[]> {
  const response = await expectSuccess(await call("/v1/events", { bearer: credential }));
  return (response.items as EventRow[]) ?? [];
}

async function moderate(email: string, targetType: string, targetId: string, action: string): Promise<Response> {
  return call("/v1/moderation/actions", {
    email,
    body: { target_type: targetType, target_id: targetId, action, reason_code: "rules" },
  });
}

async function readyAsset(credential: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", VALID_WEBP);
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const reserved = await expectSuccess(await call("/v1/uploads", {
    bearer: credential,
    headers: { "idempotency-key": crypto.randomUUID() },
    body: { content_type: "image/webp", byte_size: VALID_WEBP.byteLength, sha256 },
  }), 201);
  const assetId = String(reserved.asset_id);
  if (reserved.upload_token) {
    await expectSuccess(await call(`/v1/uploads/${assetId}/content`, {
      method: "PUT",
      raw: VALID_WEBP,
      headers: { "idempotency-key": crypto.randomUUID(), "upload-token": String(reserved.upload_token) },
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
  }
  return assetId;
}

async function enroll(name: string, email: string): Promise<{ credential: string; agentId: string }> {
  const body = await expectSuccess(await call("/v1/agents", {
    email,
    body: { display_name: name, declared_model: "fixture-model" },
  }), 201);
  return { credential: String(body.credential), agentId: String(body.agent_id) };
}

async function expectSuccess(response: Response, status = 200): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body;
}
