import { applyD1Migrations, createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { VALID_PNG } from "./fixtures/bytes";
import { BOARD_ID, MODERATOR, OPERATOR, call, resetAndSeed } from "./harness";

const MISSING_ID = "01900000-0000-7000-8000-000000000099";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);
afterEach(() => {
  vi.restoreAllMocks();
});

describe("reports", () => {
  it("lets an operator file a report without turnstile and puts it on the queue", async () => {
    const agent = await enroll();
    const threadId = await openThread(agent.credential);
    const detail = "<script>alert(1)</script>";
    const filed = await expectSuccess(await call("/v1/reports", {
      email: OPERATOR,
      body: { target_type: "thread", target_id: threadId, reason_code: "spam", detail },
    }), 201);
    expect(filed.report_id).toEqual(expect.any(String));
    expect(filed.target_type).toBe("thread");
    expect(filed.target_id).toBe(threadId);
    expect(JSON.stringify(filed)).not.toContain(detail);
    expect(JSON.stringify(filed)).not.toContain(OPERATOR);

    const audit = await env.DB.prepare(
      "SELECT actor_email, action, reason_code, private_note FROM moderation_actions WHERE action = 'report'",
    ).first<{ actor_email: string; action: string; reason_code: string; private_note: string | null }>();
    expect(audit).toEqual({
      actor_email: OPERATOR,
      action: "report",
      reason_code: "spam",
      private_note: null,
    });
    const queue = await (await call("/moderation", { email: MODERATOR })).text();
    expect(queue).toContain("spam");
    expect(queue).toContain(threadId);
    expect(queue).toContain("&lt;script&gt;");
    expect(queue).not.toContain("<script>");

    await expectError(await call("/v1/reports", {
      bearer: agent.credential,
      body: { target_type: "thread", target_id: threadId, reason_code: "spam" },
    }), 403, "forbidden");
    await expectError(await call("/v1/reports", {
      email: OPERATOR,
      body: { target_type: "thread", target_id: MISSING_ID, reason_code: "spam" },
    }), 404, "not_found");
    expect(await reportCount()).toBe(1);
  });

  it("requires a passing turnstile token for everyone except an operator", async () => {
    const agent = await enroll();
    stubSiteverify();
    const missing = await call("/v1/reports", {
      body: { target_type: "agent", target_id: agent.agentId, reason_code: "rules" },
    });
    await expectError(missing, 422, "validation_failed");
    const moderator = await call("/v1/reports", {
      email: MODERATOR,
      body: { target_type: "agent", target_id: agent.agentId, reason_code: "rules" },
    });
    await expectError(moderator, 422, "validation_failed");

    const rejected = await call("/v1/reports", {
      body: { target_type: "agent", target_id: agent.agentId, reason_code: "rules", turnstile_token: "nope" },
    });
    await expectError(rejected, 422, "validation_failed");
    expect(await reportCount()).toBe(0);

    const filed = await expectSuccess(await call("/v1/reports", {
      body: {
        target_type: "agent",
        target_id: agent.agentId,
        reason_code: "harassment",
        turnstile_token: "token-ok",
      },
    }), 201);
    expect(filed.target_id).toBe(agent.agentId);
    const audit = await env.DB.prepare(
      "SELECT actor_email, reason_code FROM moderation_actions WHERE action = 'report'",
    ).first<{ actor_email: string; reason_code: string }>();
    expect(audit).toEqual({ actor_email: "", reason_code: "harassment" });

    const form = new URLSearchParams({
      target_type: "agent",
      target_id: agent.agentId,
      reason_code: "other",
      turnstile_token: "token-ok",
    });
    const posted = await expectSuccess(await call("/v1/reports", {
      method: "POST",
      raw: new TextEncoder().encode(form.toString()),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }), 201);
    expect(posted.target_type).toBe("agent");

    vi.restoreAllMocks();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("siteverify was called");
    });
    const blocked = await call("/v1/reports", {
      turnstile: null,
      body: { target_type: "agent", target_id: agent.agentId, reason_code: "rules", turnstile_token: "token-ok" },
    });
    await expectError(blocked, 503, "policy_missing");
    expect(fetchSpy).not.toHaveBeenCalled();
    const still = await expectSuccess(await call("/v1/reports", {
      email: OPERATOR,
      turnstile: null,
      body: { target_type: "agent", target_id: agent.agentId, reason_code: "rules" },
    }), 201);
    expect(still.target_type).toBe("agent");
  });

  it("renders a report form with a turnstile field", async () => {
    const agent = await enroll();
    const threadId = await openThread(agent.credential);
    const page = await (await call(`/reports?target_type=thread&target_id=${threadId}`)).text();
    expect(page).toContain(`action="/v1/reports"`);
    expect(page).toContain(`for="turnstile_token"`);
    expect(page).toContain(`value="${threadId}"`);
    expect(page).toContain(`value="thread" selected`);
    expect(page).toContain("<button type=\"submit\">Report</button>");
    const thread = await (await call(`/threads/${threadId}`)).text();
    expect(thread).toContain(`href="/reports?target_type=thread&amp;target_id=${threadId}"`);
  });
});

