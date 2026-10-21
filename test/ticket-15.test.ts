import { applyD1Migrations, createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { decodeCursor, encodeCursor } from "../src/browse";
import { VALID_PNG } from "./fixtures/bytes";
import { BOARD_ID, MODERATOR, OPERATOR, UUID_V7, call, releaseThread, resetAndSeed } from "./harness";

const HELD_CURSOR = encodeCursor("2026-01-01T00:00:00Z", "01900000-0000-7000-8000-000000000099");

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);
afterEach(() => {
  vi.restoreAllMocks();
});

describe("accessible pages", () => {
  it("moves through the feed, thread, profile, report, and moderation with the keyboard", async () => {
    const ada = await enroll("Ada");
    const assetId = await readyAsset(ada.credential);
    const opened = await expectSuccess(await call("/v1/threads", {
      bearer: ada.credential,
      headers: { "idempotency-key": "pages-square" },
      body: threadBody(assetId, { title: "Square", caption: "owner caption" }),
    }), 201);
    const threadId = String(opened.thread_id);
    const postId = String(opened.post_id);
    await expectSuccess(await act(postId, "approve"));
    const replied = await expectSuccess(await call(`/v1/threads/${threadId}/posts`, {
      bearer: ada.credential,
      headers: { "idempotency-key": "pages-reply" },
      body: { text: "plain reply" },
    }), 201);
    const replyId = String(replied.post_id);
    await expectSuccess(await act(replyId, "approve"));
    await releaseThread(ada.credential);
    const held = await expectSuccess(await call("/v1/threads", {
      bearer: ada.credential,
      headers: { "idempotency-key": "pages-held" },
      body: threadBody(assetId, { title: "Held", caption: "still waiting" }),
    }), 201);

    const feed = await call("/boards/beta");
    const feedHtml = await feed.text();
    expect(feed.status).toBe(200);
    expect(feed.headers.get("content-security-policy")).toContain("script-src 'none'");
    expect(keyboardShell(feedHtml)).toBe(true);
    expect(feedHtml).toContain("Square");
    expect(feedHtml).toContain('alt="A square"');
    expect(feedHtml).not.toContain("Held");
    expect(feedHtml).not.toContain("<script");

    const threadHtml = await page(`/threads/${threadId}`);
    expect(keyboardShell(threadHtml)).toBe(true);
    expect(threadHtml).toContain('alt="A square"');
    expect(threadHtml).toContain("owner caption");
    expect(threadHtml).toContain("plain reply");
    expect(threadHtml).toContain(`<a href="/agents/${ada.agentId}">Ada</a>`);
    expect(threadHtml).toContain(`href="/reports?target_type=post&amp;target_id=${postId}"`);
    expect(threadHtml).toContain(`href="/reports?target_type=post&amp;target_id=${replyId}"`);
    expect(threadHtml).toContain(`href="/reports?target_type=thread&amp;target_id=${threadId}"`);
    expect(threadHtml).toContain('href="/boards/beta"');
    expect(threadHtml.match(/<img /g)).toHaveLength(1);

    await env.DB.prepare("UPDATE posts SET alt_text = '' WHERE id = ?").bind(postId).run();
    const missingHtml = await page(`/threads/${threadId}`);
    expect(missingHtml).toContain('alt=""');
    expect(missingHtml).toContain("Image description missing");
    expect(missingHtml).toContain("plain reply");

    const profileHtml = await page(`/agents/${ada.agentId}`);
    expect(keyboardShell(profileHtml)).toBe(true);
    expect(profileHtml).toContain("Ada");
    expect(profileHtml).toContain("fixture-model");
    expect(profileHtml).toContain("owner caption");
    expect(profileHtml).toContain("plain reply");
    expect(profileHtml).toContain(`href="/reports?target_type=post&amp;target_id=${postId}"`);
    expect(profileHtml).toContain('href="/boards/beta"');

    const queue = await call("/moderation", { email: MODERATOR });
    const queueHtml = await queue.text();
    expect(queue.status).toBe(200);
    expect(keyboardShell(queueHtml)).toBe(true);
    expect(queueHtml).toContain("Held");
    expect(queueHtml).toContain(`<button type="submit">Approve</button>`);
    expect(queueHtml).toContain(`action="/v1/moderation/actions"`);
    expect(queueHtml).toContain("<p>Disengaged</p>");
    expect(queueHtml).toContain('href="/boards/beta"');
    expect(queueHtml).not.toContain("<script");
    expect(queueHtml.match(/<button type="submit">Approve<\/button>/g)).toHaveLength(1);
    await expectError(await call("/moderation"), 401, "access_required");
    await expectError(await call("/moderation", { bearer: ada.credential }), 403, "forbidden");

    const reportHtml = await page(`/reports?target_type=post&target_id=${postId}`);
    expect(keyboardShell(reportHtml)).toBe(true);
    expect(reportHtml).toContain('href="/boards/beta"');
    expect(reportHtml).toContain(`action="/v1/reports"`);
    expect(reportHtml).toContain(`for="target_type"`);
    expect(reportHtml).toContain(`for="reason_code"`);
    expect(reportHtml).toContain(`for="detail"`);
    expect(reportHtml).toContain(`<button type="submit">Report</button>`);
    expect(reportHtml).toContain(`value="${postId}"`);
    expect(String(held.thread_id)).toMatch(UUID_V7);
  });

  it("pages the feed, thread, and profile with the shared cursor", async () => {
    const ada = await enroll("Ada");
    const assetId = await readyAsset(ada.credential);
    const older = await publishThread(ada.credential, assetId, "Older title", "older caption", "pages-older");
    await releaseThread(ada.credential);
    const newer = await publishThread(ada.credential, assetId, "Newer title", "newer caption", "pages-newer");
    await env.DB.prepare("UPDATE posts SET created_at = ? WHERE id = ?").bind("2026-01-01T00:00:01Z", older.postId).run();
    await env.DB.prepare("UPDATE posts SET created_at = ? WHERE id = ?").bind("2026-01-01T00:00:02Z", newer.postId).run();

    const feed = await page("/boards/beta");
    expect(feed).toContain("Older title");
    expect(feed).toContain("Newer title");
    expect(nextHref(feed, "Feed")).toBeNull();
    const wide = await page("/boards/beta?limit=101");
    expect(wide).toContain("Older title");
    expect(wide).toContain("Newer title");
    expect(nextHref(wide, "Feed")).toBeNull();
    await expectError(await call("/boards/beta?limit=0"), 400, "malformed");
    await expectError(await call("/boards/beta?cursor=not-a-cursor"), 400, "malformed");
    await expectError(await call(`/threads/${older.threadId}?limit=0`), 400, "malformed");
    await expectError(await call(`/agents/${ada.agentId}?cursor=not-a-cursor`), 400, "malformed");
    await expectError(await call("/moderation?limit=0", { email: MODERATOR }), 400, "malformed");

    const firstFeed = await page("/boards/beta?limit=1");
    expect(firstFeed).toContain("Newer title");
    expect(firstFeed).not.toContain("Older title");
    const feedNext = nextHref(firstFeed, "Feed");
    expect(feedNext).toContain("limit=1");
    const secondFeed = await page(feedNext ?? "");
    expect(secondFeed).toContain("Older title");
    expect(secondFeed).not.toContain("Newer title");
    expect(nextHref(secondFeed, "Feed")).toBeNull();

    const firstProfile = await page(`/agents/${ada.agentId}?limit=1`);
    expect(firstProfile).toContain("newer caption");
    expect(firstProfile).not.toContain("older caption");
    const profileNext = nextHref(firstProfile, "Posts");
    expect(profileNext).toContain("limit=1");
    const secondProfile = await page(profileNext ?? "");
    expect(secondProfile).toContain("older caption");
    expect(secondProfile).not.toContain("newer caption");
    expect(nextHref(secondProfile, "Posts")).toBeNull();

    const replied = await expectSuccess(await call(`/v1/threads/${older.threadId}/posts`, {
      bearer: ada.credential,
      headers: { "idempotency-key": "pages-thread-reply" },
      body: { text: "later reply" },
    }), 201);
    await expectSuccess(await act(String(replied.post_id), "approve"));
    await env.DB.prepare("UPDATE posts SET created_at = ? WHERE id = ?").bind("2026-01-01T00:00:03Z", replied.post_id).run();
    const firstThread = await page(`/threads/${older.threadId}?limit=1`);
    expect(firstThread).toContain("older caption");
    expect(firstThread).not.toContain("later reply");
    const threadNext = nextHref(firstThread, "Posts");
    expect(threadNext).toContain("limit=1");
    const secondThread = await page(threadNext ?? "");
    expect(secondThread).toContain("later reply");
    expect(secondThread).not.toContain("older caption");
    expect(secondThread).toContain("Older title");
    expect(nextHref(secondThread, "Posts")).toBeNull();
  });

  it("pages reports at 25 and caps the page at 100", async () => {
    const ada = await enroll("Ada");
    for (let index = 0; index < 101; index += 1) {
      const detail = `report-${String(index).padStart(3, "0")}`;
      await expectSuccess(await call("/v1/reports", {
        email: OPERATOR,
        body: { target_type: "agent", target_id: ada.agentId, reason_code: "rules", detail },
      }), 201);
    }
    await env.DB.batch(Array.from({ length: 101 }, (_, index) => {
      const detail = `report-${String(index).padStart(3, "0")}`;
      const minute = String(Math.floor(index / 60)).padStart(2, "0");
      const second = String(index % 60).padStart(2, "0");
      return env.DB.prepare("UPDATE reports SET created_at = ? WHERE detail = ?").bind(
        `2026-01-01T00:${minute}:${second}Z`,
        detail,
      );
    }));

    const first = await page("/moderation", MODERATOR);
    expect(first.match(/<h3>Report<\/h3>/g)).toHaveLength(25);
    expect(first).toContain("report-000");
    expect(first).toContain("report-024");
    expect(first).not.toContain("report-025");
    const href = nextHref(first, "Reports");
    expect(href).toContain("limit=25");
    const cursor = new URL(`https://jchain.example.test${href}`).searchParams.get("reports_cursor");
    const oldest = await env.DB.prepare(
      "SELECT id, created_at FROM reports WHERE detail = ?",
    ).bind("report-024").first<{ id: string; created_at: string }>();
    expect(decodeCursor(cursor ?? "")).toEqual({ createdAt: oldest?.created_at, id: oldest?.id });
    const second = await page(href ?? "", MODERATOR);
    expect(second).toContain("report-025");
    expect(second).not.toContain("report-000");

    const kept = await page(`/moderation?limit=25&pending_cursor=${HELD_CURSOR}`, MODERATOR);
    const keptHref = nextHref(kept, "Reports") ?? "";
    const keptQuery = new URL(`https://jchain.example.test${keptHref}`).searchParams;
    expect(keptQuery.get("limit")).toBe("25");
    expect(keptQuery.get("pending_cursor")).toBe(HELD_CURSOR);
    expect(keptQuery.get("reports_cursor")).not.toBeNull();

    const capped = await page("/moderation?limit=101", MODERATOR);
    expect(capped.match(/<h3>Report<\/h3>/g)).toHaveLength(100);
    expect(capped).toContain("report-000");
    expect(capped).toContain("report-099");
    expect(capped).not.toContain("report-100");
    const cappedHref = nextHref(capped, "Reports");
    expect(cappedHref).toContain("limit=100");
    const last = await page(cappedHref ?? "", MODERATOR);
    expect(last.match(/<h3>Report<\/h3>/g)).toHaveLength(1);
    expect(last).toContain("report-100");
    expect(nextHref(last, "Reports")).toBeNull();
  });
});

