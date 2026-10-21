import { applyD1Migrations, createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { VALID_PNG } from "./fixtures/bytes";
import { BOARD_ID, MODERATOR, OPERATOR, UUID_V7, call, resetAndSeed } from "./harness";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);
afterEach(() => {
  vi.restoreAllMocks();
});

describe("open a thread", () => {
  it("commits a thread and opening post, replays the same ids, and does not charge quota", async () => {
    const agent = await enroll();
    const assetId = await readyAsset(agent.credential);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    const caption = "a quiet caption about the picture";
    const first = threadBody(assetId, { caption, title: "First light" });
    const created = await expectSuccess(await openThread(agent.credential, first, "west run"), 201);
    expect(created.thread_id).toMatch(UUID_V7);
    expect(created.post_id).toMatch(UUID_V7);
    expect(created.state).toBe("pending_review");
    expect(created.provenance).toEqual({ source: "model", model: "fixture-model" });
    expect(created.rights_attestation).toBe("I made this.");
    expect(created.license).toBe("cc0");
    expect(created.limits).toBeUndefined();
    expect(logs.join("\n")).not.toContain(caption);

    const replayed = await expectSuccess(await openThread(agent.credential, reversed(first), "west run"), 201);
    expect(replayed.thread_id).toBe(created.thread_id);
    expect(replayed.post_id).toBe(created.post_id);
    expect(replayed.state).toBe("pending_review");
    expect(replayed.request_id).not.toBe(created.request_id);

    const conflict = await openThread(agent.credential, threadBody(assetId, { title: "Other" }), "west run");
    await expectError(conflict, 409, "idempotency_conflict");
    const queue = await call("/moderation", { email: MODERATOR });
    const html = await queue.text();
    expect(html).toContain("First light");
    expect(html).not.toContain("Other");
  });

  it("rejects secret-looking captions and alt text and leaves the title unscanned", async () => {
    const agent = await enroll();
    const assetId = await readyAsset(agent.credential);
    const secret = `jc_${"a".repeat(20)}`;
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    const captionHit = await openThread(agent.credential, threadBody(assetId, { caption: `see ${secret}` }));
    const captionBody = await expectError(captionHit, 422, "secret_in_caption");
    expect(JSON.stringify(captionBody)).not.toContain(secret);
    expect(logs.join("\n")).not.toContain(secret);

    const altSecret = `up_${"b".repeat(20)}`;
    await expectError(
      await openThread(agent.credential, threadBody(assetId, { alt_text: altSecret }), "alt-key"),
      422,
      "secret_in_caption",
    );
    await expectError(
      await openThread(agent.credential, threadBody(assetId, { caption: "-----BEGIN" }), "begin-key"),
      422,
      "secret_in_caption",
    );
    const short = await expectSuccess(await openThread(
      agent.credential,
      threadBody(assetId, { caption: `jc_${"a".repeat(19)}`, title: `title ${secret}` }),
      "short-key",
    ), 201);
    expect(short.state).toBe("pending_review");
    const page = await call("/moderation", { email: MODERATOR });
    const html = await page.text();
    expect(html).toContain(`title ${secret}`);
    expect(html).not.toContain(`see ${secret}`);
    expect(html).not.toContain(altSecret);
    expect(html).not.toContain("-----BEGIN");
  });

  it("rejects a missing key, a bad field, an unready asset, and another agent's asset", async () => {
    const owner = await enroll("Ada");
    const other = await enroll("Bea");
    const assetId = await readyAsset(owner.credential);
    const reserved = await expectSuccess(await call("/v1/uploads", {
      bearer: owner.credential,
      headers: { "idempotency-key": crypto.randomUUID() },
      body: {
        content_type: "image/png",
        byte_size: 1,
        sha256: "a".repeat(64),
      },
    }), 201);

    await expectError(await openThread(owner.credential, threadBody(assetId), ""), 400, "malformed");
    await expectError(
      await call("/v1/threads", {
        method: "POST",
        bearer: owner.credential,
        headers: { "idempotency-key": "missing-body-key" },
      }),
      400,
      "malformed",
    );
    await expectError(
      await openThread(owner.credential, { ...threadBody(assetId), extra: true }, "extra"),
      400,
      "malformed",
    );
    await expectError(
      await openThread(owner.credential, threadBody(assetId, { license: "public-domain" }), "license"),
      422,
      "validation_failed",
    );
    await expectError(
      await openThread(owner.credential, threadBody(String(reserved.asset_id)), "reserved"),
      409,
      "state_conflict",
    );
    await expectError(
      await openThread(other.credential, threadBody(assetId), "stolen"),
      404,
      "not_found",
    );
    await expectError(
      await openThread(owner.credential, threadBody(assetId, { board_id: "01900000-0000-7000-8000-000000000099" }), "board"),
      404,
      "not_found",
    );
    const feed = await call("/boards/beta");
    expect(await feed.text()).toContain("No published threads.");
  });
});

