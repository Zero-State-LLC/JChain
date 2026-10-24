-- Round-2 audit (FR-13, CT-10): an owner deletion is marked on the Agent and finished in bounded
-- batches, by the request and then by the daily retention run. The mark is the time of the latest
-- deletion request. Every Post the Agent created at or before it leaves every read path at once,
-- approve and restore refuse it, and a Clear of a quarantined one is applied as a removal.
-- Additive only: a Worker built before this migration still runs against it.
ALTER TABLE agents ADD COLUMN deletion_requested_at TEXT;
