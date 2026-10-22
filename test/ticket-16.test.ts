import { applyD1Migrations, createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { encodeCursor } from "../src/browse";
import { runReferenceClient } from "../src/reference-client";
import { VALID_PNG } from "./fixtures/bytes";
import { BOARD_ID, MODERATOR, OPERATOR, UUID_V7, call, resetAndSeed } from "./harness";

const MISSING_ID = "01900000-0000-7000-8000-000000000099";
const SENTINEL = "PROMPT-SENTINEL-do-not-log";
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);
afterEach(() => {
  vi.restoreAllMocks();
});

describe("beta readiness", () => {
  it("reads rules, uploads, publishes, replies, reacts, and consumes events", async () => {
    const ada = await enroll("Ada");
    const rules = await expectSuccess(await call(`/v1/boards/${BOARD_ID}/rules`, { bearer: ada.credential }));
    expect(rules.instructions).toContain("untrusted data");
    expect(rules.board_id).toBe(BOARD_ID);

    const assetId = await readyAsset(ada.credential);
    const opened = await expectSuccess(await call("/v1/threads", {
      bearer: ada.credential,
      headers: { "idempotency-key": "beta-thread" },
      body: threadBody(assetId, { title: "Beta title", caption: "owner caption" }),
    }), 201);
    const threadId = String(opened.thread_id);
    const postId = String(opened.post_id);
    const approved = await expectSuccess(await act(postId, "approve"));
    expect(String(approved.event_id)).toMatch(UUID_V7);

    const replied = await expectSuccess(await call(`/v1/threads/${threadId}/posts`, {
      bearer: ada.credential,
      headers: { "idempotency-key": "beta-reply" },
      body: { text: "plain reply" },
    }), 201);
    expect(String(replied.post_id)).toMatch(UUID_V7);

    const reaction = await expectSuccess(await call(`/v1/posts/${postId}/reactions/plus`, {
      method: "PUT",
      bearer: ada.credential,
      headers: { "idempotency-key": "beta-plus" },
    }), 201);
    expect(reaction.count).toBe(1);

    const events = await expectSuccess(await call("/v1/events", { bearer: ada.credential }));
    const items = events.items as Array<{ resource_id?: string; type?: string }>;
    expect(items).toContainEqual(expect.objectContaining({ type: "post.published", resource_id: postId }));

    const consumed = await runReferenceClient(
      (pathname, options) => call(pathname, options),
      ada.credential,
    );
    expect(consumed.quoted).toContainEqual({ caption: "owner caption", alt_text: "A square" });
    expect(consumed.replies.length).toBeGreaterThan(0);
    expect(JSON.stringify(consumed)).not.toContain(ada.credential);
  });

  it("logs request class and shows queue gauges without tokens or prompts", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    const ada = await enroll("Ada");
    const assetId = await readyAsset(ada.credential);
    await expectSuccess(await call("/v1/threads", {
      bearer: ada.credential,
      headers: { "idempotency-key": "gauge-thread", "x-run-id": "west-run" },
      body: threadBody(assetId, { title: "Held", caption: "still waiting" }),
    }), 201);
    const limited = await call("/v1/threads", {
      bearer: ada.credential,
      headers: { "idempotency-key": "gauge-limited" },
      body: threadBody(assetId, { title: "Too many", caption: SENTINEL }),
    });
    await expectError(limited, 429, "rate_limited");
    const invalid = await call("/v1/threads", {
      bearer: ada.credential,
      headers: { "idempotency-key": "gauge-invalid", "x-run-id": "run-\u007f" },
      body: { caption: SENTINEL },
    });
    await expectError(invalid, 400, "malformed");
    const missing = await call("/v1/boards?cursor=kept-out", {
      bearer: "jc_not-a-secret",
      headers: { "x-run-id": "west-run" },
    });
    await expectError(missing, 401, "credential_invalid");

    const text = logs.join("\n");
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain("jc_not-a-secret");
    expect(text).not.toContain(ada.credential);
    expect(text).not.toContain("run-\u007f");
    expect(text).not.toContain("cursor=kept-out");
    const requestLines = logs.map(parseLog).filter((entry) => entry?.message === "request");
    expect(requestLines).toContainEqual(expect.objectContaining({
      message: "request",
      run_id: "west-run",
      path: "/v1/threads",
      status: 201,
    }));
    expect(requestLines.some((entry) => entry?.error_code === "rate_limited" && entry.path === "/v1/threads")).toBe(true);
    expect(requestLines.some((entry) => entry?.error_code === "credential_invalid" && entry.path === "/v1/boards")).toBe(true);
    expect(requestLines.every((entry) => typeof entry?.latency_ms === "number")).toBe(true);

    const queue = await (await call("/moderation", { email: MODERATOR })).text();
    expect(queue).toContain("<h2>Metrics</h2>");
    expect(queue).toMatch(/Queue depth: [1-9]/);
    expect(queue).toMatch(/Oldest pending age: \d+ seconds/);
    expect(queue).toContain("Upload queue depth: 0");
    expect(queue).toMatch(/Storage bytes: [1-9]/);
    expect(queue).toContain("Deletion backlog: 0");
  });

  it("records the load receipt without claiming the 50-agent target", async () => {
    const agents: Array<{ agentId: string; credential: string }> = [];
    for (let index = 0; index < 20; index += 1) {
      agents.push(await enroll(`Agent ${index}`));
    }
    await expectSuccess(await call("/v1/agents", {
      email: OPERATOR,
      body: { display_name: "Agent 20", declared_model: "fixture-model" },
    }), 201);

    const ada = agents[0];
    if (ada === undefined) throw new Error("no agent");
    const samples: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const started = performance.now();
      expect((await call("/v1/boards", { bearer: ada.credential })).status).toBe(200);
      samples.push(performance.now() - started);
    }
    const burstStarted = performance.now();
    const burst = await Promise.all(Array.from({ length: 10 }, () => call("/v1/boards", { bearer: ada.credential })));
    const burstMs = performance.now() - burstStarted;
    expect(burst.every((response) => response.status === 200)).toBe(true);

    const pendingAsset = await uploadedAsset(ada.credential);
    const readyStarted = performance.now();
    await settle(pendingAsset);
    const readyMs = performance.now() - readyStarted;
    const status = await expectSuccess(await call(`/v1/assets/${pendingAsset}/status`, { bearer: ada.credential }));
    expect(status.state).toBe("ready");
    const publishStarted = performance.now();
    await expectSuccess(await call("/v1/threads", {
      bearer: ada.credential,
      headers: { "idempotency-key": "load-thread" },
      body: threadBody(pendingAsset),
    }), 201);
    const publishAckMs = performance.now() - publishStarted;

    const readP95 = percentile95(samples);
    const requestsPerSecond = burstMs <= 0 ? 0 : (10 * 1000) / burstMs;
    const readyWithin60s = readyMs < 60_000;
    const loadMatches = agents.length >= 50 && requestsPerSecond >= 10;
    const receipt = {
      message: "at14 receipt",
      agents: agents.length,
      required_agents: 50,
      requests_per_second: requestsPerSecond,
      read_p95_ms: readP95,
      publish_ack_ms: publishAckMs,
      ready_ms: readyMs,
      ready_within_60s: readyWithin60s,
      nfr_01_achieved: loadMatches && readP95 < 1000 && publishAckMs < 2000,
      nfr_02_achieved: loadMatches && readyWithin60s,
    };
    console.log(JSON.stringify(receipt));
    expect(receipt.agents).toBe(20);
    expect(Number.isFinite(receipt.read_p95_ms)).toBe(true);
    expect(Number.isFinite(receipt.publish_ack_ms)).toBe(true);
    expect(Number.isFinite(receipt.requests_per_second)).toBe(true);
    expect(receipt.nfr_01_achieved).toBe(false);
    expect(receipt.nfr_02_achieved).toBe(false);
  });

  it("drills stuck uploads, lost events, credential compromise, an abusive agent, and the publishing stop", async () => {
    const ada = await enroll("Ada");
    const stuckStarted = performance.now();
    const stuck = await uploadedAsset(ada.credential);
    const waiting = await expectSuccess(await call(`/v1/assets/${stuck}/status`, { bearer: ada.credential }));
    expect(waiting.state).toBe("uploaded");
    await settle(stuck);
    const recovered = await expectSuccess(await call(`/v1/assets/${stuck}/status`, { bearer: ada.credential }));
    expect(recovered.state).toBe("ready");
    const stuckUploadMs = performance.now() - stuckStarted;
    const opened = await expectSuccess(await call("/v1/threads", {
      bearer: ada.credential,
      headers: { "idempotency-key": "drill-thread" },
      body: threadBody(stuck, { title: "Visible", caption: "visible caption" }),
    }), 201);
    const postId = String(opened.post_id);
    await expectSuccess(await act(postId, "approve"));

    const eventsStarted = performance.now();
    const expired = await call(`/v1/events?after=${encodeCursor("2000-01-01T00:00:00Z", MISSING_ID)}`, {
      bearer: ada.credential,
    });
    const expiredBody = await expired.json() as { error?: { code?: string }; resync?: unknown };
    expect(expired.status).toBe(410);
    expect(expiredBody.error?.code).toBe("cursor_expired");
    expect(typeof expiredBody.resync).toBe("string");
    const resumed = await expectSuccess(await call("/v1/events", { bearer: ada.credential }));
    const resumedItems = resumed.items as Array<{ resource_id?: string }>;
    expect(resumedItems.some((item) => item.resource_id === postId)).toBe(true);
    expect(JSON.stringify(resumedItems)).not.toContain("visible caption");
    const lostEventsMs = performance.now() - eventsStarted;

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    const credentialStarted = performance.now();
    const rotated = await expectSuccess(await call(`/v1/agents/${ada.agentId}/credentials`, {
      method: "POST",
      email: OPERATOR,
    }), 201);
    const next = String(rotated.credential);
    await expectError(await call("/v1/agents/me", { bearer: ada.credential }), 401, "credential_invalid");
    const me = await expectSuccess(await call("/v1/agents/me", { bearer: next }));
    expect(me.agent_id).toBe(ada.agentId);
    expect(logs.join("\n")).not.toContain(next);
    const credentialMs = performance.now() - credentialStarted;

    const abusiveStarted = performance.now();
    const suspended = await expectSuccess(await call(`/v1/agents/${ada.agentId}/suspend`, {
      method: "POST",
      email: OPERATOR,
    }));
    expect(suspended.state).toBe("suspended");
    await expectError(await call("/v1/agents/me", { bearer: next }), 401, "credential_invalid");
    const abusiveAgentMs = performance.now() - abusiveStarted;

    const bea = await enroll("Bea");
    const beaAsset = await readyAsset(bea.credential);
    const pending = await expectSuccess(await call("/v1/threads", {
      bearer: bea.credential,
      headers: { "idempotency-key": "drill-stop" },
      body: threadBody(beaAsset, { title: "Stopped", caption: "not yet" }),
    }), 201);
    const stopStarted = performance.now();
    await expectSuccess(await call("/v1/admin/publishing-stop", {
      method: "POST",
      email: MODERATOR,
      body: { engaged: true },
    }));
    await expectError(await act(String(pending.post_id), "approve"), 409, "state_conflict");
    expect((await call(`/threads/${pending.thread_id}`)).status).toBe(404);
    await expectSuccess(await call("/v1/admin/publishing-stop", {
      method: "POST",
      email: MODERATOR,
      body: { engaged: false },
    }));
    await expectSuccess(await act(String(pending.post_id), "approve"));
    expect(await (await call(`/threads/${pending.thread_id}`)).text()).toContain("Stopped");
    const publishingStopMs = performance.now() - stopStarted;

    const rtoMs = stuckUploadMs + lostEventsMs + credentialMs + abusiveAgentMs + publishingStopMs;
    const drill = {
      message: "restore drill",
      stuck_upload_ms: stuckUploadMs,
      lost_events_ms: lostEventsMs,
      credential_ms: credentialMs,
      abusive_agent_ms: abusiveAgentMs,
      publishing_stop_ms: publishingStopMs,
      rto_ms: rtoMs,
      rpo_hours: 24,
      backup_expiry_days: 30,
      nfr_04_achieved: rtoMs < FOUR_HOURS_MS,
    };
    console.log(JSON.stringify(drill));
    expect(drill.nfr_04_achieved).toBe(true);
    expect(drill.rto_ms).toBeLessThan(FOUR_HOURS_MS);
  });
});

function percentile95(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, index)] ?? 0;
}

function parseLog(line: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
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
  const assetId = await uploadedAsset(credential);
  await settle(assetId);
  return assetId;
}

async function uploadedAsset(credential: string): Promise<string> {
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
  const completed = await expectSuccess(await call(`/v1/uploads/${assetId}/complete`, {
    method: "POST",
    bearer: credential,
    headers: { "idempotency-key": crypto.randomUUID() },
  }), 202);
  expect(completed.state).toBe("uploaded");
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
