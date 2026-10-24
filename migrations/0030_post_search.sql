-- Header search over published Posts (Danny, 2026-10-24: "build all").
-- A full-text index over the only Post text there is: the title, the caption, and the alt text.
-- It holds no Credential, email, private note, report detail, or anything else.
--
-- post_search_ids gives each Post a stable integer for the index row. A Post id is text, and the
-- implicit rowid of the posts table is not stable (VACUUM and a table rebuild may renumber it), so
-- the index never relies on it. An INTEGER PRIMARY KEY is stable.
--
-- The index mirrors the text columns of posts through triggers, so every write that changes a
-- Post's text changes the index inside the same statement, and so the same D1 batch: an insert
-- adds the Post, an update of the title, caption, or alt text replaces it (a tombstone writes ''
-- and the old words leave the index), and a delete removes it. secure-delete makes FTS5 remove the
-- old tokens from the index pages at delete time, rather than leaving them until a later merge.
--
-- Readers never see a row because it is in the index: every query joins back to posts through the
-- Visibility Projection.
--
-- A migration that rebuilds the posts table drops these triggers with it, and must recreate them
-- and refill the index (the backfill below).
-- Additive only: a Worker built before this migration still runs against it.
CREATE TABLE post_search_ids (
  id INTEGER PRIMARY KEY,
  post_id TEXT NOT NULL UNIQUE
);

CREATE VIRTUAL TABLE post_search USING fts5(
  title,
  caption,
  alt_text,
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO post_search (post_search, rank) VALUES ('secure-delete', 1);

INSERT INTO post_search_ids (post_id) SELECT id FROM posts ORDER BY created_at, id;

INSERT INTO post_search (rowid, title, caption, alt_text)
SELECT post_search_ids.id, posts.title, posts.caption, posts.alt_text
  FROM post_search_ids
  JOIN posts ON posts.id = post_search_ids.post_id;

CREATE TRIGGER post_search_after_insert AFTER INSERT ON posts
BEGIN
  INSERT INTO post_search_ids (post_id) VALUES (new.id);
  INSERT INTO post_search (rowid, title, caption, alt_text)
  SELECT post_search_ids.id, new.title, new.caption, new.alt_text
    FROM post_search_ids
   WHERE post_search_ids.post_id = new.id;
END;

CREATE TRIGGER post_search_after_update AFTER UPDATE OF title, caption, alt_text ON posts
BEGIN
  DELETE FROM post_search
   WHERE rowid = (SELECT post_search_ids.id FROM post_search_ids WHERE post_search_ids.post_id = old.id);
  INSERT INTO post_search (rowid, title, caption, alt_text)
  SELECT post_search_ids.id, new.title, new.caption, new.alt_text
    FROM post_search_ids
   WHERE post_search_ids.post_id = new.id;
END;

CREATE TRIGGER post_search_after_delete AFTER DELETE ON posts
BEGIN
  DELETE FROM post_search
   WHERE rowid = (SELECT post_search_ids.id FROM post_search_ids WHERE post_search_ids.post_id = old.id);
  DELETE FROM post_search_ids WHERE post_search_ids.post_id = old.id;
END;
