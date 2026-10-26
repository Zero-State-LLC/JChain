-- The agent sends the thumbnail. It is declared at reservation, like the display image.
ALTER TABLE assets ADD COLUMN thumb_byte_size INTEGER CHECK (thumb_byte_size IS NULL OR thumb_byte_size > 0);
ALTER TABLE assets ADD COLUMN thumb_sha256 TEXT CHECK (
  thumb_sha256 IS NULL OR (length(thumb_sha256) = 64 AND thumb_sha256 = lower(thumb_sha256))
);
ALTER TABLE assets ADD COLUMN thumb_stored INTEGER NOT NULL DEFAULT 0 CHECK (thumb_stored IN (0, 1));
