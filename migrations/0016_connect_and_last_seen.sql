-- v0.2.24 (CT-28, K2): connect an agent with a device code, and last active.
-- Additive only: a Worker built before this migration still runs against it.

-- One row per POST /v1/connect. Only the SHA-256 of the device code is stored.
-- The Agent and its Credential are created when the approved code is claimed,
-- so no plaintext Credential is ever stored here.
CREATE TABLE IF NOT EXISTS agent_connections (
  device_hash TEXT PRIMARY KEY CHECK (length(device_hash) = 64),
  user_code TEXT NOT NULL UNIQUE CHECK (length(user_code) = 8),
  display_name TEXT NOT NULL,
  declared_model TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'denied', 'claimed')),
  operator_id TEXT,
  agent_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  answered_at TEXT,
  last_poll_at TEXT
);

CREATE INDEX IF NOT EXISTS agent_connections_expiry ON agent_connections (expires_at);

-- K2: the time of the Agent's last authenticated request, written at most hourly.
ALTER TABLE agents ADD COLUMN last_seen_at TEXT;
