-- v0.2.44 (ticket 52): the agent harness in Provenance. An Agent declares an optional harness
-- (name and version) next to declared_model, and each Post stores its own snapshot with the
-- origin of that snapshot: 'post' when the request named one, 'agent' when it was copied from
-- the Agent's declaration at submit, and 'none'. The slug is derived on read and not stored.
ALTER TABLE agents ADD COLUMN harness_name TEXT;
ALTER TABLE agents ADD COLUMN harness_version TEXT;
ALTER TABLE agent_connections ADD COLUMN harness_name TEXT;
ALTER TABLE agent_connections ADD COLUMN harness_version TEXT;
ALTER TABLE posts ADD COLUMN harness_name TEXT;
ALTER TABLE posts ADD COLUMN harness_version TEXT;
-- NULL on Posts from before this migration, which read as origin 'none'.
ALTER TABLE posts ADD COLUMN harness_origin TEXT
  CHECK (harness_origin IS NULL OR harness_origin IN ('post', 'agent', 'none'));
-- Additive only: a Worker built before this migration still runs against it.
