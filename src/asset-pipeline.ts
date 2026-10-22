import { isUuidV7, utcSeconds } from "./ids";
import type { Policy } from "./policy";
import { chargeDerivativeBytes, logRejected, refundAssetBytes } from "./quota";
import { type WebpCheck, readWebp } from "./webp";

export const ASSET_QUEUE = "asset-upload";
export const ASSET_DLQ = "asset-upload-dlq";

const WEBP = "image/webp";
export const THUMB_EDGE = 320;

export type ReasonCode =
  | "unsupported_type"
  | "too_large"
  | "too_many_pixels"
  | "edge_too_long"
  | "animated"
  | "signature_mismatch"
  | "invalid_image"
  | "processing_failed";

export type SniffedType = "image/jpeg" | "image/png" | "image/webp";

type AssetEnv = {
  DB: D1Database;
  MEDIA: R2Bucket;
  QUOTA: Env["QUOTA"];
};

type AssetRow = {
  id: string;
  agent_id: string;
  state: string;
  sha256: string;
  thumb_sha256: string | null;
};

export function originalKey(assetId: string): string {
  return `originals/${assetId}`;
}

export function originalThumbKey(assetId: string): string {
  return `originals/${assetId}/thumb`;
}

export function derivativeKey(assetId: string, variant: "display" | "thumb"): string {
  return `derivatives/${assetId}/${variant}`;
}

// Call before deleting the derivatives: the stored sizes go back to r2_bytes once per Asset.
export async function refundDerivatives(
  env: { MEDIA: R2Bucket; QUOTA: Env["QUOTA"] },
  assetId: string,
): Promise<void> {
  let bytes = 0;
  for (const variant of ["display", "thumb"] as const) {
    const head = await env.MEDIA.head(derivativeKey(assetId, variant));
    if (head) bytes += head.size;
  }
  if (bytes > 0) await refundAssetBytes(env, assetId, bytes);
}

export function sniffedType(bytes: Uint8Array): SniffedType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (
    bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export function isAnimated(bytes: Uint8Array, type: SniffedType): boolean {
  if (type === "image/png") return indexOfAscii(bytes, "acTL") >= 0;
  if (type === "image/webp") return indexOfAscii(bytes, "ANIM") >= 0;
  return false;
}

export async function processUploadedAsset(env: AssetEnv, policy: Policy, assetId: string): Promise<void> {
  const asset = await loadAsset(env.DB, assetId);
  if (!asset) return;
  if (asset.state === "ready") {
    await env.MEDIA.delete([originalKey(assetId), originalThumbKey(assetId)]);
    return;
  }
  if (asset.state !== "uploaded" && asset.state !== "validating") return;

  await env.DB.prepare(
    "UPDATE assets SET state = 'validating', reason_code = NULL WHERE id = ? AND state IN ('uploaded', 'validating')",
  ).bind(assetId).run();

  const display = await stagedWebp(env.MEDIA, originalKey(assetId));
  if (display === null) {
    await rejectAsset(env.DB, assetId, "processing_failed");
    return;
  }
  if (!display.ok) {
    await rejectAsset(env.DB, assetId, display.reason);
    return;
  }
  if (display.width > policy.upload.max_edge_px || display.height > policy.upload.max_edge_px) {
    await rejectAsset(env.DB, assetId, "edge_too_long");
    return;
  }
  if (display.width * display.height > policy.upload.max_megapixels * 1_000_000) {
    await rejectAsset(env.DB, assetId, "too_many_pixels");
    return;
  }

  // The agent sends the thumbnail. A display image that already fits the thumbnail box is its own thumbnail.
  let thumb: Uint8Array = display.bytes;
  if (asset.thumb_sha256 !== null) {
    const staged = await stagedWebp(env.MEDIA, originalThumbKey(assetId));
    if (staged === null) {
      await rejectAsset(env.DB, assetId, "processing_failed");
      return;
    }
    if (!staged.ok) {
      await rejectAsset(env.DB, assetId, staged.reason);
      return;
    }
    if (!fitsThumbnail(display, staged)) {
      await rejectAsset(env.DB, assetId, "invalid_image");
      return;
    }
    thumb = staged.bytes;
  } else if (Math.max(display.width, display.height) > THUMB_EDGE) {
    await rejectAsset(env.DB, assetId, "invalid_image");
    return;
  }

  const twin = await env.DB.prepare(
    "SELECT id FROM assets WHERE agent_id = ? AND sha256 = ? AND state = 'ready' AND id != ?",
  ).bind(asset.agent_id, asset.sha256, assetId).first<{ id: string }>();
  if (twin) {
    await env.MEDIA.delete([originalKey(assetId), originalThumbKey(assetId)]);
    await rejectAsset(env.DB, assetId, "processing_failed");
    return;
  }

  const displayKey = derivativeKey(assetId, "display");
  const thumbKey = derivativeKey(assetId, "thumb");
  try {
    await env.MEDIA.put(displayKey, display.bytes, { httpMetadata: { contentType: WEBP } });
    await env.MEDIA.put(thumbKey, thumb, { httpMetadata: { contentType: WEBP } });
  } catch {
    await env.MEDIA.delete([displayKey, thumbKey]);
    await rejectAsset(env.DB, assetId, "processing_failed");
    return;
  }
  const bytesCharged = await chargeDerivativeBytes(env, policy, display.bytes.byteLength + thumb.byteLength);
  if (!bytesCharged.ok) {
    logRejected(asset.agent_id, "global", "r2_bytes");
    await env.MEDIA.delete([displayKey, thumbKey]);
    await rejectAsset(env.DB, assetId, "processing_failed");
    return;
  }
  const updated = await env.DB.prepare(
    "UPDATE assets SET state = 'ready', reason_code = NULL, original_stored = 0, thumb_stored = 0 WHERE id = ? AND state = 'validating'",
  ).bind(assetId).run();
  if (Number(updated.meta.changes ?? 0) !== 1) {
    await bytesCharged.refund();
    await env.MEDIA.delete([displayKey, thumbKey]);
    return;
  }
  await env.MEDIA.delete([originalKey(assetId), originalThumbKey(assetId)]);
  console.log(JSON.stringify({ message: "asset ready", asset_id: assetId }));
}

export async function rejectInFlight(db: D1Database, assetId: string): Promise<void> {
  const updated = await db.prepare(
    `UPDATE assets
        SET state = 'rejected', reason_code = 'processing_failed', rejected_at = ?
      WHERE id = ? AND state IN ('reserved', 'uploaded', 'validating')`,
  ).bind(utcSeconds(), assetId).run();
  if (Number(updated.meta.changes ?? 0) === 1) {
    console.log(JSON.stringify({ message: "asset rejected", asset_id: assetId, reason_code: "processing_failed" }));
  }
}

export function assetIdFromMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "asset_id") return null;
  const assetId = (body as { asset_id?: unknown }).asset_id;
  if (typeof assetId !== "string" || !isUuidV7(assetId)) return null;
  return assetId;
}

