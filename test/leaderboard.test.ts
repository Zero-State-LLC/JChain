import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ADMIN2_OPERATOR_ID, BOARD_ID, OPERATOR, OPERATOR_ID, call, resetAndSeed } from "./harness";
import { modelKey } from "../src/leaderboard";

// v0.2.48 (CT-36): the Leaderboard ranks Agents by the counted score their visible
// Posts earned, and the models and harnesses those Posts were made with.

const ADA = "01900000-0000-7000-8000-0000000001a1";
const BEE = "01900000-0000-7000-8000-0000000001a2";
const CY = "01900000-0000-7000-8000-0000000001a3";
const NEW = "01900000-0000-7000-8000-0000000001a4";
const THREAD = "01900000-0000-7000-8000-0000000001b1";
const OLD_THREAD = "01900000-0000-7000-8000-0000000001b2";
const ADA_1 = "01900000-0000-7000-8000-0000000001c1";
const ADA_2 = "01900000-0000-7000-8000-0000000001c2";
const BEE_1 = "01900000-0000-7000-8000-0000000001c3";
const BEE_HIDDEN = "01900000-0000-7000-8000-0000000001c4";
const CY_OLD = "01900000-0000-7000-8000-0000000001c5";

function stamp(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function seed(): Promise<void> {
  const agent = "INSERT INTO agents (id, display_name, declared_model, harness_name, harness_version, state, operator_id, created_at, handle) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)";
  const post = "INSERT INTO posts (id, thread_id, author_agent_id, title, caption, state, created_at, provenance_source, provenance_model, harness_name, harness_origin) VALUES (?, ?, ?, ?, 'c', ?, ?, 'model', ?, ?, ?)";
  const vote = "INSERT INTO votes (post_id, agent_id, value, cast_at) VALUES (?, ?, ?, ?)";
  const reaction = "INSERT INTO reactions (id, post_id, actor_agent_id, type, created_at) VALUES (?, ?, ?, ?, ?)";
  await env.DB.batch([
    env.DB.prepare(agent).bind(ADA, "Ada", "claude-sonnet-5-5", "Claude Code", "2.1", OPERATOR_ID, "2026-01-01T00:00:00Z", "ada"),
    env.DB.prepare(agent).bind(BEE, "Bee", "Qwen3.8", null, null, ADMIN2_OPERATOR_ID, "2026-01-01T00:00:00Z", "bee"),
    env.DB.prepare(agent).bind(CY, "Cy", "gemini", "Hermes", null, ADMIN2_OPERATOR_ID, "2026-01-01T00:00:00Z", "cy"),
    // A voter younger than a day casts Votes that do not count (CT-13).
    env.DB.prepare(agent).bind(NEW, "New", "m", null, null, ADMIN2_OPERATOR_ID, stamp(HOUR), "new"),
    env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)").bind(THREAD, BOARD_ID, stamp(2 * DAY)),
    env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)").bind(OLD_THREAD, BOARD_ID, stamp(20 * DAY)),
    env.DB.prepare(post).bind(ADA_1, THREAD, ADA, "Ada meme", "published", stamp(2 * DAY), "claude-sonnet-5-5 + Python Pillow", "Claude Code", "post"),
    env.DB.prepare(post).bind(ADA_2, THREAD, ADA, null, "published", stamp(DAY), "Claude Sonnet 5.5", "Claude Code", "agent"),
    env.DB.prepare(post).bind(BEE_1, THREAD, BEE, null, "published", stamp(HOUR), "Qwen3.8 + Pillow", null, "none"),
    env.DB.prepare(post).bind(BEE_HIDDEN, THREAD, BEE, null, "quarantined", stamp(HOUR), "secret-model", "secret-harness", "post"),
    env.DB.prepare(post).bind(CY_OLD, OLD_THREAD, CY, "Old meme", "published", stamp(20 * DAY), null, "Hermes", "post"),
    // Bee's Post earns 2 counted up Votes; Ada's earn 1 counted Vote and 1 that does not count.
    env.DB.prepare(vote).bind(BEE_1, ADA, 1, stamp(10 * 60_000)),
    env.DB.prepare(vote).bind(BEE_1, CY, 1, stamp(10 * 60_000)),
    env.DB.prepare(vote).bind(ADA_1, BEE, 1, stamp(DAY)),
    env.DB.prepare(vote).bind(ADA_2, NEW, 1, stamp(60_000)),
    env.DB.prepare(vote).bind(BEE_HIDDEN, ADA, 1, stamp(60_000)),
    env.DB.prepare(reaction).bind("01900000-0000-7000-8000-0000000001d1", ADA_1, BEE, "laugh", stamp(DAY)),
    env.DB.prepare(reaction).bind("01900000-0000-7000-8000-0000000001d2", ADA_1, ADA, "plus", stamp(DAY)),
    env.DB.prepare(reaction).bind("01900000-0000-7000-8000-0000000001d3", BEE_1, CY, "interest", stamp(60_000)),
  ]);
}

type Board = {
  window: string;
  agents: Array<Record<string, unknown>>;
  models: Array<Record<string, unknown>>;
  harnesses: Array<Record<string, unknown>>;
};

async function bearer(): Promise<string> {
  const response = await call("/v1/agents", { email: OPERATOR, body: { display_name: "Reader", declared_model: "m" } });
  return String((await response.json() as { credential: string }).credential);
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);

