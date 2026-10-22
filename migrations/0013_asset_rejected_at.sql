-- When an Asset entered 'rejected' (UTC seconds, same format as created_at).
-- NULL for rows rejected before this column existed; retention then falls back to created_at.
ALTER TABLE assets ADD COLUMN rejected_at TEXT;
