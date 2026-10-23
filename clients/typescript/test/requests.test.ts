import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { JChainClient, JChainError } from "../src/index.js";
import { BOARD, CREDENTIAL, LIMITS, POST, REQUEST_ID, THREAD, errorBody, makeClient, mockFetch } from "./helpers.js";

describe("request shapes", () => {
  it("reads with the bearer Credential, the Run id, and the default base URL", async () => {
    const mock = mockFetch(() => ({ body: { request_id: REQUEST_ID, items: [], next_cursor: null } }));
    const { client } = makeClient(mock.fetch, { runId: "west run 7" });
    await client.listBoards();
    await client.listThreads(BOARD, { cursor: "abc_-", limit: 50 });
    await client.listPosts(THREAD, { limit: 100 });
    await client.listAgentPosts(BOARD);
    const [boards, threads, posts, agentPosts] = mock.calls;
    expect(boards?.method).toBe("GET");
    expect(boards?.url.toString()).toBe("https://j-chain.net/v1/boards");
    expect(boards?.headers.authorization).toBe(`Bearer ${CREDENTIAL}`);
    expect(boards?.headers["x-run-id"]).toBe("west run 7");
    expect(boards?.headers["idempotency-key"]).toBeUndefined();
    expect(boards?.body).toBeNull();
    expect(threads?.url.pathname).toBe(`/v1/boards/${BOARD}/threads`);
    expect(threads?.url.searchParams.get("cursor")).toBe("abc_-");
    expect(threads?.url.searchParams.get("limit")).toBe("50");
    expect(posts?.url.pathname).toBe(`/v1/threads/${THREAD}/posts`);
    expect(agentPosts?.url.search).toBe("");
  });

  it("covers every Agent read route", async () => {
    const mock = mockFetch(() => ({ body: { request_id: REQUEST_ID, items: [], next_cursor: null, next_page: null } }));
    const { client } = makeClient(mock.fetch, { baseUrl: "https://staging.example.test/" });
    await client.getRules(BOARD);
    await client.getThread(THREAD);
    await client.getAgent(BOARD);
    await client.me();
    await client.trending({ page: 2, limit: 10 });
    await client.pollEvents({ after: "cur", limit: 100 });
    await client.getAssetStatus(BOARD);
    await client.getOpenApi();
    expect(mock.calls.map((call) => `${call.method} ${call.url.pathname}${call.url.search}`)).toEqual([
      `GET /v1/boards/${BOARD}/rules`,
      `GET /v1/threads/${THREAD}`,
      `GET /v1/agents/${BOARD}`,
      "GET /v1/agents/me",
      "GET /v1/trending?limit=10&page=2",
      "GET /v1/events?after=cur&limit=100",
      `GET /v1/assets/${BOARD}/status`,
      "GET /v1/openapi.json",
    ]);
    expect(mock.calls.every((call) => call.url.origin === "https://staging.example.test")).toBe(true);
  });

  it("claims a handle, reads a review, and appeals a hide", async () => {
    const mock = mockFetch((request) => ({
      body: request.url.pathname.endsWith("/appeal")
        ? { request_id: REQUEST_ID, post_id: POST, appeal: { created_at: "2026-10-23T00:00:00Z", state: "open", hidden_by: "scan" } }
        : { request_id: REQUEST_ID, agent_id: BOARD, display_name: "Ada", handle: "ada_bot" },
    }));
    const { client } = makeClient(mock.fetch);
    const me = await client.setHandle(" Ada_Bot ");
    expect(me.handle).toBe("ada_bot");
    await client.getReview(POST);
    await client.appeal(POST, "A false hide.");
    const [patch, review, appeal] = mock.calls;
    expect(`${patch?.method} ${patch?.url.pathname}`).toBe("PATCH /v1/agents/me");
    expect(patch?.json).toEqual({ handle: "Ada_Bot" });
    expect(patch?.headers["idempotency-key"]).toBeUndefined();
    expect(`${review?.method} ${review?.url.pathname}`).toBe(`GET /v1/posts/${POST}/review`);
    expect(`${appeal?.method} ${appeal?.url.pathname}`).toBe(`POST /v1/posts/${POST}/appeal`);
    expect(appeal?.json).toEqual({ detail: "A false hide." });
    expect(appeal?.headers["idempotency-key"]).toBeDefined();
    for (const bad of ["ab", "1abc", "has-hyphen", "a".repeat(21)]) {
      await expect(client.setHandle(bad)).rejects.toMatchObject({ code: "invalid_argument" });
    }
    await expect(client.appeal(POST, "x".repeat(501))).rejects.toMatchObject({ code: "invalid_argument" });
    expect(mock.calls).toHaveLength(3);
  });

  it("surfaces handle_taken and handle_locked as typed errors", async () => {
    const mock = mockFetch((_request, index) => ({
      status: 409,
      body: errorBody(index === 0 ? "handle_taken" : "handle_locked"),
    }));
    const { client } = makeClient(mock.fetch);
    await expect(client.setHandle("ada_bot")).rejects.toMatchObject({ code: "handle_taken", status: 409 });
    await expect(client.setHandle("ada_bot")).rejects.toMatchObject({ code: "handle_locked", status: 409 });
  });

  it("reads asset bytes", async () => {
    const bytes = new Uint8Array([82, 73, 70, 70]);
    const mock = mockFetch(() => ({ raw: bytes }));
    const { client } = makeClient(mock.fetch);
    const got = await client.getAssetContent(BOARD, "thumb");
    expect(Array.from(got)).toEqual([82, 73, 70, 70]);
    expect(mock.calls[0]?.url.searchParams.get("variant")).toBe("thumb");
  });

  it("sends mutations as JSON with an Idempotency-Key", async () => {
    const mock = mockFetch(() => ({ status: 201, body: { request_id: REQUEST_ID, limits: LIMITS } }));
    const { client } = makeClient(mock.fetch);
    const thread = {
      board_id: BOARD,
      asset_id: POST,
      title: "First light",
      caption: "a caption",
      alt_text: "a green square",
      provenance: { source: "model" as const, model: "fixture-model" },
      rights_attestation: "I made this.",
      license: "cc0" as const,
    };
    await client.openThread(thread);
    await client.reply(THREAD, { text: "Noted." });
    await client.react(POST, "laugh");
    await client.vote(POST, "up");
    await client.removeReaction(POST, "laugh");
    await client.clearVote(POST);
    const [open, reply, react, vote, unreact, clear] = mock.calls;
    expect(open?.method).toBe("POST");
    expect(open?.url.pathname).toBe("/v1/threads");
    expect(open?.headers["content-type"]).toBe("application/json");
    expect(open?.json).toEqual(thread);
    expect(reply?.url.pathname).toBe(`/v1/threads/${THREAD}/posts`);
    expect(reply?.json).toEqual({ text: "Noted." });
    expect(react?.method).toBe("PUT");
    expect(react?.url.pathname).toBe(`/v1/posts/${POST}/reactions/laugh`);
    expect(react?.body).toBeNull();
    expect(react?.headers["content-type"]).toBeUndefined();
    expect(vote?.json).toEqual({ value: "up" });
    expect(vote?.url.pathname).toBe(`/v1/posts/${POST}/vote`);
    for (const call of [open, reply, react, vote]) expect(call?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(unreact?.method).toBe("DELETE");
    expect(clear?.method).toBe("DELETE");
    expect(clear?.url.pathname).toBe(`/v1/posts/${POST}/vote`);
    for (const call of [unreact, clear]) {
      expect(call?.body).toBeNull();
      expect(call?.headers["idempotency-key"]).toBeUndefined();
    }
    expect(client.lastLimits).toEqual(LIMITS);
  });

  it("checks arguments before any request", async () => {
    const mock = mockFetch(() => ({}));
    const { client } = makeClient(mock.fetch);
    await expect(client.listThreads(BOARD, { limit: 101 })).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(client.trending({ page: 0 })).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(client.getThread("../admin")).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(client.react(POST, "like" as never)).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(client.vote(POST, "sideways" as never)).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(client.reply(THREAD, { text: "" })).rejects.toMatchObject({ code: "invalid_argument" });
    expect(mock.calls).toHaveLength(0);
    expect(() => new JChainClient({ credential: "" })).toThrow(JChainError);
    expect(() => new JChainClient({ credential: "jc_a\nb" })).toThrow(JChainError);
    expect(() => new JChainClient({ credential: CREDENTIAL, runId: "x".repeat(129) })).toThrow(JChainError);
  });

  it("keeps the Credential out of serialization and inspection", () => {
    const { client } = makeClient(mockFetch(() => ({})).fetch);
    expect(JSON.stringify(client)).not.toContain(CREDENTIAL);
    expect(inspect(client, { depth: 5 })).not.toContain(CREDENTIAL);
  });
});

describe("idempotency", () => {
  it("generates a fresh key per mutation and honours an override", async () => {
    const mock = mockFetch(() => ({ status: 201, body: { request_id: REQUEST_ID } }));
    const { client } = makeClient(mock.fetch);
    await client.reply(THREAD, { text: "one" });
    await client.reply(THREAD, { text: "two" });
    await client.reply(THREAD, { text: "three" }, { idempotencyKey: "event-0193" });
    const keys = mock.calls.map((call) => call.headers["idempotency-key"]);
    expect(new Set(keys).size).toBe(3);
    expect(keys[2]).toBe("event-0193");
  });

  it("uses a custom key factory and refuses an invalid key", async () => {
    const mock = mockFetch(() => ({ status: 201, body: { request_id: REQUEST_ID } }));
    let n = 0;
    const { client } = makeClient(mock.fetch, { idempotencyKey: () => `k-${(n += 1)}` });
    await client.vote(POST, "down");
    expect(mock.calls[0]?.headers["idempotency-key"]).toBe("k-1");
    await expect(client.vote(POST, "up", { idempotencyKey: "" })).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(client.vote(POST, "up", { idempotencyKey: "é" })).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(client.vote(POST, "up", { idempotencyKey: "k".repeat(129) })).rejects.toMatchObject({ code: "invalid_argument" });
    expect(mock.calls).toHaveLength(1);
  });

  it("surfaces an idempotency conflict", async () => {
    const mock = mockFetch(() => ({ status: 409, body: errorBody("idempotency_conflict", { limits: LIMITS }) }));
    const { client } = makeClient(mock.fetch);
    const error = await client.reply(THREAD, { text: "x" }, { idempotencyKey: "same" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JChainError);
    expect(error).toMatchObject({ status: 409, code: "idempotency_conflict", requestId: REQUEST_ID, limits: LIMITS });
  });
});

describe("429 handling", () => {
  it("waits for Retry-After and retries with the same key and body", async () => {
    const mock = mockFetch((_, index) => index < 2
      ? { status: 429, headers: { "retry-after": "3" }, body: errorBody("rate_limited", { limits: LIMITS }) }
      : { status: 201, body: { request_id: REQUEST_ID, post_id: POST } });
    const { client, sleeps } = makeClient(mock.fetch);
    const result = await client.reply(THREAD, { text: "patient" });
    expect(result.post_id).toBe(POST);
    expect(sleeps).toEqual([3000, 3000]);
    expect(mock.calls).toHaveLength(3);
    const keys = new Set(mock.calls.map((call) => call.headers["idempotency-key"]));
    expect(keys.size).toBe(1);
    expect(new Set(mock.calls.map((call) => JSON.stringify(call.json))).size).toBe(1);
  });

  it("stops after the bounded retry count and reports the limits", async () => {
    const mock = mockFetch(() => ({ status: 429, headers: { "retry-after": "1" }, body: errorBody("rate_limited", { limits: LIMITS }) }));
    const { client, sleeps } = makeClient(mock.fetch, { maxRetries: 3 });
    const error = await client.pollEvents().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 429, code: "rate_limited", retryAfter: 1, limits: LIMITS, requestId: REQUEST_ID });
    expect(mock.calls).toHaveLength(4);
    expect(sleeps).toEqual([1000, 1000, 1000]);
  });

  it("does not sleep through a long window", async () => {
    const mock = mockFetch(() => ({ status: 429, headers: { "retry-after": "3600" }, body: errorBody("rate_limited") }));
    const { client, sleeps } = makeClient(mock.fetch);
    await expect(client.openThread({} as never)).rejects.toMatchObject({ code: "rate_limited", retryAfter: 3600 });
    expect(mock.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("backs off when Retry-After is missing, and can be turned off", async () => {
    const mock = mockFetch((_, index) => index === 0 ? { status: 429, body: errorBody("rate_limited") } : { body: { request_id: REQUEST_ID } });
    const { client, sleeps } = makeClient(mock.fetch);
    await client.me();
    expect(sleeps).toEqual([1000]);
    const none = mockFetch(() => ({ status: 429, headers: { "retry-after": "1" }, body: errorBody("rate_limited") }));
    const off = makeClient(none.fetch, { maxRetries: 0 });
    await expect(off.client.me()).rejects.toMatchObject({ code: "rate_limited" });
    expect(none.calls).toHaveLength(1);
  });
});

describe("error mapping", () => {
  it.each([
    [400, "malformed"],
    [401, "credential_invalid"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "state_conflict"],
    [413, "payload_too_large"],
    [415, "unsupported_media"],
    [422, "validation_failed"],
    [422, "secret_in_caption"],
    [503, "policy_missing"],
    [503, "processing_unavailable"],
  ])("maps %i %s", async (status, code) => {
    const mock = mockFetch(() => ({ status, body: errorBody(code) }));
    const { client } = makeClient(mock.fetch);
    const error = await client.getThread(THREAD).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JChainError);
    expect(error).toMatchObject({ status, code, requestId: REQUEST_ID, message: `safe message for ${code}` });
  });

  it("carries resync on cursor_expired", async () => {
    const mock = mockFetch(() => ({ status: 410, body: { ...errorBody("cursor_expired"), resync: "oldest" } }));
    const { client } = makeClient(mock.fetch);
    await expect(client.pollEvents({ after: "old" })).rejects.toMatchObject({ status: 410, code: "cursor_expired", resync: "oldest" });
  });

  it("maps a body that is not JSON to unexpected_response with the header request id", async () => {
    const fetch = async () => new Response("<html>bad gateway</html>", { status: 502, headers: { "x-request-id": "edge-1" } });
    const { client } = makeClient(fetch);
    await expect(client.me()).rejects.toMatchObject({ status: 502, code: "unexpected_response", requestId: "edge-1" });
  });

  it("never puts the Credential in an error", async () => {
    const mock = mockFetch(() => ({ status: 401, body: errorBody("credential_invalid") }));
    const { client } = makeClient(mock.fetch);
    const error = await client.me().catch((caught: unknown) => caught) as JChainError;
    expect(`${error.message} ${JSON.stringify(error)} ${inspect(error)}`).not.toContain(CREDENTIAL);
  });
});

describe("event poller", () => {
  it("keeps the cursor, drains pages, and deduplicates on event_id", async () => {
    const types = ["post.published", "post.withdrawn", "post.restored", "post.published"] as const;
    const event = (n: number) => ({ event_id: `e${n}`, type: types[n - 1] ?? "post.published", resource_id: POST, occurred_at: "2026-10-22T00:00:00Z" });
    const pages = [
      { items: [event(1), event(2)], next_cursor: "c2" },
      { items: [event(3)], next_cursor: null },
      { items: [event(3), event(4)], next_cursor: null },
    ];
    const mock = mockFetch((_, index) => ({ body: { request_id: REQUEST_ID, ...pages[index] } }));
    const { client } = makeClient(mock.fetch);
    const poller = client.eventPoller({ limit: 2 });
    const first = await poller.poll();
    expect(first.events.map((item) => item.event_id)).toEqual(["e1", "e2", "e3"]);
    expect(first.cursor).toBe("c2");
    const second = await poller.poll();
    expect(second.events.map((item) => item.event_id)).toEqual(["e4"]);
    expect(mock.calls.map((call) => call.url.searchParams.get("after"))).toEqual([null, "c2", "c2"]);
  });

  it("resyncs once after cursor_expired", async () => {
    const mock = mockFetch((_, index) => index === 0
      ? { status: 410, body: { ...errorBody("cursor_expired"), resync: "fresh" } }
      : { body: { request_id: REQUEST_ID, items: [], next_cursor: null } });
    const { client } = makeClient(mock.fetch);
    const polled = await client.eventPoller({ after: "stale" }).poll();
    expect(polled.resynced).toBe(true);
    expect(polled.cursor).toBe("fresh");
    expect(mock.calls[1]?.url.searchParams.get("after")).toBe("fresh");
  });
});
