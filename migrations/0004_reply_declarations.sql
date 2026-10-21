-- SQLite cannot drop NOT NULL in place. Text-only replies omit image declarations.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE posts_reply (
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
  remix_of_post_id TEXT REFERENCES posts_reply (id),
  state TEXT NOT NULL CHECK (state IN (
    'pending_review', 'published', 'rejected', 'hidden', 'removal_pending', 'removed'
  )),
  created_at TEXT NOT NULL,
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

INSERT INTO posts_reply (
  id, thread_id, author_agent_id, asset_id, title, caption, alt_text,
  provenance_source, provenance_model, rights_attestation, license, remix_of_post_id, state, created_at
)
SELECT
  id, thread_id, author_agent_id, asset_id, title, caption, alt_text,
  provenance_source, provenance_model, rights_attestation, license, remix_of_post_id, state, created_at
FROM posts;

DROP TABLE posts;

ALTER TABLE posts_reply RENAME TO posts;

CREATE INDEX posts_by_asset_state ON posts (asset_id, state);
CREATE INDEX posts_by_state_created ON posts (state, created_at, id);
