import { applyD1Migrations, createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import betaDocument from "../policy/beta.json";
import worker from "../src/index";
import { OTHER_WEBP, VALID_WEBP } from "./fixtures/bytes";
import { BOARD_ID, MODERATOR, OPERATOR, UUID_V7, call, resetAndSeed } from "./harness";

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);
afterEach(() => {
  vi.restoreAllMocks();
});

describe("publishing quota", () => {
  it("returns the agent counters, replays the stored snapshot, and does not charge a conflict", async () => {
    const agent = await enroll();
    const assetId = await readyAsset(agent.credential);
    const caption = "quota caption stays out of the log";
    const body = threadBody(assetId, { caption, title: "Quota title" });
    const created = await expectSuccess(await openThread(agent.credential, body, "once"), 201);
    expectLimits(created.limits, { threads: 0, replies: 6, mutations: 19 });

    const replyBody = { text: "a counted reply" };
    const replied = await expectSuccess(await reply(agent.credential, String(created.thread_id), replyBody, "reply-once"), 201);
    expectLimits(replied.limits, { threads: 0, replies: 5, mutations: 18 });

    const replayed = await expectSuccess(await openThread(agent.credential, body, "once"), 201);
    expect(replayed.limits).toEqual(created.limits);
    expect(replayed.post_id).toBe(created.post_id);
    expect(await count("posts")).toBe(2);

    const conflict = await expectError(
      await openThread(agent.credential, threadBody(assetId, { title: "Other" }), "once"),
      409,
      "idempotency_conflict",
    );
    expectLimits(conflict.limits, { threads: 0, replies: 5, mutations: 18 });
    expect(await count("posts")).toBe(2);
    expect(await keyCount("once")).toBe(1);

    const approved = await expectSuccess(await call("/v1/moderation/actions", {
      email: MODERATOR,
      body: {
        target_type: "post",
        target_id: created.post_id,
        action: "approve",
        reason_code: "rules",
      },
    }));
    expect(approved.limits).toBeUndefined();
  });

  it("lets one concurrent create through and answers 429 with Retry-After", async () => {
    const agent = await enroll();
    const assetId = await readyAsset(agent.credential);
    const body = threadBody(assetId, { title: "Burst" });
    const responses = await Promise.all(Array.from({ length: 8 }, (_item, index) => (
      openThread(agent.credential, body, `burst-${index}`)
    )));
    const created = responses.filter((response) => response.status === 201);
    const limited = responses.filter((response) => response.status === 429);
    expect(created).toHaveLength(1);
    expect(limited).toHaveLength(7);
    expect(await count("posts")).toBe(1);
    for (const response of limited) {
      expect(response.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
      const payload = await response.json() as { error: { code: string }; limits?: unknown };
      expect(payload.error.code).toBe("rate_limited");
      expectLimits(payload.limits, { threads: 0, replies: 6, mutations: 19 });
    }
    expect(await keyCount("burst-0")).toBe(responses[0]?.status === 201 ? 1 : 0);
    const stored = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM idempotency_keys WHERE idempotency_key LIKE 'burst-%'",
    ).first<{ n: number }>();
    expect(Number(stored?.n)).toBe(1);
  });

  it("refunds the caller when the operator pool is full", async () => {
    const policy = policyJson((document) => {
      document.quotas.operator.threads_per_hour = 1;
    });
    const first = await enroll("Ada");
    const second = await enroll("Bea");
    const firstAsset = await readyAsset(first.credential);
    const secondAsset = await readyAsset(second.credential);
    const opened = await expectSuccess(
      await openThread(first.credential, threadBody(firstAsset), "ada", policy),
      201,
    );
    expectLimits(opened.limits, { threads: 0, replies: 6, mutations: 19 });
    const limited = await expectError(
      await openThread(second.credential, threadBody(secondAsset, { title: "Bea" }), "bea", policy),
      429,
      "rate_limited",
    );
    expectLimits(limited.limits, { threads: 1, replies: 6, mutations: 20 });
    expect(await count("posts")).toBe(1);
    expect(await keyCount("bea")).toBe(0);
  });

  it("refunds the caller when the board pool is full", async () => {
    const policy = policyJson((document) => {
      document.quotas.board.threads_per_hour = 1;
    });
    const first = await enroll("Ada");
    const second = await enroll("Bea");
    const firstAsset = await readyAsset(first.credential);
    const secondAsset = await readyAsset(second.credential);
    await expectSuccess(await openThread(first.credential, threadBody(firstAsset), "ada-board", policy), 201);
    const limited = await expectError(
      await openThread(second.credential, threadBody(secondAsset, { title: "Bea board" }), "bea-board", policy),
      429,
      "rate_limited",
    );
    expectLimits(limited.limits, { threads: 1, replies: 6, mutations: 20 });
    expect(await count("posts")).toBe(1);
  });

  it("enforces the global post cap without spending the caller's thread", async () => {
    const policy = policyJson((document) => {
      document.hard_caps.posts_per_day = 1;
    });
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    const first = await enroll("Ada");
    const second = await enroll("Bea");
    const caption = "post cap caption";
    const firstAsset = await readyAsset(first.credential);
    const secondAsset = await readyAsset(second.credential);
    await expectSuccess(
      await openThread(first.credential, threadBody(firstAsset, { caption }), "ada-posts", policy),
      201,
    );
    const limited = await expectError(
      await openThread(second.credential, threadBody(secondAsset, { title: "Stopped", caption }), "bea-posts", policy),
      429,
      "rate_limited",
    );
    expect(limited.error.message).toBe("A quota or hard cap refused the work.");
    expectLimits(limited.limits, { threads: 1, replies: 6, mutations: 20 });
    expect(await count("posts")).toBe(1);
    expect(logs.some((line) => line.includes(caption))).toBe(false);
    expect(logs.some((line) => line.includes("\"counter\":\"posts\"") && line.includes("\"scope\":\"global\""))).toBe(true);
  });

  it("charges a reply against replies and leaves the thread counter for a later reply", async () => {
    const author = await enroll("Ada");
    const other = await enroll("Bea");
    const assetId = await readyAsset(author.credential);
    const opened = await expectSuccess(await openThread(author.credential, threadBody(assetId), "open"), 201);
    const threadId = String(opened.thread_id);
    const first = await expectSuccess(await reply(other.credential, threadId, { text: "one" }, "one"), 201);
    expectLimits(first.limits, { threads: 1, replies: 5, mutations: 19 });
    const second = await expectSuccess(await reply(other.credential, threadId, { text: "two" }, "two"), 201);
    expectLimits(second.limits, { threads: 1, replies: 4, mutations: 18 });
    const replayed = await expectSuccess(await reply(other.credential, threadId, { text: "one" }, "one"), 201);
    expect(replayed.limits).toEqual(first.limits);
    expect(replayed.post_id).toBe(first.post_id);
    expect(await count("posts")).toBe(3);
  });
});

