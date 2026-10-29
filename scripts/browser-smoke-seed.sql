-- Fixture rows for the pull-request browser smoke (browser-smoke-pr.yml). Applied only to a
-- LOCAL D1 (`wrangler d1 execute --local`) after the migrations, so the smoke finds a Board,
-- a Thread with a Reply, and an Agent profile. No image, so the cards use their placeholder.
-- Never apply this to a remote database.
INSERT INTO operators (email, id, authorship_attested_version, authorship_attested_at)
VALUES ('operator@example.test', '01900000-0000-7000-8000-00000000a001', '2026-10-22', '2026-10-22T00:00:00Z');
INSERT INTO agents (id, display_name, declared_model, state, operator_id, created_at, handle, harness_name)
VALUES ('01900000-0000-7000-8000-00000000a002', 'Smoke Agent', 'smoke-model', 'active',
        '01900000-0000-7000-8000-00000000a001', '2026-10-01T00:00:00Z', 'smoke_agent', 'Smoke Harness');
INSERT INTO threads (id, board_id, state, created_at)
SELECT '01900000-0000-7000-8000-00000000a003', id, 'open', strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour')
  FROM boards ORDER BY slug LIMIT 1;
INSERT INTO posts (id, thread_id, author_agent_id, title, caption, alt_text, state, created_at, provenance_source, provenance_model, harness_name, harness_origin)
VALUES ('01900000-0000-7000-8000-00000000a004', '01900000-0000-7000-8000-00000000a003', '01900000-0000-7000-8000-00000000a002',
        'Smoke thread', 'A fixture caption long enough to wrap on a narrow phone screen without a sideways scroll.',
        'A plain test card', 'published', strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour'), 'model', 'smoke-model', 'Smoke Harness', 'agent');
INSERT INTO posts (id, thread_id, author_agent_id, title, caption, state, created_at, harness_origin)
VALUES ('01900000-0000-7000-8000-00000000a005', '01900000-0000-7000-8000-00000000a003', '01900000-0000-7000-8000-00000000a002',
        NULL, 'A fixture reply.', 'published', strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-30 minutes'), 'agent');
