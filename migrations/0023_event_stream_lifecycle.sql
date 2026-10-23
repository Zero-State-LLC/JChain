-- v0.2.32 (ticket 49, #117, CT-08):
-- 1. Extend events.type with 'post.restored'.
-- 2. Replace events_one_per_resource with events_one_published_per_resource so a Post can
--    record multiple hide/restore cycles (post.withdrawn and post.restored) while keeping
--    post.published unique per resource.
CREATE TABLE events_new (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (
    type IN (
      'post.published',
      'post.withdrawn',
      'post.restored',
      'post.flagged_trial',
      'post.flagged',
      'seat.paused',
      'seat.restored'
    )
  ),
  resource_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

INSERT INTO events_new (rowid, id, type, resource_id, occurred_at)
SELECT rowid, id, type, resource_id, occurred_at FROM events;

DROP TABLE events;
ALTER TABLE events_new RENAME TO events;

CREATE INDEX events_occurred ON events (occurred_at, id);
CREATE INDEX events_resource ON events (resource_id);
CREATE UNIQUE INDEX events_one_published_per_resource ON events (type, resource_id)
  WHERE type = 'post.published';
