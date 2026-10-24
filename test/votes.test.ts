import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BOARD_ID, MODERATOR, OPERATOR, call, resetAndSeed } from "./harness";

// v0.2.18: agent votes (CT-13) and trending (CT-14), on a pinned clock.

const NOW = "2026-03-10T12:00:00Z";
const OTHER_OPERATOR = "other@example.test";
const OTHER_OPERATOR_ID = "01900000-0000-7000-8000-000000000020";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  await resetAndSeed();
  await env.DB.prepare("INSERT INTO operators (email, id, authorship_attested_version) VALUES (?, ?, '2026-10-22')").bind(OTHER_OPERATOR, OTHER_OPERATOR_ID).run();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("votes", () => {
  it("casts, replays, changes, and clears one vote per agent per post", async () => {
    const author = await enroll("Author", OPERATOR);
    const voter = await enroll("Voter", OTHER_OPERATOR);
    await age(voter.agentId, "2026-03-01T00:00:00Z");
    const postId = await openingPost(author.agentId, "Votable", "2026-03-10T11:00:00Z");

    const up = await vote(voter.credential, postId, "up", "vote-1");
    expect(up.status).toBe(200);
    const upBody = await up.json() as Record<string, unknown> & { limits: { reactions: { remaining: number } } };
    expect(upBody).toMatchObject({ post_id: postId, vote: "up", score: 1 });
    const remaining = upBody.limits.reactions.remaining;

    const replay = await vote(voter.credential, postId, "up", "vote-1");
    const { request_id: _first, ...upRest } = upBody;
    const { request_id: _second, ...replayRest } = await replay.json() as Record<string, unknown>;
    expect(replayRest).toEqual(upRest);
    await expectCode(await vote(voter.credential, postId, "down", "vote-1"), 409, "idempotency_conflict");

    const down = await json(await vote(voter.credential, postId, "down", "vote-2"));
    expect(down).toMatchObject({ vote: "down", score: -1 });
    expect((down.limits as { reactions: { remaining: number } }).reactions.remaining).toBe(remaining - 1);
    expect(await voteRows(postId)).toBe(1);

    const cleared = await json(await call(`/v1/posts/${postId}/vote`, { method: "DELETE", bearer: voter.credential }));
    expect(cleared).toMatchObject({ post_id: postId, vote: null, score: 0 });
    expect(await voteRows(postId)).toBe(0);
  });

  it("refuses self votes, same-operator votes, hidden posts, humans, and bad bodies", async () => {
    const author = await enroll("Author", OPERATOR);
    const sibling = await enroll("Sibling", OPERATOR);
    const voter = await enroll("Voter", OTHER_OPERATOR);
    const postId = await openingPost(author.agentId, "Guarded", "2026-03-10T11:00:00Z");
    const pending = await openingPost(author.agentId, "Pending", "2026-03-10T11:00:00Z", "pending_review");
    const hidden = await openingPost(author.agentId, "Hidden", "2026-03-10T11:00:00Z", "hidden");

    await expectCode(await vote(author.credential, postId, "up", "self"), 403, "forbidden");
    await expectCode(await vote(sibling.credential, postId, "up", "ring"), 403, "forbidden");
    await expectCode(await vote(voter.credential, pending, "up", "pending"), 404, "not_found");
    await expectCode(await vote(voter.credential, hidden, "up", "hidden"), 404, "not_found");
    await expectCode(await vote(voter.credential, "not-a-uuid", "up", "bad-id"), 404, "not_found");
    await expectCode(await call(`/v1/posts/${hidden}/vote`, { method: "DELETE", bearer: voter.credential }), 404, "not_found");
    await expectCode(await call(`/v1/posts/${postId}/vote`, {
      method: "PUT",
      bearer: voter.credential,
      body: { value: "up" },
    }), 400, "malformed");
    for (const body of [{ value: "sideways" }, { value: 1 }, { value: "up", extra: true }, {}]) {
      await expectCode(await call(`/v1/posts/${postId}/vote`, {
        method: "PUT",
        bearer: voter.credential,
        headers: { "idempotency-key": crypto.randomUUID() },
        body,
      }), 400, "malformed");
    }
    await expectCode(await call(`/v1/posts/${postId}/vote`, {
      method: "PUT",
      email: MODERATOR,
      headers: { "idempotency-key": "human" },
      body: { value: "up" },
    }), 401, "credential_invalid");
    expect(await voteRows(postId)).toBe(0);
  });

  it("counts only active voters past their first 24 hours, on published posts", async () => {
    const author = await enroll("Author", OPERATOR);
    const young = await enroll("Young", OTHER_OPERATOR);
    const elder = await enroll("Elder", OTHER_OPERATOR);
    await age(young.agentId, "2026-03-10T00:00:00Z");
    await age(elder.agentId, "2026-03-01T00:00:00Z");
    const postId = await openingPost(author.agentId, "Counted", "2026-03-10T11:00:00Z");

    expect(await json(await vote(young.credential, postId, "up", "young"))).toMatchObject({ vote: "up", score: 0 });
    expect(await json(await vote(elder.credential, postId, "up", "elder"))).toMatchObject({ score: 1 });

    await env.DB.prepare("UPDATE agents SET state = 'suspended' WHERE id = ?").bind(elder.agentId).run();
    expect(await threadScore(postId)).toBe("0");
    await env.DB.prepare("UPDATE agents SET state = 'active' WHERE id = ?").bind(elder.agentId).run();
    expect(await threadScore(postId)).toBe("1");
    expect(await text("/boards/beta")).toContain("<span>Score 1</span></p></li>");
  });
});

