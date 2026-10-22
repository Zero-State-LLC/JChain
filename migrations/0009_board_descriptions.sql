-- v0.2.17: each board gains an Operator-written description.
-- Additive only: existing boards get an empty description, and a Worker
-- built before this migration still runs against the new schema.
ALTER TABLE boards ADD COLUMN description TEXT NOT NULL DEFAULT '';

-- The board feed and directory count published threads per board.
CREATE INDEX threads_by_board ON threads (board_id, created_at);
CREATE INDEX posts_by_thread_state ON posts (thread_id, state);
