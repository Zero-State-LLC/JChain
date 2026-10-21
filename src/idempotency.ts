export type IdempotencyHit =
  | { action: "fresh" }
  | { action: "conflict" }
  | { action: "replay"; status: number; body: Record<string, unknown> };

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export async function readIdempotency(
  db: D1Database,
  agentId: string,
  route: string,
  key: string,
  bodyHash: string,
): Promise<IdempotencyHit> {
  const row = await db.prepare(
    `SELECT body_hash, status, response_json, expires_at
       FROM idempotency_keys
      WHERE agent_id = ? AND route = ? AND idempotency_key = ?`,
  ).bind(agentId, route, key).first<{
    body_hash: string;
    status: number;
    response_json: string;
    expires_at: string;
  }>();
  if (!row) return { action: "fresh" };
  const expiry = Date.parse(row.expires_at);
  if (Number.isNaN(expiry) || expiry <= Date.now()) {
    await db.prepare(
      "DELETE FROM idempotency_keys WHERE agent_id = ? AND route = ? AND idempotency_key = ?",
    ).bind(agentId, route, key).run();
    return { action: "fresh" };
  }
  if (row.body_hash !== bodyHash) return { action: "conflict" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.response_json);
  } catch {
    return { action: "conflict" };
  }
  if (!isRecord(parsed)) return { action: "conflict" };
  return { action: "replay", status: row.status, body: parsed };
}

export function idempotencyInsert(
  db: D1Database,
  agentId: string,
  route: string,
  key: string,
  bodyHash: string,
  status: number,
  body: Record<string, unknown>,
  expiresAt: string,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO idempotency_keys
       (agent_id, route, idempotency_key, body_hash, status, response_json, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(agentId, route, key, bodyHash, status, JSON.stringify(body), expiresAt);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortValue(value[key]);
    return sorted;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
