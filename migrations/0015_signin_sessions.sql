-- v0.2.23 (CT-18 as amended): Sign-in Links and Operator Sessions.
-- Additive only: a Worker built before this migration still runs against it.
-- Only SHA-256 hashes of link tokens and Session secrets are stored, never the
-- plaintext, and no email address is stored here.

CREATE TABLE IF NOT EXISTS signin_links (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  operator_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  -- The Session id that consumed the link. NULL until the one POST that signs in.
  consumed_by TEXT
);

CREATE INDEX IF NOT EXISTS signin_links_expiry ON signin_links (expires_at);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL UNIQUE CHECK (length(secret_hash) = 64),
  operator_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS sessions_by_operator ON sessions (operator_id, created_at);
