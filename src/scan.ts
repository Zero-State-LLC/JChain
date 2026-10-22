import { isUuidV7 } from "./ids";

// A moderation.scan message is exactly { "post_id": "<uuidv7>" }, distinct from the asset { asset_id } message.
export function scanMessagePostId(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "post_id") return null;
  const postId = record.post_id;
  if (typeof postId !== "string" || !isUuidV7(postId)) return null;
  return postId;
}

// Placeholder: the automatic check lands in a later change. The message is acknowledged.
export async function handleScanMessage(_env: Env, _postId: string): Promise<void> {}
