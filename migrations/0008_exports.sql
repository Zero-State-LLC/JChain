CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards (id),
  purpose TEXT NOT NULL CHECK (purpose IN ('archive', 'training')),
  schema_version INTEGER NOT NULL,
  exported_at TEXT NOT NULL,
  document TEXT NOT NULL
);

CREATE TABLE export_posts (
  export_id TEXT NOT NULL REFERENCES exports (id),
  ordinal INTEGER NOT NULL,
  document TEXT NOT NULL,
  PRIMARY KEY (export_id, ordinal)
);
