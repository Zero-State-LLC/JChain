import { applyD1Migrations, createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import betaDocument from "../policy/beta.json";
import worker from "../src/index";
import { VALID_WEBP } from "./fixtures/bytes";
import { BOARD_ID, MODERATOR, OPERATOR, call, pinClock, resetAndSeed } from "./harness";

const MISSING_ID = "01900000-0000-7000-8000-000000000099";
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  pinClock();
  await resetAndSeed();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("reactions", () => {
  it("keeps one reaction per actor, post, and type", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message));
    });
    const ada = await enroll("Ada");
    const bea = await enroll("Bea");
    const caption = "react-caption-10";
    const { threadId, postId } = await publishedThread(ada.credential, caption, false);
    await expectError(await react(ada.credential, postId, "plus", "pending-key"), 404, "not_found");
    expect(await reactionRows(postId, "plus")).toBe(0);
    expect(await idempotencyRows("pending-key")).toBe(0);

    await expectSuccess(await act(postId, "approve"));
    const created = await expectSuccess(await react(ada.credential, postId, "plus", "pending-key"), 201);
    expect(created.post_id).toBe(postId);
    expect(created.type).toBe("plus");
    expect(created.count).toBe(1);
    expectLimits(created.limits, { threads: 0, replies: 6, mutations: 19 });
    expect(await reactionRows(postId, "plus")).toBe(1);
    expect(await reactionRows(postId, "plus", ada.agentId)).toBe(1);
    expect(await idempotencyRows("pending-key")).toBe(1);

    const replayed = await expectSuccess(await react(ada.credential, postId, "plus", "pending-key"), 201);
    expect(replayed.count).toBe(1);
    expect(replayed.limits).toEqual(created.limits);
    expect(replayed.request_id).not.toBe(created.request_id);
    expect(await reactionRows(postId, "plus")).toBe(1);
    expect(await idempotencyRows("pending-key")).toBe(1);

    const conflict = await react(ada.credential, postId, "plus", "pending-key", { extra: true });
    const conflictBody = await expectError(conflict, 409, "idempotency_conflict");
    expectLimits(conflictBody.limits, { threads: 0, replies: 6, mutations: 19 });
    expect(await reactionRows(postId, "plus")).toBe(1);

    await expectError(await call(`/v1/posts/${postId}/reactions/plus`, {
      method: "PUT",
      bearer: ada.credential,
      headers: { "idempotency-key": "array-key", "content-type": "application/json" },
      raw: new TextEncoder().encode("[1]"),
    }), 400, "malformed");
    expect(await reactionRows(postId, "plus")).toBe(1);
    expect(await idempotencyRows("array-key")).toBe(0);

    const again = await expectSuccess(await react(ada.credential, postId, "plus", "again-plus"), 200);
    expect(again.count).toBe(1);
    expect(await reactionRows(postId, "plus", ada.agentId)).toBe(1);

    const beaPlus = await expectSuccess(await react(bea.credential, postId, "plus", "bea-plus"), 201);
    expect(beaPlus.count).toBe(2);
    expectLimits(beaPlus.limits, { threads: 1, replies: 6, mutations: 20 });
    const stored = await expectSuccess(await react(ada.credential, postId, "plus", "pending-key"), 201);
    expect(stored.count).toBe(1);
    expect(stored.limits).toEqual(created.limits);

    const duringStop = await expectSuccess(await call("/v1/admin/publishing-stop", {
      email: MODERATOR,
      body: { engaged: true },
    }));
    expect(duringStop.engaged).toBe(true);
    const laugh = await expectSuccess(await react(ada.credential, postId, "laugh", "laugh-key"), 201);
    expect(laugh.count).toBe(1);
    expectLimits(laugh.limits, { threads: 0, replies: 6, mutations: 19 });
    await expectSuccess(await call("/v1/admin/publishing-stop", {
      email: MODERATOR,
      body: { engaged: false },
    }));

    const page = await call(`/threads/${threadId}`);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'none'");
    const html = await page.text();
    expect(html).toContain("<dt>Plus <code>plus</code></dt><dd>2</dd>");
    expect(html).toContain("<dt>Minus <code>minus</code></dt><dd>0</dd>");
    expect(html).toContain("<dt>Laugh <code>laugh</code></dt><dd>1</dd>");
    expect(html).toContain("<dt>Interest <code>interest</code></dt><dd>0</dd>");
    expect(html).not.toContain(ada.credential);

    const events = await expectSuccess(await call("/v1/events", { bearer: ada.credential }));
    const items = events.items as Array<{ type: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe("post.published");
    expect(JSON.stringify(items)).not.toContain(caption);

    const replied = await expectSuccess(await call(`/v1/threads/${threadId}/posts`, {
      bearer: ada.credential,
      headers: { "idempotency-key": "reply-after-reaction" },
      body: { text: "a reply after reactions" },
    }), 201);
    expectLimits(replied.limits, { threads: 0, replies: 5, mutations: 18 });
    const afterReply = await expectSuccess(await call("/v1/events", { bearer: ada.credential }));
    expect(afterReply.items).toHaveLength(1);

    const removed = await expectSuccess(await unreact(ada.credential, postId, "plus"));
    expect(removed.count).toBe(1);
    expect(await reactionRows(postId, "plus", ada.agentId)).toBe(0);
    expect(await reactionRows(postId, "plus", bea.agentId)).toBe(1);
    const removedAgain = await expectSuccess(await unreact(ada.credential, postId, "plus"));
    expect(removedAgain.count).toBe(1);
    const afterDelete = await (await call(`/threads/${threadId}`)).text();
    expect(afterDelete).toContain("<dt>Plus <code>plus</code></dt><dd>1</dd>");
    expect(afterDelete).toContain("<dt>Laugh <code>laugh</code></dt><dd>1</dd>");

    const reactionLogs = logs.filter((line) => line.includes("reaction added") || line.includes("reaction removed"));
    expect(reactionLogs.length).toBeGreaterThan(0);
    for (const line of reactionLogs) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual(["message", "post_id", "type"]);
      expect(parsed.post_id).toBe(postId);
      expect(["reaction added", "reaction removed"]).toContain(parsed.message);
    }
    expect(reactionLogs.join("\n")).not.toContain(caption);
    expect(reactionLogs.join("\n")).not.toContain(ada.credential);
  });

  it("conceals reactions on a post the caller cannot see", async () => {
    const ada = await enroll("Ada");
    const { threadId } = await publishedThread(ada.credential, "opening stays", true);
    const replyId = await replyTo(ada.credential, threadId, "hidden reply words");
    await expectError(await react(ada.credential, replyId, "plus", "before-approve"), 404, "not_found");
    expect(await reactionRows(replyId, "plus")).toBe(0);
    expect(await idempotencyRows("before-approve")).toBe(0);

    await expectSuccess(await act(replyId, "approve"));
    const created = await expectSuccess(await react(ada.credential, replyId, "plus", "before-approve"), 201);
    expect(created.count).toBe(1);

    await expectSuccess(await act(replyId, "hide"));
    const replay = await expectError(await react(ada.credential, replyId, "plus", "before-approve"), 404, "not_found");
    expect(JSON.stringify(replay)).not.toContain("count");
    await expectError(await react(ada.credential, replyId, "plus", "while-hidden"), 404, "not_found");
    await expectError(await unreact(ada.credential, replyId, "plus"), 404, "not_found");
    expect(await reactionRows(replyId, "plus")).toBe(1);
    expect(await idempotencyRows("while-hidden")).toBe(0);
    const hiddenPage = await call(`/threads/${threadId}`);
    expect(hiddenPage.status).toBe(200);
    const hiddenHtml = await hiddenPage.text();
    expect(hiddenHtml).toContain("opening stays");
    expect(hiddenHtml).not.toContain("hidden reply words");
    expect(hiddenHtml).toContain("<dt>Plus <code>plus</code></dt><dd>0</dd>");
    expect(hiddenHtml).not.toContain("<dt>Plus <code>plus</code></dt><dd>1</dd>");

    await expectSuccess(await act(replyId, "restore"));
    const restored = await (await call(`/threads/${threadId}`)).text();
    expect(restored).toContain("hidden reply words");
    expect(restored).toContain("<dt>Plus <code>plus</code></dt><dd>1</dd>");
    expect(restored).toContain("<dt>Plus <code>plus</code></dt><dd>0</dd>");

    const rejectedId = await replyTo(ada.credential, threadId, "rejected reply words");
    await expectSuccess(await act(rejectedId, "reject"));
    await expectError(await react(ada.credential, rejectedId, "laugh", "rejected-key"), 404, "not_found");
    expect(await reactionRows(rejectedId, "laugh")).toBe(0);
    expect(await (await call(`/threads/${threadId}`)).text()).not.toContain("rejected reply words");

    const removedId = await replyTo(ada.credential, threadId, "removed reply words");
    await expectSuccess(await act(removedId, "approve"));
    await expectSuccess(await react(ada.credential, removedId, "interest", "remove-key"), 201);
    await expectSuccess(await act(removedId, "remove"));
    await expectError(await react(ada.credential, removedId, "interest", "remove-key"), 404, "not_found");
    await expectError(await react(ada.credential, removedId, "interest", "remove-again"), 404, "not_found");
    await expectError(await unreact(ada.credential, removedId, "interest"), 404, "not_found");
    expect(await reactionRows(removedId, "interest")).toBe(1);
    const removedPage = await (await call(`/threads/${threadId}`)).text();
    expect(removedPage).not.toContain("removed reply words");
    expect(removedPage).not.toContain("<dt>Interest <code>interest</code></dt><dd>1</dd>");
  });

  it("stores one reaction when two identical puts overlap", async () => {
    const ada = await enroll("Ada");
    const { postId } = await publishedThread(ada.credential, "race caption", true);
    const [first, second] = await Promise.all([
      react(ada.credential, postId, "plus", "race-key"),
      react(ada.credential, postId, "plus", "race-key"),
    ]);
    expect([first.status, second.status].every((status) => status === 200 || status === 201)).toBe(true);
    expect(await reactionRows(postId, "plus", ada.agentId)).toBe(1);
    expect(await idempotencyRows("race-key")).toBe(1);
  });

  it("replays a capped overlap instead of charging the loser", async () => {
    const ada = await enroll("Ada");
    const { postId } = await publishedThread(ada.credential, "race one", true);
    const policy = agentPolicy({ reactions_per_minute: 1 });
    // Pin the interleaving that used to flake: the winner takes the only slot, and its D1 batch
    // waits until the loser's charge is refused, so the loser looks for the winner's row first.
    const gated = overlapEnv(policy);
    const [first, second] = await Promise.all([
      reactIn(gated, ada.credential, postId, "plus", "race-one"),
      reactIn(gated, ada.credential, postId, "plus", "race-one"),
    ]);
    expect([first.status, second.status].every((status) => status === 200 || status === 201)).toBe(true);
    expect(await reactionRows(postId, "plus", ada.agentId)).toBe(1);
    expect(await idempotencyRows("race-one")).toBe(1);
    const blocked = await react(ada.credential, postId, "minus", "race-one-next", undefined, policy);
    expect(blocked.status).toBe(429);
    expect(await reactionRows(postId, "minus")).toBe(0);
  });

  it("keeps one reaction charge when two identical puts overlap", async () => {
    const ada = await enroll("Ada");
    const { postId } = await publishedThread(ada.credential, "race cap", true);
    const policy = agentPolicy({ reactions_per_minute: 2 });
    const [first, second] = await Promise.all([
      react(ada.credential, postId, "plus", "race-cap", undefined, policy),
      react(ada.credential, postId, "plus", "race-cap", undefined, policy),
    ]);
    expect([first.status, second.status].every((status) => status === 200 || status === 201)).toBe(true);
    expect(await reactionRows(postId, "plus", ada.agentId)).toBe(1);
    expect(await idempotencyRows("race-cap")).toBe(1);

    const next = await expectSuccess(
      await react(ada.credential, postId, "minus", "race-cap-next", undefined, policy),
      201,
    );
    expect(limitsOf(next.limits).reactions.remaining).toBe(0);
    expect(await reactionRows(postId, "minus")).toBe(1);
    const blocked = await react(ada.credential, postId, "laugh", "race-cap-blocked", undefined, policy);
    expect(blocked.status).toBe(429);
    expect(await reactionRows(postId, "laugh")).toBe(0);
  });

  it("drops minute counters from earlier windows", async () => {
    const stub = env.QUOTA.getByName("agent:minute-expiry");
    await stub.clear();
    const charge = (key: string, counter: string, amount = 1) => ({
      key,
      amount,
      limit: 100,
      reset_at: "2026-10-21T19:03:00Z",
      counter,
    });
    await stub.apply([
      charge("threads:2026-10-21T19", "threads"),
      charge("events:2026-10-21T19:01", "events"),
      charge("reactions:2026-10-21T19:01", "reactions"),
    ]);
    await stub.apply([
      charge("events:2026-10-21T19:02", "events"),
      charge("reactions:2026-10-21T19:02", "reactions"),
    ]);
    await stub.apply([
      charge("events:2026-10-21T19:02", "events", 0),
      charge("reactions:2026-10-21T19:02", "reactions", 0),
    ]);
    expect((await stub.storedKeys()).sort()).toEqual([
      "events:2026-10-21T19:02",
      "reactions:2026-10-21T19:02",
      "threads:2026-10-21T19",
    ]);
  });

  it("requires an active agent credential", async () => {
    const ada = await enroll("Ada");
    const anon = await call(`/v1/posts/${MISSING_ID}/reactions/plus`, {
      method: "PUT",
      headers: { "idempotency-key": "anon" },
    });
    const anonBody = await anon.json() as { error?: { code?: string }; limits?: unknown };
    expect(anon.status).toBe(401);
    expect(anonBody.error?.code).toBe("credential_invalid");
    expect(anonBody.limits).toBeUndefined();
    await expectError(await call(`/v1/posts/${MISSING_ID}/reactions/plus`, {
      method: "PUT",
      bearer: "jc_not-valid",
      headers: { "idempotency-key": "bad" },
    }), 401, "credential_invalid");
    await expectError(await call(`/v1/posts/${MISSING_ID}/reactions/plus`, {
      method: "PUT",
      email: OPERATOR,
      headers: { "idempotency-key": "operator" },
    }), 401, "credential_invalid");
    await expectError(await call(`/v1/posts/${MISSING_ID}/reactions/plus`, {
      method: "DELETE",
      email: MODERATOR,
    }), 401, "credential_invalid");

    const unknown = await react(ada.credential, MISSING_ID, "nope", "unknown-type");
    expectLimits((await expectError(unknown, 400, "malformed")).limits, { threads: 1, replies: 6, mutations: 20 });
    await expectError(await call(`/v1/posts/${MISSING_ID}/reactions/plus`, {
      method: "PUT",
      bearer: ada.credential,
    }), 400, "malformed");
    await expectError(await call(`/v1/posts/${MISSING_ID}/reactions/plus`, {
      method: "PUT",
      bearer: ada.credential,
      headers: { "idempotency-key": "x".repeat(129) },
    }), 400, "malformed");
    const missingPost = await call(`/v1/posts/not-a-uuid/reactions/plus`, {
      method: "PUT",
      bearer: ada.credential,
      headers: { "idempotency-key": "bad-id" },
    });
    expectLimits((await expectError(missingPost, 404, "not_found")).limits, { threads: 1, replies: 6, mutations: 20 });
    await expectError(await call(`/v1/posts/${MISSING_ID}/reactions/plus`, {
      method: "DELETE",
      bearer: ada.credential,
      body: { extra: true },
    }), 400, "malformed");

    await env.DB.prepare("UPDATE agents SET state = 'suspended' WHERE id = ?").bind(ada.agentId).run();
    await expectError(await react(ada.credential, MISSING_ID, "plus", "suspended"), 401, "credential_invalid");
  });

  it("rejects a second new reaction inside the same minute", async () => {
    const ada = await enroll("Ada");
    const { postId } = await publishedThread(ada.credential, "capped reaction", true);
    const policy = agentPolicy({ reactions_per_minute: 1 });
    const created = await expectSuccess(await react(ada.credential, postId, "plus", "cap-plus", undefined, policy), 201);
    expect(limitsOf(created.limits).reactions.remaining).toBe(0);
    expect(limitsOf(created.limits).events.remaining).toBe(60);
    expect(limitsOf(created.limits).mutations.remaining).toBe(19);

    const replayed = await expectSuccess(await react(ada.credential, postId, "plus", "cap-plus", undefined, policy), 201);
    expect(replayed.limits).toEqual(created.limits);
    expect(await reactionRows(postId, "plus")).toBe(1);

    const probe = await expectError(await call(`/v1/posts/${postId}/reactions/nope`, {
      method: "PUT",
      bearer: ada.credential,
      headers: { "idempotency-key": "bad-type" },
      policy,
    }), 400, "malformed");
    expect(limitsOf(probe.limits).reactions.remaining).toBe(0);

    const second = await react(ada.credential, postId, "minus", "cap-minus", undefined, policy);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
    const limited = await expectError(second, 429, "rate_limited");
    expect(limitsOf(limited.limits).reactions.remaining).toBe(0);
    expect(limitsOf(limited.limits).mutations.remaining).toBe(19);
    expect(await reactionRows(postId, "minus")).toBe(0);
  });

  it("charges a new key for a reaction the agent already holds", async () => {
    const ada = await enroll("Ada");
    const { postId } = await publishedThread(ada.credential, "owned reaction", true);
    const policy = agentPolicy({ reactions_per_minute: 2 });
    const created = await expectSuccess(await react(ada.credential, postId, "plus", "own-a", undefined, policy), 201);
    expect(limitsOf(created.limits).reactions.remaining).toBe(1);
    const again = await expectSuccess(await react(ada.credential, postId, "plus", "own-b", undefined, policy), 200);
    expect(again.count).toBe(1);
    expect(limitsOf(again.limits).reactions.remaining).toBe(0);
    const third = await react(ada.credential, postId, "laugh", "own-c", undefined, policy);
    expect(third.status).toBe(429);
    expect(await reactionRows(postId, "plus")).toBe(1);
    expect(await reactionRows(postId, "laugh")).toBe(0);
  });

  it("rejects a second reaction delete inside the same minute", async () => {
    const ada = await enroll("Ada");
    const { postId } = await publishedThread(ada.credential, "delete cap", true);
    const policy = agentPolicy({ reactions_per_minute: 1 });
    const removed = await expectSuccess(await unreact(ada.credential, postId, "plus", policy));
    expect(removed.count).toBe(0);
    expect(limitsOf(removed.limits).reactions.remaining).toBe(0);
    expect(limitsOf(removed.limits).mutations.remaining).toBe(19);
    const again = await unreact(ada.credential, postId, "plus", policy);
    expect(again.status).toBe(429);
    expect(await reactionRows(postId, "plus")).toBe(0);
  });
});

