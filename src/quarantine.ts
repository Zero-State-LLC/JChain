// v0.2.36 quarantine-first moderation (Danny, 2026-10-23 3:44 PM PT): posting happens first, the
// system recommends a Post for moderation, messages the Moderators, and quarantines the Post until a
// Moderator clears or archives it. Every automatic path (the Content Scan, a Seat Flag, a signed-in
// report) builds its writes here, so all three have the same effects in one D1 batch.
import { blockAssetHashes } from "./blocked-hashes";
import { uuidv7 } from "./ids";

export type QuarantineSource = "scan" | "seat_agents" | "report";

export type QuarantinePlan = {
  postId: string;
  assetId: string | null;
  source: QuarantineSource;
  // Audit actor: 'system' for the scan, 'seat_agent' for a Seat Flag, the reporter's email for a report.
  actor: string;
  reasonCode: string;
  // id-document, csam, and the scan's S4: the Asset's hashes join the Blocked Hash list as prohibited.
  prohibited: boolean;
  // Only a csam report places a legal hold.
  legalHold: boolean;
  at: string;
  // Optional extra guard, ANDed to "the Post is published". Its binds follow the Post id.
  guard?: { sql: string; binds: unknown[] };
};

export type QuarantineBatch = {
  statements: D1PreparedStatement[];
  // Index, within `statements`, of the Post update. One change means the quarantine applied.
  updateIndex: number;
  actionId: string;
  eventId: string;
};

// Published to quarantined, its Asset ready to quarantined with quarantined_at, queue first, one
// post.withdrawn Event, and one audit row. Every write is guarded on the Post still being published
// (and the caller's guard), or on this batch's audit row, so a raced or replayed call writes nothing.
export function quarantineStatements(db: D1Database, plan: QuarantinePlan): QuarantineBatch {
  const where = `posts.id = ? AND posts.state = 'published'${plan.guard === undefined ? "" : ` AND (${plan.guard.sql})`}`;
  const binds: unknown[] = [plan.postId, ...(plan.guard?.binds ?? [])];
  const eventId = uuidv7();
  const actionId = uuidv7();
  const hold = plan.legalHold ? ", legal_hold = 1, legal_hold_reason = 'csam'" : "";
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO events (id, type, resource_id, occurred_at)
       SELECT ?, 'post.withdrawn', posts.id, ? FROM posts WHERE ${where}`,
    ).bind(eventId, plan.at, ...binds),
    db.prepare(
      `INSERT INTO moderation_actions (
         id, actor_email, target_type, target_id, action, reason_code, private_note, event_id, created_at
       )
       SELECT ?, ?, 'post', posts.id, 'quarantine', ?, NULL, ?, ? FROM posts WHERE ${where}`,
    ).bind(actionId, plan.actor, plan.reasonCode, eventId, plan.at, ...binds),
  ];
  const updateIndex = statements.length;
  statements.push(db.prepare(
    `UPDATE posts SET state = 'quarantined', quarantined_by = ?, queue_first = 1${hold} WHERE ${where}`,
  ).bind(plan.source, ...binds));
  if (plan.assetId !== null) {
    statements.push(db.prepare(
      `UPDATE assets SET state = 'quarantined', quarantined_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ? AND state = 'ready' AND EXISTS (SELECT 1 FROM moderation_actions WHERE id = ?)`,
    ).bind(plan.assetId, actionId));
    if (plan.prohibited) statements.push(blockAssetHashes(db, plan.assetId, true, plan.at, actionId));
  }
  return { statements, updateIndex, actionId, eventId };
}
