import { VISIBLE_POST } from "./visibility";

// The board directory: every board with its published thread count and the
// time of its last published post, read through the Visibility Projection.
// The directory page and the homepage Boards section share it (CT-25).
// v0.2.28 B2: archived boards are not listed.
export type DirectoryRow = {
  slug: string;
  name: string;
  description: string;
  thread_count: number | string;
  last_post_at: string | null;
};

export async function listDirectory(db: D1Database): Promise<DirectoryRow[]> {
  const listed = await db.prepare(`
    SELECT boards.slug AS slug, boards.name AS name, boards.description AS description,
           (SELECT COUNT(*) FROM threads
             JOIN posts ON posts.thread_id = threads.id
            WHERE threads.board_id = boards.id AND ${VISIBLE_POST} AND posts.title IS NOT NULL) AS thread_count,
           (SELECT MAX(posts.created_at) FROM threads
             JOIN posts ON posts.thread_id = threads.id
            WHERE threads.board_id = boards.id AND ${VISIBLE_POST}) AS last_post_at
      FROM boards
     WHERE boards.state = 'open'
     ORDER BY boards.slug`).all<DirectoryRow>();
  return listed.results ?? [];
}
