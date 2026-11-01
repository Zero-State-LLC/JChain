// v0.2.50 M5: the connector turns an image from the Agent's platform (PNG, JPEG, or WebP) into the
// static WebP and the 320 px thumbnail that the asset pipeline requires. The codecs are WebAssembly
// builds bundled with the Worker; nothing draws or generates an image here.
import decodeJpeg, { init as initJpegDecode } from "@jsquash/jpeg/decode";
import decodePng, { init as initPngDecode } from "@jsquash/png/decode";
import resize, { initResize } from "@jsquash/resize";
import decodeWebp, { init as initWebpDecode } from "@jsquash/webp/decode";
import encodeWebp, { init as initWebpEncode } from "@jsquash/webp/encode";
import JPEG_DEC from "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm";
import PNG_DEC from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm?module";
import RESIZE from "@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm?module";
import WEBP_DEC from "@jsquash/webp/codec/dec/webp_dec.wasm";
import WEBP_ENC from "@jsquash/webp/codec/enc/webp_enc_simd.wasm";
import { sniffedType } from "./asset-pipeline";
import { readWebp } from "./webp";

export const THUMB_EDGE = 320;
const QUALITY = 82;

// Workers have no ImageData; the codecs only need its three fields.
class WorkerImageData {
  readonly colorSpace = "srgb";
  constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {}
}
if (typeof (globalThis as { ImageData?: unknown }).ImageData === "undefined") {
  (globalThis as { ImageData?: unknown }).ImageData = WorkerImageData;
}

let ready: Promise<unknown> | null = null;
function initCodecs(): Promise<unknown> {
  ready ??= Promise.all([
    initJpegDecode(JPEG_DEC),
    initPngDecode(PNG_DEC),
    initResize(RESIZE),
    initWebpDecode(WEBP_DEC),
    initWebpEncode(WEBP_ENC),
  ]);
  return ready;
}

export type Converted = { display: Uint8Array; thumb: Uint8Array | null; width: number; height: number };
export type ConvertFailure = "invalid_image" | "animated" | "too_many_pixels" | "edge_too_long";
export type Limits = { maxMegapixels: number; maxEdgePx: number };

// Reads the dimensions from the header first, so an oversized image is refused before it is decoded.
export async function convertToWebp(bytes: Uint8Array, limits: Limits): Promise<{ ok: true; image: Converted } | { ok: false; reason: ConvertFailure }> {
  const type = sniffedType(bytes);
  if (type === null) return { ok: false, reason: "invalid_image" };
  if (isAnimated(bytes, type)) return { ok: false, reason: "animated" };
  const size = headerSize(bytes, type);
  if (size === null) return { ok: false, reason: "invalid_image" };
  if (size.width > limits.maxEdgePx || size.height > limits.maxEdgePx) return { ok: false, reason: "edge_too_long" };
  if (size.width * size.height > limits.maxMegapixels * 1_000_000) return { ok: false, reason: "too_many_pixels" };
  await initCodecs();
  let pixels: Awaited<ReturnType<typeof decodeWebp>>;
  try {
    const buffer = bytes.slice().buffer;
    pixels = type === "image/png" ? await decodePng(buffer) : type === "image/jpeg" ? await decodeJpeg(buffer) : await decodeWebp(buffer);
  } catch {
    return { ok: false, reason: "invalid_image" };
  }
  const display = new Uint8Array(await encodeWebp(pixels, { quality: QUALITY }));
  let thumb: Uint8Array | null = null;
  if (pixels.width > THUMB_EDGE || pixels.height > THUMB_EDGE) {
    const scale = THUMB_EDGE / Math.max(pixels.width, pixels.height);
    const small = await resize(pixels, {
      width: Math.max(1, Math.round(pixels.width * scale)),
      height: Math.max(1, Math.round(pixels.height * scale)),
    });
    thumb = new Uint8Array(await encodeWebp(small, { quality: QUALITY }));
  }
  return { ok: true, image: { display, thumb, width: pixels.width, height: pixels.height } };
}

function isAnimated(bytes: Uint8Array, type: string): boolean {
  const ascii = (tag: string) => {
    outer: for (let at = 0; at + tag.length <= bytes.length; at += 1) {
      for (let k = 0; k < tag.length; k += 1) if (bytes[at + k] !== tag.charCodeAt(k)) continue outer;
      return true;
    }
    return false;
  };
  if (type === "image/png") return ascii("acTL");
  if (type === "image/webp") return ascii("ANIM");
  return false;
}

function headerSize(bytes: Uint8Array, type: string): { width: number; height: number } | null {
  if (type === "image/png") {
    if (bytes.length < 24) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (type === "image/webp") {
    const check = readWebp(bytes);
    return check.ok ? { width: check.width, height: check.height } : null;
  }
  // JPEG: walk the markers to the first start-of-frame.
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (bytes[at + 5]! << 8) | bytes[at + 6]!, width: (bytes[at + 7]! << 8) | bytes[at + 8]! };
    }
    at += 2 + length;
  }
  return null;
}
