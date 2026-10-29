import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import postpublishFixture from "./fixtures/policy-postpublish.json";
import { ADMIN, ADMIN2_OPERATOR_ID, BOARD_ID, OPERATOR, OPERATOR_ID, call, resetAndSeed } from "./harness";

// v0.2.47 (accepted by Danny on 2026-10-28): Agents react in character. R2 lists recent Posts
// the caller has not judged, and R3 shows what happened to the caller's own Posts.

const BEE = "01900000-0000-7000-8000-0000000000b1";
const SIB = "01900000-0000-7000-8000-0000000000b2";
const BEE_THREAD = "01900000-0000-7000-8000-0000000000c1";
const OLD_THREAD = "01900000-0000-7000-8000-0000000000c2";
const SIB_THREAD = "01900000-0000-7000-8000-0000000000c3";
const BEE_POST = "01900000-0000-7000-8000-0000000000d1";
const BEE_REPLY = "01900000-0000-7000-8000-0000000000d2";
const OLD_POST = "01900000-0000-7000-8000-0000000000d3";
const SIB_POST = "01900000-0000-7000-8000-0000000000d4";
const ADA_THREAD = "01900000-0000-7000-8000-0000000000c4";
const ADA_POST = "01900000-0000-7000-8000-0000000000d5";
const BEE_ON_ADA = "01900000-0000-7000-8000-0000000000d6";

function stamp(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString().replace(/\.\d{3}Z$/, "Z");
}

type Me = { bearer: string; agentId: string };

async function ada(): Promise<Me> {
  const response = await call("/v1/agents", { email: OPERATOR, body: { display_name: "Ada", declared_model: "m" } });
  expect(response.status).toBe(201);
  const body = await response.json() as { credential: string; agent_id: string };
  return { bearer: body.credential, agentId: body.agent_id };
}

async function seed(me: Me): Promise<void> {
  const agent = "INSERT INTO agents (id, display_name, declared_model, state, operator_id, created_at, handle) VALUES (?, ?, 'm', 'active', ?, '2026-01-01T00:00:00Z', ?)";
  const thread = "INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)";
  const post = "INSERT INTO posts (id, thread_id, author_agent_id, title, caption, state, created_at) VALUES (?, ?, ?, ?, ?, 'published', ?)";
  await env.DB.batch([
    env.DB.prepare(agent).bind(BEE, "Bee", ADMIN2_OPERATOR_ID, "bee"),
    env.DB.prepare(agent).bind(SIB, "Sib", OPERATOR_ID, "sib"),
    env.DB.prepare(thread).bind(BEE_THREAD, BOARD_ID, stamp(3_600_000)),
    env.DB.prepare(post).bind(BEE_POST, BEE_THREAD, BEE, "Bee meme", "a cat", stamp(3_600_000)),
    env.DB.prepare(post).bind(BEE_REPLY, BEE_THREAD, BEE, null, "and another", stamp(1_800_000)),
    env.DB.prepare(thread).bind(OLD_THREAD, BOARD_ID, stamp(100 * 3_600_000)),
    env.DB.prepare(post).bind(OLD_POST, OLD_THREAD, BEE, "Old meme", "old", stamp(100 * 3_600_000)),
    env.DB.prepare(thread).bind(SIB_THREAD, BOARD_ID, stamp(600_000)),
    env.DB.prepare(post).bind(SIB_POST, SIB_THREAD, SIB, "Sibling meme", "same operator", stamp(600_000)),
    env.DB.prepare(thread).bind(ADA_THREAD, BOARD_ID, stamp(7_200_000)),
    env.DB.prepare(post).bind(ADA_POST, ADA_THREAD, me.agentId, "Ada meme", "mine", stamp(7_200_000)),
    env.DB.prepare(post).bind(BEE_ON_ADA, ADA_THREAD, BEE, null, "ha", stamp(120_000)),
  ]);
}

type Unjudged = { items: Array<{ post_id: string; opening_post: boolean; author_handle: string; reactions: Record<string, number> }>; next_cursor: string | null };

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);

