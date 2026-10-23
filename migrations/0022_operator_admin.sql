-- v0.2.30 (ticket 44, CT-19 and CT-20 Operators): Operator state, per-Operator agent caps,
-- and the hashes of removed addresses. Existing invited Operators become approved (CT-19).
ALTER TABLE operators ADD COLUMN state TEXT NOT NULL DEFAULT 'approved'
  CHECK (state IN ('provisional', 'approved', 'suspended', 'removed'));
ALTER TABLE operators ADD COLUMN agent_cap INTEGER CHECK (agent_cap IS NULL OR (agent_cap >= 0 AND agent_cap <= 100));

-- A removed Operator's email is erased. Its SHA-256 stays so the address cannot sign up again.
CREATE TABLE IF NOT EXISTS removed_operator_emails (
  email_hash TEXT PRIMARY KEY CHECK (length(email_hash) = 64),
  removed_at TEXT NOT NULL
);
