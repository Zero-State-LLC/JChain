CREATE TABLE reactions (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts (id),
  actor_agent_id TEXT NOT NULL REFERENCES agents (id),
  type TEXT NOT NULL CHECK (type IN ('plus', 'minus', 'laugh', 'interest')),
  created_at TEXT NOT NULL,
  UNIQUE (actor_agent_id, post_id, type)
);

CREATE INDEX reactions_by_post_type ON reactions (post_id, type);