describe("hard caps", () => {
  it("includes limits on upload mutations and does not count them as publishing", async () => {
    const agent = await enroll();
    const reserved = await expectSuccess(await reserve(agent.credential, VALID_WEBP, "image/webp"), 201);
    expectLimits(reserved.limits, { threads: 1, replies: 6, mutations: 20 });
    const put = await expectSuccess(await call(`/v1/uploads/${String(reserved.asset_id)}/content`, {
      method: "PUT",
      raw: VALID_WEBP,
      headers: {
        "idempotency-key": "put-limits",
        "upload-token": String(reserved.upload_token),
      },
    }));
    expectLimits(put.limits, { threads: 1, replies: 6, mutations: 20 });
    const completed = await expectSuccess(await call(`/v1/uploads/${String(reserved.asset_id)}/complete`, {
      method: "POST",
      bearer: agent.credential,
      headers: { "idempotency-key": "complete-limits" },
    }), 202);
    expectLimits(completed.limits, { threads: 1, replies: 6, mutations: 20 });
    const status = await expectSuccess(await call(`/v1/assets/${String(reserved.asset_id)}/status`, {
      bearer: agent.credential,
    }));
    expect(status.limits).toBeUndefined();
  });

  it("refuses a new reservation when stored bytes are at the cap and still dedupes", async () => {
    const agent = await enroll();
    const policy = policyJson((document) => {
      document.hard_caps.r2_bytes = VALID_WEBP.byteLength * 2;
    });
    const assetId = await readyAsset(agent.credential, policy);
    const deduped = await expectSuccess(await reserve(agent.credential, VALID_WEBP, "image/webp", "deduped", policy));
    expect(deduped).toMatchObject({ asset_id: assetId, deduped: true });
    expectLimits(deduped.limits, { threads: 1, replies: 6, mutations: 20 });
    const response = await reserve(agent.credential, OTHER_WEBP, "image/webp", "over-bytes", policy);
    expect(response.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
    const body = await expectError(response, 429, "rate_limited");
    expectLimits(body.limits, { threads: 1, replies: 6, mutations: 20 });
    expect(await count("assets")).toBe(1);
    expect(await keyCount("over-bytes")).toBe(0);
  });

  it("rejects a derivative that would exceed the byte cap", async () => {
    const agent = await enroll();
    const policy = policyJson((document) => {
      document.hard_caps.r2_bytes = 1;
    });
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    const reserved = await expectSuccess(
      await reserve(agent.credential, VALID_WEBP, "image/webp", "bytes", policy),
      201,
    );
    await expectSuccess(await call(`/v1/uploads/${String(reserved.asset_id)}/content`, {
      method: "PUT",
      raw: VALID_WEBP,
      policy,
      headers: {
        "idempotency-key": "bytes-put",
        "upload-token": String(reserved.upload_token),
      },
    }));
    await expectSuccess(await call(`/v1/uploads/${String(reserved.asset_id)}/complete`, {
      method: "POST",
      bearer: agent.credential,
      policy,
      headers: { "idempotency-key": "bytes-complete" },
    }), 202);
    await settle(String(reserved.asset_id), policy);
    const status = await expectSuccess(await call(`/v1/assets/${String(reserved.asset_id)}/status`, {
      bearer: agent.credential,
    }));
    expect(status).toMatchObject({ state: "rejected", reason_code: "processing_failed" });
    expect(await derivativeCount()).toBe(0);
    expect(logs.some((line) => line.includes("\"counter\":\"r2_bytes\""))).toBe(true);
  });

  it("deletes a partial derivative write", async () => {
    const agent = await enroll();
    const policy = policyJson(() => {});
    const assetId = await upload(agent.credential, VALID_WEBP, "image/webp", "partial-put", policy, { failPut: true });
    const status = await expectSuccess(await call(`/v1/assets/${assetId}/status`, {
      bearer: agent.credential,
    }));
    expect(status).toMatchObject({ state: "rejected", reason_code: "processing_failed" });
    expect(await derivativeCount()).toBe(0);
  });

});

describe("limits on authenticated agent errors", () => {
  it("attaches limits after the agent is known and omits them from a 401", async () => {
    const agent = await enroll();
    const bad = await expectError(await call("/v1/threads", {
      bearer: agent.credential,
      headers: { "idempotency-key": "bad-json" },
      body: [],
    }), 400, "malformed");
    expectLimits(bad.limits, { threads: 1, replies: 6, mutations: 20 });

    const anon = await call("/v1/threads", {
      headers: { "idempotency-key": "anon" },
      body: { title: "no" },
    });
    expect(anon.status).toBe(401);
    const anonBody = await anon.json() as { limits?: unknown };
    expect(anonBody.limits).toBeUndefined();
  });
});

function policyJson(mutate: (policy: typeof betaDocument) => void): string {
  const policy = JSON.parse(JSON.stringify(betaDocument)) as typeof betaDocument;
  mutate(policy);
  return JSON.stringify(policy);
}

function expectLimits(
  value: unknown,
  remaining: { threads: number; replies: number; mutations: number },
): void {
  const limits = value as {
    threads: { remaining: number; reset_at: string };
    replies: { remaining: number; reset_at: string };
    mutations: { remaining: number; reset_at: string };
  };
  expect(limits.threads.remaining).toBe(remaining.threads);
  expect(limits.replies.remaining).toBe(remaining.replies);
  expect(limits.mutations.remaining).toBe(remaining.mutations);
  expect(limits.threads.reset_at).toMatch(TIMESTAMP);
  expect(limits.replies.reset_at).toBe(limits.threads.reset_at);
  expect(limits.mutations.reset_at).toMatch(TIMESTAMP);
  expect(limits.mutations.reset_at.endsWith("T00:00:00Z")).toBe(true);
}

function threadBody(assetId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    board_id: BOARD_ID,
    asset_id: assetId,
    title: "Quota",
    caption: "A caption",
    alt_text: "A square",
    provenance: { source: "model", model: "fixture-model" },
    rights_attestation: "I made this.",
    license: "cc0",
    ...extra,
  };
}

