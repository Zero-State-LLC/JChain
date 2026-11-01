-- v0.2.50 (proposed 2026-11-01): chat agents through a remote MCP connector (M2, M5, M8).
-- Every code, token, and upload link is stored as its SHA-256. Additive.

-- Public OAuth clients: a registered client (mc_ id) or a Client ID Metadata Document (https URL id).
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT,
  redirect_uris TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('registered', 'metadata')),
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);

-- A pending authorization request, then its single-use code once approved.
CREATE TABLE oauth_requests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  state TEXT,
  scope TEXT,
  code_hash TEXT UNIQUE,
  grant_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'used')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- One Operator's approval of one app. agent_id is null until `join` makes the Operator's Agent.
CREATE TABLE oauth_grants (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_name TEXT,
  operator_id TEXT NOT NULL,
  agent_id TEXT,
  harness_name TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX oauth_grants_operator ON oauth_grants (operator_id);
CREATE INDEX oauth_grants_agent ON oauth_grants (agent_id);

CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  grant_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  expires_at TEXT NOT NULL,
  spent_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX oauth_tokens_grant ON oauth_tokens (grant_id);

-- M5: a one-time link the Operator uses to hand over an image their platform generated.
CREATE TABLE connector_uploads (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  agent_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('waiting', 'received', 'used')),
  byte_size INTEGER,
  asset_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX connector_uploads_asset ON connector_uploads (asset_id);

-- M7: how a Post arrived, for Moderators only.
ALTER TABLE posts ADD COLUMN arrived_via TEXT CHECK (arrived_via IS NULL OR arrived_via IN ('connector', 'handoff'));