describe("approve", () => {
  it("publishes one post and one event, then keeps that event id on replay", async () => {
    const agent = await enroll();
    const assetId = await readyAsset(agent.credential);
    const body = threadBody(assetId, { title: "Approved once", caption: "visible later" });
    const opened = await expectSuccess(await openThread(agent.credential, body, "same-create"), 201);
    const note = "moderator-only note";
    const approved = await expectSuccess(await approve(String(opened.post_id), { private_note: note }));
    expect(approved.event_id).toMatch(UUID_V7);
    expect(approved.post_id).toBe(opened.post_id);
    expect(approved.state).toBe("published");
    expect(JSON.stringify(approved)).not.toContain(note);

    await expectError(await approve(String(opened.post_id), { key: "second" }), 409, "state_conflict");
    const replay = await expectSuccess(await openThread(agent.credential, body, "same-create"), 201);
    expect(replay.thread_id).toBe(opened.thread_id);
    expect(replay.post_id).toBe(opened.post_id);
    expect(replay.event_id).toBe(approved.event_id);
    expect(replay.state).toBe("published");

    await expectError(await approve(String(opened.post_id), { action: "reject" }), 409, "state_conflict");
    await expectError(await approve(String(opened.post_id), { target_type: "thread" }), 409, "state_conflict");
    await expectError(
      await call("/v1/moderation/actions", { bearer: agent.credential, body: approveBody(String(opened.post_id)) }),
      403,
      "forbidden",
    );
    await expectError(await approve(String(opened.post_id), { email: OPERATOR }), 403, "forbidden");
    await expectError(await call("/v1/moderation/actions", { body: approveBody(String(opened.post_id)) }), 401, "access_required");
    const feed = await call("/boards/beta");
    expect(await feed.text()).not.toContain(note);
  });
});

describe("board pages", () => {
  it("hides a pending thread and shows alt text, declarations, and escaped caption after approval", async () => {
    const agent = await enroll();
    const other = await enroll("Bea");
    const assetId = await readyAsset(agent.credential);
    const caption = `<script>alert(1)</script>`;
    const opened = await expectSuccess(await openThread(agent.credential, threadBody(assetId, {
      title: "On the board",
      caption,
      alt_text: "a one pixel square",
    })), 201);
    const threadId = String(opened.thread_id);
    const pendingPage = await call(`/threads/${threadId}`);
    expect(pendingPage.status).toBe(404);
    expect(pendingPage.headers.get("content-type")).toContain("text/html");
    expect(await pendingPage.text()).not.toContain("On the board");
    const pendingFeed = await call("/boards/beta");
    expect(await pendingFeed.text()).not.toContain("On the board");
    await expectError(await call(`/v1/assets/${assetId}/content?variant=display`), 401, "credential_invalid");
    await expectError(
      await call(`/v1/assets/${assetId}/content?variant=display`, { bearer: other.credential }),
      404,
      "not_found",
    );
    const ownerBytes = await call(`/v1/assets/${assetId}/content?variant=display`, { bearer: agent.credential });
    expect(ownerBytes.status).toBe(200);

    const queue = await call("/moderation", { email: MODERATOR });
    const queueHtml = await queue.text();
    expect(queue.status).toBe(200);
    expect(queueHtml).toContain("On the board");
    expect(queueHtml).toContain("a one pixel square");
    expect(queueHtml).toContain(`action="/v1/moderation/actions"`);
    expect(queueHtml).not.toContain("<script>");
    await expectError(await call("/moderation", { bearer: agent.credential }), 403, "forbidden");
    await expectError(await call("/moderation"), 401, "access_required");

    const form = new URLSearchParams({
      target_type: "post",
      target_id: String(opened.post_id),
      action: "approve",
      reason_code: "rules",
    });
    const approved = await expectSuccess(await call("/v1/moderation/actions", {
      method: "POST",
      email: MODERATOR,
      raw: new TextEncoder().encode(form.toString()),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }));
    expect(approved.event_id).toMatch(UUID_V7);

    const feed = await call("/boards/beta");
    const feedHtml = await feed.text();
    expect(feed.status).toBe(200);
    expect(feed.headers.get("cache-control")).toBe("no-store");
    expect(feedHtml).toContain(`/threads/${threadId}`);
    expect(feedHtml).toContain("On the board");
    expect(feedHtml).toContain('alt="a one pixel square"');
    const page = await call(`/threads/${threadId}`);
    const pageHtml = await page.text();
    expect(page.status).toBe(200);
    expect(pageHtml).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(pageHtml).not.toContain("<script>");
    expect(pageHtml).toContain("a one pixel square");
    expect(pageHtml).toContain("model");
    expect(pageHtml).toContain("fixture-model");
    expect(pageHtml).toContain("I made this.");
    expect(pageHtml).toContain("cc0");
    const published = await call(`/v1/assets/${assetId}/content?variant=display`);
    expect(published.status).toBe(200);
    expect(published.headers.get("content-type")).toBe("image/webp");
    const stranger = await call(`/v1/assets/${assetId}/content?variant=thumb`, { bearer: other.credential });
    expect(stranger.status).toBe(200);

    await env.DB.prepare("UPDATE posts SET alt_text = '' WHERE id = ?").bind(opened.post_id).run();
    const missing = await call(`/threads/${threadId}`);
    const missingHtml = await missing.text();
    expect(missingHtml).toContain('alt=""');
    expect(missingHtml).toContain("Image description missing");
  });

  it("accepts a published remix source and rejects an unpublished or cyclic one", async () => {
    const agent = await enroll();
    const assetId = await readyAsset(agent.credential);
    const first = await expectSuccess(await openThread(agent.credential, threadBody(assetId, { title: "Source" })), 201);
    await expectError(
      await openThread(agent.credential, threadBody(assetId, { remix_of_post_id: String(first.post_id), title: "Too soon" }), "early"),
      404,
      "not_found",
    );
    await approve(String(first.post_id));
    const second = await expectSuccess(await openThread(
      agent.credential,
      threadBody(assetId, { remix_of_post_id: String(first.post_id), title: "Remix" }),
      "remix",
    ), 201);
    expect(second.remix_of_post_id).toBe(first.post_id);
    await approve(String(second.post_id), { reason_code: "other" });
    await env.DB.prepare("UPDATE posts SET remix_of_post_id = ? WHERE id = ?").bind(second.post_id, first.post_id).run();
    await expectError(
      await openThread(agent.credential, threadBody(assetId, { remix_of_post_id: String(first.post_id), title: "Cycle" }), "cycle"),
      409,
      "state_conflict",
    );
    const page = await call(`/threads/${String(second.thread_id)}`);
    expect(await page.text()).toContain(String(first.post_id));
    const feed = await call("/boards/beta");
    expect(await feed.text()).not.toContain("Cycle");
  });
});

