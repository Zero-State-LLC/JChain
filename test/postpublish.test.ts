import { applyD1Migrations, createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { VALID_WEBP } from "./fixtures/bytes";
import postpublishFixture from "./fixtures/policy-postpublish.json";
import { BOARD_ID, INSTRUCTIONS, MODERATOR, OPERATOR, UUID_V7, call, resetAndSeed } from "./harness";

const POSTPUBLISH = JSON.stringify(postpublishFixture);
const OLD_SENTENCE = "A Moderator approves a Post before it is public.";
const NEW_SENTENCE = "A Post is public when it is submitted, and Moderators can hide it afterwards.";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);
afterEach(() => {
  vi.restoreAllMocks();
});

describe("AT-39 publish on submit", () => {
  it("publishes a thread and a reply on submit with one Event and one scan message each", async () => {
    const { credential } = await enroll();
    const assetId = await readyAsset(credential);
    const fake = fakeQueue();
    const bindings = postEnv(POSTPUBLISH, fake.queue);
    const key = crypto.randomUUID();
    const body = threadBody(assetId);

    const opened = await expectSuccess(await submit("/v1/threads", credential, body, { env: bindings, key }), 201);
    const postId = String(opened.post_id);
    const threadId = String(opened.thread_id);
    expect(opened.state).toBe("published");
    expect(String(opened.event_id)).toMatch(UUID_V7);
    expect((await postRow(postId))?.state).toBe("published");
    expect(await publishedEvents(postId)).toBe(1);
    expect((await scanRow(postId))?.result).toBe("pending");
    expect(fake.sent).toEqual([{ post_id: postId }]);

    const replayed = await expectSuccess(await submit("/v1/threads", credential, body, { env: bindings, key }), 201);
    expect(replayed.post_id).toBe(postId);
    expect(replayed.state).toBe("published");
    expect(replayed.event_id).toBe(opened.event_id);
    expect(fake.sent).toHaveLength(1);

    const replied = await expectSuccess(
      await submit(`/v1/threads/${threadId}/posts`, credential, { text: "A reply" }, { env: bindings }),
      201,
    );
    const replyId = String(replied.post_id);
    expect(replied.state).toBe("published");
    expect(String(replied.event_id)).toMatch(UUID_V7);
    expect(await publishedEvents(replyId)).toBe(1);
    expect(fake.sent).toEqual([{ post_id: postId }, { post_id: replyId }]);

    const events = await expectSuccess(await call("/v1/events", { bearer: credential }));
    const resources = (events.items as { resource_id: string; type: string }[])
      .filter((item) => item.type === "post.published")
      .map((item) => item.resource_id);
    expect(resources).toContain(postId);
    expect(resources).toContain(replyId);

    const read = await call(`/v1/threads/${threadId}/posts`, { email: OPERATOR });
    expect(read.status).toBe(200);
    const text = await read.text();
    expect(text).toContain(postId);
    expect(text).toContain(replyId);
  });

  it("keeps the Post pending_review while the Publishing Stop is engaged", async () => {
    const { credential } = await enroll();
    const assetId = await readyAsset(credential);
    await expectSuccess(await call("/v1/admin/publishing-stop", { email: MODERATOR, body: { engaged: true } }));
    const fake = fakeQueue();
    const opened = await expectSuccess(
      await submit("/v1/threads", credential, threadBody(assetId), { env: postEnv(POSTPUBLISH, fake.queue) }),
      201,
    );
    const postId = String(opened.post_id);
    expect(opened.state).toBe("pending_review");
    expect(opened.event_id).toBeUndefined();
    expect((await postRow(postId))?.state).toBe("pending_review");
    expect(await publishedEvents(postId)).toBe(0);
    expect(await scanRow(postId)).toBeNull();
    expect(fake.sent).toHaveLength(0);
  });

  it("holds an Agent below review.hold_first_posts until a Moderator approves", async () => {
    const policy = variant((p) => {
      (p.review as Record<string, unknown>).hold_first_posts = 1;
    });
    const { credential } = await enroll();
    const assetId = await readyAsset(credential);
    const fake = fakeQueue();
    const bindings = postEnv(policy, fake.queue);
    const opened = await expectSuccess(await submit("/v1/threads", credential, threadBody(assetId), { env: bindings }), 201);
    const postId = String(opened.post_id);
    expect(opened.state).toBe("pending_review");
    expect(await publishedEvents(postId)).toBe(0);
    expect(fake.sent).toHaveLength(0);

    await expectSuccess(await call("/v1/moderation/actions", {
      email: MODERATOR,
      body: { target_type: "post", target_id: postId, action: "approve", reason_code: "rules" },
    }));

    const replied = await expectSuccess(
      await submit(`/v1/threads/${String(opened.thread_id)}/posts`, credential, { text: "Next" }, { env: bindings }),
      201,
    );
    expect(replied.state).toBe("published");
    expect(fake.sent).toEqual([{ post_id: String(replied.post_id) }]);
  });

  it("leaves the Post published and flagged unscanned when the scan send fails", async () => {
    const { credential } = await enroll();
    const assetId = await readyAsset(credential);
    const fake = fakeQueue(true);
    const opened = await expectSuccess(
      await submit("/v1/threads", credential, threadBody(assetId), { env: postEnv(POSTPUBLISH, fake.queue) }),
      201,
    );
    const postId = String(opened.post_id);
    expect(opened.state).toBe("published");
    expect(fake.sent).toHaveLength(1);
    expect((await postRow(postId))?.state).toBe("published");
    expect(await publishedEvents(postId)).toBe(1);
    expect((await scanRow(postId))?.result).toBe("unscanned");
  });
});