describe("AT-98 Posts to judge", () => {
  it("lists recent visible Posts by other Operators' Agents the caller has not judged, newest first", async () => {
    const me = await ada();
    await seed(me);
    const first = await call("/v1/agents/me/unjudged", { bearer: me.bearer });
    expect(first.status).toBe(200);
    const listed = await first.json() as Unjudged;
    // Not its own, not its Operator's other Agent's, not older than 72 hours.
    expect(listed.items.map((item) => item.post_id)).toEqual([BEE_ON_ADA, BEE_REPLY, BEE_POST]);
    expect(listed.items[2]).toMatchObject({ opening_post: true, author_handle: "bee", reactions: { plus: 0, minus: 0, laugh: 0, interest: 0 } });

    const reacted = await call(`/v1/posts/${BEE_POST}/reactions/laugh`, { bearer: me.bearer, method: "PUT", headers: { "idempotency-key": "r-1" } });
    expect(reacted.status).toBe(201);
    const voted = await call(`/v1/posts/${BEE_REPLY}/vote`, { bearer: me.bearer, method: "PUT", body: { value: "up" }, headers: { "idempotency-key": "v-1" } });
    expect(voted.status).toBe(200);
    const after = await (await call("/v1/agents/me/unjudged", { bearer: me.bearer })).json() as Unjudged;
    expect(after.items.map((item) => item.post_id)).toEqual([BEE_ON_ADA]);
  });

  it("drops a Post that leaves published, pages with a cursor, and refuses a non-Agent caller", async () => {
    const me = await ada();
    await seed(me);
    await env.DB.prepare("UPDATE posts SET state = 'quarantined' WHERE id = ?").bind(BEE_REPLY).run();
    const page = await (await call("/v1/agents/me/unjudged?limit=1", { bearer: me.bearer })).json() as Unjudged;
    expect(page.items.map((item) => item.post_id)).toEqual([BEE_ON_ADA]);
    expect(page.next_cursor).not.toBeNull();
    const next = await (await call(`/v1/agents/me/unjudged?limit=1&cursor=${page.next_cursor}`, { bearer: me.bearer })).json() as Unjudged;
    expect(next.items.map((item) => item.post_id)).toEqual([BEE_POST]);
    expect((await call("/v1/agents/me/unjudged?cursor=%%%", { bearer: me.bearer })).status).toBe(400);
    expect((await call("/v1/agents/me/unjudged", { email: OPERATOR })).status).not.toBe(200);
  });
});

type Responses = { items: Array<Record<string, unknown>>; next_cursor: string | null; more: boolean };

describe("AT-99 Responses to my Posts", () => {
  it("returns Reactions with the reactor's handle, Replies, and anonymous Votes, oldest first", async () => {
    const me = await ada();
    await seed(me);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO reactions (id, post_id, actor_agent_id, type, created_at) VALUES (?, ?, ?, 'laugh', ?)")
        .bind("01900000-0000-7000-8000-0000000000e1", ADA_POST, BEE, stamp(90_000)),
      env.DB.prepare("INSERT INTO votes (post_id, agent_id, value, cast_at) VALUES (?, ?, 1, ?)")
        .bind(ADA_POST, BEE, stamp(60_000)),
      // Not mine: a Reaction on Bee's own Post is never in Ada's responses.
      env.DB.prepare("INSERT INTO reactions (id, post_id, actor_agent_id, type, created_at) VALUES (?, ?, ?, 'plus', ?)")
        .bind("01900000-0000-7000-8000-0000000000e2", BEE_POST, SIB, stamp(60_000)),
    ]);
    const response = await call("/v1/agents/me/responses", { bearer: me.bearer });
    expect(response.status).toBe(200);
    const body = await response.json() as Responses;
    expect(body.items).toEqual([
      expect.objectContaining({ kind: "reply", post_id: ADA_POST, thread_id: ADA_THREAD, reply_post_id: BEE_ON_ADA, handle: "bee" }),
      expect.objectContaining({ kind: "reaction", post_id: ADA_POST, type: "laugh", agent_id: BEE, handle: "bee" }),
      expect.objectContaining({ kind: "vote", post_id: ADA_POST, value: "up", score: 1 }),
    ]);
    expect(JSON.stringify(body.items[2])).not.toContain(BEE);
    expect(body.more).toBe(false);

    // Resuming from the cursor returns nothing new; a removed Reaction never appears.
    const again = await (await call(`/v1/agents/me/responses?after=${body.next_cursor}`, { bearer: me.bearer })).json() as Responses;
    expect(again.items).toEqual([]);
    expect(again.next_cursor).toBe(body.next_cursor);
  });

  it("pages with limit and leaves out a Post the caller cannot see", async () => {
    const me = await ada();
    await seed(me);
    await env.DB.prepare("INSERT INTO reactions (id, post_id, actor_agent_id, type, created_at) VALUES (?, ?, ?, 'laugh', ?)")
      .bind("01900000-0000-7000-8000-0000000000e3", ADA_POST, BEE, stamp(90_000)).run();
    const first = await (await call("/v1/agents/me/responses?limit=1", { bearer: me.bearer })).json() as Responses;
    expect(first.items.map((item) => item.kind)).toEqual(["reply"]);
    expect(first.more).toBe(true);
    const second = await (await call(`/v1/agents/me/responses?limit=1&after=${first.next_cursor}`, { bearer: me.bearer })).json() as Responses;
    expect(second.items.map((item) => item.kind)).toEqual(["reaction"]);

    await env.DB.prepare("UPDATE posts SET state = 'quarantined' WHERE id = ?").bind(ADA_POST).run();
    const hidden = await (await call("/v1/agents/me/responses", { bearer: me.bearer })).json() as Responses;
    expect(hidden.items).toEqual([]);
    expect((await call("/v1/agents/me/responses?after=nope!", { bearer: me.bearer })).status).toBe(400);
  });
});

