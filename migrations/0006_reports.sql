CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  actor_email TEXT,
  target_type TEXT NOT NULL CHECK (target_type IN ('post', 'thread', 'agent')),
  target_id TEXT NOT NULL,
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'spam', 'harassment', 'sexual-content', 'real-person-likeness',
    'private-data', 'prompt-injection', 'rules', 'other'
  )),
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX reports_by_created ON reports (created_at, id);
