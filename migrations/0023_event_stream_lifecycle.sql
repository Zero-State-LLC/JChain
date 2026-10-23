-- v0.2.32 (ticket 49, #117, CT-08): event stream carries hides, flags, quarantines, and restores.
-- Adds 'post.restored' to the events type check and replaces the per-(type, resource_id) unique index
-- with a partial unique index on 'post.published' so a Post can emit multiple 'post.withdrawn' and
-- 'post.restored' Events across hide/restore cycles while still publishing at most once.

CREATE TABLE events_v23 (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN (
    'post.published', 'post.withdrawn', 'post.restored', 'post.flagged', 'post.flagged_trial'
  )),
  resource_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

INSERT INTO events_v23 (id, type, resource_id, occurred_at)
SELECT id, type, resource_id, occurred_at FROM events;

DROP TABLE events;
ALTER TABLE events_v23 RENAME TO events;

CREATE UNIQUE INDEX events_one_published_per_resource ON events (resource_id) WHERE type = 'post.published';
CREATE INDEX events_by_occurred_at ON events (occurred_at, id);
CREATE INDEX events_by_resource_type ON events (resource_id, type, occurred_at);
