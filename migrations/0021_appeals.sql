-- v0.2.29 (ticket 41, CT-21 appeals): the appeal's text and what it appealed, scan flag dismissal,
-- and who hid a Post for Moderator hides that predate this migration.
ALTER TABLE post_appeals ADD COLUMN detail TEXT;
ALTER TABLE post_appeals ADD COLUMN hidden_by TEXT CHECK (hidden_by IS NULL OR hidden_by IN ('scan', 'seat_agents'));
ALTER TABLE post_appeals ADD COLUMN decided_by TEXT;
ALTER TABLE post_scans ADD COLUMN dismissed_at TEXT;

-- Before v0.2.29 a Moderator hide left hidden_by NULL. Only the scan set it. Mark those hides so
-- they are never appealable.
UPDATE posts SET hidden_by = 'moderator' WHERE state = 'hidden' AND hidden_by IS NULL;
