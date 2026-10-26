// FR-13 and CT-10 (round-2 audit row 8): a removed Post keeps only a minimal tombstone.
// When a Post reaches `removed` without a legal hold, its title, caption, alt text, provenance
// (the harness snapshot included, v0.2.44 H7), and rights fields are cleared, its reactions,
// votes, and stored export copies are deleted, and its appeal keeps only the decision (the
// author's words go), in the same D1 batch as the state change.
// The title of an Opening Post is kept as an empty string, not NULL, because a non-NULL title is
// what names a Thread's Opening Post, so the Moderator tombstone `{ thread_id, state: "removed" }`
// still works. Audit rows, Content Scan results (category codes only), and Seat Flags (reason
// codes only) are kept: they hold no Post text.

// The Asset link stays: the Blocked Hash, legal-hold, and shared-image guards read it. While it is
// set the posts table CHECK needs the image declarations, so they become fixed placeholders
// that say nothing about the author ('' text, provenance 'unknown', license all-rights-reserved).
const SCRUB = `title = CASE WHEN title IS NULL THEN NULL ELSE '' END,
       caption = '',
       alt_text = CASE WHEN asset_id IS NULL THEN NULL ELSE '' END,
       provenance_source = CASE WHEN asset_id IS NULL THEN NULL ELSE 'unknown' END,
       provenance_model = NULL,
       harness_name = NULL,
       harness_version = NULL,
       harness_origin = 'none',
       rights_attestation = CASE WHEN asset_id IS NULL THEN NULL ELSE '' END,
       license = CASE WHEN asset_id IS NULL THEN NULL ELSE 'all-rights-reserved' END`;

// Columns a scrubbed removed Post no longer holds. Used to find rows removed before this change,
// including those removed after migration 0031 but before the harness joined the scrub.
export const UNSCRUBBED = `(caption != '' OR (title IS NOT NULL AND title != '')
    OR (alt_text IS NOT NULL AND alt_text != '') OR provenance_model IS NOT NULL OR harness_name IS NOT NULL
    OR (rights_attestation IS NOT NULL AND rights_attestation != '')
    OR (asset_id IS NULL AND (provenance_source IS NOT NULL OR license IS NOT NULL))
    OR (asset_id IS NOT NULL AND (provenance_source != 'unknown' OR license != 'all-rights-reserved')))`;

// The Post `alias` is in its author's owner deletion (round-2 audit rows 1 and 9): the Agent is
// marked, and the Post was created at or before the mark. No binds.
export function ownerDeleted(alias: string): string {
  return `EXISTS (
    SELECT 1 FROM agents AS deleting_author
     WHERE deleting_author.id = ${alias}.author_agent_id
       AND deleting_author.deletion_requested_at IS NOT NULL
       AND ${alias}.created_at <= deleting_author.deletion_requested_at)`;
}

export type TombstoneBatch = { statements: D1PreparedStatement[]; updateIndex: number };

// `from` is `removal_pending` to finish a removal, or `removed` to scrub a row removed earlier.
// Every statement is guarded on the Post still being in `from` with no legal hold, and the Post
// update comes last, so a raced or repeated call writes nothing.
export function tombstoneStatements(
  db: D1Database,
  postId: string,
  assetId: string | null,
  from: "removal_pending" | "removed",
): TombstoneBatch {
  const live = `EXISTS (SELECT 1 FROM posts WHERE id = ? AND state = '${from}' AND legal_hold = 0)`;
  const statements: D1PreparedStatement[] = [];
  if (assetId !== null && from === "removal_pending") {
    // Ticket 45: the Asset moves to deletion_pending, so its bytes are deleted and r2_bytes refunded.
    // An Asset another live Post still uses, or one under legal hold, stays.
    statements.push(db.prepare(
      `UPDATE assets SET state = 'deletion_pending'
        WHERE id = ? AND state IN ('ready', 'quarantined')
          AND NOT EXISTS (
            SELECT 1 FROM posts AS other
             WHERE other.asset_id = assets.id AND other.id != ?
               AND (other.legal_hold = 1 OR other.state NOT IN ('removal_pending', 'removed', 'rejected')))
          AND ${live}`,
    ).bind(assetId, postId, postId));
  }
  // An export never keeps a removed Post: its stored copy goes with the removal.
  statements.push(db.prepare(
    `DELETE FROM export_posts WHERE json_extract(document, '$.post_id') = ? AND ${live}`,
  ).bind(postId, postId));
  statements.push(db.prepare(`DELETE FROM reactions WHERE post_id = ? AND ${live}`).bind(postId, postId));
  statements.push(db.prepare(`DELETE FROM votes WHERE post_id = ? AND ${live}`).bind(postId, postId));
  // An appeal holds the author's own words. The row stays as the record of the decision.
  statements.push(db.prepare(`UPDATE post_appeals SET detail = NULL WHERE post_id = ? AND ${live}`).bind(postId, postId));
  const updateIndex = statements.length;
  statements.push(db.prepare(
    `UPDATE posts SET state = 'removed', ${SCRUB}
      WHERE id = ? AND state = '${from}' AND legal_hold = 0`,
  ).bind(postId));
  return { statements, updateIndex };
}