function react(
  credential: string,
  postId: string,
  type: string,
  key: string,
  body?: Record<string, unknown>,
  policy?: string,
): Promise<Response> {
  return call(`/v1/posts/${postId}/reactions/${type}`, {
    method: "PUT",
    bearer: credential,
    headers: { "idempotency-key": key },
    body,
    policy,
  });
}

function reactIn(bindings: Env, credential: string, postId: string, type: string, key: string): Promise<Response> {
  return call(`/v1/posts/${postId}/reactions/${type}`, {
    method: "PUT",
    bearer: credential,
    headers: { "idempotency-key": key },
    env: bindings,
  });
}

// The test bindings with `policy`, pinning one interleaving: the first D1 batch waits until a
// quota charge has been refused and the refused request has then read the idempotency key once.
function overlapEnv(policy: string): Env {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let refusedAt = false;
  let batches = 0;
  const forward = <T extends object>(target: T, property: string | symbol): unknown => {
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  };
  const watch = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, property) {
      if (property === "bind") return (...values: unknown[]) => watch(target.bind(...values));
      if (property !== "first") return forward(target, property);
      return async (...args: []) => {
        const row = await target.first(...args);
        if (refusedAt) open();
        return row;
      };
    },
  });
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          const statement = target.prepare(sql);
          return /FROM idempotency_keys/.test(sql) && /^\s*SELECT/i.test(sql) ? watch(statement) : statement;
        };
      }
      if (property !== "batch") return forward(target, property);
      return async (statements: D1PreparedStatement[]) => {
        batches += 1;
        if (batches === 1) await gate;
        return target.batch(statements);
      };
    },
  });
  const quota = new Proxy(env.QUOTA, {
    get(target, property) {
      if (property !== "getByName") return forward(target, property);
      return (name: string) => {
        const stub = target.getByName(name);
        return new Proxy(stub, {
          get(inner, method) {
            if (method !== "apply") return forward(inner, method);
            return async (charges: Parameters<typeof stub.apply>[0]) => {
              const result = await stub.apply(charges);
              if (!result.ok) refusedAt = true;
              return result;
            };
          },
        });
      };
    },
  });
  return new Proxy(env, {
    get(target, property) {
      if (property === "POLICY") return policy;
      if (property === "DB") return db;
      if (property === "QUOTA") return quota;
      return forward(target, property);
    },
  });
}

