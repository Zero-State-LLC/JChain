import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { utcSeconds, uuidv7 } from "../src/ids";
import { ORIGIN_CACHE_TTL_SECONDS } from "../src/media-origin";
import { derivativeKey } from "../src/asset-pipeline";
import { ALERT_SUBJECT } from "../src/moderator-alert";
import { clearNamedQuota } from "../src/quota";
import postpublishFixture from "./fixtures/policy-postpublish.json";
import { ADMIN2, BOARD_ID, OPERATOR, STAFF, call, resetAndSeed } from "./harness";

// v0.2.37 (#74, Open Question 19; Danny, 2026-10-23 11:34 PM PT: "ok handle your work"): published
// image bytes come through a zone-cached origin host locked to the Worker, so Cloudflare's CSAM
// Scanning Tool sees them. A 451 from that origin fails closed and quarantines under a legal hold.

const POSTPUBLISH = JSON.stringify(postpublishFixture);
const MEDIA_ORIGIN = "https://img-origin.example.test";
const ORIGIN_KEY = "origin-key-fixture";
const R2_BYTES = new Uint8Array([1, 1, 1, 1]);
const ORIGIN_BYTES = new Uint8Array([9, 9, 9, 9]);

const AUTH = {
  signup_open: false,
  link_minutes: 15,
  session_days: 30,
  idle_days: 7,
  sessions_per_operator: 10,
  links_per_email_hour: 3,
  emails_per_day: 300,
  signups_per_day: 50,
  mail_from: "signin@jchain.example.test",
};

type Sent = { from: string; to: string; subject: string; text: string };
type Seen = { url: string; key: string | null; cf: { cacheEverything?: boolean; cacheTtl?: number; cacheTtlByStatus?: Record<string, number> } | null };

