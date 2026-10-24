import { applyD1Migrations, createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import betaDocument from "../policy/beta.json";
import { derivativeKey } from "../src/asset-pipeline";
import { encodeCursor } from "../src/browse";
import worker from "../src/index";
import { utcSeconds, uuidv7 } from "../src/ids";
import { claimAsset, releaseAsset } from "../src/quota";
import { readWebp } from "../src/webp";
import { ANIMATED_WEBP, OTHER_WEBP, SQUARE_THUMB_WEBP, VALID_PNG, VALID_WEBP } from "./fixtures/bytes";
import { BOARD_ID, OPERATOR, call, resetAndSeed } from "./harness";

// Round-2 audit findings 3 to 7 and 12 to 14 (storage and the event stream).

const BIG = 1_000_000_000_000_000;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);
afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /v1/events pages in commit order (finding 3, CT-08)", () => {
  it("delivers an Event committed late with an earlier timestamp", async () => {
    const agent = await enroll();
    const base = Date.now() - 60 * 60 * 1000;
    const first = await seedPublished(agent.agentId, utcSeconds(new Date(base + 10_000)));
    const second = await seedPublished(agent.agentId, utcSeconds(new Date(base + 20_000)));

    const page = await expectJson(await call("/v1/events?limit=1", { bearer: agent.credential }), 200);
    expect(ids(page)).toEqual([first.eventId]);
    const cursor = String(page.next_cursor);

    // A slower request stamped its Event before `first` and commits only now.
    const late = await seedPublished(agent.agentId, utcSeconds(new Date(base + 5_000)));

    const rest = await expectJson(await call(`/v1/events?limit=10&after=${cursor}`, { bearer: agent.credential }), 200);
    expect(ids(rest)).toEqual([second.eventId, late.eventId]);
    expect(rest.next_cursor).toBeNull();
  });

  it("recovers an Agent holding a cursor from before the change", async () => {
    const agent = await enroll();
    const base = Date.now() - 60 * 60 * 1000;
    const first = await seedPublished(agent.agentId, utcSeconds(new Date(base + 10_000)));
    const second = await seedPublished(agent.agentId, utcSeconds(new Date(base + 20_000)));
    const late = await seedPublished(agent.agentId, utcSeconds(new Date(base + 5_000)));

    // The old (occurred_at, id) cursor resumes without skipping; repeats are deduplicated on event_id.
    const legacy = encodeCursor(first.occurredAt, first.eventId);
    const resumed = await expectJson(await call(`/v1/events?limit=10&after=${legacy}`, { bearer: agent.credential }), 200);
    expect(ids(resumed)).toEqual(expect.arrayContaining([second.eventId, late.eventId]));

    // An old cursor past the retained window still answers cursor_expired with a resync that works.
    const expired = await call(`/v1/events?after=${encodeCursor("2000-01-01T00:00:00Z", first.eventId)}`, {
      bearer: agent.credential,
    });
    const expiredBody = await expired.json() as { error?: { code?: string }; resync?: string | null };
    expect(expired.status).toBe(410);
    expect(expiredBody.error?.code).toBe("cursor_expired");
    expect(typeof expiredBody.resync).toBe("string");
    const resynced = await expectJson(
      await call(`/v1/events?limit=10&after=${String(expiredBody.resync)}`, { bearer: agent.credential }),
      200,
    );
    expect(ids(resynced)).toEqual([second.eventId, late.eventId]);
  });

  it("answers cursor_expired when the cursor's position now holds another Event", async () => {
    const agent = await enroll();
    await seedPublished(agent.agentId, utcSeconds(new Date(Date.now() - 60_000)));
    const page = await expectJson(await call("/v1/events?limit=1", { bearer: agent.credential }), 200);
    expect(page.next_cursor).toBeNull();
    await seedPublished(agent.agentId, utcSeconds(new Date(Date.now() - 50_000)));
    const listed = await expectJson(await call("/v1/events?limit=1", { bearer: agent.credential }), 200);
    const cursor = String(listed.next_cursor);
    // Forge the same position with another id: the stream does not trust it.
    const decoded = atob(cursor.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(cursor.length / 4) * 4, "="));
    const forged = btoa(decoded.replace(/\|[^|]+$/, `|${uuidv7()}`)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const response = await call(`/v1/events?after=${forged}`, { bearer: agent.credential });
    expect(response.status).toBe(410);
    await expectError(await call("/v1/events?after=ZTJ8MHx4", { bearer: agent.credential }), 400, "malformed");
  });
});

