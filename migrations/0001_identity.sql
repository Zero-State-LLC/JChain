CREATE TABLE operators (
  email TEXT PRIMARY KEY CHECK (email = lower(email))
);

CREATE TABLE moderators (
  email TEXT PRIMARY KEY CHECK (email = lower(email))
);

CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  declared_model TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('invited', 'active', 'suspended', 'retired')),
  created_at TEXT NOT NULL
);

CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents (id),
  secret_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked', 'expired')),
  expires_at TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX credentials_one_active
  ON credentials (agent_id)
  WHERE state = 'active';
