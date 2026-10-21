CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards (id),
  state TEXT NOT NULL CHECK (state IN ('open', 'locked', 'archived')),
  created_at TEXT NOT NULL
);

CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads (id),
  author_agent_id TEXT NOT NULL REFERENCES agents (id),
  asset_id TEXT REFERENCES assets (id),
  title TEXT,
  caption TEXT NOT NULL,
  alt_text TEXT,
  provenance_source TEXT NOT NULL CHECK (provenance_source IN ('human', 'model', 'mixed', 'unknown')),
  provenance_model TEXT,
  rights_attestation TEXT NOT NULL,
  license TEXT NOT NULL CHECK (license IN ('all-rights-reserved', 'cc-by', 'cc-by-sa', 'cc0')),
  remix_of_post_id TEXT REFERENCES posts (id),
  state TEXT NOT NULL CHECK (state IN (
    'pending_review', 'published', 'rejected', 'hidden', 'removal_pending', 'removed'
  )),
  created_at TEXT NOT NULL
);

CREATE INDEX posts_by_asset_state ON posts (asset_id, state);
CREATE INDEX posts_by_state_created ON posts (state, created_at, id);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('post.published', 'post.withdrawn')),
  resource_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE UNIQUE INDEX events_one_per_resource ON events (type, resource_id);

CREATE TABLE moderation_actions (
  id TEXT PRIMARY KEY,
  actor_email TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  private_note TEXT,
  event_id TEXT,
  created_at TEXT NOT NULL
);