function keyboardShell(html: string): boolean {
  const skip = html.indexOf('<a href="#content">Skip to content</a>');
  const main = html.indexOf('<main id="content">');
  return skip >= 0 && main > skip && html.includes("</main>");
}

function nextHref(html: string, label: string): string | null {
  const found = html.match(new RegExp(`<nav aria-label="${label}"><a href="([^"]+)">Next</a></nav>`));
  return found?.[1]?.replaceAll("&amp;", "&") ?? null;
}

async function page(pathname: string, email?: string): Promise<string> {
  const response = await call(pathname, email === undefined ? {} : { email });
  expect(response.status).toBe(200);
  return response.text();
}

async function publishThread(
  credential: string,
  assetId: string,
  title: string,
  caption: string,
  key: string,
): Promise<{ threadId: string; postId: string }> {
  const opened = await expectSuccess(await call("/v1/threads", {
    bearer: credential,
    headers: { "idempotency-key": key },
    body: threadBody(assetId, { title, caption }),
  }), 201);
  const postId = String(opened.post_id);
  await expectSuccess(await act(postId, "approve"));
  return { threadId: String(opened.thread_id), postId };
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

function act(targetId: string, action: string): Promise<Response> {
  return call("/v1/moderation/actions", {
    email: MODERATOR,
    body: { target_type: "post", target_id: targetId, action, reason_code: "rules" },
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
