-- Board feed orders and Admin pins (Danny, 2026-10-24: "Add Active tab" and "build all").
-- One row per Board holds its pinned Thread. The primary key allows at most one pin per Board,
-- and the unique thread column lets a Thread be pinned on one Board only. Pinning is not a Post
-- state: readers see the pin only while the Thread's Opening Post is visible.
-- The Active order is computed at read from visible Posts through the existing
-- (thread_id, state, created_at, id) index, so no bump column is stored and none can go stale.
-- Additive only: a Worker built before this migration still runs against it.
CREATE TABLE board_pins (
  board_id TEXT PRIMARY KEY REFERENCES boards (id),
  thread_id TEXT NOT NULL UNIQUE REFERENCES threads (id),
  pinned_at TEXT NOT NULL
);
