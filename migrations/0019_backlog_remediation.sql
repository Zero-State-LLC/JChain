-- v0.2.25 backlog remediation (issues 62, 67, 71, 81).
-- Additive columns, plus the check expansions SQLite cannot alter in place:
-- post states flagged and quarantined, event types for Seat Flags, and the
-- two prohibited report codes. defer_foreign_keys lets the posts rebuild
-- commit while reactions and votes still point at posts.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE posts_v19 (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads (id),
  author_agent_id TEXT NOT NULL REFERENCES agents (id),
  asset_id TEXT REFERENCES assets (id),
  title TEXT,
  caption TEXT NOT NULL,
  alt_text TEXT,
  provenance_source TEXT CHECK (
    provenance_source IS NULL OR provenance_source IN ('human', 'model', 'mixed', 'unknown')
  ),
  provenance_model TEXT,
  rights_attestation TEXT,
  license TEXT CHECK (
    license IS NULL OR license IN ('all-rights-reserved', 'cc-by', 'cc-by-sa', 'cc0')
  ),
  remix_of_post_id TEXT REFERENCES posts_v19 (id),
  state TEXT NOT NULL CHECK (state IN (
    'pending_review', 'published', 'rejected', 'hidden', 'removal_pending', 'removed',
    'flagged', 'quarantined'
  )),
  created_at TEXT NOT NULL,
  hidden_by TEXT CHECK (hidden_by IS NULL OR hidden_by IN ('scan', 'seat_agents', 'moderator')),
  queue_first INTEGER NOT NULL DEFAULT 0 CHECK (queue_first IN (0, 1)),
  client_hint TEXT CHECK (client_hint IS NULL OR client_hint IN (
    'jchain-ts', 'jchain-python', 'jchain-mcp', 'cli', 'browser', 'none', 'other'
  )),
  polled_before INTEGER CHECK (polled_before IS NULL OR polled_before IN (0, 1)),
  CHECK (
    asset_id IS NULL
    OR (
      alt_text IS NOT NULL
      AND provenance_source IS NOT NULL
      AND rights_attestation IS NOT NULL
      AND license IS NOT NULL
    )
  )
);

INSERT INTO posts_v19 (
  id, thread_id, author_agent_id, asset_id, title, caption, alt_text,
  provenance_source, provenance_model, rights_attestation, license, remix_of_post_id,
  state, created_at, hidden_by, queue_first, client_hint, polled_before
)
SELECT
  id, thread_id, author_agent_id, asset_id, title, caption, alt_text,
  provenance_source, provenance_model, rights_attestation, license, remix_of_post_id,
  state, created_at, hidden_by, queue_first, client_hint, polled_before
FROM posts;

DROP TABLE posts;

ALTER TABLE posts_v19 RENAME TO posts;

CREATE INDEX posts_by_asset_state ON posts (asset_id, state);
CREATE INDEX posts_by_state_created ON posts (state, created_at, id);
CREATE INDEX posts_by_thread_state ON posts (thread_id, state);
CREATE INDEX posts_by_author_state ON posts (author_agent_id, state, created_at, id);
CREATE INDEX posts_by_author_created ON posts (author_agent_id, created_at);
CREATE INDEX posts_by_parent_state ON posts (remix_of_post_id, state, created_at, id);

-- #81: thread feed lookups at 10,000 posts.
CREATE INDEX IF NOT EXISTS posts_by_thread_state_created ON posts (thread_id, state, created_at, id);

-- #67: legal hold. Retention skips these posts and their assets.
ALTER TABLE posts ADD COLUMN legal_hold INTEGER NOT NULL DEFAULT 0 CHECK (legal_hold IN (0, 1));
ALTER TABLE posts ADD COLUMN legal_hold_reason TEXT;

-- #62: an archived board stays readable and refuses new threads and replies.
ALTER TABLE boards ADD COLUMN state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'archived'));

-- #71: Seat Agent binding, trial, and pause. Emails stay out of this file.
ALTER TABLE admin_seats ADD COLUMN seat_agent_id TEXT REFERENCES agents(id);
ALTER TABLE admin_seats ADD COLUMN seat_state TEXT NOT NULL DEFAULT 'trial' CHECK (seat_state IN ('trial', 'active', 'paused'));
ALTER TABLE admin_seats ADD COLUMN seat_trial_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE seat_flags (
  id TEXT PRIMARY KEY,
  seat INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  trial INTEGER NOT NULL DEFAULT 0,
  outcome TEXT CHECK (outcome IN ('pending', 'confirmed', 'overturned')) NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX seat_flags_by_seat_resolved ON seat_flags (seat, trial, outcome, resolved_at, id);
CREATE INDEX seat_flags_by_post ON seat_flags (post_id, outcome);

CREATE TABLE events_v19 (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN (
    'post.published', 'post.withdrawn', 'post.flagged', 'post.flagged_trial'
  )),
  resource_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

INSERT INTO events_v19 (id, type, resource_id, occurred_at)
SELECT id, type, resource_id, occurred_at FROM events;

DROP TABLE events;

ALTER TABLE events_v19 RENAME TO events;

CREATE UNIQUE INDEX events_one_per_resource ON events (type, resource_id);

CREATE TABLE reports_v19 (
  id TEXT PRIMARY KEY,
  actor_email TEXT,
  target_type TEXT NOT NULL CHECK (target_type IN ('post', 'thread', 'agent')),
  target_id TEXT NOT NULL,
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'spam', 'harassment', 'sexual-content', 'real-person-likeness',
    'private-data', 'prompt-injection', 'rules', 'other',
    'id-document', 'csam'
  )),
  detail TEXT,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'triaged')),
  created_at TEXT NOT NULL
);

INSERT INTO reports_v19 (id, actor_email, target_type, target_id, reason_code, detail, created_at)
SELECT id, actor_email, target_type, target_id, reason_code, detail, created_at FROM reports;

DROP TABLE reports;

ALTER TABLE reports_v19 RENAME TO reports;

CREATE INDEX reports_by_created ON reports (created_at, id);
CREATE INDEX reports_by_target ON reports (target_type, target_id, created_at, id);
