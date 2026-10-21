CREATE TABLE operators (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE operator_sessions (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked', 'expired')),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE moderators (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked', 'expired')),
  created_at TEXT NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  declared_model TEXT,
  state TEXT NOT NULL CHECK (state IN ('invited', 'active', 'suspended', 'retired')),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_agents_operator ON agents (operator_id, created_at, id);

CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked', 'expired')),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX idx_credentials_agent ON credentials (agent_id, created_at, id);

CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'public')),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_boards_order ON boards (created_at, id);

CREATE TABLE policy_config (
  id TEXT PRIMARY KEY CHECK (id = 'current'),
  document TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
