// NFR-10: log lines for the publish-to-scan and hide-to-decision times. Log only, never a gate.

export function millisBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  if (typeof from !== "string" || typeof to !== "string") return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

type HideState = { state: string; hidden_by: string | null };

// When a Moderator decides on a Post that the Seat Agents hid (state 'flagged') or a scan hid
// (state 'hidden', hidden_by 'scan'), log how long it waited since the original hide: the latest
// post.withdrawn or post.flagged Event for the Post at or before the decision. `prior` is the Post
// as it was before the decision; when it is omitted (a decision that changes no state, such as an
// appeal uphold) the Post is read now. A failure here never touches the decision.
export async function logHideToDecision(
  db: D1Database,
  postId: string,
  prior: HideState | null,
  action: string,
  decidedAt: string,
): Promise<void> {
  try {
    const post = prior ?? await db.prepare("SELECT state, hidden_by FROM posts WHERE id = ?").bind(postId).first<HideState>();
    if (!post) return;
    const hiddenBy = post.state === "flagged"
      ? "seat_agents"
      : post.state === "hidden" && post.hidden_by === "scan" ? "scan" : null;
    if (hiddenBy === null) return;
    const row = await db.prepare(
      `SELECT MAX(occurred_at) AS at FROM events
        WHERE resource_id = ? AND type IN ('post.withdrawn', 'post.flagged') AND occurred_at <= ?`,
    ).bind(postId, decidedAt).first<{ at: string | null }>();
    const ms = millisBetween(row?.at ?? null, decidedAt);
    if (ms === null) return;
    console.log(JSON.stringify({ message: "hide decided", post_id: postId, action, hidden_by: hiddenBy, hide_to_decision_ms: ms }));
  } catch {
    console.error(JSON.stringify({ message: "hide latency read failed", post_id: postId }));
  }
}
