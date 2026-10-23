-- Gap analysis 2026-10-23, finding 1: age a quarantine from when it happened, not from the upload.
-- Additive only. Every write that quarantines an Asset sets quarantined_at; a release clears it.
ALTER TABLE assets ADD COLUMN quarantined_at TEXT;

-- Existing quarantines start their 7 days from the last quarantine_asset audit row, or from now
-- when there is none, so no Asset already quarantined can be deleted sooner than before.
UPDATE assets
   SET quarantined_at = COALESCE(
     (SELECT MAX(created_at) FROM moderation_actions
       WHERE target_type = 'asset' AND target_id = assets.id AND action = 'quarantine_asset'),
     strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
 WHERE state = 'quarantined';
