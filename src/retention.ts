import { derivativeKey, originalKey, refundDerivatives } from "./asset-pipeline";
import { utcSeconds } from "./ids";
import { parsePolicy, type Policy } from "./policy";
import { purgeConnections } from "./connect";
import { alertModerators, DAILY_ALERT_MS } from "./moderator-alert";
import { mailerOf, purgeEndedSignIns } from "./session";

// Retention sweep (SPEC Retention, Asset state machine). Runs from the Worker
// `scheduled` handler. Every step is idempotent and bounded per run, so a cron
// that fires often simply drains a backlog over several runs.

export const RETENTION_BATCH = 100;
export const AUDIT_BATCH = 500;
export const REDACTED_EMAIL = "redacted";
// A reservation is purged one hour after its upload token expired, so a PUT that
// passed the expiry check at the boundary has finished writing first.
export const RESERVATION_GRACE_HOURS = 1;

export const SCAN_PENDING_MINUTES = 15;
// CT-23: at most this many published Posts with no scan row are sent for a scan per run.
export const SCAN_BACKFILL_BATCH = 10;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

type RetentionEnv = Pick<Env, "DB" | "MEDIA" | "POLICY" | "QUOTA"> & Partial<Pick<Env, "ASSET_UPLOAD">>;

export type RetentionAlert = {
  metric: string;
  age_seconds: number;
  count: number;
};

export type RetentionResult = {
  ran: boolean;
  audit_redacted: number;
  reports_redacted: number;
  assets_deleted: number;
  alerts: RetentionAlert[];
};

const UPLOAD_ALERT_SECONDS = 300;

// Asset retention guards, on an `assets` row. Retention never deletes an Asset a legal-hold Post
// references (any state), a quarantined Asset a quarantined Post still waits on, or a ready Asset
// any Post references.
const NO_HELD_POST = `NOT EXISTS (
  SELECT 1 FROM posts WHERE posts.asset_id = assets.id AND posts.legal_hold = 1)`;
const NO_WAITING_POST = `NOT EXISTS (
  SELECT 1 FROM posts WHERE posts.asset_id = assets.id AND posts.state = 'quarantined')`;
const NO_POST = "NOT EXISTS (SELECT 1 FROM posts WHERE posts.asset_id = assets.id)";
const REVIEW_ALERT_SECONDS = 3600;

export async function runRetention(env: RetentionEnv, now: number): Promise<RetentionResult> {
  const policy = parsePolicy(typeof env.POLICY === "string" ? env.POLICY : undefined);
  if (policy === null) {
    console.log(JSON.stringify({ message: "retention skipped", reason: "policy_missing" }));
    return { ran: false, audit_redacted: 0, reports_redacted: 0, assets_deleted: 0, alerts: [] };
  }
  const audit = await redactAudit(env.DB, policy, now);
  const removals = await finishRemovals(env.DB);
  const assets = await deleteExpiredAssets(env, policy, now);
  const signIns = await purgeSignIns(env.DB, policy, now, mailerOf(env as Env) !== null && policy.auth !== undefined);
  const idempotency = await purgeExpiredIdempotency(env.DB, now);
  const events = await purgeOldEvents(env.DB, policy, now);
  const scans = await sweepStuckScans(env.DB, now);
  // After the sweep, so a row it writes is not marked unscanned in the same run.
  const backfilled = policy.moderation_mode === "postpublish" ? await backfillScans(env) : 0;
  const alerts = await breachAlerts(env.DB, now);
  // v0.2.36: quarantined Posts still waiting, and no Moderator alert in the last 24 hours.
  const moderatorAlerts = await alertModerators(env, policy, { gapMs: DAILY_ALERT_MS, now });
  const result = { ran: true, ...audit, assets_deleted: assets, alerts };
  console.log(JSON.stringify({
    message: "retention run",
    ...result,
    sign_ins_deleted: signIns,
    removals_finished: removals,
    idempotency_deleted: idempotency,
    events_deleted: events,
    scans_swept: scans,
    scans_backfilled: backfilled,
    moderator_alerts: moderatorAlerts,
  }));
  return result;
}