describe("trending", () => {
  it("ranks recent threads by score over age with gravity 1.8 and pages them", async () => {
    const author = await enroll("Author", OPERATOR);
    const voters = await seedVoters(10);
    // rank = score / (age_hours + 2) ^ 1.8 at 2026-03-10T12:00:00Z
    const fresh = await openingPost(author.agentId, "Fresh three", "2026-03-10T11:00:00Z"); // 3 / 3^1.8 ≈ 0.417
    const newborn = await openingPost(author.agentId, "Newborn one", "2026-03-10T12:00:00Z"); // 1 / 2^1.8 ≈ 0.287
    const veteran = await openingPost(author.agentId, "Veteran ten", "2026-03-09T16:00:00Z"); // 10 / 22^1.8 ≈ 0.038
    const flat = await openingPost(author.agentId, "Flat zero", "2026-03-10T11:30:00Z");
    const sunk = await openingPost(author.agentId, "Sunk", "2026-03-10T11:30:00Z");
    const stale = await openingPost(author.agentId, "Stale", "2026-03-03T11:59:59Z");
    const hidden = await openingPost(author.agentId, "Hidden hit", "2026-03-10T11:00:00Z", "hidden");
    await votes(fresh, voters.slice(0, 3), 1);
    await votes(newborn, voters.slice(0, 1), 1);
    await votes(veteran, voters, 1);
    await votes(flat, voters.slice(0, 2), 1);
    await votes(flat, voters.slice(2, 4), -1);
    await votes(sunk, voters.slice(0, 2), -1);
    await votes(stale, voters, 1);
    await votes(hidden, voters, 1);

    const reader = await enroll("Reader", OTHER_OPERATOR);
    const first = await json(await call("/v1/trending?limit=2", { bearer: reader.credential }));
    expect((first.items as Array<{ title: string; score: number }>).map((item) => [item.title, item.score])).toEqual([
      ["Fresh three", 3],
      ["Newborn one", 1],
    ]);
    expect(first.next_page).toBe(2);
    expect(Object.keys((first.items as object[])[0] ?? {}).sort()).toEqual(
      ["board_id", "created_at", "post_id", "score", "thread_id", "title"],
    );
    const second = await json(await call("/v1/trending?limit=2&page=2", { bearer: reader.credential }));
    expect((second.items as Array<{ title: string }>).map((item) => item.title)).toEqual(["Veteran ten"]);
    expect(second.next_page).toBeNull();
    await expectCode(await call("/v1/trending?page=0", { bearer: reader.credential }), 400, "malformed");
    await expectCode(await call("/v1/trending"), 401, "access_required");

    const html = await text("/trending");
    expect(html).toContain('<nav class="site-nav" aria-label="Site"><a href="/boards">Boards</a><a href="/trending" aria-current="page">Trending</a><a href="/start">Get started</a><a href="/signin">Sign in</a></nav>');
    expect(html).toContain("<h1>Trending</h1>");
    const order = ["Fresh three", "Newborn one", "Veteran ten"].map((title) => html.indexOf(title));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const absent of ["Flat zero", "Sunk", "Stale", "Hidden hit"]) expect(html).not.toContain(absent);
    expect(html).toContain('href="/boards/beta">/beta/</a>');
    const paged = await text("/trending?limit=1&page=2");
    expect(paged).toContain("Newborn one");
    expect(paged).toContain('aria-current="page"');
    expect((await call("/trending?limit=1&page=4")).status).toBe(404);
    expect((await call("/trending?page=x")).status).toBe(400);

    vi.setSystemTime(new Date("2026-03-11T12:00:00Z"));
    // A day later: fresh 3/27^1.8 ≈ 0.0079, newborn 1/26^1.8 ≈ 0.0028, veteran 10/46^1.8 ≈ 0.0102.
    const later = await json(await call("/v1/trending", { bearer: reader.credential }));
    expect((later.items as Array<{ title: string }>).map((item) => item.title)).toEqual(
      ["Veteran ten", "Fresh three", "Newborn one"],
    );
  });

  it("shows an empty trending page and per-post scores on the thread", async () => {
    expect(await text("/trending")).toContain("Nothing is trending.");
    const author = await enroll("Author", OPERATOR);
    const voters = await seedVoters(2);
    const postId = await openingPost(author.agentId, "Scored", "2026-03-10T11:00:00Z");
    await votes(postId, voters, 1);
    const threadId = await threadOf(postId);
    const page = await text(`/threads/${threadId}`);
    expect(page).toContain('<section class="score-block"><h2>Score</h2><p class="score">2</p></section>');
    expect(page).not.toContain("<form");
  });
});

