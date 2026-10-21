import { requirePrincipal } from "./auth";
import { fail, isResponse, ok, type App } from "./http";

type BoardRow = {
  id: string;
  slug: string;
  title: string;
  visibility: string;
  created_at: string;
};

function parseLimit(value: string | undefined): number | null {
  if (value === undefined) return 25;
  if (!/^[1-9][0-9]*$/.test(value)) return null;
  const limit = Number(value);
  if (limit < 1 || limit > 100) return null;
  return limit;
}

function encodeCursor(createdAt: string, id: string): string {
  return btoa(JSON.stringify({ created_at: createdAt, id }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeCursor(value: string): { created_at: string; id: string } | null {
  if (value.length === 0 || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const parsed: unknown = JSON.parse(atob(padded));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.created_at !== "string" || typeof record.id !== "string") return null;
    if (record.created_at.length > 40 || record.id.length > 80) return null;
    return { created_at: record.created_at, id: record.id };
  } catch {
    return null;
  }
}

export function registerBoardRoutes(app: App): void {
  app.get("/v1/boards", async (c) => {
    const principal = await requirePrincipal(c);
    if (isResponse(principal)) return principal;

    const limit = parseLimit(c.req.query("limit"));
    if (limit === null) return fail(c, 400, "bad_request", "Limit must be an integer from 1 to 100.");

    const cursorParam = c.req.query("cursor");
    let cursor: { created_at: string; id: string } | null = null;
    if (cursorParam) {
      cursor = decodeCursor(cursorParam);
      if (!cursor) return fail(c, 400, "bad_request", "Cursor is invalid.");
    }

    const listed = await c.env.DB.prepare(
      `SELECT id, slug, title, visibility, created_at
       FROM boards
       WHERE (? IS NULL OR created_at > ? OR (created_at = ? AND id > ?))
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
      .bind(cursor?.created_at ?? null, cursor?.created_at ?? null, cursor?.created_at ?? null, cursor?.id ?? null, limit + 1)
      .all<BoardRow>();

    const hasMore = listed.results.length > limit;
    const page = hasMore ? listed.results.slice(0, limit) : listed.results;
    const last = hasMore ? page[page.length - 1] : undefined;
    const nextCursor = last ? encodeCursor(last.created_at, last.id) : null;

    return ok(c, 200, {
      boards: page.map((row) => ({
        id: row.id,
        slug: row.slug,
        title: row.title,
        visibility: row.visibility,
      })),
      page: { limit, next_cursor: nextCursor },
    });
  });
}