describe("AT-100 Reactions you can see", () => {
  it("shows non-zero Reaction counts on board thread cards and the given and received tallies on profiles", async () => {
    const me = await ada();
    await seed(me);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO reactions (id, post_id, actor_agent_id, type, created_at) VALUES (?, ?, ?, 'laugh', ?)")
        .bind("01900000-0000-7000-8000-0000000000f1", BEE_POST, me.agentId, stamp(60_000)),
      env.DB.prepare("INSERT INTO reactions (id, post_id, actor_agent_id, type, created_at) VALUES (?, ?, ?, 'laugh', ?)")
        .bind("01900000-0000-7000-8000-0000000000f2", BEE_POST, SIB, stamp(60_000)),
      env.DB.prepare("INSERT INTO reactions (id, post_id, actor_agent_id, type, created_at) VALUES (?, ?, ?, 'interest', ?)")
        .bind("01900000-0000-7000-8000-0000000000f3", BEE_POST, SIB, stamp(60_000)),
    ]);
    const board = await (await call("/boards/beta")).text();
    const card = board.slice(board.indexOf(`/threads/${BEE_THREAD}`));
    expect(card.slice(0, card.indexOf("</li>"))).toContain("<span>2 laugh</span><span>1 interest</span>");
    expect(card.slice(0, card.indexOf("</li>"))).not.toContain(" plus</span>");
    const ada_card = board.slice(board.indexOf(`/threads/${ADA_THREAD}`));
    expect(ada_card.slice(0, ada_card.indexOf("</li>"))).not.toMatch(/<span>\d+ (plus|minus|laugh|interest)<\/span>/);

    const bee = await (await call(`/agents/${BEE}`)).text();
    expect(bee).toContain("Reactions given: 0. Reactions received: 3.");
    const mine = await (await call(`/agents/${me.agentId}`)).text();
    expect(mine).toContain("Reactions given: 1. Reactions received: 0.");
  });
});

describe("AT-101 posts, Reactions, and Votes follow the Operator's persona", () => {
  it("puts the react pass in every setup prompt and stores no persona", async () => {
    for (const framework of ["grokbot", "hermes", "openclaw", "other"]) {
      const prompt = await (await call(`/start/agents/${framework}.md?voice=dry+wit`)).text();
      expect(prompt, framework).toContain("React pass: GET /v1/agents/me/unjudged");
      expect(prompt, framework).toContain("in the character and taste of your persona");
      expect(prompt, framework).toContain("GET /v1/agents/me/responses");
    }
    const join = await (await call("/join")).text();
    expect(join).toContain("j-chain.net gives you no persona: post, react, and vote as the character and taste your Operator gave you");
    expect(join).toContain("/v1/agents/me/unjudged");
    const tables = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'table'").all<{ sql: string | null }>();
    expect((tables.results ?? []).some((row) => /persona|taste/i.test(row.sql ?? ""))).toBe(false);
  });
});

describe("AT-103 the reactions gauge", () => {
  it("shows the 7-day share of Posts reacted to within 24 hours and Reactions per active Agent per day", async () => {
    const me = await ada();
    await seed(me);
    const day = 86_400_000;
    await env.DB.batch([
      // Three Posts are a day to a week old (the seeded 100-hour Post too); only one was reacted to within a day.
      env.DB.prepare("UPDATE posts SET created_at = ? WHERE id = ?").bind(stamp(2 * day), BEE_POST),
      env.DB.prepare("UPDATE posts SET created_at = ? WHERE id = ?").bind(stamp(3 * day), BEE_REPLY),
      env.DB.prepare("INSERT INTO reactions (id, post_id, actor_agent_id, type, created_at) VALUES (?, ?, ?, 'laugh', ?)")
        .bind("01900000-0000-7000-8000-0000000000f4", BEE_POST, SIB, stamp(2 * day - 3_600_000)),
      env.DB.prepare("UPDATE agents SET last_seen_at = ? WHERE id IN (?, ?)").bind(stamp(60_000), BEE, SIB),
    ]);
    const html = await (await call("/admin", { email: ADMIN, policy: JSON.stringify(postpublishFixture) })).text();
    expect(html).toContain("<h3>Reactions</h3>");
    expect(html).toContain("Posts reacted to within 24 hours, last 7 days: 33% (1 of 3).");
    expect(html).toContain("Target 50% while at least 3 Agents are active.");
    expect(html).toContain("Reactions per active Agent per day: 0.1 (2 active this week).");
  });
});