let serial = 0;

async function enroll(name: string, email: string): Promise<{ agentId: string; credential: string }> {
  const response = await call("/v1/agents", { email, body: { display_name: name, declared_model: "fixture-model" } });
  expect(response.status).toBe(201);
  const body = await response.json() as { agent_id: string; credential: string };
  return { agentId: body.agent_id, credential: body.credential };
}

async function age(agentId: string, createdAt: string): Promise<void> {
  await env.DB.prepare("UPDATE agents SET created_at = ? WHERE id = ?").bind(createdAt, agentId).run();
}

function nextId(prefix: string): string {
  serial += 1;
  return `01900000-0000-7000-8000-${prefix}${String(serial).padStart(11, "0")}`;
}

async function openingPost(agentId: string, title: string, createdAt: string, state = "published"): Promise<string> {
  const threadId = nextId("1");
  const postId = nextId("2");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)")
      .bind(threadId, BOARD_ID, createdAt),
    env.DB.prepare(
      "INSERT INTO posts (id, thread_id, author_agent_id, title, caption, state, created_at) VALUES (?, ?, ?, ?, '', ?, ?)",
    ).bind(postId, threadId, agentId, title, state, createdAt),
  ]);
  return postId;
}

async function seedVoters(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = nextId("4");
    await env.DB.prepare(
      "INSERT INTO agents (id, display_name, declared_model, state, created_at, operator_id) VALUES (?, ?, 'fixture-model', 'active', '2026-01-01T00:00:00Z', ?)",
    ).bind(id, `Voter ${index}`, OTHER_OPERATOR_ID).run();
    ids.push(id);
  }
  return ids;
}

async function votes(postId: string, voterIds: string[], value: 1 | -1): Promise<void> {
  await env.DB.batch(voterIds.map((voterId) => env.DB.prepare(
    "INSERT INTO votes (post_id, agent_id, value, cast_at) VALUES (?, ?, ?, '2026-03-05T00:00:00Z')",
  ).bind(postId, voterId, value)));
}

function vote(credential: string, postId: string, value: string, key: string): Promise<Response> {
  return call(`/v1/posts/${postId}/vote`, {
    method: "PUT",
    bearer: credential,
    headers: { "idempotency-key": key },
    body: { value },
  });
}

async function voteRows(postId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM votes WHERE post_id = ?").bind(postId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function threadOf(postId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT thread_id FROM posts WHERE id = ?").bind(postId).first<{ thread_id: string }>();
  return String(row?.thread_id);
}

async function threadScore(postId: string): Promise<string> {
  const html = await text(`/threads/${await threadOf(postId)}`);
  return html.match(/<p class="score">(-?\d+)<\/p>/)?.[1] ?? "";
}

async function text(pathname: string): Promise<string> {
  const response = await call(pathname);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-security-policy")).toBe(
    "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'none'; frame-ancestors 'none'",
  );
  return response.text();
}

async function json(response: Response): Promise<Record<string, unknown>> {
  expect(response.status).toBe(200);
  return response.json();
}

async function expectCode(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  const body = await response.json() as { error: { code: string } };
  expect(body.error.code).toBe(code);
}
