import { applyD1Migrations, createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { derivativeKey } from "../src/asset-pipeline";
import { VALID_PNG } from "./fixtures/bytes";
import { BOARD_ID, MODERATOR, OPERATOR, UUID_V7, call, resetAndSeed } from "./harness";

const MISSING_ID = "01900000-0000-7000-8000-000000000099";
const OTHER_ID = "01900000-0000-7000-8000-000000000011";
const OTHER = "other@example.test";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);
afterEach(() => {
  vi.restoreAllMocks();
});

describe("owner deletion", () => {
  it("stops serving bytes and leaves a moderator tombstone", async () => {
    const ada = await enroll("Ada");
    const bea = await enroll("Bea");
    const assetId = await readyAsset(ada.credential);
    const opened = await expectSuccess(await call("/v1/threads", {
      bearer: ada.credential,
      headers: { "idempotency-key": "owner-thread" },
      body: threadBody(assetId),
    }), 201);
    const threadId = String(opened.thread_id);
    const postId = String(opened.post_id);
    await expectSuccess(await act("post", postId, "approve"));
    const adaReply = await expectSuccess(await call(`/v1/threads/${threadId}/posts`, {
      bearer: ada.credential,
      headers: { "idempotency-key": "ada-reply" },
      body: { text: "ada reply" },
    }), 201);
    await expectSuccess(await act("post", String(adaReply.post_id), "approve"));
    const beaReply = await expectSuccess(await call(`/v1/threads/${threadId}/posts`, {
      bearer: bea.credential,
      headers: { "idempotency-key": "bea-reply" },
      body: { text: "bea reply" },
    }), 201);
    await expectSuccess(await act("post", String(beaReply.post_id), "approve"));
    expect((await call(`/v1/assets/${assetId}/content?variant=display`)).status).toBe(200);

    await env.DB.prepare("INSERT INTO operators (email, id) VALUES (?, ?)").bind(OTHER, OTHER_ID).run();
    await expectError(await remove(ada.agentId, OTHER), 403, "forbidden");
    await expectError(await remove(ada.agentId, MODERATOR), 403, "forbidden");
    await expectError(await call("/v1/deletion-requests", {
      method: "POST",
      bearer: ada.credential,
      body: { agent_id: ada.agentId },
    }), 403, "forbidden");
    await expectError(await call("/v1/deletion-requests", {
      method: "POST",
      email: OPERATOR,
      sameOrigin: false,
      body: { agent_id: ada.agentId },
    }), 403, "forbidden");
    expect((await call(`/v1/assets/${assetId}/content?variant=display`)).status).toBe(200);

    const deleted = await expectSuccess(await remove(ada.agentId, OPERATOR));
    expect(Object.keys(deleted).sort()).toEqual(["agent_id", "request_id"]);
    expect(deleted.agent_id).toBe(ada.agentId);
    expect(JSON.stringify(deleted)).not.toContain("owner caption");
    expect(JSON.stringify(deleted)).not.toContain(ada.credential);

    await expectError(await call(`/v1/assets/${assetId}/content?variant=display`), 404, "not_found");
    await expectError(await call(`/v1/assets/${assetId}/content?variant=thumb`, { bearer: ada.credential }), 404, "not_found");
    await expectError(await call(`/v1/assets/${assetId}/content?variant=display`, { email: MODERATOR }), 404, "not_found");
    expect(await env.MEDIA.get(derivativeKey(assetId, "display"))).toBeNull();
    expect(await env.MEDIA.get(derivativeKey(assetId, "thumb"))).toBeNull();

    const tombstone = await expectSuccess(await call(`/v1/threads/${threadId}`, { email: MODERATOR }));
    expect(Object.keys(tombstone).sort()).toEqual(["request_id", "state", "thread_id"]);
    expect(tombstone).toMatchObject({ thread_id: threadId, state: "removed" });
    expect(JSON.stringify(tombstone)).not.toContain("owner caption");
    expect(JSON.stringify(tombstone)).not.toContain("Owner title");
    await expectError(await call(`/v1/threads/${threadId}`, { bearer: ada.credential }), 404, "not_found");
    await expectError(await call(`/v1/threads/${threadId}`, { bearer: bea.credential }), 404, "not_found");
    await expectError(await call(`/v1/threads/${threadId}`, { email: OPERATOR }), 404, "not_found");

    const kept = await expectSuccess(await call(`/v1/threads/${threadId}/posts`, { email: MODERATOR }));
    expect(JSON.stringify(kept)).toContain("bea reply");
    expect(JSON.stringify(kept)).not.toContain("ada reply");
    expect(JSON.stringify(kept)).not.toContain("owner caption");
    await expectError(await call(`/v1/threads/${threadId}/posts`, { bearer: bea.credential }), 404, "not_found");

    const page = await call(`/threads/${threadId}`);
    expect(page.status).toBe(404);
    const html = await page.text();
    expect(html).not.toContain("owner caption");
    expect(html).not.toContain("bea reply");
    const feed = await (await call("/boards/beta")).text();
    expect(feed).not.toContain("Owner title");

    const events = await expectSuccess(await call("/v1/events", { bearer: ada.credential }));
    const items = events.items as { type: string; resource_id: string }[];
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "post.withdrawn", resource_id: postId }),
    ]));
    expect(JSON.stringify(events)).not.toContain("owner caption");

    await expectError(await remove(ada.agentId, OPERATOR), 409, "state_conflict");
    const policy = JSON.parse(env.POLICY) as { retention: { backup_expiry_days: number } };
    expect(policy.retention.backup_expiry_days).toBe(30);
  });

  it("rejects a caller who does not own a deletable agent", async () => {
    const ada = await enroll("Ada");
    await expectError(await remove(ada.agentId, OPERATOR), 409, "state_conflict");
    await expectError(await call("/v1/deletion-requests", {
      method: "POST",
      email: OPERATOR,
      body: {},
    }), 400, "malformed");
    await expectError(await remove(MISSING_ID, OPERATOR), 404, "not_found");
    await expectError(await remove("not-a-uuid", OPERATOR), 404, "not_found");
    await expectError(await call("/v1/deletion-requests", { method: "POST" }), 401, "access_required");
  });
});

