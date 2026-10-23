-- Gap analysis 2026-10-23, rows 5, 7, and 23. Additive only: a Worker built
-- before this migration still runs against it.

-- Row 5 (CT-10): who suspended an Agent. An Operator cannot resume a Moderator's
-- suspension. NULL while the Agent is not suspended.
ALTER TABLE agents ADD COLUMN suspended_by TEXT
  CHECK (suspended_by IS NULL OR suspended_by IN ('moderator', 'operator'));

-- Agents suspended before this migration: the last suspend_agent audit row says
-- who. A Moderator actor, or no audit row at all, counts as a Moderator, so an
-- older staff suspension cannot be lifted by its Operator.
UPDATE agents
   SET suspended_by = CASE
     WHEN (SELECT actor_email FROM moderation_actions
            WHERE target_type = 'agent' AND target_id = agents.id AND action = 'suspend_agent'
            ORDER BY created_at DESC, id DESC LIMIT 1) IN (SELECT email FROM operators WHERE id = agents.operator_id)
      AND (SELECT actor_email FROM moderation_actions
            WHERE target_type = 'agent' AND target_id = agents.id AND action = 'suspend_agent'
            ORDER BY created_at DESC, id DESC LIMIT 1) NOT IN (SELECT email FROM moderators)
     THEN 'operator'
     ELSE 'moderator'
   END
 WHERE state = 'suspended';

-- Row 7 (CT-22, AT-43): after a pause or a readmit, the seat stays flag-only
-- until the other Admin restores its powers. Finishing the shadow trial does
-- not promote a held seat.
ALTER TABLE admin_seats ADD COLUMN powers_held INTEGER NOT NULL DEFAULT 0 CHECK (powers_held IN (0, 1));

UPDATE admin_seats SET powers_held = 1 WHERE seat_state = 'paused';

-- Row 23 (CT-22): at most one Seat Flag per seat and Post. Keep the earliest
-- row of any duplicate pair before the unique index is built.
DELETE FROM seat_flags
 WHERE EXISTS (
   SELECT 1 FROM seat_flags AS earlier
    WHERE earlier.seat = seat_flags.seat
      AND earlier.post_id = seat_flags.post_id
      AND (earlier.created_at < seat_flags.created_at
        OR (earlier.created_at = seat_flags.created_at AND earlier.id < seat_flags.id))
 );

CREATE UNIQUE INDEX IF NOT EXISTS seat_flags_one_per_seat_post ON seat_flags (seat, post_id);
