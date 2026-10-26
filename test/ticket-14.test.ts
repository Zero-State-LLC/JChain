import { applyD1Migrations, createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { VALID_WEBP } from "./fixtures/bytes";
import { runRetention } from "../src/retention";
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
    const header = await env.DB.prepare("SELECT document FROM exports").all<{ document: string }>();
    expect(header.results?.map((row) => JSON.parse(row.document))).toEqual([
      expect.objectContaining({ schema_version: 1, purpose: "archive" }),
    ]);
    expect(header.results?.every((row) => !row.document.includes("owner caption"))).toBe(true);
    const pieces = await env.DB.prepare("SELECT COUNT(*) AS n FROM export_posts").first<{ n: number }>();
    expect(pieces?.n).toBe(2);

    await expectSuccess(await act("post", postId, "hide"));
    // v0.2.31 (AT-07): hiding the Opening Post conceals its Thread's Replies from exports too,
    // both in a new export and when an earlier export is read again.
    const hidden = await readExport(await createExport("archive"));
    expect(hidden.posts).toEqual([]);
    expect(JSON.stringify(hidden)).not.toContain("owner caption");
    expect(JSON.stringify(hidden)).not.toContain("remix caption");
    expect(JSON.stringify(hidden)).not.toContain(NOTE);
    const firstId = String((await env.DB.prepare("SELECT id FROM exports ORDER BY id LIMIT 1").first<{ id: string }>())?.id);
    const reread = await readExport(firstId);
    expect(reread.posts).toEqual([]);
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
    // An owner deletion purges the Agent's stored export copies, not only their reads.
    expect(await exportRows(postId)).toBe(0);
    expect(JSON.stringify(await readExport(await firstExportId()))).not.toContain("removed caption");

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

  it("re-filters a stored export on read and purges a finished removal", async () => {
    const ada = await enroll("Ada");
    const assetId = await readyAsset(ada.credential);
    const opened = await expectSuccess(await call("/v1/threads", {
      bearer: ada.credential,
      headers: { "idempotency-key": "refilter-thread" },
      body: threadBody(assetId),
    }), 201);
    const threadId = String(opened.thread_id);
    await expectSuccess(await act("post", String(opened.post_id), "approve"));
    const keptReply = await expectSuccess(await call(`/v1/threads/${threadId}/posts`, {
      bearer: ada.credential,
      headers: { "idempotency-key": "refilter-kept" },
      body: { text: "kept reply words" },
    }), 201);
    await expectSuccess(await act("post", String(keptReply.post_id), "approve"));
    const heldReply = await expectSuccess(await call(`/v1/threads/${threadId}/posts`, {
      bearer: ada.credential,
      headers: { "idempotency-key": "refilter-held" },
      body: { text: "held reply words" },
    }), 201);
    const heldId = String(heldReply.post_id);
    await expectSuccess(await act("post", heldId, "approve"));
    const goneReply = await expectSuccess(await call(`/v1/threads/${threadId}/posts`, {
      bearer: ada.credential,
      headers: { "idempotency-key": "refilter-gone" },
      body: { text: "gone reply words" },
    }), 201);
    const goneId = String(goneReply.post_id);
    await expectSuccess(await act("post", goneId, "approve"));

    const exportId = String((await expectSuccess(await createExport("archive"), 201)).export_id);
    const before = JSON.stringify(await readExport(exportId));
    expect(before).toContain("held reply words");
    expect(before).toContain("gone reply words");
    expect(await exportRows(heldId)).toBe(1);
    expect(await exportRows(goneId)).toBe(1);

    // A legal hold (C-13 item 5) keeps a Post out of every export read, whatever its state.
    await env.DB.prepare("UPDATE posts SET legal_hold = 1, legal_hold_reason = 'csam' WHERE id = ?").bind(heldId).run();
    const held = JSON.stringify(await readExport(exportId));
    expect(held).not.toContain("held reply words");
    expect(held).toContain("kept reply words");
    expect(JSON.stringify(await readExport(await createExport("archive")))).not.toContain("held reply words");

    // A hide drops the Post from the stored export on read; a restore brings it back.
    await expectSuccess(await act("post", goneId, "hide"));
    expect(JSON.stringify(await readExport(exportId))).not.toContain("gone reply words");
    await expectSuccess(await act("post", goneId, "restore"));
    expect(JSON.stringify(await readExport(exportId))).toContain("gone reply words");

    // A removal is invisible at once, and its stored copies are deleted when the removal finishes.
    await expectSuccess(await act("post", goneId, "remove"));
    expect(JSON.stringify(await readExport(exportId))).not.toContain("gone reply words");
    await runRetention(env, Date.now());
    const gone = await env.DB.prepare("SELECT state FROM posts WHERE id = ?").bind(goneId).first<{ state: string }>();
    expect(gone?.state).toBe("removed");
    expect(await exportRows(goneId)).toBe(0);
    expect(await exportRows(String(keptReply.post_id))).toBeGreaterThan(0);
    const after = JSON.stringify(await readExport(exportId));
    expect(after).toContain("kept reply words");
    expect(after).not.toContain("gone reply words");
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

async function exportRows(postId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM export_posts WHERE json_extract(document, '$.post_id') = ?",
  ).bind(postId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function firstExportId(): Promise<string> {
  const row = await env.DB.prepare("SELECT id FROM exports ORDER BY id LIMIT 1").first<{ id: string }>();
  return String(row?.id);
}

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
  const sha256 = await sha256HexBytes(VALID_WEBP);
  const reserved = await expectSuccess(await call("/v1/uploads", {
    bearer: credential,
    headers: { "idempotency-key": crypto.randomUUID() },
    body: { content_type: "image/webp", byte_size: VALID_WEBP.byteLength, sha256 },
  }), 201);
  const assetId = String(reserved.asset_id);
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
  await worker.queue(batch, env, ctx);
  await getQueueResult(batch, ctx);
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
