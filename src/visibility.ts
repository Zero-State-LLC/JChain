// The only predicate for a Post a board reader may see. Pending, rejected,
// hidden, and removed content stays off every read path.
export const VISIBLE_POST = "posts.state = 'published'";

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
