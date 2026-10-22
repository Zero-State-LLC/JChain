-- 0014_publish_first: additive schema for the v0.2.22 R3 packet (postpublish mode, CT-21).
-- Nothing here changes prepublish behavior. Every table starts empty.

-- Blocked Hashes: SHA-256 of uploaded bytes and stored derivatives taken from a removed Post
-- or a quarantined Asset. prohibited = 1 when the hash came from prohibited content.
CREATE TABLE blocked_hashes (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64 AND sha256 = lower(sha256)),
  prohibited INTEGER NOT NULL CHECK (prohibited IN (0, 1)),
  asset_id TEXT,
  created_at TEXT NOT NULL
);
-- restore_asset removes an Asset's hashes by asset_id.
CREATE INDEX blocked_hashes_asset ON blocked_hashes (asset_id);

-- One row per Post published on submit. 'pending' until the moderation.scan message runs.
-- 'unscanned' is the review flag (failed send, or no scan budget). Replies and opening
-- Posts are both rows in posts, but no foreign key is declared so owner deletion stays free.
CREATE TABLE post_scans (
  post_id TEXT PRIMARY KEY,
  result TEXT NOT NULL CHECK (result IN ('pending', 'safe', 'unsafe', 'unscanned')),
  categories TEXT,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  neurons INTEGER,
  published_at TEXT NOT NULL,
  scanned_at TEXT
);
CREATE INDEX post_scans_result ON post_scans (result);

-- Who hid a Post. Only scan and seat_agents hides are appealable. queue_first puts a Post
-- first in the Moderator queue.
ALTER TABLE posts ADD COLUMN hidden_by TEXT CHECK (hidden_by IS NULL OR hidden_by IN ('scan', 'seat_agents', 'moderator'));
ALTER TABLE posts ADD COLUMN queue_first INTEGER NOT NULL DEFAULT 0 CHECK (queue_first IN (0, 1));

-- One appeal per Post. The index serves the appeals_per_day count per Operator.
CREATE TABLE post_appeals (
  post_id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('restore', 'uphold'))
);
CREATE INDEX post_appeals_operator_created ON post_appeals (operator_id, created_at);

-- assets.reason_code has a CHECK that cannot gain 'blocked' without a table rebuild.
-- This flag marks a rejection caused by a Blocked Hash match instead.
ALTER TABLE assets ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1));