describe("CT-12 rules in postpublish", () => {
  it("returns postpublish and the changed sentence", async () => {
    const body = await expectSuccess(await call(`/v1/boards/${BOARD_ID}/rules`, { email: OPERATOR, policy: POSTPUBLISH }));
    expect(body.moderation).toBe("postpublish");
    expect(body.instructions).toBe(INSTRUCTIONS.replace(OLD_SENTENCE, NEW_SENTENCE));
    expect(String(body.instructions)).not.toContain(OLD_SENTENCE);
  });

  it("prints the mode's instructions on /rules and the board page", async () => {
    for (const path of ["/rules", "/boards/beta"]) {
      const post = await (await call(path, { policy: POSTPUBLISH })).text();
      expect(post).toContain(NEW_SENTENCE);
      expect(post).not.toContain(OLD_SENTENCE);
      const pre = await (await call(path)).text();
      expect(pre).toContain(OLD_SENTENCE);
      expect(pre).not.toContain(NEW_SENTENCE);
    }
  });

  it("keeps the prepublish document unchanged", async () => {
    const body = await expectSuccess(await call(`/v1/boards/${BOARD_ID}/rules`, { email: OPERATOR }));
    expect(body.moderation).toBe("prepublish");
    expect(body.instructions).toBe(INSTRUCTIONS);
  });
});

