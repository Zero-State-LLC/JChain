import { decodeCursor } from "./browse";
import { isUuidV7 } from "./ids";
import { VISIBLE_POST, visiblePost } from "./visibility";
import { decodeBase64url, encodeBase64url } from "./base64url";

// Board feed orders (Danny, 2026-10-24, "Add Active tab"). New stays the default (C-07): newest
// Opening Post first. Active sorts Threads by their bump, the publish time of the latest visible
// Post. Replies past the bump limit never bump. The bump is computed at read from visible Posts,
// so a Reply that leaves `published` takes its bump with it.
export const BOARD_SORTS = ["new", "active"] as const;
export type BoardSort = (typeof BOARD_SORTS)[number];

// Spec constant: the 301st published Reply of a Thread, and every later one, does not bump it.
export const BUMP_LIMIT = 300;

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const VERSION = "b1";
const NONE = "-";

export function parseSort(raw: string | undefined): BoardSort | null | "malformed" {
  if (raw === undefined) return null;
  return (BOARD_SORTS as readonly string[]).includes(raw) ? raw as BoardSort : "malformed";
}

// The bump of the Thread whose Opening Post is `opening`. With fewer than BUMP_LIMIT visible
// Replies it is the newest visible Post. From BUMP_LIMIT on it is the BUMP_LIMIT-th visible
// Reply, oldest first, so later Replies add nothing. A snapshot id leaves out Posts written
// after the first page of an API listing, so later pages keep the order the first page saw.
// The snapshot is the highest rowid of the Board's visible Posts when page 1 was read (codex
// review on #168, v0.2.40): a rowid is assigned when the row is inserted, so a Reply that commits
// later, even one whose id was allocated earlier, is above it. Posts rows are never deleted, so
// rowids only grow.
// The snapshot is a validated whole number, so it is inlined.
export function bumpSql(opening: string, snapshot: number | null): string {
  if (snapshot !== null && !Number.isSafeInteger(snapshot)) throw new Error("bad snapshot");
  const capped = (alias: string): string => snapshot === null ? "" : ` AND ${alias}.rowid <= ${snapshot}`;
  return `MAX(${opening}.created_at, COALESCE(
    (SELECT bump_reply.created_at FROM posts AS bump_reply
      WHERE bump_reply.thread_id = ${opening}.thread_id AND bump_reply.title IS NULL
        AND ${visiblePost("bump_reply")}${capped("bump_reply")}
      ORDER BY bump_reply.created_at ASC, bump_reply.id ASC
      LIMIT 1 OFFSET ${BUMP_LIMIT - 1}),
    (SELECT MAX(bump_latest.created_at) FROM posts AS bump_latest
      WHERE bump_latest.thread_id = ${opening}.thread_id
        AND ${visiblePost("bump_latest")}${capped("bump_latest")}),
    ${opening}.created_at))`;
}

// The commit-order boundary for an Active listing: the highest rowid of the Board's Posts a reader
// sees (Visibility Projection). Every Post inserted after this read is above it, since rowids only
// grow. Only visible Posts count, so the cursor does not reveal how many Posts were written that no
// reader sees (independent review, v0.2.40): a quarantined or pending Post leaves it unchanged.
export async function postsSnapshot(db: D1Database, boardId: string): Promise<number> {
  const row = await db.prepare(
    `SELECT COALESCE(MAX(posts.rowid), 0) AS n
       FROM posts JOIN threads ON threads.id = posts.thread_id
      WHERE threads.board_id = ? AND ${VISIBLE_POST}`,
  ).bind(boardId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

// The board's pinned Thread, only while its Opening Post is visible (Visibility Projection).
export async function visiblePinnedThread(db: D1Database, boardId: string): Promise<string | null> {
  const row = await db.prepare(
    `SELECT board_pins.thread_id AS thread_id
       FROM board_pins
       JOIN threads ON threads.id = board_pins.thread_id AND threads.board_id = board_pins.board_id
       JOIN posts ON posts.thread_id = threads.id AND posts.title IS NOT NULL
      WHERE board_pins.board_id = ? AND ${VISIBLE_POST}`,
  ).bind(boardId).first<{ thread_id: string }>();
  return row?.thread_id ?? null;
}

// The board feed cursor. It carries the sort, the Thread left out because page 1 showed it
// pinned, the Active snapshot, and the keyset (sort key, Opening Post id) of the last row. No
// keyset means the next page starts at the top of the unpinned rows.
export type BoardCursor = {
  sort: BoardSort;
  pinned: string | null;
  snapshot: number | null;
  key: string | null;
  id: string | null;
};

export function encodeBoardCursor(cursor: BoardCursor): string {
  const text = [
    VERSION,
    cursor.sort,
    cursor.pinned ?? NONE,
    cursor.snapshot === null ? NONE : String(cursor.snapshot),
    cursor.key ?? NONE,
    cursor.id ?? NONE,
  ].join("|");
  return encodeBase64url(text);
}

// Accepts this cursor and the older (created_at, id) cursor, which is a New cursor.
export function decodeBoardCursor(value: string): BoardCursor | null {
  const legacy = decodeCursor(value);
  if (legacy !== null) {
    return { sort: "new", pinned: null, snapshot: null, key: legacy.createdAt, id: legacy.id };
  }
  const text = decodeBase64url(value);
  if (text === null) return null;
  const parts = text.split("|");
  if (parts.length !== 6 || parts[0] !== VERSION) return null;
  const [, sort, pinned, snapshot, key, id] = parts as [string, string, string, string, string, string];
  if (sort !== "new" && sort !== "active") return null;
  const optionalId = (part: string): string | null | false => part === NONE ? null : isUuidV7(part) ? part : false;
  const pinnedId = optionalId(pinned);
  const snapshotValue = snapshot === NONE
    ? null
    : /^(0|[1-9][0-9]{0,14})$/.test(snapshot) ? Number(snapshot) : false;
  const lastId = optionalId(id);
  if (pinnedId === false || snapshotValue === false || lastId === false) return null;
  const keyValue = key === NONE ? null : STAMP.test(key) ? key : false;
  if (keyValue === false) return null;
  if ((keyValue === null) !== (lastId === null)) return null;
  // Active always carries its snapshot; New never does.
  if ((sort === "active") !== (snapshotValue !== null)) return null;
  return { sort, pinned: pinnedId, snapshot: snapshotValue, key: keyValue, id: lastId };
}
