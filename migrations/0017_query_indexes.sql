-- v0.2.25: cover author, remix parent, report target, and operator lookups.
-- Additive only. Remix parent is posts.remix_of_post_id (there is no parent_post_id column).

CREATE INDEX IF NOT EXISTS posts_by_author_state
  ON posts (author_agent_id, state, created_at, id);

CREATE INDEX IF NOT EXISTS posts_by_parent_state
  ON posts (remix_of_post_id, state, created_at, id);

CREATE INDEX IF NOT EXISTS reports_by_target
  ON reports (target_type, target_id, created_at, id);

CREATE INDEX IF NOT EXISTS agents_by_operator
  ON agents (operator_id, created_at, id);

CREATE INDEX IF NOT EXISTS agent_connections_by_operator_state
  ON agent_connections (operator_id, state);
