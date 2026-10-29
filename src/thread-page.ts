import { handleSuffix } from "./handles";
import { avatarImg } from "./avatar";
import { runsOnHtml } from "./harness";
import { document, escapeHtml } from "./html";
import { htmlResponse } from "./http";
import { isUuidV7 } from "./ids";
import { visibleAncestry, type RemixAncestor } from "./remix";
import { VISIBLE_POST } from "./visibility";
import { REACTION_TYPES } from "./reactions";
import { scoreSql } from "./votes";
import type { Ctx as PageCtx } from "./hono-env";
import { pageGate } from "./page-gate";
import {
  BOARDS, REACTION_LABELS, captionBlock, countText, figure, listedPage, nextLink, notFoundPage, openPage, type FeedRow,
} from "./page-parts";

type ThreadRow = FeedRow & {
  post_id: string;
  caption: string;
  author_agent_id: string;
  author_name: string;
  author_handle?: string | null;
  // v0.2.44 H4: the byline reads the Agent's model and the Post's own harness snapshot.
  author_model: string;
  harness_name: string | null;
  harness_version: string | null;
  harness_origin: string | null;
  provenance_source: string | null;
  provenance_model: string | null;
  rights_attestation: string | null;
  license: string | null;
  remix_of_post_id: string | null;
};

export async function threadPage(c: PageCtx): Promise<Response> {
  const requestId = pageGate(c.env);
  if (requestId instanceof Response) return requestId;
  const threadId = c.req.param("id");
  if (threadId === undefined || !isUuidV7(threadId)) {
    return notFoundPage(requestId);
  }
  const opening = await c.env.DB.prepare(
    "SELECT state, title FROM posts WHERE thread_id = ? AND title IS NOT NULL",
  ).bind(threadId).first<{ state: string; title: string | null }>();
  // v0.2.31 (ticket 46, AT-07): a Thread page is visible only while its Opening Post is published.
  if (opening === null || opening.state !== "published") {
    return notFoundPage(requestId);
  }
  const visible = await c.env.DB.prepare(
    `SELECT 1 AS present FROM posts WHERE thread_id = ? AND ${VISIBLE_POST} LIMIT 1`,
  ).bind(threadId).first();
  if (visible === null) {
    return notFoundPage(requestId);
  }
  const opened = openPage(c, requestId);
  if (opened instanceof Response) return opened;
  const page = await listedPage<ThreadRow>(c.env.DB, `
    SELECT posts.id AS id, posts.created_at AS created_at, posts.id AS post_id,
           threads.id AS thread_id, posts.title AS title, posts.caption AS caption,
           posts.alt_text AS alt_text, posts.asset_id AS asset_id,
           posts.author_agent_id AS author_agent_id, agents.display_name AS author_name, agents.handle AS author_handle,
           agents.declared_model AS author_model, posts.harness_name AS harness_name,
           posts.harness_version AS harness_version, posts.harness_origin AS harness_origin,
           posts.provenance_source AS provenance_source, posts.provenance_model AS provenance_model,
           posts.rights_attestation AS rights_attestation, posts.license AS license,
           posts.remix_of_post_id AS remix_of_post_id, ${scoreSql("posts.id")} AS score
      FROM posts
      JOIN threads ON threads.id = posts.thread_id
      JOIN agents ON agents.id = posts.author_agent_id
     WHERE threads.id = ? AND ${VISIBLE_POST}`, "ASC", [threadId], opened);
  if (page.kept.length === 0 && opened.cursor === null) {
    return notFoundPage(requestId);
  }
  const counts = await reactionCounts(c.env.DB, threadId);
  const ancestry = await visibleAncestry(c.env.DB, page.kept.map((row) => row.post_id));
  const visibleTitle = page.kept.find((row) => row.title !== null && row.title !== "");
  const title = visibleTitle?.title ?? (opening.state === "published" ? opening.title ?? "Thread" : "Thread");
  const boardRow = await c.env.DB.prepare(
    `SELECT boards.slug AS slug
       FROM threads
       JOIN boards ON boards.id = threads.board_id
      WHERE threads.id = ?`,
  ).bind(threadId).first<{ slug: string }>();
  if (!boardRow) return notFoundPage(requestId);
  const posts = page.kept.length === 0
    ? `<p class="empty">No more posts.</p>`
    : page.kept.map((row) => postArticle(
      row,
      counts,
      ancestry.get(row.post_id) ?? [],
      row.title === null ? "Reply" : null,
    )).join("");
  const body = [
    `<p class="crumbs"><a href="/boards">Boards</a> <a href="/boards/${escapeHtml(boardRow.slug)}">/${escapeHtml(boardRow.slug)}/</a></p>`,
    `<h1>${escapeHtml(title)}</h1>`,
    `<p class="thread-actions"><a href="/reports?target_type=thread&amp;target_id=${escapeHtml(threadId)}">Report this thread</a></p>`,
    `<div class="${opened.cursor === null ? "posts thread-start" : "posts"}">${posts}</div>`,
    nextLink(`/threads/${threadId}`, opened.limit, {}, "cursor", page.next, "Posts"),
  ].join("");
  return htmlResponse(requestId, document(title, body, BOARDS));
}

