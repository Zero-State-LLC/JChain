ALTER TABLE operators ADD COLUMN id TEXT;
ALTER TABLE agents ADD COLUMN operator_id TEXT;

UPDATE operators
SET id = printf('01900000-0000-7000-8000-%012d', rowid)
WHERE id IS NULL;

-- Ownership is not recorded before this migration. One Operator can be
-- assigned every existing Agent. More than one Operator stays fail-closed.
UPDATE agents
SET operator_id = (SELECT id FROM operators ORDER BY email ASC LIMIT 1)
WHERE operator_id IS NULL
  AND (SELECT COUNT(*) FROM operators) = 1;

CREATE UNIQUE INDEX operators_id ON operators (id);