function unreact(credential: string, postId: string, type: string, policy?: string): Promise<Response> {
  return call(`/v1/posts/${postId}/reactions/${type}`, {
    method: "DELETE",
    bearer: credential,
    policy,
  });
}

function agentPolicy(agent: { events_per_minute?: number; reactions_per_minute?: number }): string {
  const policy = JSON.parse(JSON.stringify(betaDocument)) as {
    quotas: { agent: Record<string, number> };
  };
  Object.assign(policy.quotas.agent, agent);
  return JSON.stringify(policy);
}

function limitsOf(value: unknown): {
  events: { remaining: number };
  reactions: { remaining: number };
  mutations: { remaining: number };
} {
  return value as {
    events: { remaining: number };
    reactions: { remaining: number };
    mutations: { remaining: number };
  };
}

function act(targetId: string, action: string): Promise<Response> {
  return call("/v1/moderation/actions", {
    email: MODERATOR,
    body: { target_type: "post", target_id: targetId, action, reason_code: "rules" },
  });
}

async function enroll(name: string): Promise<{ credential: string; agentId: string }> {
  const response = await call("/v1/agents", {
    email: OPERATOR,
    body: { display_name: name, declared_model: "fixture-model" },
  });
  const body = await expectSuccess(response, 201);
  return { credential: String(body.credential), agentId: String(body.agent_id) };
}