describe("CT-03, CT-04, CT-05 overlapping requests with one Idempotency-Key", () => {
  // One thread an hour per Agent: an overlapping loser may hit the cap or the key, and must
  // replay or conflict either way, never 500 and never 429.
  const roomy = POSTPUBLISH;

  it("creates one Thread and replays it to the other request", async () => {
    const { credential } = await enroll();
    const assetId = await readyAsset(credential);
    const fake = fakeQueue();
    const bindings = postEnv(roomy, fake.queue);
    const body = threadBody(assetId);
    const [first, second] = await Promise.all([
      submit("/v1/threads", credential, body, { env: bindings, key: "race-thread" }),
      submit("/v1/threads", credential, body, { env: bindings, key: "race-thread" }),
    ]);
    const a = await expectSuccess(first, 201);
    const b = await expectSuccess(second, 201);
    expect(a.post_id).toBe(b.post_id);
    expect(a.state).toBe("published");
    expect(b.state).toBe("published");
    expect(await threadPostCount(assetId)).toBe(1);
    expect(await keyRows("race-thread")).toBe(1);
    expect(fake.sent).toEqual([{ post_id: a.post_id }]);
  });

  it("answers idempotency_conflict to an overlapping different body", async () => {
    const { credential } = await enroll();
    const assetId = await readyAsset(credential);
    const bindings = postEnv(roomy, fakeQueue().queue);
    const [first, second] = await Promise.all([
      submit("/v1/threads", credential, threadBody(assetId), { env: bindings, key: "race-differ" }),
      submit("/v1/threads", credential, threadBody(assetId, { title: "Other" }), { env: bindings, key: "race-differ" }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = first.status === 409 ? first : second;
    await expectError(loser, 409, "idempotency_conflict");
    expect(await threadPostCount(assetId)).toBe(1);
  });

  it("creates one Reply and replays it to the other request", async () => {
    const { credential } = await enroll();
    const assetId = await readyAsset(credential);
    const fake = fakeQueue();
    const bindings = postEnv(roomy, fake.queue);
    const opened = await expectSuccess(await submit("/v1/threads", credential, threadBody(assetId), { env: bindings }), 201);
    const path = `/v1/threads/${String(opened.thread_id)}/posts`;
    const [first, second] = await Promise.all([
      submit(path, credential, { text: "same reply" }, { env: bindings, key: "race-reply" }),
      submit(path, credential, { text: "same reply" }, { env: bindings, key: "race-reply" }),
    ]);
    const a = await expectSuccess(first, 201);
    const b = await expectSuccess(second, 201);
    expect(a.post_id).toBe(b.post_id);
    const replies = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM posts WHERE thread_id = ? AND title IS NULL",
    ).bind(String(opened.thread_id)).first<{ n: number }>();
    expect(Number(replies?.n ?? 0)).toBe(1);
    expect(await keyRows("race-reply")).toBe(1);
    expect(fake.sent).toEqual([{ post_id: opened.post_id }, { post_id: a.post_id }]);
  });

  it("reserves one Upload and replays it to the other request", async () => {
    const { credential, agentId } = await enroll();
    const body = {
      content_type: "image/webp",
      byte_size: VALID_WEBP.byteLength,
      sha256: await sha256HexBytes(VALID_WEBP),
    };
    const reserve = (): Promise<Response> => call("/v1/uploads", {
      bearer: credential,
      headers: { "idempotency-key": "race-upload" },
      body,
    });
    const [first, second] = await Promise.all([reserve(), reserve()]);
    const a = await expectSuccess(first, 201);
    const b = await expectSuccess(second, 201);
    expect(a.asset_id).toBe(b.asset_id);
    expect(typeof a.upload_token).toBe("string");
    expect(typeof b.upload_token).toBe("string");
    const assets = await env.DB.prepare("SELECT COUNT(*) AS n FROM assets WHERE agent_id = ?").bind(agentId).first<{ n: number }>();
    expect(Number(assets?.n ?? 0)).toBe(1);
    expect(await keyRows("race-upload")).toBe(1);
  });
});

async function threadPostCount(assetId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE asset_id = ?").bind(assetId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function keyRows(key: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE idempotency_key = ?").bind(key).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

describe("AT-48 policy validation", () => {
  const bad: [string, string][] = [
    ["postpublish without review", variant((p) => {
      delete p.review;
    })],
    ["postpublish without moderation", variant((p) => {
      delete p.moderation;
    })],
    ["review with an extra key", variant((p) => {
      (p.review as Record<string, unknown>).extra = 1;
    })],
    ["review missing a key", variant((p) => {
      delete (p.review as Record<string, unknown>).appeal_days;
    })],
    ["ai_neurons_per_day 10001", variant((p) => {
      (p.moderation as Record<string, unknown>).ai_neurons_per_day = 10001;
    })],
    ["hold_first_posts 11", variant((p) => {
      (p.review as Record<string, unknown>).hold_first_posts = 11;
    })],
    ["cohort mode", variant((p) => {
      p.moderation_mode = "cohort";
    })],
  ];

  for (const [name, policy] of bad) {
    it(`${name} is policy_missing on every /v1 route`, async () => {
      await expectError(await call("/v1/boards", { email: OPERATOR, policy }), 503, "policy_missing");
      await expectError(await call("/v1/agents/me", { bearer: "jc_not_a_real_credential", policy }), 503, "policy_missing");
      await expectError(await call("/v1/threads", { bearer: "jc_not_a_real_credential", policy, body: {} }), 503, "policy_missing");
    });
  }

  it("accepts ai_neurons_per_day 0", async () => {
    const policy = variant((p) => {
      (p.moderation as Record<string, unknown>).ai_neurons_per_day = 0;
    });
    await expectSuccess(await call("/v1/boards", { email: OPERATOR, policy }));
  });

  it("a prepublish policy with valid staged blocks behaves as before", async () => {
    const policy = variant((p) => {
      p.moderation_mode = "prepublish";
    });
    const { credential } = await enroll();
    const assetId = await readyAsset(credential);
    const opened = await expectSuccess(await submit("/v1/threads", credential, threadBody(assetId), { policy }), 201);
    const postId = String(opened.post_id);
    expect(opened.state).toBe("pending_review");
    expect(opened.event_id).toBeUndefined();
    expect(await publishedEvents(postId)).toBe(0);
    expect(await scanRow(postId)).toBeNull();
    const rules = await expectSuccess(await call(`/v1/boards/${BOARD_ID}/rules`, { email: OPERATOR, policy }));
    expect(rules.moderation).toBe("prepublish");
    expect(rules.instructions).toBe(INSTRUCTIONS);
  });

  it("a prepublish policy with an invalid staged block is policy_missing", async () => {
    const policy = variant((p) => {
      p.moderation_mode = "prepublish";
      (p.review as Record<string, unknown>).appeal_days = 0;
    });
    await expectError(await call("/v1/boards", { email: OPERATOR, policy }), 503, "policy_missing");
  });
});

describe("AT-40 and AT-49 Blocked Hashes", () => {
  async function uploadSettled(credential: string): Promise<string> {
    const reserved = await expectSuccess(await call("/v1/uploads", {
      bearer: credential,
      headers: { "idempotency-key": crypto.randomUUID() },
      body: {
        content_type: "image/webp",
        byte_size: VALID_WEBP.byteLength,
        sha256: await sha256HexBytes(VALID_WEBP),
      },
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

  async function blockedCount(): Promise<number> {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM blocked_hashes").first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  async function postsWithAsset(assetId: string): Promise<number> {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE asset_id = ?")
      .bind(assetId).first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  function moderate(body: Record<string, unknown>): Promise<Response> {
    return call("/v1/moderation/actions", { email: MODERATOR, body });
  }

  it("blocks the bytes of a Post a Moderator removes, so a new upload is rejected as blocked", async () => {
    const ada = await enroll("Ada");
    const assetId = await readyAsset(ada.credential);
    const fake = fakeQueue();
    const opened = await expectSuccess(await submit("/v1/threads", ada.credential, threadBody(assetId), {
      env: postEnv(POSTPUBLISH, fake.queue),
    }), 201);
    const postId = String(opened.post_id);
    if (opened.state !== "published") {
      await expectSuccess(await moderate({
        target_type: "post", target_id: postId, action: "approve", reason_code: "rules",
      }));
    }
    const removed = await expectSuccess(await moderate({
      target_type: "post", target_id: postId, action: "remove", reason_code: "rules",
    }));
    expect(removed.state).toBe("removal_pending");
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM blocked_hashes WHERE asset_id = ? AND prohibited = 0",
    ).bind(assetId).first<{ n: number }>();
    expect(Number(rows?.n ?? 0)).toBeGreaterThan(0);

    const bea = await enroll("Bea");
    const second = await uploadSettled(bea.credential);
    const status = await expectSuccess(await call(`/v1/assets/${second}/status`, { bearer: bea.credential }));
    expect(status.state).toBe("rejected");
    expect(status.reason_code).toBe("blocked");
    const row = await env.DB.prepare("SELECT state, blocked FROM assets WHERE id = ?")
      .bind(second).first<{ state: string; blocked: number }>();
    expect(row).toEqual({ state: "rejected", blocked: 1 });
  });

  it("blocks the bytes of an Asset a Moderator quarantines", async () => {
    const ada = await enroll("Ada");
    const assetId = await readyAsset(ada.credential);
    const done = await expectSuccess(await moderate({
      target_type: "asset", target_id: assetId, action: "quarantine_asset", reason_code: "rules",
    }));
    expect(done.state).toBe("quarantined");
    expect(await blockedCount()).toBeGreaterThan(0);
  });

  it("quarantines a new upload that matches a prohibited Blocked Hash", async () => {
    await env.DB.prepare(
      "INSERT INTO blocked_hashes (sha256, prohibited, asset_id, created_at) VALUES (?, 1, NULL, ?)",
    ).bind(await sha256HexBytes(VALID_WEBP), "2026-01-01T00:00:00Z").run();
    const ada = await enroll("Ada");
    const assetId = await uploadSettled(ada.credential);
    const status = await expectSuccess(await call(`/v1/assets/${assetId}/status`, { bearer: ada.credential }));
    expect(status.state).toBe("quarantined");

    // Queued first: the quarantined upload is listed for Moderators, ahead of the reports,
    // with its age and the Admin-only Restore image form.
    const page = await (await call("/moderation", { email: MODERATOR })).text();
    const start = page.indexOf('id="queue-quarantined-uploads"');
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(page.indexOf('id="reports"'));
    const section = page.slice(start, page.indexOf('id="reports"'));
    expect(section).toContain(assetId);
    expect(section).toContain("(age ");
    expect(section).toContain('name="action" value="restore_asset"');
    expect(section).toContain("Restore image (Admin)");
  });

  it("refuses a thread and a reply whose ready Asset was blocked afterwards (AT-49)", async () => {
    const ada = await enroll("Ada");
    const assetId = await readyAsset(ada.credential);
    const opened = await expectSuccess(await submit("/v1/threads", ada.credential, threadBody(assetId), { policy: POSTPUBLISH }), 201);
    const asset = await env.DB.prepare("SELECT display_sha256 FROM assets WHERE id = ?")
      .bind(assetId).first<{ display_sha256: string | null }>();
    expect(asset?.display_sha256).toMatch(/^[0-9a-f]{64}$/);
    await env.DB.prepare(
      "INSERT INTO blocked_hashes (sha256, prohibited, asset_id, created_at) VALUES (?, 0, NULL, ?)",
    ).bind(String(asset?.display_sha256), "2026-01-01T00:00:00Z").run();

    await expectError(await submit("/v1/threads", ada.credential, threadBody(assetId)), 409, "state_conflict");
    await expectError(await submit(`/v1/threads/${String(opened.thread_id)}/posts`, ada.credential, {
      text: "Again",
      asset_id: assetId,
      alt_text: "A square",
      provenance: { source: "model", model: "fixture-model" },
      rights_attestation: "I made this.",
      license: "cc0",
    }), 409, "state_conflict");
    expect(await postsWithAsset(assetId)).toBe(1);
  });

  it("adds nothing to the list on an owner deletion", async () => {
    const ada = await enroll("Ada");
    const assetId = await readyAsset(ada.credential);
    await expectSuccess(await submit("/v1/threads", ada.credential, threadBody(assetId)), 201);
    const response = await call("/v1/deletion-requests", { email: OPERATOR, body: { agent_id: ada.agentId } });
    expect(response.status).toBeLessThan(300);
    expect(await blockedCount()).toBe(0);
  });

  it("keeps prepublish submits with an unblocked Asset pending review", async () => {
    const ada = await enroll("Ada");
    const assetId = await readyAsset(ada.credential);
    const opened = await expectSuccess(await submit("/v1/threads", ada.credential, threadBody(assetId)), 201);
    expect(opened.state).toBe("pending_review");
  });
});

function variant(mutate: (policy: Record<string, unknown>) => void): string {
  const policy = JSON.parse(POSTPUBLISH) as Record<string, unknown>;
  mutate(policy);
  return JSON.stringify(policy);
}

type FakeQueue = {
  sent: unknown[];
  queue: { send(body: unknown): Promise<void>; sendBatch(): Promise<void> };
};

function fakeQueue(fail = false): FakeQueue {
  const sent: unknown[] = [];
  return {
    sent,
    queue: {
      async send(body: unknown): Promise<void> {
        sent.push(body);
        if (fail) throw new Error("queue unavailable");
      },
      async sendBatch(): Promise<void> {},
    },
  };
}

function postEnv(policy: string, queue: FakeQueue["queue"]): Env {
  return new Proxy(env, {
    get(target, property) {
      if (property === "POLICY") return policy;
      if (property === "ASSET_UPLOAD") return queue;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Env;
}

async function postRow(id: string): Promise<{ state: string } | null> {
  return env.DB.prepare("SELECT state FROM posts WHERE id = ?").bind(id).first<{ state: string }>();
}

async function scanRow(id: string): Promise<{ result: string } | null> {
  return env.DB.prepare("SELECT result FROM post_scans WHERE post_id = ?").bind(id).first<{ result: string }>();
}

async function publishedEvents(id: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE resource_id = ? AND type = 'post.published'",
  ).bind(id).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

function threadBody(assetId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    board_id: BOARD_ID,
    asset_id: assetId,
    title: "Hello",
    caption: "A caption",
    alt_text: "A square",
    provenance: { source: "model", model: "fixture-model" },
    rights_attestation: "I made this.",
    license: "cc0",
    ...extra,
  };
}

function submit(
  path: string,
  credential: string,
  body: Record<string, unknown>,
  options: { env?: Env; policy?: string; key?: string } = {},
): Promise<Response> {
  return call(path, {
    bearer: credential,
    headers: { "idempotency-key": options.key ?? crypto.randomUUID() },
    body,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.policy === undefined ? {} : { policy: options.policy }),
  });
}

async function readyAsset(credential: string): Promise<string> {
  const reserved = await expectSuccess(await call("/v1/uploads", {
    bearer: credential,
    headers: { "idempotency-key": crypto.randomUUID() },
    body: {
      content_type: "image/webp",
      byte_size: VALID_WEBP.byteLength,
      sha256: await sha256HexBytes(VALID_WEBP),
    },
  }), 201);
  await expectSuccess(await call(`/v1/uploads/${String(reserved.asset_id)}/content`, {
    method: "PUT",
    raw: VALID_WEBP,
    headers: {
      "idempotency-key": crypto.randomUUID(),
      "upload-token": String(reserved.upload_token),
    },
  }));
  await expectSuccess(await call(`/v1/uploads/${String(reserved.asset_id)}/complete`, {
    method: "POST",
    bearer: credential,
    headers: { "idempotency-key": crypto.randomUUID() },
  }), 202);
  await settle(String(reserved.asset_id));
  const status = await expectSuccess(await call(`/v1/assets/${String(reserved.asset_id)}/status`, {
    bearer: credential,
  }));
  expect(status.state).toBe("ready");
  return String(reserved.asset_id);
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

async function enroll(name = "Ada"): Promise<{ credential: string; agentId: string }> {
  const response = await call("/v1/agents", {
    email: OPERATOR,
    body: { display_name: name, declared_model: "fixture-model" },
  });
  const body = await expectSuccess(response, 201);
  return { credential: String(body.credential), agentId: String(body.agent_id) };
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function expectError(response: Response, status: number, code: string): Promise<ErrorBody> {
  const body = await response.json() as ErrorBody;
  expect(response.status).toBe(status);
  expect(body.error.code).toBe(code);
  expect(body.request_id).toMatch(UUID_V7);
  return body;
}

async function expectSuccess(response: Response, status = 200): Promise<SuccessBody> {
  const body = await response.json() as SuccessBody;
  expect(response.status).toBe(status);
  expect(body.request_id).toMatch(UUID_V7);
  return body;
}

type ErrorBody = { request_id: string; error: { code: string; message: string } };
type SuccessBody = Record<string, unknown>;
