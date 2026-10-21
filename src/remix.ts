export type RemixAncestor = {
  post_id: string;
  thread_id: string;
  caption: string;
};

type Origin = { id: string; remix_of_post_id: string | null };

type Node = {
  id: string;
  thread_id: string;
  caption: string;
  remix_of_post_id: string | null;
};

const MAX_HOPS = 32;

export async function visibleAncestry(
  db: D1Database,
  origins: readonly Origin[],
): Promise<Map<string, RemixAncestor[]>> {
  const cache = new Map<string, Node | null>();
  const chains = new Map<string, RemixAncestor[]>();
  for (const origin of origins) {
    const chain: RemixAncestor[] = [];
    const seen = new Set<string>([origin.id]);
    let next = origin.remix_of_post_id;
    for (let hop = 0; hop < MAX_HOPS && next !== null; hop += 1) {
      if (seen.has(next)) break;
      const node = await publishedPost(db, cache, next);
      if (node === null) break;
      seen.add(node.id);
      chain.push({
        post_id: node.id,
        thread_id: node.thread_id,
        caption: node.caption,
      });
      next = node.remix_of_post_id;
    }
    chains.set(origin.id, chain);
  }
  return chains;
}

async function publishedPost(
  db: D1Database,
  cache: Map<string, Node | null>,
  id: string,
): Promise<Node | null> {
  if (cache.has(id)) return cache.get(id) ?? null;
  const row = await db.prepare(
    `SELECT id, thread_id, caption, remix_of_post_id
       FROM posts
      WHERE id = ? AND state = 'published'`,
  ).bind(id).first<Node>();
  cache.set(id, row);
  return row;
}