// Ticket 45: a Moderator removal finishes here. The Post moves from removal_pending to removed,
// and its Asset moves to deletion_pending, so deleteExpiredAssets deletes the bytes and refunds
// r2_bytes in the same run. An Asset another live Post still uses, or one under legal hold, stays.
// The Post's stored export copies are deleted in the same batch.
async function finishRemovals(db: D1Database): Promise<number> {
  const listed = await db.prepare(
    `SELECT id, asset_id FROM posts
      WHERE state = 'removal_pending' AND legal_hold = 0
      ORDER BY created_at, id
      LIMIT ?`,
  ).bind(RETENTION_BATCH).all<{ id: string; asset_id: string | null }>();
  let finished = 0;
  for (const post of listed.results ?? []) {
    const statements: D1PreparedStatement[] = [];
    if (post.asset_id !== null) {
      statements.push(db.prepare(
        `UPDATE assets SET state = 'deletion_pending'
          WHERE id = ? AND state IN ('ready', 'quarantined')
            AND NOT EXISTS (
              SELECT 1 FROM posts AS other
               WHERE other.asset_id = assets.id AND other.id != ?
                 AND (other.legal_hold = 1 OR other.state NOT IN ('removal_pending', 'removed', 'rejected')))`,
      ).bind(post.asset_id, post.id));
    }
    // An export never keeps a removed Post: its stored copy goes with the removal.
    statements.push(db.prepare(
      `DELETE FROM export_posts
        WHERE json_extract(document, '$.post_id') = ?
          AND EXISTS (SELECT 1 FROM posts WHERE id = ? AND state = 'removal_pending' AND legal_hold = 0)`,
    ).bind(post.id, post.id));
    statements.push(db.prepare(
      "UPDATE posts SET state = 'removed' WHERE id = ? AND state = 'removal_pending' AND legal_hold = 0",
    ).bind(post.id));
    const results = await db.batch(statements);
    if (Number(results[results.length - 1]?.meta.changes ?? 0) === 1) finished += 1;
  }
  return finished;
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
// - ready and referenced by no Post, retention.rejected_upload_days after
//   created_at (round-2 audit finding 4);
// - deletion_pending left by an interrupted run, at any age.
// A quarantined Asset that a quarantined Post still references waits for the
// Moderator's Clear or Archive and is never aged (v0.2.36 quarantine-first).
// Stored derivative bytes are refunded to the global r2_bytes counter once per
// Asset, before the R2 delete, so a repeated run neither loses nor doubles it.
async function deleteExpiredAssets(env: RetentionEnv, policy: Policy, now: number): Promise<number> {
  const keep = policy.retention.rejected_upload_days * DAY_MS;
  const keepCutoff = utcSeconds(new Date(now - keep));
  const legacyRejectedCutoff = utcSeconds(new Date(now - keep - policy.retention.reservation_hours * HOUR_MS));
  const reservationCutoff = utcSeconds(new Date(now - RESERVATION_GRACE_HOURS * HOUR_MS));
  const listed = await env.DB.prepare(
    // The state terms are one parenthesized group, so the legal-hold guard applies to every one of
    // them (AND binds tighter than OR). A quarantine is aged from quarantined_at, which every
    // quarantine write sets; older rows fall back to the last quarantine_asset audit row, and
    // never to the upload time, which made a fresh quarantine of an old Asset look expired.
    `SELECT id FROM assets
      WHERE (state = 'deletion_pending'
         OR (state = 'reserved' AND expires_at < ?)
         OR (state = 'rejected' AND rejected_at IS NOT NULL AND rejected_at < ?)
         OR (state = 'rejected' AND rejected_at IS NULL AND created_at < ?)
         OR (state = 'quarantined' AND COALESCE(
              quarantined_at,
              (SELECT MAX(created_at) FROM moderation_actions
                WHERE target_type = 'asset' AND target_id = assets.id AND action = 'quarantine_asset')) < ?
            AND ${NO_WAITING_POST})
         OR (state = 'ready' AND created_at < ? AND ${NO_POST}))
      AND ${NO_HELD_POST}
      ORDER BY created_at, id
      LIMIT ?`,
  ).bind(reservationCutoff, keepCutoff, legacyRejectedCutoff, keepCutoff, keepCutoff, RETENTION_BATCH).all<{ id: string }>();
  const candidates = (listed.results ?? []).map((row) => row.id);
  if (candidates.length === 0) return 0;
  const listedPlaceholders = candidates.map(() => "?").join(", ");
  // The guards are re-checked in the write, so a Post that took a ready Asset, or a quarantine of
  // a Post, between the read and this write keeps the Asset.
  await env.DB.prepare(
    `UPDATE assets SET state = 'deletion_pending'
      WHERE id IN (${listedPlaceholders}) AND ${NO_HELD_POST}
        AND (state IN ('reserved', 'rejected')
          OR (state = 'quarantined' AND ${NO_WAITING_POST})
          OR (state = 'ready' AND ${NO_POST}))`,
  ).bind(...candidates).run();
  const pending = await env.DB.prepare(
    `SELECT id FROM assets WHERE id IN (${listedPlaceholders}) AND state = 'deletion_pending' ORDER BY created_at, id`,
  ).bind(...candidates).all<{ id: string }>();
  const ids = (pending.results ?? []).map((row) => row.id);
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(", ");
  await env.DB.prepare(`DELETE FROM upload_tokens WHERE asset_id IN (${placeholders})`).bind(...ids).run();
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

// v0.2.23: ended Sessions, Sign-in Links, and connect requests. Only a database
// that lacks those tables (migrations 0015 or 0016 not applied yet) skips this
// step. Any other failure propagates, so the cron run fails and is retried.
// #77: one structured line per breached age, with no content and no tokens.
async function breachAlerts(db: D1Database, now: number): Promise<RetentionAlert[]> {
  const alerts: RetentionAlert[] = [];
  const upload = await ageOf(db, "SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM assets WHERE state IN ('uploaded', 'validating')");
  const uploadAlert = alertFor("upload_queue_age", upload, now, UPLOAD_ALERT_SECONDS);
  if (uploadAlert !== null) alerts.push(uploadAlert);
  const review = await ageOf(db, "SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM posts WHERE state = 'pending_review'");
  const reviewAlert = alertFor("moderation_queue_age", review, now, REVIEW_ALERT_SECONDS);
  if (reviewAlert !== null) alerts.push(reviewAlert);
  for (const alert of alerts) {
    console.warn(JSON.stringify({
      level: "warn",
      message: "alert threshold breached",
      metric: alert.metric,
      age_seconds: alert.age_seconds,
      count: alert.count,
    }));
  }
  return alerts;
}

async function ageOf(db: D1Database, sql: string): Promise<{ n: number; oldest: string | null }> {
  const row = await db.prepare(sql).first<{ n: number; oldest: string | null }>();
  return { n: Number(row?.n ?? 0), oldest: row?.oldest ?? null };
}

function alertFor(
  metric: string,
  row: { n: number; oldest: string | null },
  now: number,
  limitSeconds: number,
): RetentionAlert | null {
  if (row.n < 1 || row.oldest === null) return null;
  const parsed = Date.parse(row.oldest);
  if (Number.isNaN(parsed)) return null;
  const age = Math.floor((now - parsed) / 1000);
  if (age <= limitSeconds) return null;
  return { metric, age_seconds: age, count: row.n };
}

async function purgeSignIns(db: D1Database, policy: Policy, now: number, enabled: boolean): Promise<number> {
  try {
    return (await purgeEndedSignIns(db, policy, now, enabled)) + (await purgeConnections(db, now));
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) {
      console.log(JSON.stringify({ message: "retention sign-in step skipped", reason: "tables missing" }));
      return 0;
    }
    throw error;
  }
}

async function purgeExpiredIdempotency(db: D1Database, now: number): Promise<number> {
  const cutoff = utcSeconds(new Date(now));
  const deleted = await db.prepare(
    `DELETE FROM idempotency_keys
      WHERE rowid IN (
        SELECT rowid FROM idempotency_keys
         WHERE expires_at < ?
         ORDER BY expires_at
         LIMIT ?)`,
  ).bind(cutoff, AUDIT_BATCH).run();
  return Number(deleted.meta.changes ?? 0);
}

async function purgeOldEvents(db: D1Database, policy: Policy, now: number): Promise<number> {
  const cutoff = utcSeconds(new Date(now - policy.retention.audit_log_days * DAY_MS));
  const deleted = await db.prepare(
    `DELETE FROM events
      WHERE id IN (
        SELECT id FROM events
         WHERE occurred_at < ?
         ORDER BY occurred_at, id
         LIMIT ?)`,
  ).bind(cutoff, AUDIT_BATCH).run();
  return Number(deleted.meta.changes ?? 0);
}

async function sweepStuckScans(db: D1Database, now: number): Promise<number> {
  const cutoff = utcSeconds(new Date(now - SCAN_PENDING_MINUTES * MINUTE_MS));
  try {
    const updated = await db.prepare(
      `UPDATE post_scans SET result = 'unscanned'
        WHERE post_id IN (
          SELECT post_id FROM post_scans
           WHERE result = 'pending' AND scanned_at IS NULL AND published_at < ?
           ORDER BY published_at, post_id
           LIMIT ?)`,
    ).bind(cutoff, RETENTION_BATCH).run();
    return Number(updated.meta.changes ?? 0);
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) return 0;
    throw error;
  }
}

