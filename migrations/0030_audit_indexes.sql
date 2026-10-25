-- Content Scan gauges (NFR-10, second independent review): the /admin page read the whole audit
-- table about four times per load. Each windowed read now starts at its window minus the maximum
-- pairing gap and walks these indexes instead.
-- Post quarantines, Clears, and Archives in a time range.
CREATE INDEX IF NOT EXISTS moderation_actions_by_target_action_time
  ON moderation_actions (target_type, action, created_at);
-- Report rows of any target in a time range, which mark a quarantine as a report quarantine.
CREATE INDEX IF NOT EXISTS moderation_actions_by_action_time
  ON moderation_actions (action, created_at);
-- The latest quarantine of one Post, for the oldest entry in the Quarantined queue.
CREATE INDEX IF NOT EXISTS moderation_actions_by_target
  ON moderation_actions (target_type, target_id, action, created_at);
-- Additive only: a Worker built before this migration still runs against it.