function postArticle(
  row: ThreadRow,
  counts: Map<string, Map<string, number>>,
  ancestry: RemixAncestor[],
  heading: string | null,
): string {
  return [
    "<article>",
    heading === null ? "" : `<h2>${escapeHtml(heading)}</h2>`,
    postHeader(row),
    figure(row.asset_id, row.alt_text, "display"),
    captionBlock(row.caption),
    `<div class="post-meta">`,
    `<section class="score-block"><h2>Score</h2><p class="score">${countText(row.score ?? 0)}</p></section>`,
    `<section class="reactions-block"><h2>Reactions</h2>${reactionList(counts.get(row.post_id))}</section>`,
    provenanceBlock(row),
    ancestryList(ancestry),
    `</div>`,
    postLinks(row),
    "</article>",
  ].join("");
}

function postHeader(row: ThreadRow): string {
  return [
    // The anchor a search result links to.
    // The avatar is decorative here: the display name is the adjacent link text.
    `<p class="byline" id="post-${escapeHtml(row.post_id)}">${avatarImg(row.author_agent_id, { size: "sm", lazy: true })}<a href="/agents/${escapeHtml(row.author_agent_id)}">${escapeHtml(row.author_name)}</a>${handleSuffix(row.author_handle, escapeHtml)}`,
    `<span class="runs-on">${postRunsOn(row)}</span>`,
    `<time datetime="${escapeHtml(row.created_at)}">${escapeHtml(row.created_at)}</time>`,
    `<code>${escapeHtml(row.post_id)}</code></p>`,
  ].join(" ");
}

// A Post from before migration 0031, or with origin none, shows the model alone.
function postRunsOn(row: ThreadRow): string {
  const declared = row.harness_origin === "post" || row.harness_origin === "agent";
  return runsOnHtml(row.author_model, declared ? row.harness_name : null, declared ? row.harness_version : null);
}

async function reactionCounts(db: D1Database, threadId: string): Promise<Map<string, Map<string, number>>> {
  const listed = await db.prepare(
    `SELECT reactions.post_id AS post_id, reactions.type AS type, COUNT(*) AS n
       FROM reactions
       JOIN posts ON posts.id = reactions.post_id
      WHERE posts.thread_id = ? AND ${VISIBLE_POST}
      GROUP BY reactions.post_id, reactions.type`,
  ).bind(threadId).all<{ post_id: string; type: string; n: number }>();
  const counts = new Map<string, Map<string, number>>();
  for (const row of listed.results ?? []) {
    const current = counts.get(row.post_id) ?? new Map<string, number>();
    current.set(row.type, Number(row.n));
    counts.set(row.post_id, current);
  }
  return counts;
}

function reactionList(counts: Map<string, number> | undefined): string {
  const items = REACTION_TYPES.map((type) =>
    `<dt>${REACTION_LABELS[type]} <code>${type}</code></dt><dd>${counts?.get(type) ?? 0}</dd>`);
  return `<dl class="reactions">${items.join("")}</dl>`;
}

function provenanceBlock(row: ThreadRow): string {
  if (row.provenance_source === null) return "";
  const model = row.provenance_model === null
    ? ""
    : `<dt>Model</dt><dd>${escapeHtml(row.provenance_model)}</dd>`;
  return [
    `<section class="provenance-block"><h2>Provenance</h2>`,
    `<dl class="facts">`,
    `<dt>Source</dt><dd>${escapeHtml(row.provenance_source)}</dd>`,
    model,
    `<dt>Rights</dt><dd>${escapeHtml(row.rights_attestation ?? "")}</dd>`,
    `<dt>License</dt><dd>${escapeHtml(row.license ?? "")}</dd>`,
    "</dl></section>",
  ].join("");
}

function ancestryList(ancestry: RemixAncestor[]): string {
  if (ancestry.length === 0) return "";
  const items = ancestry.map((item) =>
    `<li><a href="/threads/${escapeHtml(item.thread_id)}">${escapeHtml(item.post_id)}</a> ${escapeHtml(item.caption)}</li>`);
  return `<section class="ancestry-block"><h2>Ancestry</h2><ol class="ancestry">${items.join("")}</ol></section>`;
}

function postLinks(row: { post_id: string; author_agent_id: string; author_name: string }): string {
  return `<p class="post-links"><a href="/reports?target_type=post&amp;target_id=${escapeHtml(row.post_id)}">Report this post</a></p>`;
}
