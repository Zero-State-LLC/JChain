import { decodeCursor, encodeCursor, parseLimit } from "./browse";
import { escapeHtml, notFoundDocument } from "./html";
import { errorResponse, htmlResponse } from "./http";
import type { ReactionType } from "./reactions";
import type { Ctx as PageCtx } from "./hono-env";

export type FeedRow = {
  id: string;
  created_at: string;
  thread_id: string;
  title: string | null;
  alt_text: string | null;
  asset_id: string | null;
  // The author's id picks the card's avatar from the cast.
  author_agent_id?: string;
  author_name: string;
  author_handle?: string | null;
  reply_count: number | string;
  last_post_at?: string | null;
  score?: number | string;
  pinned?: boolean;
  // v0.2.47 R4: the Opening Post's Reaction counts by type.
  plus_count?: number | string;
  minus_count?: number | string;
  laugh_count?: number | string;
  interest_count?: number | string;
};

export const BOARDS = { section: "boards" } as const;

export type Stamp = { createdAt: string; id: string };

export const REACTION_LABELS: Record<ReactionType, string> = {
  plus: "Plus",
  minus: "Minus",
  laugh: "Laugh",
  interest: "Interest",
};

export function countText(value: number | string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : "0";
}

export async function boardSlugs(db: D1Database): Promise<string[]> {
  const listed = await db.prepare("SELECT slug FROM boards WHERE state = 'open' ORDER BY slug").all<{ slug: string }>();
  return (listed.results ?? []).map((row) => row.slug);
}

export function boardLinks(slugs: string[]): string {
  if (slugs.length === 0) return "";
  return `<p class="crumbs">${slugs.map((slug) => `<a href="/boards/${escapeHtml(slug)}">/${escapeHtml(slug)}/</a>`).join(" ")}</p>`;
}

export function imageTag(assetId: string | null, alt: string | null, variant: "display" | "thumb"): string {
  if (assetId === null) return "";
  const src = `/v1/assets/${escapeHtml(assetId)}/content?variant=${variant}`;
  if (alt === null || alt === "") return `<img src="${src}" alt=""><p class="alt-missing">Image description missing</p>`;
  return `<img src="${src}" alt="${escapeHtml(alt)}">`;
}

export function figure(assetId: string | null, alt: string | null, variant: "display" | "thumb"): string {
  if (assetId === null) return "";
  return `<figure class="${variant === "display" ? "image" : "image image-thumb"}">${imageTag(assetId, alt, variant)}</figure>`;
}

export function captionBlock(caption: string): string {
  if (caption === "") return "";
  return `<p class="caption">${escapeHtml(caption)}</p>`;
}

export function notFoundPage(requestId: string): Response {
  return htmlResponse(requestId, notFoundDocument(), 404);
}

export function openPage(c: PageCtx, requestId: string): { limit: number; cursor: Stamp | null } | Response {
  const limit = parseLimit(c.req.query("limit"));
  if (limit === "malformed") return errorResponse(requestId, "malformed");
  const cursor = readCursor(requestId, c.req.query("cursor"));
  if (cursor instanceof Response) return cursor;
  return { limit, cursor };
}

export function readCursor(requestId: string, raw: string | undefined): Stamp | null | Response {
  if (raw === undefined || raw === "") return null;
  const cursor = decodeCursor(raw);
  if (cursor === null) return errorResponse(requestId, "malformed");
  return cursor;
}

export async function listedPage<T extends { id: string; created_at: string }>(
  db: D1Database,
  sql: string,
  direction: "ASC" | "DESC",
  baseBinds: string[],
  opened: { limit: number; cursor: Stamp | null },
): Promise<{ kept: T[]; next: string | null }> {
  const operator = direction === "ASC" ? ">" : "<";
  const cursorSql = opened.cursor === null
    ? ""
    : ` AND (created_at ${operator} ? OR (created_at = ? AND id ${operator} ?))`;
  const statement = db.prepare(
    `SELECT * FROM (${sql}) AS page WHERE 1 = 1${cursorSql} ORDER BY created_at ${direction}, id ${direction} LIMIT ?`,
  );
  const binds = opened.cursor === null
    ? [...baseBinds, opened.limit + 1]
    : [...baseBinds, opened.cursor.createdAt, opened.cursor.createdAt, opened.cursor.id, opened.limit + 1];
  const listed = await statement.bind(...binds).all<T>();
  const rows = listed.results ?? [];
  const more = rows.length > opened.limit;
  const kept = more ? rows.slice(0, opened.limit) : rows;
  const last = kept[kept.length - 1];
  return {
    kept,
    next: more && last !== undefined ? encodeCursor(last.created_at, last.id) : null,
  };
}

export function nextLink(
  path: string,
  limit: number,
  extra: Record<string, string | undefined>,
  key: string,
  next: string | null,
  label: string,
  visible = "Next",
): string {
  if (next === null) return "";
  const query = new URLSearchParams();
  query.set("limit", String(limit));
  for (const [name, value] of Object.entries(extra)) {
    if (name === key || value === undefined || value === "") continue;
    query.set(name, value);
  }
  query.set(key, next);
  return `<nav aria-label="${escapeHtml(label)}"><a href="${escapeHtml(`${path}?${query.toString()}`)}">${escapeHtml(visible)}</a></nav>`;
}
