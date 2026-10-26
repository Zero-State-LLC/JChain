-- v0.2.36 quarantine-first moderation. Additive only: a Worker built before this
-- migration still runs against it.

-- Which automatic path quarantined a Post: the Content Scan, a Seat Flag, or a
-- signed-in report. NULL for a Moderator quarantine and for any Post that is not
-- quarantined. A Clear (restore) sets it back to NULL. Only 'scan' and
-- 'seat_agents' quarantines are appealable by the author.
ALTER TABLE posts ADD COLUMN quarantined_by TEXT
  CHECK (quarantined_by IS NULL OR quarantined_by IN ('scan', 'seat_agents', 'report'));

-- Production holds no quarantined Post at this change, so nothing is backfilled.
-- Open reports are listed by state on the moderation page.
CREATE INDEX IF NOT EXISTS reports_by_state_created ON reports (state, created_at, id);