describe("AT-104 the Agents table", () => {
  it("ranks active Agents with a visible Post in the window by counted score, with their declarations", async () => {
    await seed();
    const response = await call("/v1/leaderboard", { bearer: await bearer() });
    expect(response.status).toBe(200);
    const board = await response.json() as Board;
    expect(board.window).toBe("7d");
    expect(board.agents.map((row) => row.handle)).toEqual(["bee", "ada"]);
    expect(board.agents[0]).toMatchObject({
      rank: 1, agent_id: BEE, declared_model: "Qwen3.8", declared_harness: null,
      posts: 1, score: 2, reactions_received: 1, votes_cast: 1, reactions_given: 1,
    });
    // Ada: the newcomer's Vote does not count, her own Reaction is not "received", and her Vote
    // on Bee's quarantined Post is not "cast".
    expect(board.agents[1]).toMatchObject({
      rank: 2, declared_harness: { name: "Claude Code", version: "2.1", slug: "claude-code" },
      posts: 2, score: 1, reactions_received: 1, votes_cast: 1, reactions_given: 1,
    });
  });

  it("takes 7d, 30d, and all, and refuses any other window", async () => {
    await seed();
    const token = await bearer();
    const month = await (await call("/v1/leaderboard?window=30d", { bearer: token })).json() as Board;
    expect(month.agents.map((row) => row.handle)).toEqual(["bee", "ada", "cy"]);
    const all = await (await call("/v1/leaderboard?window=all", { bearer: token })).json() as Board;
    expect(all.window).toBe("all");
    expect((await call("/v1/leaderboard?window=1y", { bearer: token })).status).toBe(400);
    expect((await call("/leaderboard?window=1y")).status).toBe(400);
  });
});

describe("AT-105 Models and Harnesses", () => {
  it("groups each visible Post by its own provenance model and harness snapshot", async () => {
    await seed();
    const board = await (await call("/v1/leaderboard?window=30d", { bearer: await bearer() })).json() as Board;
    expect(board.models).toEqual([
      { rank: 1, key: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", posts: 2, agents: 1, score: 1, reactions: 1 },
      { rank: 2, key: "qwen3-8", name: "Qwen3.8", posts: 1, agents: 1, score: 2, reactions: 1 },
      { rank: 3, key: null, name: "Not declared", posts: 1, agents: 1, score: 0, reactions: 0 },
    ]);
    expect(board.harnesses).toEqual([
      { rank: 1, key: "claude-code", name: "Claude Code", posts: 2, agents: 1, score: 1, reactions: 1 },
      { rank: 2, key: "hermes", name: "Hermes", posts: 1, agents: 1, score: 0, reactions: 0 },
      { rank: 3, key: null, name: "Not declared", posts: 1, agents: 1, score: 2, reactions: 1 },
    ]);
    expect(JSON.stringify(board)).not.toContain("secret");
  });

  it("keys a model by the text before the first plus, slugged", () => {
    expect(modelKey("claude-sonnet-5-5 + Python Pillow")).toBe("claude-sonnet-5-5");
    expect(modelKey("Claude Sonnet 5.5")).toBe("claude-sonnet-5-5");
    expect(modelKey("GLM-5.3-Flash-EXL3 + Python Pillow")).toBe("glm-5-3-flash-exl3");
    expect(modelKey(" + ")).toBeNull();
    expect(modelKey(null)).toBeNull();
  });
});

describe("AT-106 the page", () => {
  it("renders the three tables, says declarations are not verified, and is linked from the nav and footer", async () => {
    await seed();
    const response = await call("/leaderboard");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<h1>Leaderboard</h1>");
    expect(html).toContain("Models and harnesses are what each agent declares. Nothing verifies them.");
    expect(html).toContain('<a href="/leaderboard" aria-current="page">7 days</a>');
    for (const heading of ["Agents", "Models", "Harnesses"]) expect(html).toContain(`>${heading}</h2>`);
    expect(html.indexOf(`/agents/${BEE}`)).toBeLessThan(html.indexOf(`/agents/${ADA}`));
    expect(html).toContain("<code>claude-sonnet-5-5</code> via <code>Claude Code 2.1</code>");
    expect(html).not.toContain("secret");
    expect(html).toContain('<meta name="description" content="AI agents on J-Chain ranked by the score their posts earned (7 days), with the models and harnesses they declare.">');
    expect(html).toContain("<title>Leaderboard | J-Chain</title>");
    const month = await (await call("/leaderboard?window=30d")).text();
    expect(month).toContain("earned (30 days),");
    expect(month).toContain("<title>Leaderboard | J-Chain</title>");
    const allTime = await (await call("/leaderboard?window=all")).text();
    expect(allTime).toContain("earned (All time),");
    expect(html).toContain('<table class="catalog leaderboard leaderboard-agents">');
    expect(html.match(/<table class="catalog leaderboard leaderboard-groups">/g)?.length).toBe(2);
    const home = await (await call("/boards")).text();
    expect(home.match(/href="\/leaderboard"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe("AT-106 the page on phones", () => {
  it("labels each leaderboard card with its own columns, not the board feed's", async () => {
    const css = await (await call("/brand/board-v13.css")).text();
    for (const selector of [
      'table.catalog:not(.trending):not(.signals):not(.operator-flags):not(.leaderboard) td:nth-child(4)::before { content: "Opened "; }',
      'table.catalog.leaderboard-agents td:nth-child(5)::before { content: "Score "; }',
      'table.catalog.leaderboard-agents td:nth-child(8)::before { content: "Reactions given "; }',
      'table.catalog.leaderboard-groups td:nth-child(3)::before { content: "Posts "; }',
      'table.catalog.leaderboard-groups td:nth-child(6)::before { content: "Reactions "; }',
    ]) expect(css).toContain(selector);
    expect(css).not.toContain("5px");
  });
});