describe("per-Agent upload bytes (findings 4 and 5)", () => {
  it("charges declared bytes at reserve time, counts a rejected upload, and stores no rejected bytes", async () => {
    const agent = await enroll();
    const policy = policyJson((document) => {
      document.quotas.agent.upload_bytes_per_day = ANIMATED_WEBP.byteLength + VALID_PNG.byteLength + VALID_WEBP.byteLength;
    });

    const animated = await expectJson(await reserve(agent.credential, ANIMATED_WEBP, policy), 201);
    await expectError(await put(String(animated.asset_id), String(animated.upload_token), ANIMATED_WEBP, policy), 422, "validation_failed");
    const spoofed = await expectJson(await reserve(agent.credential, VALID_PNG, policy), 201);
    await expectError(await put(String(spoofed.asset_id), String(spoofed.upload_token), VALID_PNG, policy), 422, "validation_failed");
    // Bytes refused at PUT time are never written to R2.
    expect(await objectCount()).toBe(0);
    expect(await status(String(animated.asset_id), agent.credential)).toMatchObject({ state: "rejected", reason_code: "animated" });
    expect(await status(String(spoofed.asset_id), agent.credential)).toMatchObject({ state: "rejected", reason_code: "signature_mismatch" });

    // A replay of a reservation charges nothing.
    await expectJson(await reserve(agent.credential, VALID_WEBP, policy, "kept"), 201);
    await expectJson(await reserve(agent.credential, VALID_WEBP, policy, "kept"), 201);

    // The rejected uploads still counted, so the window is now full.
    const over = await reserve(agent.credential, OTHER_WEBP, policy, "over");
    expect(over.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
    await expectError(over, 429, "rate_limited");
    expect(await count("SELECT COUNT(*) AS n FROM assets")).toBe(3);

    // Another Agent has its own window.
    const other = await enroll("Bea");
    await expectJson(await reserve(other.credential, OTHER_WEBP, policy, "theirs"), 201);
  });

  it("counts the declared thumbnail too", async () => {
    const agent = await enroll();
    const policy = policyJson((document) => {
      document.quotas.agent.upload_bytes_per_day = VALID_WEBP.byteLength + SQUARE_THUMB_WEBP.byteLength - 1;
    });
    const response = await call("/v1/uploads", {
      bearer: agent.credential,
      policy,
      headers: { "idempotency-key": "with-thumb" },
      body: {
        content_type: "image/webp",
        byte_size: VALID_WEBP.byteLength,
        sha256: await sha256HexBytes(VALID_WEBP),
        thumb: { byte_size: SQUARE_THUMB_WEBP.byteLength, sha256: await sha256HexBytes(SQUARE_THUMB_WEBP) },
      },
    });
    await expectError(response, 429, "rate_limited");
  });

  it("refuses a policy without the new key", async () => {
    const policy = policyJson((document) => {
      delete (document.quotas.agent as Partial<typeof document.quotas.agent>).upload_bytes_per_day;
    });
    await expectError(await call("/v1/boards", { email: OPERATOR, policy }), 503, "policy_missing");
  });
});

describe("review of PR #150", () => {
  it("keeps the event-poll counter when an upload is reserved", async () => {
    const agent = await enroll();
    const policy = policyJson((document) => {
      document.quotas.agent.events_per_minute = 1;
    });
    expect((await call("/v1/events", { bearer: agent.credential, policy })).status).toBe(200);
    await expectJson(await reserve(agent.credential, VALID_WEBP, policy), 201);
    expect((await call("/v1/events", { bearer: agent.credential, policy })).status).toBe(429);
  });

  it("refuses a submit whose Asset retention deleted after the ready check, and commits no Post", async () => {
    const agent = await enroll();
    const assetId = await uploaded(agent.credential, VALID_WEBP);
    await deliver(assetId, env, "ready");
    expect(await status(assetId, agent.credential)).toMatchObject({ state: "ready" });
    const racing = new Proxy(env, {
      get(target, property) {
        if (property === "DB") {
          return new Proxy(target.DB, {
            get(db, name) {
              if (name === "batch") {
                return async (statements: D1PreparedStatement[]) => {
                  await db.prepare("UPDATE assets SET state = 'deleted' WHERE id = ?").bind(assetId).run();
                  return db.batch(statements);
                };
              }
              const value = Reflect.get(db, name, db) as unknown;
              return typeof value === "function" ? value.bind(db) : value;
            },
          });
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Env;
    const response = await call("/v1/threads", {
      bearer: agent.credential,
      env: racing,
      headers: { "idempotency-key": "raced" },
      body: {
        board_id: BOARD_ID,
        asset_id: assetId,
        title: "Raced",
        caption: "caption",
        alt_text: "alt",
        provenance: { source: "model", model: "fixture-model" },
        rights_attestation: "I made this.",
        license: "cc0",
      },
    });
    await expectError(response, 409, "state_conflict");
    expect(await count("SELECT COUNT(*) AS n FROM posts")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM threads")).toBe(0);
    const asset = await env.DB.prepare("SELECT state FROM assets WHERE id = ?").bind(assetId).first<{ state: string }>();
    expect(asset?.state).toBe("deleted");
  });
});

describe("queue deliveries of one Asset (findings 6 and 7)", () => {
  it("lets one of two concurrent deliveries process the Asset and keeps its stored files", async () => {
    const agent = await enroll();
    const assetId = await uploaded(agent.credential, VALID_WEBP);
    const [one, two] = await Promise.all([deliver(assetId, env, "a"), deliver(assetId, env, "b")]);
    await settleRetries(assetId, [one, two]);

    expect(await status(assetId, agent.credential)).toMatchObject({ state: "ready" });
    expect(await env.MEDIA.head(derivativeKey(assetId, "display"))).not.toBeNull();
    expect(await env.MEDIA.head(derivativeKey(assetId, "thumb"))).not.toBeNull();
    expect(await r2Used()).toBe(VALID_WEBP.byteLength * 2);

    // A late duplicate after ready changes nothing and charges nothing.
    await deliver(assetId, env, "c");
    expect(await env.MEDIA.head(derivativeKey(assetId, "display"))).not.toBeNull();
    expect(await r2Used()).toBe(VALID_WEBP.byteLength * 2);
  });

  it("retries a delivery that finds the Asset claimed, and processes it once the claim ends", async () => {
    const agent = await enroll();
    const assetId = await uploaded(agent.credential, VALID_WEBP);
    const held = await claimAsset(env, assetId);
    expect(held).not.toBeNull();
    const busy = await deliver(assetId, env, "busy");
    expect(busy.retryMessages.map((message) => message.msgId)).toEqual([`msg-${assetId}-busy`]);
    expect(await status(assetId, agent.credential)).toMatchObject({ state: "uploaded" });
    expect(await r2Used()).toBe(0);
    await releaseAsset(env, assetId, Number(held));
    const done = await deliver(assetId, env, "after");
    expect(done.retryMessages).toEqual([]);
    expect(await status(assetId, agent.credential)).toMatchObject({ state: "ready" });
  });

  it("charges r2_bytes once when the ready write fails and the queue retries", async () => {
    const agent = await enroll();
    const assetId = await uploaded(agent.credential, VALID_WEBP);
    const failed = await deliver(assetId, failingReadyWrite(), "fail");
    expect(failed.retryMessages.map((message) => message.msgId)).toEqual([`msg-${assetId}-fail`]);
    expect(await status(assetId, agent.credential)).toMatchObject({ state: "validating" });
    expect(await r2Used()).toBe(VALID_WEBP.byteLength * 2);

    const retried = await deliver(assetId, env, "retry");
    expect(retried.retryMessages).toEqual([]);
    expect(await status(assetId, agent.credential)).toMatchObject({ state: "ready" });
    expect(await r2Used()).toBe(VALID_WEBP.byteLength * 2);
  });
});

describe("VP8 frame header (finding 12, CT-03)", () => {
  it("rejects a first partition that runs past the chunk, and keeps a consistent frame", async () => {
    expect(readWebp(SQUARE_THUMB_WEBP).ok).toBe(true);
    const broken = SQUARE_THUMB_WEBP.slice();
    const chunkSize = new DataView(broken.buffer).getUint32(16, true);
    const tag = (broken[20] ?? 0) | ((broken[21] ?? 0) << 8) | ((broken[22] ?? 0) << 16);
    const forged = (tag & 0x1f) | (chunkSize << 5);
    broken[20] = forged & 0xff;
    broken[21] = (forged >>> 8) & 0xff;
    broken[22] = (forged >>> 16) & 0xff;
    expect(readWebp(broken)).toEqual({ ok: false, reason: "invalid_image" });
    const empty = SQUARE_THUMB_WEBP.slice();
    empty[20] = (empty[20] ?? 0) & 0x1f;
    empty[21] = 0;
    empty[22] = 0;
    expect(readWebp(empty)).toEqual({ ok: false, reason: "invalid_image" });
  });
});

describe("admin HTML refusal (finding 13)", () => {
  it("answers a browser with no Access identity with 401 and the access_required message", async () => {
    const response = await call("/admin", { headers: { accept: "text/html" } });
    expect(response.status).toBe(401);
    const html = await response.text();
    expect(html).toContain("Access authentication is required.");
    expect(html).not.toContain("Policy is not available.");
  });
});

describe("Retry-After for a cap with no reset (finding 14)", () => {
  it("is 3600 seconds when stored bytes are at hard_caps.r2_bytes", async () => {
    const agent = await enroll();
    const policy = policyJson((document) => {
      document.hard_caps.r2_bytes = 10;
    });
    const seeded = await env.QUOTA.getByName("global").apply([
      { key: "r2_bytes", amount: 10, limit: 10, reset_at: null, counter: "r2_bytes" },
    ]);
    expect(seeded.ok).toBe(true);
    const response = await reserve(agent.credential, VALID_WEBP, policy, "capped");
    expect(response.headers.get("retry-after")).toBe("3600");
    await expectError(response, 429, "rate_limited");
  });
});

type QueueResult = Awaited<ReturnType<typeof getQueueResult>>;

async function deliver(assetId: string, bindings: Env, tag: string): Promise<QueueResult> {
  const ctx = createExecutionContext();
  const batch = createMessageBatch("asset-upload", [{
    id: `msg-${assetId}-${tag}`,
    timestamp: new Date(),
    attempts: 1,
    body: { asset_id: assetId },
  }]);
  if (!worker.queue) throw new Error("queue handler missing");
  await worker.queue(batch, bindings, ctx);
  return getQueueResult(batch, ctx);
}

// A delivery told to retry (it found the claim held) is redelivered, as the queue would.
async function settleRetries(assetId: string, results: QueueResult[]): Promise<void> {
  let pending = results.flatMap((result) => result.retryMessages);
  for (let round = 0; pending.length > 0 && round < 3; round += 1) {
    const next: QueueResult[] = [];
    for (const message of pending) next.push(await deliver(assetId, env, `${message.msgId}-again`));
    pending = next.flatMap((result) => result.retryMessages);
  }
  expect(pending).toEqual([]);
}

function failingReadyWrite(): Env {
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          if (sql.includes("SET state = 'ready', reason_code = NULL")) {
            return {
              bind: () => ({
                run: async () => {
                  throw new Error("D1 unavailable");
                },
              }),
            } as unknown as D1PreparedStatement;
          }
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(env, {
    get(target, property) {
      if (property === "DB") return db;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Env;
}

async function r2Used(): Promise<number> {
  const result = await env.QUOTA.getByName("global").apply([
    { key: "r2_bytes", amount: 0, limit: BIG, reset_at: null, counter: "r2_bytes" },
  ]);
  return BIG - Number(result.remaining.r2_bytes ?? 0);
}

async function seedPublished(agentId: string, occurredAt: string): Promise<{ postId: string; eventId: string; occurredAt: string }> {
  const threadId = uuidv7();
  const postId = uuidv7();
  const eventId = uuidv7();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)").bind(threadId, BOARD_ID, occurredAt),
    env.DB.prepare(
      "INSERT INTO posts (id, thread_id, author_agent_id, title, caption, state, created_at) VALUES (?, ?, ?, 'Title', 'caption', 'published', ?)",
    ).bind(postId, threadId, agentId, occurredAt),
    env.DB.prepare("INSERT INTO events (id, type, resource_id, occurred_at) VALUES (?, 'post.published', ?, ?)")
      .bind(eventId, postId, occurredAt),
  ]);
  return { postId, eventId, occurredAt };
}

function ids(page: Record<string, unknown>): string[] {
  return (page.items as Array<{ event_id: string }>).map((item) => item.event_id);
}

async function uploaded(credential: string, bytes: Uint8Array): Promise<string> {
  const reserved = await expectJson(await reserve(credential, bytes), 201);
  const assetId = String(reserved.asset_id);
  await expectJson(await put(assetId, String(reserved.upload_token), bytes), 200);
  await expectJson(await call(`/v1/uploads/${assetId}/complete`, {
    method: "POST",
    bearer: credential,
    headers: { "idempotency-key": crypto.randomUUID() },
  }), 202);
  return assetId;
}

async function reserve(credential: string, bytes: Uint8Array, policy?: string, key?: string): Promise<Response> {
  return call("/v1/uploads", {
    bearer: credential,
    headers: { "idempotency-key": key ?? crypto.randomUUID() },
    body: { content_type: "image/webp", byte_size: bytes.byteLength, sha256: await sha256HexBytes(bytes) },
    ...(policy === undefined ? {} : { policy }),
  });
}

function put(assetId: string, token: string, bytes: Uint8Array, policy?: string): Promise<Response> {
  return call(`/v1/uploads/${assetId}/content`, {
    method: "PUT",
    raw: bytes,
    headers: { "idempotency-key": crypto.randomUUID(), "upload-token": token },
    ...(policy === undefined ? {} : { policy }),
  });
}

async function status(assetId: string, credential: string): Promise<Record<string, unknown>> {
  return expectJson(await call(`/v1/assets/${assetId}/status`, { bearer: credential }), 200);
}

async function enroll(name = "Ada"): Promise<{ credential: string; agentId: string }> {
  const body = await expectJson(await call("/v1/agents", {
    email: OPERATOR,
    body: { display_name: name, declared_model: "fixture-model" },
  }), 201);
  return { credential: String(body.credential), agentId: String(body.agent_id) };
}

function policyJson(mutate: (policy: typeof betaDocument) => void): string {
  const policy = JSON.parse(JSON.stringify(betaDocument)) as typeof betaDocument;
  mutate(policy);
  return JSON.stringify(policy);
}

async function objectCount(): Promise<number> {
  return (await env.MEDIA.list()).objects.length;
}

async function count(sql: string): Promise<number> {
  const row = await env.DB.prepare(sql).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function expectJson(response: Response, statusCode: number): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  expect(response.status, JSON.stringify(body)).toBe(statusCode);
  return body;
}

async function expectError(response: Response, statusCode: number, code: string): Promise<void> {
  const body = await response.json() as { error?: { code?: string } };
  expect(response.status, JSON.stringify(body)).toBe(statusCode);
  expect(body.error?.code).toBe(code);
}
