import { VISIBLE_POST } from "./visibility";

export type RemixAncestor = {
  post_id: string;
  thread_id: string;
  caption: string;
};

type AncestryRow = {
  origin_id: string;
  post_id: string;
  thread_id: string;
  caption: string;
  hop: number;
};

const MAX_HOPS = 32;
// D1 allows 100 bound parameters per statement.
const ID_BATCH = 80;

export async function visibleAncestry(
  db: D1Database,
  originIds: readonly string[],
): Promise<Map<string, RemixAncestor[]>> {
  const chains = new Map<string, RemixAncestor[]>();
  for (const id of originIds) chains.set(id, []);
  const ids = [...new Set(originIds)];
  for (let start = 0; start < ids.length; start += ID_BATCH) {
    const batch = ids.slice(start, start + ID_BATCH);
    const rows = await ancestryRows(db, batch);
    const seen = new Map<string, Set<string>>();
    const stopped = new Set<string>();
    for (const row of rows) {
      if (stopped.has(row.origin_id)) continue;
      const used = seen.get(row.origin_id) ?? new Set<string>();
      if (used.has(row.post_id)) {
        stopped.add(row.origin_id);
        continue;
      }
      used.add(row.post_id);
      seen.set(row.origin_id, used);
      chains.get(row.origin_id)?.push({
        post_id: row.post_id,
        thread_id: row.thread_id,
        caption: row.caption,
      });
    }
  }
  return chains;
}

async function ancestryRows(db: D1Database, ids: readonly string[]): Promise<AncestryRow[]> {
  const placeholders = ids.map(() => "?").join(", ");
  const listed = await db.prepare(
    `WITH RECURSIVE chain AS (
       SELECT origin.id AS origin_id, posts.id AS post_id, posts.thread_id AS thread_id,
              posts.caption AS caption, posts.remix_of_post_id AS next_id, 1 AS hop
         FROM posts AS origin
         JOIN posts
           ON posts.id = origin.remix_of_post_id
          AND ${VISIBLE_POST}
          AND posts.id != origin.id
        WHERE origin.id IN (${placeholders})
       UNION ALL
       SELECT chain.origin_id, posts.id, posts.thread_id, posts.caption, posts.remix_of_post_id,
              chain.hop + 1
         FROM chain
         JOIN posts
           ON posts.id = chain.next_id
          AND ${VISIBLE_POST}
          AND posts.id != chain.origin_id
        WHERE chain.hop < ${MAX_HOPS} AND chain.next_id IS NOT NULL
     )
     SELECT origin_id, post_id, thread_id, caption, hop
       FROM chain
      ORDER BY hop ASC, origin_id ASC`,
  ).bind(...ids).all<AncestryRow>();
  return listed.results ?? [];
}