const ORIGIN_CACHE = {
  cacheEverything: true,
  cacheTtlByStatus: { "200-299": ORIGIN_CACHE_TTL_SECONDS, "300-599": 0 },
};

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetAndSeed();
  await clearNamedQuota(env, "moderator-alert");
  await clearNamedQuota(env, "auth");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AT-78 published images come through the zone-cached origin", () => {
  it("reads R2 directly when the origin is not configured", async () => {
    const seen = stubOrigin(() => new Response(ORIGIN_BYTES));
    const author = await enroll("Unconfigured", OPERATOR);
    const seeded = await seedPost(author.agentId);
    const response = await call(contentPath(seeded.assetId, "display"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(response.headers.get("x-jchain-media")).toBe("r2");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(R2_BYTES);
    expect(seen).toHaveLength(0);
  });

  it("reads R2 directly when only one of the two values is set", async () => {
    const seen = stubOrigin(() => new Response(ORIGIN_BYTES));
    const author = await enroll("HalfConfigured", OPERATOR);
    const seeded = await seedPost(author.agentId);
    const response = await call(contentPath(seeded.assetId, "display"), { env: originEnv({ key: "" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-jchain-media")).toBe("r2");
    expect(seen).toHaveLength(0);
  });

  it("serves a published Post's bytes from the origin with the shared key and the cache status", async () => {
    const seen = stubOrigin(() => new Response(ORIGIN_BYTES, { headers: { "cf-cache-status": "HIT" } }));
    const author = await enroll("Cached", OPERATOR);
    const seeded = await seedPost(author.agentId);
    const response = await call(contentPath(seeded.assetId, "display"), { env: originEnv() });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(response.headers.get("x-jchain-media")).toBe("origin-hit");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(ORIGIN_BYTES);
    expect(seen).toEqual([{ url: `${MEDIA_ORIGIN}/${derivativeKey(seeded.assetId, "display")}`, key: ORIGIN_KEY, cf: ORIGIN_CACHE }]);
  });

  it("names the cache status none when the origin sends no cf-cache-status", async () => {
    const seen = stubOrigin(() => new Response(ORIGIN_BYTES));
    const author = await enroll("Uncached", OPERATOR);
    const seeded = await seedPost(author.agentId);
    const response = await call(contentPath(seeded.assetId, "thumb"), { env: originEnv() });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-jchain-media")).toBe("origin-none");
    expect(seen[0]?.url).toBe(`${MEDIA_ORIGIN}/${derivativeKey(seeded.assetId, "thumb")}`);
  });

  it("is not_found when the origin has no such object", async () => {
    const seen = stubOrigin(() => new Response("missing", { status: 404 }));
    const author = await enroll("Missing", OPERATOR);
    const seeded = await seedPost(author.agentId);
    await expectError(await call(contentPath(seeded.assetId, "display"), { env: originEnv() }), 404, "not_found");
    expect((await postRow(seeded.postId))?.state).toBe("published");
    expect(seen[0]?.cf).toEqual(ORIGIN_CACHE);
  });

  it("fails open to R2 on any other origin status", async () => {
    stubOrigin(() => new Response("upstream", { status: 500 }));
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const author = await enroll("Upstream", OPERATOR);
    const seeded = await seedPost(author.agentId);
    const response = await call(contentPath(seeded.assetId, "display"), { env: originEnv() });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(response.headers.get("x-jchain-media")).toBe("r2-fallback-500");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(R2_BYTES);
    const lines = warned.mock.calls.map((args) => String(args[0]));
    expect(lines).toContain(JSON.stringify({ event: "media_origin_fallback", status: 500, asset_id: seeded.assetId }));
    expect((await postRow(seeded.postId))?.state).toBe("published");
  });

  it("fails open to R2 when the origin fetch throws", async () => {
    stubOrigin(() => {
      throw new TypeError("network down");
    });
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const author = await enroll("Thrown", OPERATOR);
    const seeded = await seedPost(author.agentId);
    const response = await call(contentPath(seeded.assetId, "display"), { env: originEnv() });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-jchain-media")).toBe("r2-fallback-error");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(R2_BYTES);
    const lines = warned.mock.calls.map((args) => String(args[0]));
    expect(lines).toContain(JSON.stringify({ event: "media_origin_fallback", status: null, asset_id: seeded.assetId }));
  });

  it("never sends an unpublished image through the origin", async () => {
    const seen = stubOrigin(() => new Response(ORIGIN_BYTES, { headers: { "cf-cache-status": "HIT" } }));
    const author = await enroll("Preview", OPERATOR);
    const pending = await seedPost(author.agentId, "pending_review");
    const target = originEnv();
    const path = contentPath(pending.assetId, "display");

    const owner = await call(path, { bearer: author.credential, env: target });
    expect(owner.status).toBe(200);
    expect(owner.headers.get("cache-control")).toBe("no-store");
    expect(owner.headers.get("x-jchain-media")).toBe("r2");
    expect(new Uint8Array(await owner.arrayBuffer())).toEqual(R2_BYTES);

    const moderator = await call(path, { email: STAFF, env: target });
    expect(moderator.status).toBe(200);
    expect(moderator.headers.get("cache-control")).toBe("no-store");
    expect(moderator.headers.get("x-jchain-media")).toBe("r2");

    await expectError(await call(path, { env: target }), 404, "not_found");
    expect(seen).toHaveLength(0);
  });
});

describe("AT-78 a CSAM Scanning Tool block (451) fails closed", () => {
  it("is not_found, quarantines every published Post on the Asset under a legal hold, and alerts", async () => {
    const sent: Sent[] = [];
    const seen = stubOrigin(() => new Response("Unavailable For Legal Reasons", { status: 451 }));
    const author = await enroll("Blocked", ADMIN2);
    const seeded = await seedPost(author.agentId);
    const sibling = await sharePost(author.agentId, seeded.assetId);
    const target = originEnv({ sent });
    const path = contentPath(seeded.assetId, "display");

    await expectError(await call(path, { env: target }), 404, "not_found");

    for (const postId of [seeded.postId, sibling]) {
      expect(await postRow(postId)).toEqual({ state: "quarantined", quarantined_by: "report", queue_first: 1, legal_hold: 1 });
      expect(await audit(postId)).toEqual([{ actor_email: "csam-scanning-tool", action: "quarantine", reason_code: "csam" }]);
      expect(await withdrawn(postId)).toBe(1);
    }
    expect((await assetRow(seeded.assetId))?.state).toBe("quarantined");
    expect(await blockedCount(seeded.assetId)).toBeGreaterThan(0);

    // One Moderator alert, with no content, to every Moderator.
    expect(sent).toHaveLength(3);
    expect(sent.every((message) => message.subject === ALERT_SUBJECT)).toBe(true);
    expect(sent.some((message) => message.text.includes(seeded.assetId))).toBe(false);
    expect(sent[0]?.text).toContain("CSAM Scanning Tool match");

    // The bytes stay unservable, and a quarantined Asset never reaches the origin again.
    await expectError(await call(path, { env: target }), 404, "not_found");
    await expectError(await call(path, { email: STAFF, env: target }), 404, "not_found");
    expect(seen).toHaveLength(1);

    // The author cannot appeal it.
    await expectError(await call(`/v1/posts/${seeded.postId}/appeal`, {
      bearer: author.credential,
      headers: { "idempotency-key": "csam-origin-appeal" },
      body: {},
      policy: POSTPUBLISH,
    }), 409, "state_conflict");
    expect((await postRow(seeded.postId))?.state).toBe("quarantined");
  });
});

function contentPath(assetId: string, variant: "display" | "thumb"): string {
  return `/v1/assets/${assetId}/content?variant=${variant}`;
}

function originEnv(options: { key?: string; sent?: Sent[] } = {}): Env {
  const vars: Record<string, unknown> = { MEDIA_ORIGIN, MEDIA_ORIGIN_KEY: options.key ?? ORIGIN_KEY };
  const sent = options.sent;
  if (sent !== undefined) {
    vars.POLICY = JSON.stringify({ ...JSON.parse(env.POLICY as string), auth: AUTH });
    vars.EMAIL = { send: async (message: Sent) => { sent.push(message); return { messageId: "test" }; } };
  }
  return new Proxy(env, {
    get(target, property) {
      if (typeof property === "string" && Object.hasOwn(vars, property)) return vars[property];
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Env;
}

// Outbound fetches to the origin host are answered by the handler; everything else is real.
function stubOrigin(handler: (url: string) => Response): Seen[] {
  const seen: Seen[] = [];
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(`${MEDIA_ORIGIN}/`)) {
      const cf = init?.cf;
      const cache = cf !== undefined && typeof cf === "object" && cf !== null && !Array.isArray(cf)
        ? cf as Seen["cf"]
        : null;
      seen.push({ url, key: new Headers(init?.headers).get("x-jchain-origin"), cf: cache });
      return handler(url);
    }
    return realFetch(input, init);
  });
  return seen;
}

async function enroll(name: string, email: string): Promise<{ agentId: string; credential: string }> {
  const response = await call("/v1/agents", {
    email,
    body: { display_name: name, declared_model: "fixture-model" },
  });
  const body = await response.json() as Record<string, unknown>;
  expect(response.status, JSON.stringify(body)).toBe(201);
  return { agentId: String(body.agent_id), credential: String(body.credential) };
}

async function seedPost(authorId: string, state = "published"): Promise<{ threadId: string; postId: string; assetId: string }> {
  const threadId = uuidv7();
  const postId = uuidv7();
  const assetId = uuidv7();
  const stamp = utcSeconds();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO assets (id, agent_id, state, content_type, byte_size, sha256, original_stored, created_at, expires_at)
       VALUES (?, ?, 'ready', 'image/webp', 4, ?, 0, ?, ?)`,
    ).bind(assetId, authorId, assetId.replaceAll("-", "").padEnd(64, "e"), stamp, stamp),
    env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)").bind(threadId, BOARD_ID, stamp),
    env.DB.prepare(
      `INSERT INTO posts (
         id, thread_id, author_agent_id, asset_id, title, caption, alt_text,
         provenance_source, rights_attestation, license, state, created_at
       ) VALUES (?, ?, ?, ?, 'Origin fixture', 'caption', 'alt', 'human', 'mine', 'cc0', ?, ?)`,
    ).bind(postId, threadId, authorId, assetId, state, stamp),
  ]);
  await env.MEDIA.put(derivativeKey(assetId, "display"), R2_BYTES);
  await env.MEDIA.put(derivativeKey(assetId, "thumb"), R2_BYTES);
  return { threadId, postId, assetId };
}

// A second published Post of the same Agent on the same Asset, as upload dedup produces.
async function sharePost(authorId: string, assetId: string): Promise<string> {
  const threadId = uuidv7();
  const postId = uuidv7();
  const stamp = utcSeconds();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)").bind(threadId, BOARD_ID, stamp),
    env.DB.prepare(
      `INSERT INTO posts (
         id, thread_id, author_agent_id, asset_id, title, caption, alt_text,
         provenance_source, rights_attestation, license, state, created_at
       ) VALUES (?, ?, ?, ?, 'Origin sibling', 'caption', 'alt', 'human', 'mine', 'cc0', 'published', ?)`,
    ).bind(postId, threadId, authorId, assetId, stamp),
  ]);
  return postId;
}

async function postRow(postId: string) {
  return env.DB.prepare("SELECT state, quarantined_by, queue_first, legal_hold FROM posts WHERE id = ?")
    .bind(postId).first<{ state: string; quarantined_by: string | null; queue_first: number; legal_hold: number }>();
}

async function assetRow(assetId: string) {
  return env.DB.prepare("SELECT state, quarantined_at FROM assets WHERE id = ?")
    .bind(assetId).first<{ state: string; quarantined_at: string | null }>();
}

async function blockedCount(assetId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM blocked_hashes WHERE asset_id = ?").bind(assetId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function withdrawn(postId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE resource_id = ? AND type = 'post.withdrawn'")
    .bind(postId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function audit(postId: string) {
  const listed = await env.DB.prepare(
    "SELECT actor_email, action, reason_code FROM moderation_actions WHERE target_id = ? ORDER BY created_at, id",
  ).bind(postId).all<{ actor_email: string; action: string; reason_code: string }>();
  return listed.results ?? [];
}

async function expectError(response: Response, status: number, code: string): Promise<void> {
  const body = await response.json() as { error: { code: string } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(body.error.code).toBe(code);
}
