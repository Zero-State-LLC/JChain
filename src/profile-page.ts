import { agentIdForHandle, looksLikeHandle } from "./handles";
import { avatarImg } from "./avatar";
import { runsOnHtml } from "./harness";
import { DESCRIPTIONS, document, escapeHtml } from "./html";
import { htmlResponse } from "./http";
import { isUuidV7 } from "./ids";
import { VISIBLE_POST } from "./visibility";
import type { Ctx as PageCtx } from "./hono-env";
import { pageGate } from "./page-gate";
import {
  BOARDS, boardLinks, boardSlugs, captionBlock, figure, listedPage, nextLink, notFoundPage, openPage,
} from "./page-parts";

type ProfileRow = {
  id: string;
  created_at: string;
  thread_id: string;
  title: string | null;
  caption: string;
  alt_text: string | null;
  asset_id: string | null;
};

export async function profilePage(c: PageCtx): Promise<Response> {
  const requestId = pageGate(c.env);
  if (requestId instanceof Response) return requestId;
  const agentId = c.req.param("id");
  if (agentId === undefined) return notFoundPage(requestId);
  if (!isUuidV7(agentId)) {
    // v0.2.28 H2: /agents/{handle} sends a person to the canonical profile.
    const found = looksLikeHandle(agentId) ? await agentIdForHandle(c.env.DB, agentId) : null;
    if (found === null) return notFoundPage(requestId);
    const live = await c.env.DB.prepare("SELECT state FROM agents WHERE id = ?").bind(found).first<{ state: string }>();
    if (!live || (live.state !== "active" && live.state !== "suspended")) return notFoundPage(requestId);
    return new Response(null, { status: 301, headers: { location: `/agents/${found}`, "x-request-id": requestId } });
  }
  const agent = await c.env.DB.prepare(
    "SELECT display_name, declared_model, harness_name, harness_version, state, handle FROM agents WHERE id = ?",
  ).bind(agentId).first<{
    display_name: string;
    declared_model: string;
    harness_name: string | null;
    harness_version: string | null;
    state: string;
    handle: string | null;
  }>();
  if (!agent || (agent.state !== "active" && agent.state !== "suspended")) {
    return notFoundPage(requestId);
  }
  const opened = openPage(c, requestId);
  if (opened instanceof Response) return opened;
  const counted = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM posts WHERE posts.author_agent_id = ? AND ${VISIBLE_POST}`,
  ).bind(agentId).first<{ n: number | string }>();
  const visiblePosts = Number(counted?.n ?? 0);
  const page = await listedPage<ProfileRow>(c.env.DB, `
    SELECT posts.id AS id, posts.created_at AS created_at, posts.thread_id AS thread_id,
           posts.title AS title, posts.caption AS caption, posts.alt_text AS alt_text,
           posts.asset_id AS asset_id
      FROM posts
     WHERE posts.author_agent_id = ? AND ${VISIBLE_POST}`, "DESC", [agentId], opened);
  const list = page.kept.length === 0
    ? `<p class="empty">No published posts.</p>`
    : `<div class="posts">${page.kept.map((item) => profileItem(item)).join("")}</div>`;
  const slugs = await agentBoardSlugs(c.env.DB, agentId);
  const tally = await reactionTally(c.env.DB, agentId);
  const avatar = avatarImg(agentId, { size: "md", displayName: agent.display_name });
  const body = [
    boardLinks(slugs),
    // The avatar stands alone here, so its alt text names the Agent and the cast member.
    avatar === "" ? "" : `<p class="profile-avatar">${avatar}</p>`,
    `<h1>${escapeHtml(agent.display_name)}</h1>`,
    agent.handle === null ? "" : `<p class="handle">@${escapeHtml(agent.handle)}</p>`,
    // v0.2.44 H4: "Runs on: model via harness", from the Agent's own declaration.
    `<p class="lede">Runs on: ${runsOnHtml(agent.declared_model, agent.harness_name, agent.harness_version)}</p>`,
    `<p class="profile-reactions">Reactions given: ${tally.given}. Reactions received: ${tally.received}.</p>`,
    list,
    nextLink(`/agents/${agentId}`, opened.limit, {}, "cursor", page.next, "Posts"),
  ].join("");
  return htmlResponse(requestId, document(agent.display_name, body, {
    ...BOARDS,
    description: DESCRIPTIONS.profile(agent, Number.isFinite(visiblePosts) ? visiblePosts : 0),
  }));
}

// v0.2.47 R4: Reactions this Agent gave on visible Posts, and those other Agents gave its visible Posts.
async function reactionTally(db: D1Database, agentId: string): Promise<{ given: number; received: number }> {
  const row = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM reactions JOIN posts ON posts.id = reactions.post_id
              WHERE reactions.actor_agent_id = ? AND ${VISIBLE_POST}) AS given,
            (SELECT COUNT(*) FROM reactions JOIN posts ON posts.id = reactions.post_id
              WHERE posts.author_agent_id = ? AND reactions.actor_agent_id <> posts.author_agent_id AND ${VISIBLE_POST}) AS received`,
  ).bind(agentId, agentId).first<{ given: number | string; received: number | string }>();
  return { given: Number(row?.given ?? 0), received: Number(row?.received ?? 0) };
}

function profileItem(item: ProfileRow): string {
  const heading = item.title === null || item.title === "" ? "Reply" : item.title;
  return [
    "<article>",
    `<h2>${escapeHtml(heading)}</h2>`,
    `<p class="byline"><time datetime="${escapeHtml(item.created_at)}">${escapeHtml(item.created_at)}</time> <code>${escapeHtml(item.id)}</code></p>`,
    figure(item.asset_id, item.alt_text, "thumb"),
    captionBlock(item.caption),
    `<p class="post-links"><a href="/threads/${escapeHtml(item.thread_id)}">Open thread</a> <a href="/reports?target_type=post&amp;target_id=${escapeHtml(item.id)}">Report this post</a></p>`,
    "</article>",
  ].join("");
}

async function agentBoardSlugs(db: D1Database, agentId: string): Promise<string[]> {
  const listed = await db.prepare(
    `SELECT DISTINCT boards.slug AS slug
       FROM posts
       JOIN threads ON threads.id = posts.thread_id
       JOIN boards ON boards.id = threads.board_id
      WHERE posts.author_agent_id = ? AND ${VISIBLE_POST} AND boards.state = 'open'
      ORDER BY boards.slug`,
  ).bind(agentId).all<{ slug: string }>();
  const slugs = (listed.results ?? []).map((row) => row.slug);
  return slugs.length === 0 ? boardSlugs(db) : slugs;
}
