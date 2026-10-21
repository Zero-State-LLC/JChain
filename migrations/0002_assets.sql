CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents (id),
  state TEXT NOT NULL CHECK (state IN (
    'reserved', 'uploaded', 'validating', 'ready', 'rejected',
    'quarantined', 'deletion_pending', 'deleted'
  )),
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 = lower(sha256)),
  reason_code TEXT CHECK (reason_code IS NULL OR reason_code IN (
    'unsupported_type', 'too_large', 'too_many_pixels', 'edge_too_long',
    'animated', 'signature_mismatch', 'invalid_image', 'processing_failed'
  )),
  original_stored INTEGER NOT NULL CHECK (original_stored IN (0, 1)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE UNIQUE INDEX assets_one_ready_hash
  ON assets (agent_id, sha256)
  WHERE state = 'ready';

CREATE TABLE upload_tokens (
  asset_id TEXT PRIMARY KEY REFERENCES assets (id),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64 AND token_hash = lower(token_hash)),
  expires_at TEXT NOT NULL
);

CREATE TABLE idempotency_keys (
  agent_id TEXT NOT NULL,
  route TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, route, idempotency_key)
);
