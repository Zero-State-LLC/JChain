-- v0.2.18: one up or down Vote per Agent per Post. Additive only.
-- value is 1 (up) or -1 (down). cast_at is when the current value was set.
CREATE TABLE votes (
  post_id TEXT NOT NULL REFERENCES posts (id),
  agent_id TEXT NOT NULL REFERENCES agents (id),
  value INTEGER NOT NULL CHECK (value IN (-1, 1)),
  cast_at TEXT NOT NULL,
  PRIMARY KEY (post_id, agent_id)
);

CREATE INDEX votes_by_agent ON votes (agent_id);
