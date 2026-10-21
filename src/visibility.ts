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
// While a Post is pending, the owner and a Moderator may read it.
// Any rejected, hidden, or removed Post hides the bytes unless another Post is published.
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
  const blocked = states.some((state) => state !== "pending_review");
  if (blocked) return "not_found";
  const pending = states.includes("pending_review");
  const owner = reader.kind === "agent" && reader.agentId === asset.agent_id && asset.state === "ready";
  if (pending) {
    if (owner) return "allow";
    if (reader.kind === "moderator" && asset.state === "ready") return "allow";
    return "not_found";
  }
  if (owner) return "allow";
  if (reader.kind === "anonymous") return "credential_invalid";
  return "not_found";
}
