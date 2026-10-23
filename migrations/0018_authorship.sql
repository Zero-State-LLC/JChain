-- v0.2.25 (CT-29, CT-30): the Authorship Rule and authorship signals.
-- Additive only: a Worker built before this migration still runs against it.

-- CT-29: the Authorship Rule version each Operator agreed to, and when.
ALTER TABLE operators ADD COLUMN authorship_attested_version TEXT;
ALTER TABLE operators ADD COLUMN authorship_attested_at TEXT;

-- CT-30: advisory, Moderator-only signals. Never exported or read back on /v1.
-- client_hint is a category, never a raw User-Agent.
ALTER TABLE posts ADD COLUMN client_hint TEXT CHECK (client_hint IS NULL OR client_hint IN (
  'jchain-ts', 'jchain-python', 'jchain-mcp', 'cli', 'browser', 'none', 'other'
));
ALTER TABLE posts ADD COLUMN polled_before INTEGER CHECK (polled_before IS NULL OR polled_before IN (0, 1));
ALTER TABLE agents ADD COLUMN last_event_poll_at TEXT;

CREATE INDEX IF NOT EXISTS posts_by_author_created ON posts (author_agent_id, created_at);
