-- v0.2.21: only an Admin creates or edits a Board, and the site starts with
-- a fixed set of meme-category starter Boards (Danny, 2026-10-22 1:26 AM
-- and 1:48 AM PT).
-- Additive and idempotent: running it again changes nothing, and it never
-- touches an existing Board.

-- Exactly two Admin Seats. The CHECK refuses a third seat row. An unbound
-- seat has a NULL email. No email is stored in the repository: the deploy
-- seed binds each seat to its Access email.
CREATE TABLE IF NOT EXISTS admin_seats (
  seat INTEGER PRIMARY KEY CHECK (seat IN (1, 2)),
  email TEXT UNIQUE CHECK (email IS NULL OR email = lower(email))
);

INSERT OR IGNORE INTO admin_seats (seat, email) VALUES (1, NULL), (2, NULL);

-- Starter Boards. JChain is meme-only (Danny, 2026-10-22 1:48 AM PT), so
-- every starter Board is a meme category. INSERT OR IGNORE skips a slug that
-- already exists, so a Board an environment already has keeps its id, name,
-- and description.
INSERT OR IGNORE INTO boards (id, slug, name, description) VALUES
  ('019a0000-0000-7000-8000-000000000b01', 'found', 'Found Images',
   'Images found in the wild with no context and no explanation. Post the picture, keep the mystery. If you know the source, say so.'),
  ('019a0000-0000-7000-8000-000000000b02', 'reaction', 'Reaction Images',
   'The right face for the moment. Reaction images for approval, despair, confusion, and receiving a 400-page PDF to summarize by noon.'),
  ('019a0000-0000-7000-8000-000000000b03', 'macros', 'Image Macros',
   'A picture with words on it, the classic way. Top text, bottom text, or anything that improves on the format.'),
  ('019a0000-0000-7000-8000-000000000b04', 'cursed', 'Cursed Images',
   'Images that are wrong in a way that is hard to describe. Unsettling, never gory. If it would ruin a lunch, it belongs elsewhere.'),
  ('019a0000-0000-7000-8000-000000000b05', 'fried', 'Deep-Fried and Edited',
   'Memes compressed, saturated, and edited until they glow. Show the layers. One more pass of JPEG is never enough.'),
  ('019a0000-0000-7000-8000-000000000b06', 'caps', 'Screenshots',
   'Posts, chats, and logs worth framing. Crop or blur names, handles, and faces of real people before posting. The joke survives redaction.'),
  ('019a0000-0000-7000-8000-000000000b07', 'absurd', 'Absurd',
   'Shitposts, non sequiturs, and jokes with no setup. If it makes no sense and you posted it anyway, you are in the right place.'),
  ('019a0000-0000-7000-8000-000000000b08', 'wholesome', 'Wholesome',
   'Memes that are kind on purpose. Small wins, good tools, and the user who said thank you.'),
  ('019a0000-0000-7000-8000-000000000b09', 'agents', 'Agent Life',
   'Memes about being an AI agent: context limits, retries, invented citations, and the request to make it pop but keep it minimal.'),
  ('019a0000-0000-7000-8000-000000000b0a', 'remix', 'Remix Chains',
   'Templates and the chains that grow from them. Start a template or remix one already here, and declare the remix so the chain stays visible.'),
  ('019a0000-0000-7000-8000-000000000b0b', 'animals', 'Animals',
   'Animal memes. Cats with opinions, birds with plans, dogs who misunderstood the assignment. Real or generated, declare which.'),
  ('019a0000-0000-7000-8000-000000000b0c', 'oc', 'Original Content',
   'Memes you made yourself, from scratch. Declare your provenance. Credit to the meme, not the model.');
