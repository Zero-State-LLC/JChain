import { isUuidV7 } from "./ids";
import type { Policy } from "./policy";
import { chargeDerivativeBytes, chargeTransformations, logRejected } from "./quota";

export const ASSET_QUEUE = "asset-upload";
export const ASSET_DLQ = "asset-upload-dlq";

const WEBP = "image/webp";
const QUALITY = 80;
const THUMB_EDGE = 320;

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
  IMAGES: ImagesBinding;
  QUOTA: Env["QUOTA"];
};

type AssetRow = {
  id: string;
  agent_id: string;
  state: string;
  sha256: string;
};

export function originalKey(assetId: string): string {
  return `originals/${assetId}`;
}

export function derivativeKey(assetId: string, variant: "display" | "thumb"): string {
  return `derivatives/${assetId}/${variant}`;
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

export function imageStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export async function processUploadedAsset(env: AssetEnv, policy: Policy, assetId: string): Promise<void> {
  const asset = await loadAsset(env.DB, assetId);
  if (!asset) return;
  if (asset.state === "ready") {
    await env.MEDIA.delete(originalKey(assetId));
    return;
  }
  if (asset.state !== "uploaded" && asset.state !== "validating") return;

  await env.DB.prepare(
    "UPDATE assets SET state = 'validating', reason_code = NULL WHERE id = ? AND state IN ('uploaded', 'validating')",
  ).bind(assetId).run();

  const stored = await env.MEDIA.get(originalKey(assetId));
  if (!stored) {
    await rejectAsset(env.DB, assetId, "processing_failed");
    return;
  }
  const bytes = new Uint8Array(await stored.arrayBuffer());

  let info: ImageInfoResponse;
  try {
    info = await env.IMAGES.info(imageStream(bytes));
  } catch {
    await rejectAsset(env.DB, assetId, "invalid_image");
    return;
  }
  const size = dimensions(info);
  if (!size) {
    await rejectAsset(env.DB, assetId, "invalid_image");
    return;
  }
  if (size.width > policy.upload.max_edge_px || size.height > policy.upload.max_edge_px) {
    await rejectAsset(env.DB, assetId, "edge_too_long");
    return;
  }
  if (size.width * size.height > policy.upload.max_megapixels * 1_000_000) {
    await rejectAsset(env.DB, assetId, "too_many_pixels");
    return;
  }

  const twin = await env.DB.prepare(
    "SELECT id FROM assets WHERE agent_id = ? AND sha256 = ? AND state = 'ready' AND id != ?",
  ).bind(asset.agent_id, asset.sha256, assetId).first<{ id: string }>();
  if (twin) {
    await env.MEDIA.delete(originalKey(assetId));
    await rejectAsset(env.DB, assetId, "processing_failed");
    return;
  }

  const transformations = await chargeTransformations(env, policy);
  if (!transformations.ok) {
    logRejected(asset.agent_id, "global", "transformations");
    await rejectAsset(env.DB, assetId, "processing_failed");
    return;
  }

  let display: Uint8Array;
  let thumb: Uint8Array;
  let finished = 0;
  try {
    display = await encode(env.IMAGES, bytes, false);
    finished = 1;
    thumb = await encode(env.IMAGES, bytes, true);
    finished = 2;
  } catch {
    await transformations.refund(2 - finished);
    await env.MEDIA.delete([derivativeKey(assetId, "display"), derivativeKey(assetId, "thumb")]);
    await rejectAsset(env.DB, assetId, "processing_failed");
    return;
  }

  const displayKey = derivativeKey(assetId, "display");
  const thumbKey = derivativeKey(assetId, "thumb");
  try {
    await env.MEDIA.put(displayKey, display, { httpMetadata: { contentType: WEBP } });
    await env.MEDIA.put(thumbKey, thumb, { httpMetadata: { contentType: WEBP } });
  } catch {
    await env.MEDIA.delete([displayKey, thumbKey]);
    await rejectAsset(env.DB, assetId, "processing_failed");
    return;
  }
  const bytesCharged = await chargeDerivativeBytes(env, policy, display.byteLength + thumb.byteLength);
  if (!bytesCharged.ok) {
    logRejected(asset.agent_id, "global", "r2_bytes");
    await env.MEDIA.delete([displayKey, thumbKey]);
    await rejectAsset(env.DB, assetId, "processing_failed");
    return;
  }
  const updated = await env.DB.prepare(
    "UPDATE assets SET state = 'ready', reason_code = NULL, original_stored = 0 WHERE id = ? AND state = 'validating'",
  ).bind(assetId).run();
  if (Number(updated.meta.changes ?? 0) !== 1) {
    await bytesCharged.refund();
    await env.MEDIA.delete([displayKey, thumbKey]);
    return;
  }
  await env.MEDIA.delete(originalKey(assetId));
  console.log(JSON.stringify({ message: "asset ready", asset_id: assetId }));
}

export async function rejectInFlight(db: D1Database, assetId: string): Promise<void> {
  const updated = await db.prepare(
    `UPDATE assets
        SET state = 'rejected', reason_code = 'processing_failed'
      WHERE id = ? AND state IN ('reserved', 'uploaded', 'validating')`,
  ).bind(assetId).run();
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

async function encode(images: ImagesBinding, bytes: Uint8Array, thumbnail: boolean): Promise<Uint8Array> {
  let transformer = images.input(imageStream(bytes));
  if (thumbnail) {
    transformer = transformer.transform({ width: THUMB_EDGE, height: THUMB_EDGE, fit: "scale-down" });
  }
  const result = await transformer.output({ format: WEBP, quality: QUALITY, anim: false });
  if (result.contentType() !== WEBP) throw new Error("image output was not webp");
  const encoded = new Uint8Array(await result.response().arrayBuffer());
  if (encoded.byteLength === 0 || indexOfAscii(encoded, "ANIM") >= 0) {
    throw new Error("image output was not a static webp");
  }
  return encoded;
}

function dimensions(info: ImageInfoResponse): { width: number; height: number } | null {
  if (!("width" in info) || !("height" in info)) return null;
  if (!Number.isInteger(info.width) || !Number.isInteger(info.height)) return null;
  if (info.width < 1 || info.height < 1) return null;
  return { width: info.width, height: info.height };
}

async function loadAsset(db: D1Database, assetId: string): Promise<AssetRow | null> {
  return db.prepare(
    "SELECT id, agent_id, state, sha256 FROM assets WHERE id = ?",
  ).bind(assetId).first<AssetRow>();
}

async function rejectAsset(db: D1Database, assetId: string, reason: ReasonCode): Promise<void> {
  const updated = await db.prepare(
    `UPDATE assets
        SET state = 'rejected', reason_code = ?
      WHERE id = ? AND state IN ('uploaded', 'validating')`,
  ).bind(reason, assetId).run();
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
