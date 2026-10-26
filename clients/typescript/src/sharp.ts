// Image prep with sharp. sharp is an optional peer dependency: it loads only when you call
// encodeForJChain or sharpEncoder without passing your own sharp instance.

import type { EncodedImage, ImageEncoder, ImageInput } from "./encoder.js";
import { invalidArgument } from "./errors.js";
import {
  DEFAULT_UPLOAD_LIMITS,
  THUMB_EDGE_PX,
  fitsThumbnail,
  needsThumbnail,
  readWebpInfo,
  stripWebpMetadata,
  thumbnailSize,
} from "./webp.js";

/** The slice of the sharp API this module uses. Pass `sharp` itself. */
export type SharpLike = (input?: unknown, options?: Record<string, unknown>) => SharpPipeline;

export interface SharpPipeline {
  metadata(): Promise<{ width?: number; height?: number; orientation?: number }>;
  rotate(): SharpPipeline;
  resize(width: number, height: number, options?: Record<string, unknown>): SharpPipeline;
  webp(options?: Record<string, unknown>): SharpPipeline;
  toBuffer(options: { resolveWithObject: true }): Promise<{ data: Uint8Array; info: { width: number; height: number } }>;
}

export type EncodeOptions = {
  /** Your sharp module. Loaded with a dynamic import when absent. */
  sharp?: SharpLike;
  /** WebP quality for the first attempt, 1–100. Default 82. */
  quality?: number;
  /** Policy limits. Defaults to the beta Board Rules values. */
  maxBytes?: number;
  maxEdgePx?: number;
  maxMegapixels?: number;
  thumbEdgePx?: number;
};

export type EncodedForJChain = EncodedImage & {
  width: number;
  height: number;
  thumbSize: { width: number; height: number } | null;
};

const QUALITY_STEPS = [70, 55, 40];

/**
 * Turns any image sharp can read (bytes or a file path) into a compliant JChain upload:
 * a static display WebP no larger than the policy limits, plus a thumbnail when either edge is
 * over 320 px. The thumbnail fits 320 and keeps the display shape within 1 px. EXIF orientation is
 * applied, then every metadata chunk (EXIF, XMP, ICC) is removed. Animated input keeps its first frame.
 */
export async function encodeForJChain(input: ImageInput, options: EncodeOptions = {}): Promise<EncodedForJChain> {
  const sharp = options.sharp ?? await loadSharp();
  const maxBytes = options.maxBytes ?? DEFAULT_UPLOAD_LIMITS.max_bytes;
  const maxEdge = options.maxEdgePx ?? DEFAULT_UPLOAD_LIMITS.max_edge_px;
  const maxPixels = (options.maxMegapixels ?? DEFAULT_UPLOAD_LIMITS.max_megapixels) * 1_000_000;
  const thumbEdge = options.thumbEdgePx ?? THUMB_EDGE_PX;
  const firstQuality = options.quality ?? 82;
  if (!Number.isInteger(firstQuality) || firstQuality < 1 || firstQuality > 100) {
    throw invalidArgument("quality must be a whole number from 1 to 100.");
  }
  const source = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  const open = () => sharp(source, { animated: false, failOn: "error" });

  const meta = await open().metadata();
  if (!meta.width || !meta.height) throw invalidArgument("The image has no readable size.");
  const swapped = (meta.orientation ?? 1) >= 5;
  const width = swapped ? meta.height : meta.width;
  const height = swapped ? meta.width : meta.height;
  const scale = Math.min(1, maxEdge / Math.max(width, height), Math.sqrt(maxPixels / (width * height)));
  const target = {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };

  let display: Uint8Array | null = null;
  for (const quality of [firstQuality, ...QUALITY_STEPS.filter((step) => step < firstQuality)]) {
    let pipeline = open().rotate();
    if (scale < 1) pipeline = pipeline.resize(target.width, target.height, { fit: "fill" });
    const encoded = await pipeline.webp({ quality, effort: 4 }).toBuffer({ resolveWithObject: true });
    const stripped = stripWebpMetadata(toPlain(encoded.data));
    // A compressed stream can contain the bytes "ANIM" by chance, which the service reads as animated.
    const usable = readWebpInfo(stripped);
    if (!usable.ok && usable.problem === "animated") continue;
    if (stripped.byteLength <= maxBytes) {
      display = stripped;
      break;
    }
  }
  if (display === null) throw invalidArgument("No quality step produced a WebP under the upload size limit that the service accepts.");

  const checked = readWebpInfo(display);
  if (!checked.ok) throw invalidArgument(`The encoder produced a WebP the service would refuse (${checked.problem}).`);
  const { width: displayWidth, height: displayHeight } = checked.info;

  if (!needsThumbnail(displayWidth, displayHeight, thumbEdge)) {
    return { display, thumb: null, width: displayWidth, height: displayHeight, thumbSize: null };
  }
  const size = thumbnailSize(displayWidth, displayHeight, thumbEdge);
  for (const quality of [Math.min(firstQuality, 80), 70, 60]) {
    const encodedThumb = await sharp(display, { animated: false })
      .resize(size.width, size.height, { fit: "fill" })
      .webp({ quality, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    const thumb = stripWebpMetadata(toPlain(encodedThumb.data));
    const thumbInfo = readWebpInfo(thumb);
    if (!thumbInfo.ok) continue;
    if (!fitsThumbnail({ width: displayWidth, height: displayHeight }, thumbInfo.info, thumbEdge)) break;
    return { display, thumb, width: displayWidth, height: displayHeight, thumbSize: size };
  }
  throw invalidArgument("The encoder could not produce a thumbnail that fits the 320 px rule.");
}

/** An {@link ImageEncoder} backed by sharp. Pass it to `new JChainClient({ encoder })`. */
export function sharpEncoder(options: EncodeOptions = {}): ImageEncoder {
  return { encode: (input) => encodeForJChain(input, options) };
}

async function loadSharp(): Promise<SharpLike> {
  const name = "sharp";
  try {
    const loaded = await import(/* @vite-ignore */ name) as { default?: SharpLike };
    if (typeof loaded.default === "function") return loaded.default;
    return loaded as unknown as SharpLike;
  } catch {
    throw invalidArgument("sharp is not installed. Run `npm install sharp`, or pass your own encoder.");
  }
}

function toPlain(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