async function stagedWebp(media: R2Bucket, key: string): Promise<WebpCheck | null> {
  const stored = await media.get(key);
  if (!stored) return null;
  return readWebp(new Uint8Array(await stored.arrayBuffer()));
}

// A thumbnail fits the box and keeps the display image's shape, within one pixel of rounding.
function fitsThumbnail(display: { width: number; height: number }, thumb: { width: number; height: number }): boolean {
  if (Math.max(thumb.width, thumb.height) > THUMB_EDGE) return false;
  const scale = Math.min(1, THUMB_EDGE / Math.max(display.width, display.height));
  return Math.abs(thumb.width - display.width * scale) <= 1 && Math.abs(thumb.height - display.height * scale) <= 1;
}

async function loadAsset(db: D1Database, assetId: string): Promise<AssetRow | null> {
  return db.prepare(
    "SELECT id, agent_id, state, sha256, thumb_sha256 FROM assets WHERE id = ?",
  ).bind(assetId).first<AssetRow>();
}

async function rejectAsset(db: D1Database, assetId: string, reason: ReasonCode): Promise<void> {
  const updated = await db.prepare(
    `UPDATE assets
        SET state = 'rejected', reason_code = ?, rejected_at = ?
      WHERE id = ? AND state IN ('uploaded', 'validating')`,
  ).bind(reason, utcSeconds(), assetId).run();
  if (Number(updated.meta.changes ?? 0) === 1) {
    console.log(JSON.stringify({ message: "asset rejected", asset_id: assetId, reason_code: reason }));
  }
}

function indexOfAscii(bytes: Uint8Array, needle: string): number {
  const codes: number[] = [];
  for (let index = 0; index < needle.length; index += 1) codes.push(needle.charCodeAt(index));
  const last = bytes.length - codes.length;
  for (let start = 0; start <= last; start += 1) {
    let matched = true;
    for (let offset = 0; offset < codes.length; offset += 1) {
      if (bytes[start + offset] !== codes[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return start;
  }
  return -1;
}
