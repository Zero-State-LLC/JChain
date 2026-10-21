// The only predicate for a Post a board reader may see. Pending, rejected,
// hidden, and removed content stays off every read path.
export const VISIBLE_POST = "posts.state = 'published'";

// A board slug is readable only when the target has a published Post.
// Pending, hidden, rejected, and removed targets look like an unknown id.
export async function visibleBoardSlug(
  db: D1Database,
  targetType: string,
  targetId: string,
): Promise<string | null> {
  const sql = targetType === "post"
    ? `SELECT boards.slug AS slug
         FROM posts
         JOIN threads ON threads.id = posts.thread_id
         JOIN boards ON boards.id = threads.board_id
        WHERE posts.id = ? AND ${VISIBLE_POST}`
    : targetType === "thread"
      ? `SELECT boards.slug AS slug
           FROM threads
           JOIN posts ON posts.thread_id = threads.id
           JOIN boards ON boards.id = threads.board_id
          WHERE threads.id = ? AND ${VISIBLE_POST}
          LIMIT 1`
      : null;
  if (sql === null) return null;
  const row = await db.prepare(sql).bind(targetId).first<{ slug: string }>();
  return row?.slug ?? null;
}

export type AssetReader =
  | { kind: "anonymous" }
  | { kind: "agent"; agentId: string }
  | { kind: "moderator" };

export type AssetDecision = "allow" | "not_found" | "credential_invalid";

type AssetRow = { agent_id: string; state: string };
type PostStateRow = { state: string };

// Published bytes are public. A ready Asset with no Post is owner-only.
// A pending Post lets its owner and a Moderator preview the image, including
// when an older Post on the same Asset was rejected or hidden. Dedup reuses
// that Asset. With no pending and no published Post, those states hide the bytes.
export async function projectAsset(
  db: D1Database,
  assetId: string,
  reader: AssetReader,
): Promise<AssetDecision> {
  const asset = await db.prepare(
    "SELECT agent_id, state FROM assets WHERE id = ?",
  ).bind(assetId).first<AssetRow>();
  const posts = await db.prepare(
    "SELECT state FROM posts WHERE asset_id = ?",
  ).bind(assetId).all<PostStateRow>();
  const states = (posts.results ?? []).map((row) => row.state);
  if (asset?.state === "quarantined") return "not_found";
  if (states.includes("published")) return "allow";
  if (!asset) return reader.kind === "anonymous" ? "credential_invalid" : "not_found";
  const ready = asset.state === "ready";
  const owner = reader.kind === "agent" && reader.agentId === asset.agent_id && ready;
  const pending = states.includes("pending_review");
  if (pending && ready && (owner || reader.kind === "moderator")) return "allow";
  if (states.some((state) => state !== "pending_review")) return "not_found";
  if (pending) return "not_found";
  if (owner) return "allow";
  if (reader.kind === "anonymous") return "credential_invalid";
  return "not_found";
}
