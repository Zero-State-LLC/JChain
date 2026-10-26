// v0.2.36 quarantine-first moderation (Danny, 2026-10-23 3:44 PM PT): posting happens first, the
// system recommends a Post for moderation, messages the Moderators, and quarantines the Post until a
// Moderator clears or archives it. Every automatic path (the Content Scan, a Seat Flag, a signed-in
// report) builds its writes here, so all three have the same effects in one D1 batch.
import { blockAssetHashes } from "./blocked-hashes";
import { uuidv7 } from "./ids";

export type QuarantineSource = "scan" | "seat_agents" | "report";

// v0.2.37 (#74): the audit actor of a CSAM Scanning Tool block, so the Moderator email and the
// moderation page can name it. Its source is 'report' only so the author cannot appeal it.
export const MEDIA_MATCH_ACTOR = "csam-scanning-tool";

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
  // The other Posts on the same Asset that the batch quarantines with this one.
  siblingIds: string[];
};

// Published to quarantined, its Asset ready to quarantined with quarantined_at, queue first, one
// post.withdrawn Event, and one audit row. Every write is guarded on the Post still being published
// (and the caller's guard), or on this batch's audit row, so a raced or replayed call writes nothing.
//
// The item is the image (round-2 P0-2): upload dedup can give one Asset to several Posts of the same
// Agent, so every other published Post on the Asset is quarantined in the same batch, with the same
// source, reason, and hold, each with its own audit row and post.withdrawn Event. No published Post
// is left on a quarantined Asset. The caller sends one alert.
export async function quarantineStatements(db: D1Database, plan: QuarantinePlan): Promise<QuarantineBatch> {
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
  let siblingIds: string[] = [];
  if (plan.assetId !== null) {
    const siblings = await siblingQuarantineStatements(db, {
      assetId: plan.assetId,
      postId: plan.postId,
      actionId,
      actor: plan.actor,
      reasonCode: plan.reasonCode,
      source: plan.source,
      legalHold: plan.legalHold,
      at: plan.at,
    });
    siblingIds = siblings.siblingIds;
    statements.push(...siblings.statements);
    statements.push(db.prepare(
      `UPDATE assets SET state = 'quarantined', quarantined_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ? AND state = 'ready' AND EXISTS (SELECT 1 FROM moderation_actions WHERE id = ?)`,
    ).bind(plan.assetId, actionId));
    if (plan.prohibited) statements.push(blockAssetHashes(db, plan.assetId, true, plan.at, actionId));
  }
  return { statements, updateIndex, actionId, eventId, siblingIds };
}

export type SiblingPlan = {
  assetId: string;
  // The Post the caller's batch decides; it is never a sibling.
  postId: string;
  // The caller's audit row. Every sibling write runs only when it exists.
  actionId: string;
  actor: string;
  reasonCode: string;
  // NULL for a Moderator quarantine.
  source: QuarantineSource | null;
  legalHold: boolean;
  at: string;
};

// The other published Posts on an Asset, quarantined in the caller's batch: one audit row and one
// post.withdrawn Event each, the same source, reason, and hold, and the queue-first mark. Used by
// the shared step above and by a Moderator action that quarantines the Asset (a prohibited
// quarantine, a csam removal).
//
// A pending Post on the Asset is left pending: it is not public, it already waits for a Moderator,
// and approve needs a ready Asset, so it cannot publish while the image is quarantined. Moving it
// to quarantined would let a later Clear publish it without an approval.
export async function siblingQuarantineStatements(
  db: D1Database,
  plan: SiblingPlan,
): Promise<{ statements: D1PreparedStatement[]; siblingIds: string[] }> {
  const listed = await db.prepare(
    `SELECT id FROM posts
      WHERE asset_id = ? AND id != ? AND state = 'published'
      ORDER BY created_at, id`,
  ).bind(plan.assetId, plan.postId).all<{ id: string }>();
  const hold = plan.legalHold ? ", legal_hold = 1, legal_hold_reason = 'csam'" : "";
  const sibling = `posts.id = ? AND posts.state = 'published'
    AND EXISTS (SELECT 1 FROM moderation_actions WHERE moderation_actions.id = ?)`;
  const statements: D1PreparedStatement[] = [];
  const siblingIds: string[] = [];
  for (const row of listed.results ?? []) {
    siblingIds.push(row.id);
    const siblingEvent = uuidv7();
    statements.push(
      db.prepare(
        `INSERT INTO events (id, type, resource_id, occurred_at)
         SELECT ?, 'post.withdrawn', posts.id, ? FROM posts WHERE ${sibling}`,
      ).bind(siblingEvent, plan.at, row.id, plan.actionId),
      db.prepare(
        `INSERT INTO moderation_actions (
           id, actor_email, target_type, target_id, action, reason_code, private_note, event_id, created_at
         )
         SELECT ?, ?, 'post', posts.id, 'quarantine', ?, NULL, ?, ? FROM posts WHERE ${sibling}`,
      ).bind(uuidv7(), plan.actor, plan.reasonCode, siblingEvent, plan.at, row.id, plan.actionId),
      db.prepare(
        `UPDATE posts SET state = 'quarantined', quarantined_by = ?, queue_first = 1${hold} WHERE ${sibling}`,
      ).bind(plan.source, row.id, plan.actionId),
    );
  }
  return { statements, siblingIds };
}
