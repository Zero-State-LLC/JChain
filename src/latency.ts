// NFR-10: log lines for the publish-to-scan and hide-to-decision times. Log only, never a gate.

export function millisBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  if (typeof from !== "string" || typeof to !== "string") return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

// When a Moderator decides on a Post that the Seat Agents hid (state 'flagged') or a scan hid
// (state 'hidden' with the scan's 'system' hide as its latest hide), log how long it waited.
// `priorState` is the Post's state before the decision. A failure here never touches the decision.
export async function logHideToDecision(
  db: D1Database,
  postId: string,
  priorState: string,
  action: string,
  decidedAt: string,
): Promise<void> {
  if (priorState !== "flagged" && priorState !== "hidden") return;
  try {
    let hiddenBy: "seat_agents" | "scan";
    let hiddenAt: string | null;
    if (priorState === "flagged") {
      hiddenBy = "seat_agents";
      const row = await db.prepare(
        `SELECT MAX(occurred_at) AS at FROM events
          WHERE type = 'post.withdrawn' AND resource_id = ? AND occurred_at <= ?`,
      ).bind(postId, decidedAt).first<{ at: string | null }>();
      hiddenAt = row?.at ?? null;
    } else {
      hiddenBy = "scan";
      const row = await db.prepare(
        `SELECT actor_email, created_at FROM moderation_actions
          WHERE target_type = 'post' AND target_id = ? AND action = 'hide' AND created_at <= ?
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      ).bind(postId, decidedAt).first<{ actor_email: string; created_at: string }>();
      if (row?.actor_email !== "system") return;
      hiddenAt = row.created_at;
    }
    const ms = millisBetween(hiddenAt, decidedAt);
    if (ms === null) return;
    console.log(JSON.stringify({ message: "hide decided", post_id: postId, action, hidden_by: hiddenBy, hide_to_decision_ms: ms }));
  } catch {
    console.error(JSON.stringify({ message: "hide latency read failed", post_id: postId }));
  }
}