// CT-23: a Post published before postpublish took effect (approved under prepublish) has no scan
// row. Give a bounded batch a pending row and a moderation.scan message, as a submit does. A
// failed send marks the row unscanned for review. The row's published_at is the Post's first
// post.published Event, or its created_at.
async function backfillScans(env: RetentionEnv): Promise<number> {
  let listed: D1Result<{ id: string; published_at: string }>;
  try {
    listed = await env.DB.prepare(
      `SELECT posts.id AS id,
              COALESCE((SELECT MIN(events.occurred_at) FROM events
                         WHERE events.resource_id = posts.id AND events.type = 'post.published'),
                       posts.created_at) AS published_at
         FROM posts
        WHERE posts.state = 'published'
          AND NOT EXISTS (SELECT 1 FROM post_scans WHERE post_scans.post_id = posts.id)
        ORDER BY posts.created_at, posts.id
        LIMIT ?`,
    ).bind(SCAN_BACKFILL_BATCH).all<{ id: string; published_at: string }>();
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) return 0;
    throw error;
  }
  let count = 0;
  for (const row of listed.results ?? []) {
    const inserted = await env.DB.prepare(
      "INSERT OR IGNORE INTO post_scans (post_id, result, hidden, published_at) VALUES (?, 'pending', 0, ?)",
    ).bind(row.id, row.published_at).run();
    if (Number(inserted.meta.changes ?? 0) !== 1) continue;
    count += 1;
    try {
      if (env.ASSET_UPLOAD === undefined) throw new Error("no queue binding");
      await env.ASSET_UPLOAD.send({ post_id: row.id });
    } catch {
      console.error(JSON.stringify({ message: "scan backfill send failed", post_id: row.id }));
      await env.DB.prepare(
        "UPDATE post_scans SET result = 'unscanned' WHERE post_id = ? AND result = 'pending'",
      ).bind(row.id).run();
    }
  }
  return count;
}
