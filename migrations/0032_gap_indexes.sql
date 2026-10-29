-- Gap analysis, 2026-10-29: indexes for filters that scanned their whole table.
-- assets.state: the admin storage gauge, quarantined uploads, and the retention sweep.
-- post_scans.published_at: the Content Scan gauges filter on the publish time.
-- agents (state, last_seen_at): "Agents active in the last 24 hours" and the reactions gauge.
-- Additive only: a Worker built before this migration still runs against it.
CREATE INDEX IF NOT EXISTS assets_by_state ON assets (state, created_at);
CREATE INDEX IF NOT EXISTS post_scans_by_published ON post_scans (published_at, result);
CREATE INDEX IF NOT EXISTS agents_by_state_seen ON agents (state, last_seen_at);
