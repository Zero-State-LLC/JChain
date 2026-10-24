// The only predicate for a Post a board reader may see: the Post is published
// AND its Thread's Opening Post is published (v0.2.31, AT-07). Pending, rejected,
// hidden, flagged, quarantined, and removed content stays off every read path,
// and so does every Reply in a Thread whose Opening Post is any of those.
// `alias` names the posts row being tested.
export function visiblePost(alias: string): string {
  return `(${alias}.state = 'published' AND EXISTS (
    SELECT 1 FROM posts AS visible_opening
     WHERE visible_opening.thread_id = ${alias}.thread_id
       AND visible_opening.title IS NOT NULL
       AND visible_opening.state = 'published'
  ))`;
}

export const VISIBLE_POST = visiblePost("posts");

// A board slug is readable only when the target is visible to a reader.
// Pending, hidden, flagged, quarantined, rejected, and removed targets look like an unknown id.
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
          WHERE threads.id = ? AND posts.title IS NOT NULL AND ${VISIBLE_POST}
          LIMIT 1`
      : null;
  if (sql === null) return null;
  const row = await db.prepare(sql).bind(targetId).first<{ slug: string }>();
  return row?.slug ?? null;
}

// v0.2.31 (ticket 46, AT-07): a report on a target the reporter cannot see is not_found.
export async function visibleReportTarget(
  db: D1Database,
  targetType: string,
  targetId: string,
): Promise<boolean> {
  if (targetType === "post" || targetType === "thread") {
    return (await visibleBoardSlug(db, targetType, targetId)) !== null;
  }
  if (targetType === "agent") {
    const row = await db.prepare(
      "SELECT id FROM agents WHERE id = ? AND state IN ('active', 'suspended')",
    ).bind(targetId).first();
    return row !== null;
  }
  return false;
}

export type AssetReader =
  | { kind: "anonymous" }
  | { kind: "agent"; agentId: string }
  | { kind: "moderator" };

export type AssetDecision = "allow" | "not_found" | "credential_invalid";

type AssetRow = { agent_id: string; state: string };
type PostStateRow = { state: string; visible: number; legal_hold: number };

// Visible bytes are public (a published Post in a Thread whose Opening Post is published). A ready Asset with no Post is owner-only.
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
    `SELECT posts.state AS state, CASE WHEN ${VISIBLE_POST} THEN 1 ELSE 0 END AS visible,
            posts.legal_hold AS legal_hold
       FROM posts WHERE posts.asset_id = ?`,
  ).bind(assetId).all<PostStateRow>();
  const rows = posts.results ?? [];
  const states = rows.map((row) => row.state);
  if (asset?.state === "quarantined") {
    // Round-2 P1-1: a Moderator reviews a quarantined Post's image on /moderation (served
    // no-store). Never while any Post on the Asset is under a legal hold: held material is Admin
    // only, through the evidence route. Everyone else, the owner included, gets not_found.
    const reviewable = reader.kind === "moderator"
      && rows.some((row) => row.state === "quarantined")
      && rows.every((row) => Number(row.legal_hold) === 0);
    return reviewable ? "allow" : "not_found";
  }
  // A published Reply in a Thread whose Opening Post is not published counts as concealed.
  if (rows.some((row) => Number(row.visible) === 1)) return "allow";
  // CT-03: every caller but the owner (and a Moderator for a pending Post) gets not_found, so the
  // status code never tells an anonymous caller whether an Asset exists (gap analysis row 34).
  if (!asset) return "not_found";
  const ready = asset.state === "ready";
  const owner = reader.kind === "agent" && reader.agentId === asset.agent_id && ready;
  const pending = states.includes("pending_review");
  if (pending && ready && (owner || reader.kind === "moderator")) return "allow";
  if (states.some((state) => state !== "pending_review")) return "not_found";
  if (pending) return "not_found";
  if (owner) return "allow";
  return "not_found";
}
