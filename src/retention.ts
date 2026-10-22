import { derivativeKey, originalKey, refundDerivatives } from "./asset-pipeline";
import { utcSeconds } from "./ids";
import { parsePolicy, type Policy } from "./policy";
import { purgeConnections } from "./connect";
import { purgeEndedSignIns } from "./session";

// Retention sweep (SPEC Retention, Asset state machine). Runs from the Worker
// `scheduled` handler. Every step is idempotent and bounded per run, so a cron
// that fires often simply drains a backlog over several runs.

export const RETENTION_BATCH = 100;
export const AUDIT_BATCH = 500;
export const REDACTED_EMAIL = "redacted";
// A reservation is purged one hour after its upload token expired, so a PUT that
// passed the expiry check at the boundary has finished writing first.
export const RESERVATION_GRACE_HOURS = 1;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

type RetentionEnv = Pick<Env, "DB" | "MEDIA" | "POLICY" | "QUOTA">;

export type RetentionResult = {
  ran: boolean;
  audit_redacted: number;
  reports_redacted: number;
  assets_deleted: number;
};

export async function runRetention(env: RetentionEnv, now: number): Promise<RetentionResult> {
  const policy = parsePolicy(typeof env.POLICY === "string" ? env.POLICY : undefined);
  if (policy === null) {
    console.log(JSON.stringify({ message: "retention skipped", reason: "policy_missing" }));
    return { ran: false, audit_redacted: 0, reports_redacted: 0, assets_deleted: 0 };
  }
  const audit = await redactAudit(env.DB, policy, now);
  const assets = await deleteExpiredAssets(env, policy, now);
  const signIns = await purgeSignIns(env.DB, policy, now);
  const result = { ran: true, ...audit, assets_deleted: assets };
  console.log(JSON.stringify({ message: "retention run", ...result, sign_ins_deleted: signIns }));
  return result;
}

// Audit rows older than retention.audit_log_days keep their action, target,
// reason code, and time. The actor email and private note are removed.
async function redactAudit(
  db: D1Database,
  policy: Policy,
  now: number,
): Promise<{ audit_redacted: number; reports_redacted: number }> {
  const cutoff = utcSeconds(new Date(now - policy.retention.audit_log_days * DAY_MS));
  const [actions, reports] = await db.batch([
    db.prepare(
      `UPDATE moderation_actions SET actor_email = ?, private_note = NULL
        WHERE id IN (
          SELECT id FROM moderation_actions
           WHERE created_at < ? AND (actor_email != ? OR private_note IS NOT NULL)
           ORDER BY created_at, id
           LIMIT ?)`,
    ).bind(REDACTED_EMAIL, cutoff, REDACTED_EMAIL, AUDIT_BATCH),
    db.prepare(
      `UPDATE reports SET actor_email = NULL, detail = NULL
        WHERE id IN (
          SELECT id FROM reports
           WHERE created_at < ? AND (actor_email IS NOT NULL OR detail IS NOT NULL)
           ORDER BY created_at, id
           LIMIT ?)`,
    ).bind(cutoff, AUDIT_BATCH),
  ]);
  return {
    audit_redacted: Number(actions.meta.changes ?? 0),
    reports_redacted: Number(reports.meta.changes ?? 0),
  };
}

// Moves expired Assets through deletion_pending to deleted and removes their
// bytes from R2:
// - quarantined, retention.rejected_upload_days after the quarantine action;
// - rejected, retention.rejected_upload_days after rejected_at; rows rejected
//   before rejected_at existed (NULL) keep the old bound, rejected_upload_days
//   after created_at + reservation_hours;
// - reserved and never completed, RESERVATION_GRACE_HOURS after expires_at
//   (reservation_hours after reserve);
// - deletion_pending left by an interrupted run, at any age.
// Stored derivative bytes are refunded to the global r2_bytes counter once per
// Asset, before the R2 delete, so a repeated run neither loses nor doubles it.
async function deleteExpiredAssets(env: RetentionEnv, policy: Policy, now: number): Promise<number> {
  const keep = policy.retention.rejected_upload_days * DAY_MS;
  const keepCutoff = utcSeconds(new Date(now - keep));
  const legacyRejectedCutoff = utcSeconds(new Date(now - keep - policy.retention.reservation_hours * HOUR_MS));
  const reservationCutoff = utcSeconds(new Date(now - RESERVATION_GRACE_HOURS * HOUR_MS));
  const listed = await env.DB.prepare(
    `SELECT id FROM assets
      WHERE state = 'deletion_pending'
         OR (state = 'reserved' AND expires_at < ?)
         OR (state = 'rejected' AND rejected_at IS NOT NULL AND rejected_at < ?)
         OR (state = 'rejected' AND rejected_at IS NULL AND created_at < ?)
         OR (state = 'quarantined' AND COALESCE(
              (SELECT MAX(created_at) FROM moderation_actions
                WHERE target_type = 'asset' AND target_id = assets.id AND action = 'quarantine_asset'),
              assets.created_at) < ?)
      ORDER BY created_at, id
      LIMIT ?`,
  ).bind(reservationCutoff, keepCutoff, legacyRejectedCutoff, keepCutoff, RETENTION_BATCH).all<{ id: string }>();
  const ids = (listed.results ?? []).map((row) => row.id);
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(", ");
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE assets SET state = 'deletion_pending'
        WHERE id IN (${placeholders}) AND state IN ('reserved', 'rejected', 'quarantined')`,
    ).bind(...ids),
    env.DB.prepare(`DELETE FROM upload_tokens WHERE asset_id IN (${placeholders})`).bind(...ids),
  ]);
  for (const id of ids) await refundDerivatives(env, id);
  await env.MEDIA.delete(ids.flatMap((id) => [
    originalKey(id),
    // Staged agent thumbnail when v0.2.19 (PR #46) lands. Absent keys are a no-op.
    `${originalKey(id)}/thumb`,
    derivativeKey(id, "display"),
    derivativeKey(id, "thumb"),
  ]));
  const finished = await env.DB.prepare(
    `UPDATE assets SET state = 'deleted', original_stored = 0
      WHERE id IN (${placeholders}) AND state = 'deletion_pending'`,
  ).bind(...ids).run();
  return Number(finished.meta.changes ?? 0);
}

// v0.2.23: ended Sessions and Sign-in Links. A database without the sign-in
// tables yet (migration 0015 not applied) skips this step.
async function purgeSignIns(db: D1Database, policy: Policy, now: number): Promise<number> {
  try {
    return (await purgeEndedSignIns(db, policy, now)) + (await purgeConnections(db, now));
  } catch {
    console.log(JSON.stringify({ message: "retention sign-in step skipped" }));
    return 0;
  }
}