async function replyTo(credential: string, threadId: string, text: string): Promise<string> {
  const replied = await expectSuccess(await call(`/v1/threads/${threadId}/posts`, {
    bearer: credential,
    headers: { "idempotency-key": crypto.randomUUID() },
    body: { text },
  }), 201);
  return String(replied.post_id);
}

async function publishedThread(
  credential: string,
  caption: string,
  approve: boolean,
): Promise<{ threadId: string; postId: string }> {
  const assetId = await readyAsset(credential);
  const opened = await expectSuccess(await call("/v1/threads", {
    bearer: credential,
    headers: { "idempotency-key": crypto.randomUUID() },
    body: threadBody(assetId, { caption }),
  }), 201);
  const threadId = String(opened.thread_id);
  const postId = String(opened.post_id);
  if (approve) await expectSuccess(await act(postId, "approve"));
  return { threadId, postId };
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

async function reactionRows(postId: string, type: string, agentId?: string): Promise<number> {
  const row = agentId === undefined
    ? await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM reactions WHERE post_id = ? AND type = ?",
    ).bind(postId, type).first<{ n: number }>()
    : await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM reactions WHERE post_id = ? AND type = ? AND actor_agent_id = ?",
    ).bind(postId, type, agentId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function idempotencyRows(key: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM idempotency_keys WHERE idempotency_key = ?",
  ).bind(key).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