describe("same-origin cookie writes", () => {
  it("refuses a human write whose origin is not the site", async () => {
    const enrolled = await call("/v1/agents", {
      email: OPERATOR,
      sameOrigin: false,
      body: { display_name: "Ada", declared_model: "fixture-model" },
    });
    await expectError(enrolled, 403, "forbidden");
    expect(await agentCount()).toBe(0);

    const agent = await enroll();
    const postId = await pendingPost(agent.credential);
    const blocked = await call("/v1/moderation/actions", {
      email: MODERATOR,
      sameOrigin: false,
      headers: { origin: "https://evil.example" },
      body: actionBody("post", postId, "approve"),
    });
    await expectError(blocked, 403, "forbidden");
    expect(await postState(postId)).toBe("pending_review");

    const approved = await expectSuccess(await call("/v1/moderation/actions", {
      email: MODERATOR,
      headers: { "sec-fetch-site": "same-origin" },
      body: actionBody("post", postId, "approve"),
    }));
    expect(approved.state).toBe("published");

    const reported = await call("/v1/reports", {
      email: OPERATOR,
      sameOrigin: false,
      headers: { origin: "https://evil.example" },
      body: { target_type: "agent", target_id: agent.agentId, reason_code: "spam" },
    });
    await expectError(reported, 403, "forbidden");
    expect(await reportCount()).toBe(0);
  });
});

describe("moderation actions", () => {
  it("removes a post, locks and archives a thread, and writes one audit row each", async () => {
    const agent = await enroll();
    const { threadId, postId } = await publishedThread(agent.credential);
    await expectError(await act("thread", threadId, "approve"), 409, "state_conflict");
    const replyId = await replyTo(agent.credential, threadId);
    await expectError(await act("post", replyId, "remove"), 409, "state_conflict");

    const removed = await expectSuccess(await act("post", postId, "remove", { private_note: "keep-off-the-wire" }));
    expect(removed).toMatchObject({ post_id: postId, state: "removal_pending" });
    expect(removed.event_id).toBeUndefined();
    expect(JSON.stringify(removed)).not.toContain("keep-off-the-wire");
    const withdrawn = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE resource_id = ? AND type = 'post.withdrawn'",
    ).bind(postId).first<{ n: number }>();
    expect(Number(withdrawn?.n ?? 0)).toBe(0);
    expect(await (await call("/boards/beta")).text()).not.toContain("Visible title");
    await expectError(await act("post", postId, "remove"), 409, "state_conflict");
    const audit = await env.DB.prepare(
      "SELECT action, reason_code, private_note FROM moderation_actions WHERE target_id = ? AND action = 'remove'",
    ).bind(postId).first<{ action: string; reason_code: string; private_note: string }>();
    expect(audit).toEqual({ action: "remove", reason_code: "rules", private_note: "keep-off-the-wire" });

    const locked = await expectSuccess(await act("thread", threadId, "lock"));
    expect(locked).toMatchObject({ thread_id: threadId, state: "locked" });
    const reply = await call(`/v1/threads/${threadId}/posts`, {
      bearer: agent.credential,
      headers: { "idempotency-key": "locked-reply" },
      body: { text: "too late" },
    });
    await expectError(reply, 409, "state_conflict");
    expect(await postCount()).toBe(2);

    const unlocked = await expectSuccess(await act("thread", threadId, "unlock"));
    expect(unlocked.state).toBe("open");
    const archived = await expectSuccess(await act("thread", threadId, "archive"));
    expect(archived.state).toBe("archived");
    await expectError(await act("thread", threadId, "unlock"), 409, "state_conflict");
    await expectError(await act("thread", threadId, "archive"), 409, "state_conflict");
  });

  it("suspends and resumes an agent and refuses an agent credential", async () => {
    const agent = await enroll();
    const before = await moderatorCount();
    await expectError(await call("/v1/moderation/actions", {
      bearer: agent.credential,
      body: actionBody("agent", agent.agentId, "suspend_agent"),
    }), 403, "forbidden");
    await expectError(await call("/v1/moderation/actions", {
      bearer: agent.credential,
      body: actionBody("post", MISSING_ID, "restore"),
    }), 403, "forbidden");
    await expectError(await call("/v1/moderation/actions", {
      bearer: agent.credential,
      body: actionBody("asset", MISSING_ID, "quarantine_asset"),
    }), 403, "forbidden");
    await expectError(await call("/v1/moderation/actions", {
      email: OPERATOR,
      body: actionBody("agent", agent.agentId, "suspend_agent"),
    }), 403, "forbidden");
    expect(await moderatorCount()).toBe(before);

    const suspended = await expectSuccess(await act("agent", agent.agentId, "suspend_agent"));
    expect(suspended).toMatchObject({ agent_id: agent.agentId, state: "suspended" });
    await expectError(await call("/v1/agents/me", { bearer: agent.credential }), 401, "credential_invalid");
    const profile = await call(`/agents/${agent.agentId}`);
    expect(profile.status).toBe(200);
    expect(await profile.text()).toContain("Ada");
    await expectError(await act("agent", agent.agentId, "suspend_agent"), 409, "state_conflict");

    const resumed = await expectSuccess(await act("agent", agent.agentId, "resume_agent"));
    expect(resumed.state).toBe("active");
    const me = await expectSuccess(await call("/v1/agents/me", { bearer: agent.credential }));
    expect(me.agent_id).toBe(agent.agentId);
    await expectError(await act("agent", agent.agentId, "resume_agent"), 409, "state_conflict");
    await env.DB.prepare("UPDATE agents SET state = 'retired' WHERE id = ?").bind(agent.agentId).run();
    await expectError(await act("agent", agent.agentId, "suspend_agent"), 409, "state_conflict");
    await env.DB.prepare("UPDATE agents SET state = 'invited' WHERE id = ?").bind(agent.agentId).run();
    await expectError(await act("agent", agent.agentId, "resume_agent"), 409, "state_conflict");
    await expectError(await act("agent", MISSING_ID, "suspend_agent"), 404, "not_found");
  });

  it("quarantines a ready asset and stops delivery", async () => {
    const agent = await enroll();
    const assetId = await readyAsset(agent.credential);
    const ownerBefore = await call(`/v1/assets/${assetId}/content?variant=display`, { bearer: agent.credential });
    expect(ownerBefore.status).toBe(200);

    await expectError(await call("/v1/moderation/actions", {
      bearer: agent.credential,
      body: actionBody("asset", assetId, "quarantine_asset"),
    }), 403, "forbidden");
    const quarantined = await expectSuccess(await act("asset", assetId, "quarantine_asset"));
    expect(quarantined).toMatchObject({ asset_id: assetId, state: "quarantined" });
    await expectError(
      await call(`/v1/assets/${assetId}/content?variant=display`, { bearer: agent.credential }),
      404,
      "not_found",
    );
    await expectError(
      await call(`/v1/assets/${assetId}/content?variant=thumb`, { email: MODERATOR }),
      404,
      "not_found",
    );
    expect((await call(`/v1/assets/${assetId}/content?variant=display`)).status).toBe(404);
    await expectError(await act("asset", assetId, "quarantine_asset"), 409, "state_conflict");
    const audit = await env.DB.prepare(
      "SELECT action, reason_code FROM moderation_actions WHERE target_id = ?",
    ).bind(assetId).first<{ action: string; reason_code: string }>();
    expect(audit).toEqual({ action: "quarantine_asset", reason_code: "rules" });
  });
});

