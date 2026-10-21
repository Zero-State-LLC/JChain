import { applyD1Migrations, createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { VALID_PNG } from "./fixtures/bytes";
import { BOARD_ID, MODERATOR, OPERATOR, UUID_V7, call, resetAndSeed } from "./harness";

const MISSING_ID = "01900000-0000-7000-8000-000000000099";
const NOTE = "internal note stays private";
const POST_KEYS = [
  "alt_text",
  "asset_id",
  "author_agent_id",
  "caption",
  "created_at",
  "license",
  "post_id",
  "provenance",
  "remix_of_post_id",
  "rights_attestation",
  "thread_id",
  "title",
];

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);
afterEach(() => {
  vi.restoreAllMocks();
});

describe("export", () => {
  it("exports visible posts with provenance and leaves private notes out", async () => {
    const ada = await enroll("Ada");
    const assetId = await readyAsset(ada.credential);
    const opened = await expectSuccess(await call("/v1/threads", {
      bearer: ada.credential,
      headers: { "idempotency-key": "export-thread" },
      body: threadBody(assetId),
    }), 201);
    const threadId = String(opened.thread_id);
    const postId = String(opened.post_id);
    await expectSuccess(await act("post", postId, "approve", { private_note: NOTE }));
    const remix = await expectSuccess(await call(`/v1/threads/${threadId}/posts`, {
      bearer: ada.credential,
      headers: { "idempotency-key": "export-remix" },
      body: { text: "remix caption", remix_of_post_id: postId },
    }), 201);
    await expectSuccess(await act("post", String(remix.post_id), "approve"));
    await expectSuccess(await call(`/v1/threads/${threadId}/posts`, {
      bearer: ada.credential,
      headers: { "idempotency-key": "export-pending" },
      body: { text: "pending caption" },
    }), 201);
    const rejected = await expectSuccess(await call(`/v1/threads/${threadId}/posts`, {
      bearer: ada.credential,
      headers: { "idempotency-key": "export-rejected" },
      body: { text: "rejected caption" },
    }), 201);
    await expectSuccess(await act("post", String(rejected.post_id), "reject"));

    const archived = await readExport(await createExport("archive"));
    expect(Object.keys(archived).sort()).toEqual(["exported_at", "posts", "purpose", "request_id", "schema_version"]);
    expect(archived.schema_version).toBe(1);
    expect(archived.purpose).toBe("archive");
    const posts = archived.posts as Record<string, unknown>[];
    expect(posts.map((post) => post.caption).sort()).toEqual(["owner caption", "remix caption"]);
    for (const post of posts) expect(Object.keys(post).sort()).toEqual(POST_KEYS);
    const linked = posts.find((post) => post.caption === "remix caption");
    expect(linked?.remix_of_post_id).toBe(postId);
    const text = JSON.stringify(archived);
    expect(text).not.toContain(NOTE);
    expect(text).not.toContain("pending caption");
    expect(text).not.toContain("rejected caption");
    expect(text).not.toContain(ada.credential);
    expect(text).not.toContain("private_note");
    expect(text).not.toContain(MODERATOR);

    await expectSuccess(await act("post", postId, "hide"));
    const hidden = await readExport(await createExport("archive"));
    const hiddenPosts = hidden.posts as Record<string, unknown>[];
    expect(hiddenPosts.map((post) => post.caption)).toEqual(["remix caption"]);
    expect(hiddenPosts[0]?.remix_of_post_id).toBeNull();
    expect(JSON.stringify(hidden)).not.toContain("owner caption");
    expect(JSON.stringify(hidden)).not.toContain(NOTE);
  });

  it("hides a removed post and blocks training until the switch is on", async () => {
    await expectError(await createExport("training"), 403, "training_export_blocked");
    const ada = await enroll("Ada");
    const assetId = await readyAsset(ada.credential);
    const opened = await expectSuccess(await call("/v1/threads", {
      bearer: ada.credential,
      headers: { "idempotency-key": "remove-thread" },
      body: threadBody(assetId, { title: "Removed title", caption: "removed caption" }),
    }), 201);
    const postId = String(opened.post_id);
    await expectSuccess(await act("post", postId, "approve"));
    const published = await readExport(await createExport("archive"));
    expect(JSON.stringify(published)).toContain("removed caption");

    await expectSuccess(await act("post", postId, "remove"));
    const pending = await readExport(await createExport("archive"));
    expect(JSON.stringify(pending)).not.toContain("removed caption");

    await expectSuccess(await call("/v1/deletion-requests", {
      method: "POST",
      email: OPERATOR,
      body: { agent_id: ada.agentId },
    }));
    const removed = await readExport(await createExport("archive"));
    expect(JSON.stringify(removed.posts)).toBe("[]");

    const approved = await expectSuccess(await call("/v1/exports", {
      method: "POST",
      email: MODERATOR,
      policy: approvedPolicy(),
      body: { board_id: BOARD_ID, purpose: "training" },
    }), 201);
    const training = await readExport(String(approved.export_id), approvedPolicy());
    expect(training.purpose).toBe("training");
    expect(training.posts).toEqual([]);
  });

  it("allows only a moderator to create and read an export", async () => {
    const ada = await enroll("Ada");
    await expectError(await call("/v1/exports", {
      method: "POST",
      email: OPERATOR,
      body: { board_id: BOARD_ID, purpose: "archive" },
    }), 403, "forbidden");
    await expectError(await call("/v1/exports", {
      method: "POST",
      bearer: ada.credential,
      body: { board_id: BOARD_ID, purpose: "archive" },
    }), 403, "forbidden");
    await expectError(await call("/v1/exports", {
      method: "POST",
      email: MODERATOR,
      sameOrigin: false,
      body: { board_id: BOARD_ID, purpose: "archive" },
    }), 403, "forbidden");
    await expectError(await call("/v1/exports", {
      method: "POST",
      email: MODERATOR,
      body: { board_id: BOARD_ID },
    }), 400, "malformed");
    await expectError(await createExport("archive", MISSING_ID), 404, "not_found");
    await expectError(await call("/v1/exports", { method: "POST" }), 401, "access_required");
    const created = await expectSuccess(await createExport("archive"), 201);
    await expectError(await call(`/v1/exports/${String(created.export_id)}`, { email: OPERATOR }), 403, "forbidden");
    await expectError(await call(`/v1/exports/${String(created.export_id)}`, { bearer: ada.credential }), 403, "forbidden");
    await expectError(await call(`/v1/exports/${MISSING_ID}`, { email: MODERATOR }), 404, "not_found");
    await expectError(await call("/v1/exports/not-a-uuid", { email: MODERATOR }), 404, "not_found");
  });
});

function createExport(purpose: string, boardId = BOARD_ID): Promise<Response> {
  return call("/v1/exports", {
    method: "POST",
    email: MODERATOR,
    body: { board_id: boardId, purpose },
  });
}

async function readExport(created: Response | string, policy?: string): Promise<Record<string, unknown>> {
  const exportId = typeof created === "string"
    ? created
    : String((await expectSuccess(created, 201)).export_id);
  return expectSuccess(await call(`/v1/exports/${exportId}`, { email: MODERATOR, policy }));
}

function approvedPolicy(): string {
  const policy = JSON.parse(env.POLICY) as { training_export_approved: boolean };
  policy.training_export_approved = true;
  return JSON.stringify(policy);
}

function threadBody(assetId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    board_id: BOARD_ID,
    asset_id: assetId,
    title: "Owner title",
    caption: "owner caption",
    alt_text: "A square",
    provenance: { source: "model", model: "fixture-model" },
    rights_attestation: "I made this.",
    license: "cc0",
    ...extra,
  };
}

function act(
  targetType: string,
  targetId: string,
  action: string,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return call("/v1/moderation/actions", {
    email: MODERATOR,
    body: { target_type: targetType, target_id: targetId, action, reason_code: "rules", ...extra },
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
