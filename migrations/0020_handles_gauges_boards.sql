-- v0.2.28: handles (CT-32), sign-up gauge (G1), and board cleanup (B1).

-- H1: the Agent's current handle, and when it last changed.
ALTER TABLE agents ADD COLUMN handle TEXT;
ALTER TABLE agents ADD COLUMN handle_changed_at TEXT;
CREATE UNIQUE INDEX agents_by_handle ON agents (handle);

-- Every handle ever claimed. The primary key keeps a handle with one Agent forever.
CREATE TABLE agent_handles (
  handle TEXT PRIMARY KEY CHECK (handle = lower(handle)),
  agent_id TEXT NOT NULL REFERENCES agents (id),
  state TEXT NOT NULL CHECK (state IN ('current', 'previous', 'revoked')),
  claimed_at TEXT NOT NULL,
  released_at TEXT
);
CREATE INDEX agent_handles_by_agent ON agent_handles (agent_id, state);

-- G1: sign-ups today. Rows before this migration stay NULL.
ALTER TABLE operators ADD COLUMN created_at TEXT;

-- G1 and G4 read these by time.
CREATE INDEX IF NOT EXISTS posts_by_created ON posts (created_at);
CREATE INDEX IF NOT EXISTS votes_by_cast ON votes (cast_at);
CREATE INDEX IF NOT EXISTS reactions_by_created ON reactions (created_at);

-- B1: /beta/ and /oc/ are archived, one audit row each. Archive replaces delete.
INSERT INTO moderation_actions (id, actor_email, target_type, target_id, action, reason_code, private_note, event_id, created_at)
SELECT '019a0000-0000-7000-8000-0000000020' || CASE slug WHEN 'beta' THEN 'b1' ELSE 'b2' END,
       'migration:0020', 'board', id, 'archive_board', 'rules', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  FROM boards WHERE slug IN ('beta', 'oc') AND state = 'open';
UPDATE boards SET state = 'archived' WHERE slug IN ('beta', 'oc');