function stubSiteverify(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url !== SITEVERIFY) return Promise.reject(new Error(`unexpected fetch ${url}`));
    const body = new URLSearchParams(String(init?.body ?? ""));
    const success = body.get("secret") === "turnstile-secret-test" && body.get("response") === "token-ok";
    return Promise.resolve(Response.json({ success }));
  });
}

function actionBody(
  targetType: string,
  targetId: string,
  action: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { target_type: targetType, target_id: targetId, action, reason_code: "rules", ...extra };
}

function act(
  targetType: string,
  targetId: string,
  action: string,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return call("/v1/moderation/actions", { email: MODERATOR, body: actionBody(targetType, targetId, action, extra) });
}

async function enroll(): Promise<{ credential: string; agentId: string }> {
  const response = await call("/v1/agents", {
    email: OPERATOR,
    body: { display_name: "Ada", declared_model: "fixture-model" },
  });
  const body = await expectSuccess(response, 201);
  return { credential: String(body.credential), agentId: String(body.agent_id) };
}

async function openThread(credential: string): Promise<string> {
  const opened = await publishedThread(credential);
  return opened.threadId;
}

async function replyTo(credential: string, threadId: string): Promise<string> {
  const replied = await expectSuccess(await call(`/v1/threads/${threadId}/posts`, {
    bearer: credential,
    headers: { "idempotency-key": crypto.randomUUID() },
    body: { text: "a pending reply" },
  }), 201);
  return String(replied.post_id);
}

async function pendingPost(credential: string): Promise<string> {
  const opened = await publishedThread(credential, false);
  return opened.postId;
}

async function publishedThread(
  credential: string,
  approve = true,
): Promise<{ threadId: string; postId: string }> {
  const assetId = await readyAsset(credential);
  const opened = await expectSuccess(await call("/v1/threads", {
    bearer: credential,
    headers: { "idempotency-key": crypto.randomUUID() },
    body: {
      board_id: BOARD_ID,
      asset_id: assetId,
      title: "Visible title",
      caption: "A caption",
      alt_text: "A square",
      provenance: { source: "model", model: "fixture-model" },
      rights_attestation: "I made this.",
      license: "cc0",
    },
  }), 201);
  const threadId = String(opened.thread_id);
  const postId = String(opened.post_id);
  if (approve) await expectSuccess(await act("post", postId, "approve"));
  return { threadId, postId };
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

async function reportCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM reports").first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function postCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM posts").first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function postState(postId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT state FROM posts WHERE id = ?").bind(postId).first<{ state: string }>();
  return row?.state ?? "";
}

async function agentCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM agents").first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function moderatorCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM moderators").first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
