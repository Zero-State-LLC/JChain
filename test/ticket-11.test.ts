import { applyD1Migrations, createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { VALID_PNG } from "./fixtures/bytes";
import { BOARD_ID, MODERATOR, OPERATOR, call, releaseThread, resetAndSeed } from "./harness";

const MISSING_ID = "01900000-0000-7000-8000-000000000099";
const INVISIBLE = ["rejected", "hidden", "removal_pending", "removed"] as const;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);
afterEach(() => {
  vi.restoreAllMocks();
});

describe("remix links", () => {
  it("rejects a self-reference, an invisible source, and a cycle", async () => {
    const agent = await enroll();
    const assetId = await readyAsset(agent.credential);
    const source = await expectSuccess(await openThread(agent.credential, threadBody(assetId, {
      title: "Source",
      caption: "source words",
    }), "source"), 201);
    const sourceId = String(source.post_id);
    const blocked = await openThread(agent.credential, threadBody(assetId, {
      title: "Blocked",
      remix_of_post_id: sourceId,
    }), "pending-remix");
    expect((await expectError(blocked, 404, "not_found")).limits).toEqual(source.limits);
    expect(await titled("Blocked")).toBe(0);

    await expectSuccess(await act(sourceId, "approve"));
    for (const state of INVISIBLE) {
      await env.DB.prepare("UPDATE posts SET state = ? WHERE id = ?").bind(state, sourceId).run();
      const response = await openThread(agent.credential, threadBody(assetId, {
        title: "Blocked",
        remix_of_post_id: sourceId,
      }), `state-${state}`);
      expect((await expectError(response, 404, "not_found")).limits).toEqual(source.limits);
    }
    expect(await titled("Blocked")).toBe(0);
    await env.DB.prepare("UPDATE posts SET state = 'published' WHERE id = ?").bind(sourceId).run();

    const malformed = await openThread(agent.credential, threadBody(assetId, {
      title: "Blocked",
      remix_of_post_id: "not-a-post",
    }), "bad-id");
    await expectError(malformed, 400, "malformed");
    const unknown = await openThread(agent.credential, threadBody(assetId, {
      title: "Blocked",
      remix_of_post_id: MISSING_ID,
    }), "missing-source");
    await expectError(unknown, 404, "not_found");

    await env.DB.prepare("UPDATE posts SET remix_of_post_id = id WHERE id = ?").bind(sourceId).run();
    const self = await openThread(agent.credential, threadBody(assetId, {
      title: "Blocked",
      remix_of_post_id: sourceId,
    }), "self");
    await expectError(self, 409, "state_conflict");
    await env.DB.prepare("UPDATE posts SET remix_of_post_id = NULL WHERE id = ?").bind(sourceId).run();
    expect(await titled("Blocked")).toBe(0);
    expect(await eventRows()).toBe(1);

    await releaseThread(agent.credential);
    const mid = await expectSuccess(await openThread(agent.credential, threadBody(assetId, {
      title: "Mid",
      remix_of_post_id: sourceId,
    }), "mid"), 201);
    expect(mid.remix_of_post_id).toBe(sourceId);
    await expectSuccess(await act(String(mid.post_id), "approve"));
    await releaseThread(agent.credential);
    const tip = await expectSuccess(await openThread(agent.credential, threadBody(assetId, {
      title: "Tip",
      remix_of_post_id: String(mid.post_id),
    }), "tip"), 201);
    await expectSuccess(await act(String(tip.post_id), "approve"));
    await env.DB.prepare("UPDATE posts SET remix_of_post_id = ? WHERE id = ?").bind(tip.post_id, sourceId).run();
    const cycle = await openThread(agent.credential, threadBody(assetId, {
      title: "Cycle",
      remix_of_post_id: sourceId,
    }), "cycle");
    await expectError(cycle, 409, "state_conflict");
    expect(await titled("Cycle")).toBe(0);
    expect(await eventRows()).toBe(3);
  });

  it("shows the visible ancestry on the thread page and the post read", async () => {
    const agent = await enroll();
    const assetId = await readyAsset(agent.credential);
    const caption = "<script>remix</script>";
    const root = await expectSuccess(await openThread(agent.credential, threadBody(assetId, {
      title: "Root title",
      caption,
    }), "root"), 201);
    const rootId = String(root.post_id);
    const rootThread = String(root.thread_id);
    await expectSuccess(await act(rootId, "approve"));

    const reply = await expectSuccess(await call(`/v1/threads/${rootThread}/posts`, {
      bearer: agent.credential,
      headers: { "idempotency-key": "reply-remix" },
      body: { text: "noted reply words", remix_of_post_id: rootId },
    }), 201);
    const replyId = String(reply.post_id);
    await expectSuccess(await act(replyId, "approve"));

    await releaseThread(agent.credential);
    const link = await expectSuccess(await openThread(agent.credential, threadBody(assetId, {
      title: "Link title",
      caption: "link words",
      remix_of_post_id: rootId,
    }), "link"), 201);
    const linkId = String(link.post_id);
    const linkThread = String(link.thread_id);
    await expectSuccess(await act(linkId, "approve"));

    await releaseThread(agent.credential);
    const tip = await expectSuccess(await openThread(agent.credential, threadBody(assetId, {
      title: "Tip title",
      caption: "tip words",
      remix_of_post_id: linkId,
    }), "tip"), 201);
    const tipId = String(tip.post_id);
    const tipThread = String(tip.thread_id);
    await expectSuccess(await act(tipId, "approve"));

    const tipPosts = await listedPosts(agent.credential, tipThread);
    expect(tipPosts.map((item) => item.caption)).toEqual(["tip words"]);
    expect(tipPosts[0]?.remix_of_post_id).toBe(linkId);
    expect(tipPosts[0]?.ancestry).toEqual([
      { post_id: linkId, thread_id: linkThread },
      { post_id: rootId, thread_id: rootThread },
    ]);
    const linkPosts = await listedPosts(agent.credential, linkThread);
    expect(linkPosts[0]?.ancestry).toEqual([{ post_id: rootId, thread_id: rootThread }]);
    const rootPosts = await listedPosts(agent.credential, rootThread);
    const rootReply = rootPosts.find((item) => item.post_id === replyId);
    expect(rootReply?.ancestry).toEqual([{ post_id: rootId, thread_id: rootThread }]);
    expect(rootPosts.find((item) => item.post_id === rootId)?.ancestry).toEqual([]);
    const byAgent = await expectSuccess(await call(`/v1/agents/${agent.agentId}/posts`, { bearer: agent.credential }));
    const agentTip = (byAgent.items as Array<Record<string, unknown>>).find((item) => item.post_id === tipId);
    expect(agentTip?.ancestry).toEqual([
      { post_id: linkId, thread_id: linkThread },
      { post_id: rootId, thread_id: rootThread },
    ]);

    const page = await call(`/threads/${tipThread}`);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'none'");
    const html = await page.text();
    expect(html).toContain(`<a href="/threads/${linkThread}">link words</a> <code>${linkId}</code>`);
    expect(html).toContain(`<a href="/threads/${rootThread}">&lt;script&gt;remix&lt;/script&gt;</a> <code>${rootId}</code>`);
    expect(html).toContain("&lt;script&gt;remix&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    const feed = await (await call("/boards/beta")).text();
    expect(feed).not.toContain("&lt;script&gt;remix");
    expect(feed).not.toContain("<script>");

    await expectSuccess(await act(rootId, "hide"));
    const hiddenTip = await listedPosts(agent.credential, tipThread);
    expect(hiddenTip[0]?.remix_of_post_id).toBe(linkId);
    expect(hiddenTip[0]?.ancestry).toEqual([{ post_id: linkId, thread_id: linkThread }]);
    const hiddenLink = await listedPosts(agent.credential, linkThread);
    expect(hiddenLink[0]?.remix_of_post_id).toBeNull();
    expect(hiddenLink[0]?.ancestry).toEqual([]);
    const hiddenPage = await (await call(`/threads/${tipThread}`)).text();
    expect(hiddenPage).toContain(`<code>${linkId}</code>`);
    expect(hiddenPage).not.toContain(rootId);
    expect(hiddenPage).not.toContain("remix");
    expect(hiddenPage).not.toContain("<script>");
    const hiddenRoot = await call(`/threads/${rootThread}`);
    expect(hiddenRoot.status).toBe(200);
    expect(await hiddenRoot.text()).not.toContain("remix");

    await releaseThread(agent.credential);
    const again = await expectSuccess(await openThread(agent.credential, threadBody(assetId, {
      title: "After hide",
      remix_of_post_id: linkId,
    }), "after-hide"), 201);
    expect(again.remix_of_post_id).toBe(linkId);
    await expectSuccess(await act(String(again.post_id), "approve"));
    const after = await listedPosts(agent.credential, String(again.thread_id));
    expect(after[0]?.ancestry).toEqual([{ post_id: linkId, thread_id: linkThread }]);
    expect(JSON.stringify(after)).not.toContain(rootId);
    expect(JSON.stringify(after)).not.toContain(caption);
  });
});

function act(targetId: string, action: string): Promise<Response> {
  return call("/v1/moderation/actions", {
    email: MODERATOR,
    body: { target_type: "post", target_id: targetId, action, reason_code: "rules" },
  });
}

async function enroll(): Promise<{ credential: string; agentId: string }> {
  const response = await call("/v1/agents", {
    email: OPERATOR,
    body: { display_name: "Ada", declared_model: "fixture-model" },
  });
  const body = await expectSuccess(response, 201);
  return { credential: String(body.credential), agentId: String(body.agent_id) };
}

async function listedPosts(credential: string, threadId: string): Promise<Array<Record<string, unknown>>> {
  const body = await expectSuccess(await call(`/v1/threads/${threadId}/posts`, { bearer: credential }));
  return body.items as Array<Record<string, unknown>>;
}

async function titled(title: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE title = ?").bind(title).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function eventRows(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
  return Number(row?.n ?? 0);
}

function threadBody(assetId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    board_id: BOARD_ID,
    asset_id: assetId,
    title: "Visible title",
    caption: "A caption",
    alt_text: "A square",
    provenance: { source: "model", model: "fixture-model" },
    rights_attestation: "I made this.",
    license: "cc0",
    ...extra,
  };
}

function openThread(credential: string, body: Record<string, unknown>, key: string): Promise<Response> {
  return call("/v1/threads", {
    bearer: credential,
    headers: { "idempotency-key": key },
    body,
  });
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
    get(target, property) {
      if (property === "IMAGES") return images;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Env;
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function expectError(
  response: Response,
  status: number,
  code: string,
): Promise<{ limits?: unknown }> {
  const body = await response.json() as { error?: { code?: string }; limits?: unknown };
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(body.error?.code).toBe(code);
  return body;
}

async function expectSuccess(response: Response, status = 200): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body;
}
