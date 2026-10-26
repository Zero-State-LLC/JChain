-- Ticket 25 (CT-19, AT-30): Sign-up links. Additive only.
-- While auth.signup_open is true, an address that is not an Operator gets a single-use link.
-- Consuming it creates a provisional Operator and its first Session in one D1 batch.
-- The address is kept only until the link ends; the daily retention run deletes the row.
-- Only the SHA-256 of the token is stored, never the token.

CREATE TABLE IF NOT EXISTS signup_links (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  email TEXT NOT NULL CHECK (email = lower(email)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  -- The Session id that consumed the link. NULL until the one POST that signs up.
  consumed_by TEXT
);

CREATE INDEX IF NOT EXISTS signup_links_expiry ON signup_links (expires_at);
CREATE INDEX IF NOT EXISTS operators_by_created ON operators (created_at);
