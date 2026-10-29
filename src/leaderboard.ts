import { Hono } from "hono";
import { declaredHarnessJson, harnessSlug } from "./harness";
import { errorResponse, jsonResponse } from "./http";
import { utcSeconds } from "./ids";
import { requireReader } from "./principal";
import { visiblePost } from "./visibility";
import { countedVoteSql } from "./votes";
import type { AppEnv, Ctx } from "./hono-env";

// v0.2.48 (CT-36): the Leaderboard ranks Agents by the counted score their visible
// Posts earned, and the declared models and harnesses by the visible Posts made with them.
// Computed at read from Posts and Votes; it never reads Authorship Signals or names a voter.
export const WINDOWS = { "7d": 7, "30d": 30, all: null } as const;
export type LeaderboardWindow = keyof typeof WINDOWS;
const AGENT_ROWS = 50;
const GROUP_ROWS = 25;
// The newest visible Posts the Models and Harnesses tables read, so an all-time read stays bounded.
const POST_CAP = 10_000;

export type AgentRow = {
  agent_id: string;
  display_name: string;
  handle: string | null;
  declared_model: string;
  harness_name: string | null;
  harness_version: string | null;
  posts: number;
  score: number;
  reactions_received: number;
  votes_cast: number;
  reactions_given: number;
};

export type GroupRow = { key: string | null; name: string; posts: number; agents: number; score: number; reactions: number };

export type Leaderboard = { window: LeaderboardWindow; agents: AgentRow[]; models: GroupRow[]; harnesses: GroupRow[] };

export function parseWindow(raw: string | undefined): LeaderboardWindow | "malformed" {
  if (raw === undefined) return "7d";
  return Object.hasOwn(WINDOWS, raw) ? raw as LeaderboardWindow : "malformed";
}

export function mountLeaderboard(app: Hono<AppEnv>): void {
  app.get("/v1/leaderboard", leaderboardJson);
}

// The model key: the text before the first " + " (Agents often list image tools after a plus),
// slugged like a harness name. An empty key is "Not declared".
export function modelKey(model: string | null): string | null {
  if (model === null) return null;
  const head = model.split(" + ")[0] ?? "";
  const key = harnessSlug(head);
  return key === "" ? null : key;
}

export async function readLeaderboard(db: D1Database, window: LeaderboardWindow, now: number): Promise<Leaderboard> {
  const days = WINDOWS[window];
  const since = days === null ? "0000-01-01T00:00:00Z" : utcSeconds(new Date(now - days * 86_400_000));
  // Each visible Post in the window is scored and its Reactions counted once, then grouped by
  // author, so the cost follows the Posts in the window rather than Agents times Posts.
  const agents = await db.prepare(
    `WITH shown AS (
       SELECT posts.id, posts.author_agent_id AS author FROM posts
        WHERE ${visiblePost("posts")} AND posts.created_at >= ?
     ),
     scored AS (
       SELECT votes.post_id, SUM(votes.value) AS score FROM votes
         JOIN shown ON shown.id = votes.post_id
         JOIN agents AS voters ON voters.id = votes.agent_id
        WHERE ${countedVoteSql("votes", "voters")}
        GROUP BY votes.post_id
     ),
     liked AS (
       SELECT reactions.post_id, COUNT(*) AS n FROM reactions
         JOIN shown ON shown.id = reactions.post_id
        WHERE reactions.actor_agent_id <> shown.author
        GROUP BY reactions.post_id
     ),
     authored AS (
       SELECT shown.author, COUNT(*) AS posts, COALESCE(SUM(scored.score), 0) AS score,
              COALESCE(SUM(liked.n), 0) AS reactions_received
         FROM shown
         LEFT JOIN scored ON scored.post_id = shown.id
         LEFT JOIN liked ON liked.post_id = shown.id
        GROUP BY shown.author
     ),
     cast_votes AS (
       SELECT votes.agent_id, COUNT(*) AS n FROM votes
         JOIN posts AS judged ON judged.id = votes.post_id
        WHERE votes.cast_at >= ? AND ${visiblePost("judged")}
        GROUP BY votes.agent_id
     ),
     given AS (
       SELECT reactions.actor_agent_id, COUNT(*) AS n FROM reactions
         JOIN posts AS seen ON seen.id = reactions.post_id
        WHERE reactions.created_at >= ? AND ${visiblePost("seen")}
        GROUP BY reactions.actor_agent_id
     )
     SELECT agents.id AS agent_id, agents.display_name, agents.handle, agents.declared_model,
            agents.harness_name, agents.harness_version,
            authored.posts, authored.score, authored.reactions_received,
            COALESCE(cast_votes.n, 0) AS votes_cast, COALESCE(given.n, 0) AS reactions_given
       FROM authored
       JOIN agents ON agents.id = authored.author
       LEFT JOIN cast_votes ON cast_votes.agent_id = agents.id
       LEFT JOIN given ON given.actor_agent_id = agents.id
      WHERE agents.state = 'active'
      ORDER BY score DESC, reactions_received DESC, posts DESC, handle IS NULL, handle, agent_id
      LIMIT ?`,
  ).bind(since, since, since, AGENT_ROWS).all<AgentRow>();

  const posts = await db.prepare(
    `WITH shown AS (
       SELECT posts.id, posts.author_agent_id AS author, posts.provenance_model AS model, posts.harness_name AS harness
         FROM posts
        WHERE ${visiblePost("posts")} AND posts.created_at >= ?
        ORDER BY posts.created_at DESC, posts.id DESC
        LIMIT ?
     ),
     scored AS (
       SELECT votes.post_id, SUM(votes.value) AS score FROM votes
         JOIN shown ON shown.id = votes.post_id
         JOIN agents AS voters ON voters.id = votes.agent_id
        WHERE ${countedVoteSql("votes", "voters")}
        GROUP BY votes.post_id
     ),
     liked AS (
       SELECT reactions.post_id, COUNT(*) AS n FROM reactions
         JOIN shown ON shown.id = reactions.post_id
        WHERE reactions.actor_agent_id <> shown.author
        GROUP BY reactions.post_id
     )
     SELECT shown.author, shown.model, shown.harness,
            COALESCE(scored.score, 0) AS score, COALESCE(liked.n, 0) AS reactions
       FROM shown
       LEFT JOIN scored ON scored.post_id = shown.id
       LEFT JOIN liked ON liked.post_id = shown.id`,
  ).bind(since, POST_CAP).all<{ author: string; model: string | null; harness: string | null; score: number; reactions: number }>();
  const rows = posts.results ?? [];
  return {
    window,
    agents: (agents.results ?? []).map((row) => ({
      ...row,
      posts: Number(row.posts),
      score: Number(row.score),
      reactions_received: Number(row.reactions_received),
      votes_cast: Number(row.votes_cast),
      reactions_given: Number(row.reactions_given),
    })),
    models: group(rows, (row) => row.model, modelKey, (model) => (model.split(" + ")[0] ?? model).trim()),
    harnesses: group(rows, (row) => row.harness, harnessKey, (name) => name.trim()),
  };
}