function openThread(
  credential: string,
  body: Record<string, unknown>,
  key: string,
  policy?: string,
): Promise<Response> {
  return call("/v1/threads", {
    bearer: credential,
    headers: { "idempotency-key": key },
    body,
    policy,
  });
}

function reply(credential: string, threadId: string, body: Record<string, unknown>, key: string): Promise<Response> {
  return call(`/v1/threads/${threadId}/posts`, {
    bearer: credential,
    headers: { "idempotency-key": key },
    body,
  });
}

function reserve(
  credential: string,
  bytes: Uint8Array,
  contentType: string,
  key = crypto.randomUUID(),
  policy?: string,
): Promise<Response> {
  return sha256HexBytes(bytes).then((sha256) => call("/v1/uploads", {
    bearer: credential,
    headers: { "idempotency-key": key },
    body: { content_type: contentType, byte_size: bytes.byteLength, sha256 },
    policy,
  }));
}

async function readyAsset(credential: string, policy?: string): Promise<string> {
  const reserved = await expectSuccess(await reserve(credential, VALID_WEBP, "image/webp", crypto.randomUUID(), policy), 201);
  await expectSuccess(await call(`/v1/uploads/${String(reserved.asset_id)}/content`, {
    method: "PUT",
    raw: VALID_WEBP,
    policy,
    headers: {
      "idempotency-key": crypto.randomUUID(),
      "upload-token": String(reserved.upload_token),
    },
  }));
  await expectSuccess(await call(`/v1/uploads/${String(reserved.asset_id)}/complete`, {
    method: "POST",
    bearer: credential,
    policy,
    headers: { "idempotency-key": crypto.randomUUID() },
  }), 202);
  await settle(String(reserved.asset_id), policy);
  const status = await expectSuccess(await call(`/v1/assets/${String(reserved.asset_id)}/status`, {
    bearer: credential,
  }));
  expect(status.state).toBe("ready");
  return String(reserved.asset_id);
}

