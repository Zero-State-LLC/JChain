// CT-21, R4, and R5: the Blocked Hash list is D1 data written only by Moderator actions.
// The content scan and owner deletion never write here.

const HASH_COLUMNS = ["sha256", "thumb_sha256", "display_sha256", "derived_thumb_sha256"] as const;

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Binds, in text order: prohibited, at, the match bind once per hash column, then the optional action id.
function upsertSql(match: string, guarded: boolean): string {
  const union = HASH_COLUMNS
    .map((column) => `SELECT assets.${column} AS h, assets.id AS asset_id FROM assets WHERE ${match}`)
    .join(" UNION ");
  const guard = guarded ? " AND EXISTS (SELECT 1 FROM moderation_actions WHERE moderation_actions.id = ?)" : "";
  return `INSERT INTO blocked_hashes (sha256, prohibited, asset_id, created_at)
    SELECT h, ?, asset_id, ? FROM (${union}) WHERE h IS NOT NULL${guard}
    ON CONFLICT (sha256) DO UPDATE SET prohibited = MAX(blocked_hashes.prohibited, excluded.prohibited)`;
}

// One statement for the caller's batch. With actionId, it writes only if that audit row exists.
export function blockAssetHashes(
  db: D1Database,
  assetId: string,
  prohibited: boolean,
  at: string,
  actionId?: string,
): D1PreparedStatement {
  const binds: unknown[] = [prohibited ? 1 : 0, at, ...HASH_COLUMNS.map(() => assetId)];
  if (actionId !== undefined) binds.push(actionId);
  return db.prepare(upsertSql("assets.id = ?", actionId !== undefined)).bind(...binds);
}

export async function blockedMatch(
  db: D1Database,
  hashes: readonly (string | null)[],
): Promise<{ prohibited: boolean } | null> {
  const unique = [...new Set(hashes.filter((hash): hash is string => hash !== null))];
  if (unique.length === 0) return null;
  const row = await db.prepare(
    `SELECT COUNT(*) AS n, MAX(prohibited) AS p FROM blocked_hashes
      WHERE sha256 IN (${unique.map(() => "?").join(", ")})`,
  ).bind(...unique).first<{ n: number; p: number | null }>();
  if (Number(row?.n ?? 0) === 0) return null;
  return { prohibited: Number(row?.p ?? 0) === 1 };
}

// R4: one indexed read at CT-04 and CT-05 submit.
export async function submitBlocked(db: D1Database, assetId: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS hit FROM assets
       JOIN blocked_hashes ON blocked_hashes.sha256 IN (
         assets.sha256, assets.thumb_sha256, assets.display_sha256, assets.derived_thumb_sha256
       )
      WHERE assets.id = ? LIMIT 1`,
  ).bind(assetId).first<{ hit: number }>();
  return row !== null;
}