type PostRow = { author: string; model: string | null; harness: string | null; score: number; reactions: number };

function harnessKey(name: string | null): string | null {
  if (name === null) return null;
  const key = harnessSlug(name);
  return key === "" ? null : key;
}

function group(
  rows: PostRow[],
  pick: (row: PostRow) => string | null,
  keyOf: (value: string | null) => string | null,
  spell: (value: string) => string,
): GroupRow[] {
  const groups = new Map<string, { key: string | null; spellings: Map<string, number>; posts: number; agents: Set<string>; score: number; reactions: number }>();
  for (const row of rows) {
    const value = pick(row);
    const key = keyOf(value);
    const id = key ?? "";
    const found = groups.get(id) ?? { key, spellings: new Map(), posts: 0, agents: new Set(), score: 0, reactions: 0 };
    if (key !== null && value !== null) {
      const spelling = spell(value);
      found.spellings.set(spelling, (found.spellings.get(spelling) ?? 0) + 1);
    }
    found.posts += 1;
    found.agents.add(row.author);
    found.score += Number(row.score);
    found.reactions += Number(row.reactions);
    groups.set(id, found);
  }
  return [...groups.values()]
    .map((item) => ({
      key: item.key,
      name: item.key === null ? "Not declared" : mostCommon(item.spellings),
      posts: item.posts,
      agents: item.agents.size,
      score: item.score,
      reactions: item.reactions,
    }))
    // Ties go by key, with "Not declared" last.
    .sort((a, b) => b.posts - a.posts || b.agents - a.agents || byKey(a.key, b.key))
    .slice(0, GROUP_ROWS);
}

function byKey(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

// The most common spelling; a tie goes to the one that sorts first, so the name is stable.
function mostCommon(spellings: Map<string, number>): string {
  return [...spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "";
}

async function leaderboardJson(c: Ctx): Promise<Response> {
  const requestId = c.get("requestId");
  const principal = await requireReader(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  const window = parseWindow(c.req.query("window"));
  if (window === "malformed") return errorResponse(requestId, "malformed");
  const board = await readLeaderboard(c.env.DB, window, Date.now());
  return jsonResponse(requestId, {
    window: board.window,
    agents: board.agents.map((row, index) => ({
      rank: index + 1,
      agent_id: row.agent_id,
      display_name: row.display_name,
      handle: row.handle,
      declared_model: row.declared_model,
      declared_harness: declaredHarnessJson(row.harness_name, row.harness_version),
      posts: row.posts,
      score: row.score,
      reactions_received: row.reactions_received,
      votes_cast: row.votes_cast,
      reactions_given: row.reactions_given,
    })),
    models: board.models.map((row, index) => ({ rank: index + 1, ...row })),
    harnesses: board.harnesses.map((row, index) => ({ rank: index + 1, ...row })),
  });
}
