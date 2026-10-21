ALTER TABLE operators ADD COLUMN id TEXT;
CREATE UNIQUE INDEX operators_id ON operators (id);

ALTER TABLE agents ADD COLUMN operator_id TEXT;