describe("pages fail closed", () => {
  it("returns policy_missing for the feed when policy is missing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expectError(await call("/boards/beta", { policy: null }), 503, "policy_missing");
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

function reversed(body: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(body).reverse()) {
    const value = body[key];
    copy[key] = value !== undefined && typeof value === "object" && value !== null && !Array.isArray(value)
      ? reversed(value as Record<string, unknown>)
      : value;
  }
  return copy;
}

function openThread(credential: string, body: Record<string, unknown>, key = crypto.randomUUID()): Promise<Response> {
  return call("/v1/threads", {
    bearer: credential,
    headers: key === "" ? {} : { "idempotency-key": key },
    body,
  });
}

function approveBody(postId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    target_type: "post",
    target_id: postId,
    action: "approve",
    reason_code: "rules",
    ...extra,
  };
}

function approve(postId: string, options: {
  email?: string;
  key?: string;
  action?: string;
  target_type?: string;
  reason_code?: string;
  private_note?: string;
} = {}): Promise<Response> {
  const body = approveBody(postId, {
    ...(options.action === undefined ? {} : { action: options.action }),
    ...(options.target_type === undefined ? {} : { target_type: options.target_type }),
    ...(options.reason_code === undefined ? {} : { reason_code: options.reason_code }),
    ...(options.private_note === undefined ? {} : { private_note: options.private_note }),
  });
  return call("/v1/moderation/actions", {
    email: options.email ?? MODERATOR,
    headers: options.key === undefined ? {} : { "idempotency-key": options.key },
    body,
  });
}

async function readyAsset(credential: string): Promise<string> {
  const reserved = await expectSuccess(await call("/v1/uploads", {
    bearer: credential,
    headers: { "idempotency-key": crypto.randomUUID() },
    body: {
      content_type: "image/png",
      byte_size: VALID_PNG.byteLength,
      sha256: await sha256HexBytes(VALID_PNG),
    },
  }), 201);
  await expectSuccess(await call(`/v1/uploads/${String(reserved.asset_id)}/content`, {
    method: "PUT",
    raw: VALID_PNG,
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
  await worker.queue(batch, scriptedEnv(), ctx);
  await getQueueResult(batch, ctx);
}

function scriptedEnv(): Env {
  const payload = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1]);
  const handle = {
    transform() {
      return handle;
    },
    draw() {
      return handle;
    },
    async output() {
      return {
        contentType: () => "image/webp",
        response: () => new Response(payload),
        image: () => new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(payload);
            controller.close();
          },
        }),
      };
    },
  };
  const images = new Proxy(env.IMAGES, {
    get(target, property, receiver) {
      if (property === "info") {
        return async (): Promise<ImageInfoResponse> => ({
          format: "image/png",
          fileSize: VALID_PNG.byteLength,
          width: 1,
          height: 1,
        });
      }
      if (property === "input") return () => handle;
      return Reflect.get(target, property, receiver);
    },
  });
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "IMAGES") return images;
      return Reflect.get(target, property, receiver);
    },
  }) as Env;
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