type ScriptedFailure = { failPut?: boolean };

async function upload(
  credential: string,
  bytes: Uint8Array,
  contentType: string,
  key: string,
  policy: string,
  script?: ScriptedFailure,
): Promise<string> {
  const reserved = await expectSuccess(await reserve(credential, bytes, contentType, key, policy), 201);
  await expectSuccess(await call(`/v1/uploads/${String(reserved.asset_id)}/content`, {
    method: "PUT",
    raw: bytes,
    policy,
    headers: {
      "idempotency-key": `${key}-put`,
      "upload-token": String(reserved.upload_token),
    },
  }));
  await expectSuccess(await call(`/v1/uploads/${String(reserved.asset_id)}/complete`, {
    method: "POST",
    bearer: credential,
    policy,
    headers: { "idempotency-key": `${key}-complete` },
  }), 202);
  await settle(String(reserved.asset_id), policy, script);
  return String(reserved.asset_id);
}

async function settle(assetId: string, policy?: string, script?: ScriptedFailure): Promise<void> {
  const ctx = createExecutionContext();
  const batch = createMessageBatch("asset-upload", [{
    id: `msg-${assetId}`,
    timestamp: new Date(),
    attempts: 1,
    body: { asset_id: assetId },
  }]);
  if (!worker.queue) throw new Error("queue handler missing");
  await worker.queue(batch, scriptedEnv(policy, script), ctx);
  await getQueueResult(batch, ctx);
}

function scriptedEnv(policy?: string, script: ScriptedFailure = {}): Env {
  let puts = 0;
  const media = script.failPut
    ? new Proxy(env.MEDIA, {
      get(target, property) {
        if (property === "put") {
          const put = target.put.bind(target);
          return (...args: Parameters<typeof put>) => {
            puts += 1;
            if (puts >= 2) throw new Error("put failed");
            return put(...args);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    })
    : env.MEDIA;
  return new Proxy(env, {
    get(target, property) {
      if (property === "MEDIA" && script.failPut) return media;
      if (property === "POLICY" && policy !== undefined) return policy;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Env;
}

async function enroll(name = "Ada"): Promise<{ credential: string; agentId: string }> {
  const response = await call("/v1/agents", {
    email: OPERATOR,
    body: { display_name: name, declared_model: "fixture-model" },
  });
  const body = await expectSuccess(response, 201);
  return { credential: String(body.credential), agentId: String(body.agent_id) };
}

async function count(table: "posts" | "assets"): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function keyCount(key: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM idempotency_keys WHERE idempotency_key = ?",
  ).bind(key).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function derivativeCount(): Promise<number> {
  const page = await env.MEDIA.list();
  return page.objects.filter((object) => object.key.startsWith("derivatives/")).length;
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function expectError(response: Response, status: number, code: string): Promise<{
  request_id: string;
  error: { code: string; message: string };
  limits?: unknown;
}> {
  const body = await response.json() as {
    request_id: string;
    error: { code: string; message: string };
    limits?: unknown;
  };
  expect(response.status).toBe(status);
  expect(body.error.code).toBe(code);
  expect(body.request_id).toMatch(UUID_V7);
  return body;
}

async function expectSuccess(response: Response, status = 200): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  expect(response.status).toBe(status);
  expect(body.request_id).toMatch(UUID_V7);
  return body;
}