function remove(agentId: string, email: string): Promise<Response> {
  return call("/v1/deletion-requests", { method: "POST", email, body: { agent_id: agentId } });
}

function threadBody(assetId: string): Record<string, unknown> {
  return {
    board_id: BOARD_ID,
    asset_id: assetId,
    title: "Owner title",
    caption: "owner caption",
    alt_text: "A square",
    provenance: { source: "model", model: "fixture-model" },
    rights_attestation: "I made this.",
    license: "cc0",
  };
}

function act(targetType: string, targetId: string, action: string): Promise<Response> {
  return call("/v1/moderation/actions", {
    email: MODERATOR,
    body: { target_type: targetType, target_id: targetId, action, reason_code: "rules" },
  });
}

async function enroll(name: string): Promise<{ agentId: string; credential: string }> {
  const response = await call("/v1/agents", {
    email: OPERATOR,
    body: { display_name: name, declared_model: "fixture-model" },
  });
  const body = await expectSuccess(response, 201);
  return { agentId: String(body.agent_id), credential: String(body.credential) };
}

async function readyAsset(credential: string): Promise<string> {
  const sha256 = await sha256HexBytes(VALID_PNG);
  const reserved = await expectSuccess(await call("/v1/uploads", {
    bearer: credential,
    headers: { "idempotency-key": crypto.randomUUID() },
    body: { content_type: "image/png", byte_size: VALID_PNG.byteLength, sha256 },
  }), 201);
  const assetId = String(reserved.asset_id);
  await expectSuccess(await call(`/v1/uploads/${assetId}/content`, {
    method: "PUT",
    raw: VALID_PNG,
    headers: { "idempotency-key": crypto.randomUUID(), "upload-token": String(reserved.upload_token) },
  }));
  await expectSuccess(await call(`/v1/uploads/${assetId}/complete`, {
    method: "POST",
    bearer: credential,
    headers: { "idempotency-key": crypto.randomUUID() },
  }), 202);
  await settle(assetId);
  return assetId;
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

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type ErrorBody = { request_id: string; error: { code: string; message: string } };
type SuccessBody = Record<string, unknown>;

async function expectError(response: Response, status: number, code: string): Promise<void> {
  const body = await response.json() as ErrorBody;
  expect(response.status).toBe(status);
  expect(body.error.code).toBe(code);
  expect(body.request_id).toMatch(UUID_V7);
}

async function expectSuccess(response: Response, status = 200): Promise<SuccessBody> {
  const body = await response.json() as SuccessBody;
  expect(response.status).toBe(status);
  expect(body.request_id).toMatch(UUID_V7);
  return body;
}
