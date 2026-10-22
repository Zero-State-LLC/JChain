// Reads a static WebP from its RIFF container and bitstream headers, the same way the service does.
// It never decodes pixels, so it runs anywhere: Node, a Worker, or a browser.

/** The service's thumbnail box. Declare a thumbnail when either edge of the display image is over this. */
export const THUMB_EDGE_PX = 320;

/** Beta upload limits from Board Rules. The server is the authority; these are for early local checks. */
export const DEFAULT_UPLOAD_LIMITS = {
  max_bytes: 10_485_760,
  max_megapixels: 20,
  max_edge_px: 8192,
} as const;

export type WebpInfo = {
  width: number;
  height: number;
  /** Metadata chunks present (`EXIF`, `XMP `, `ICCP`). The service drops them; the encoder should too. */
  metadata: string[];
};

export type WebpProblem = "not_webp" | "animated" | "invalid_image";

type Chunk = { fourcc: string; start: number; payload: number; size: number; end: number };

const METADATA = new Set(["ICCP", "EXIF", "XMP "]);
const BITSTREAMS = new Set(["VP8 ", "VP8L"]);
const VP8X_ALPHA = 0x10;
const VP8X_ANIMATION = 0x02;

/** True when the bytes start with `RIFF` and carry `WEBP` at offset 8. */
export function isWebp(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && ascii(bytes, 0) === "RIFF" && ascii(bytes, 8) === "WEBP";
}

/** Reads width, height, and metadata chunks. Returns a problem code for anything the service would refuse. */
export function readWebpInfo(input: Uint8Array): { ok: true; info: WebpInfo } | { ok: false; problem: WebpProblem } {
  if (!isWebp(input)) return { ok: false, problem: "not_webp" };
  // The service refuses any WebP whose bytes contain the ASCII fourcc ANIM, wherever it appears.
  if (containsAscii(input, "ANIM")) return { ok: false, problem: "animated" };
  const parsed = parseChunks(input);
  if (parsed === null) return { ok: false, problem: "invalid_image" };
  const chunks = parsed;
  if (chunks.some((chunk) => chunk.fourcc === "ANIM" || chunk.fourcc === "ANMF")) return { ok: false, problem: "animated" };
  const metadata = chunks.filter((chunk) => METADATA.has(chunk.fourcc)).map((chunk) => chunk.fourcc);
  const kept = chunks.filter((chunk) => !METADATA.has(chunk.fourcc));
  const first = kept[0];
  if (!first) return { ok: false, problem: "invalid_image" };
  if (BITSTREAMS.has(first.fourcc)) {
    if (kept.length !== 1) return { ok: false, problem: "invalid_image" };
    const size = bitstreamSize(input, first);
    return size ? { ok: true, info: { ...size, metadata } } : { ok: false, problem: "invalid_image" };
  }
  if (first.fourcc !== "VP8X" || first.size !== 10) return { ok: false, problem: "invalid_image" };
  const flags = input[first.payload] ?? 0;
  if (flags & VP8X_ANIMATION) return { ok: false, problem: "animated" };
  const canvas = { width: u24(input, first.payload + 4) + 1, height: u24(input, first.payload + 7) + 1 };
  const rest = kept.slice(1);
  const alpha = rest[0]?.fourcc === "ALPH" ? rest.shift() : undefined;
  const image = rest[0];
  if (!image || rest.length !== 1 || !BITSTREAMS.has(image.fourcc)) return { ok: false, problem: "invalid_image" };
  if (alpha && image.fourcc !== "VP8 ") return { ok: false, problem: "invalid_image" };
  const size = bitstreamSize(input, image);
  if (!size || size.width !== canvas.width || size.height !== canvas.height) return { ok: false, problem: "invalid_image" };
  return { ok: true, info: { ...size, metadata } };
}

/** Removes `EXIF`, `XMP `, and `ICCP` chunks and clears their VP8X flags. Returns the input when nothing changes. */
export function stripWebpMetadata(input: Uint8Array): Uint8Array {
  const chunks = isWebp(input) ? parseChunks(input) : null;
  if (chunks === null) return input;
  const kept = chunks.filter((chunk) => !METADATA.has(chunk.fourcc));
  const vp8x = kept.find((chunk) => chunk.fourcc === "VP8X");
  const flags = vp8x ? input[vp8x.payload] ?? 0 : 0;
  const cleanFlags = flags & (VP8X_ALPHA | VP8X_ANIMATION);
  if (kept.length === chunks.length && cleanFlags === flags) return input;
  const length = 12 + kept.reduce((total, chunk) => total + chunk.end - chunk.start, 0);
  const output = new Uint8Array(length);
  output.set(input.subarray(0, 12));
  new DataView(output.buffer).setUint32(4, length - 8, true);
  let offset = 12;
  for (const chunk of kept) {
    output.set(input.subarray(chunk.start, chunk.end), offset);
    if (chunk.fourcc === "VP8X") output[offset + 8] = cleanFlags;
    offset += chunk.end - chunk.start;
  }
  return output;
}

/** True when either edge is over {@link THUMB_EDGE_PX}, so the upload must declare a thumbnail. */
export function needsThumbnail(width: number, height: number, edge = THUMB_EDGE_PX): boolean {
  return Math.max(width, height) > edge;
}

/** The thumbnail size the client aims for: longer side at most `edge`, same shape, each side at least 1. */
export function thumbnailSize(width: number, height: number, edge = THUMB_EDGE_PX): { width: number; height: number } {
  const scale = Math.min(1, edge / Math.max(width, height));
  return {
    width: Math.max(1, Math.min(edge, Math.round(width * scale))),
    height: Math.max(1, Math.min(edge, Math.round(height * scale))),
  };
}

/** The service's rule: the thumbnail fits the box and keeps the display shape within one pixel. */
export function fitsThumbnail(
  display: { width: number; height: number },
  thumb: { width: number; height: number },
  edge = THUMB_EDGE_PX,
): boolean {
  if (Math.max(thumb.width, thumb.height) > edge) return false;
  const scale = Math.min(1, edge / Math.max(display.width, display.height));
  return Math.abs(thumb.width - display.width * scale) <= 1 && Math.abs(thumb.height - display.height * scale) <= 1;
}

function parseChunks(input: Uint8Array): Chunk[] | null {
  if (input.length < 20 || u32(input, 4) + 8 !== input.length) return null;
  const chunks: Chunk[] = [];
  let offset = 12;
  while (offset < input.length) {
    if (offset + 8 > input.length) return null;
    const size = u32(input, offset + 4);
    const end = offset + 8 + size + (size & 1);
    if (end > input.length) return null;
    chunks.push({ fourcc: ascii(input, offset), start: offset, payload: offset + 8, size, end });
    offset = end;
  }
  return chunks;
}

function bitstreamSize(input: Uint8Array, chunk: Chunk): { width: number; height: number } | null {
  const at = chunk.payload;
  if (chunk.fourcc === "VP8 ") {
    if (chunk.size < 10) return null;
    if (((input[at] ?? 0) & 0x01) !== 0) return null;
    if (input[at + 3] !== 0x9d || input[at + 4] !== 0x01 || input[at + 5] !== 0x2a) return null;
    const width = u16(input, at + 6) & 0x3fff;
    const height = u16(input, at + 8) & 0x3fff;
    if (width < 1 || height < 1) return null;
    return { width, height };
  }
  if (chunk.size < 5 || input[at] !== 0x2f) return null;
  const bits = u32(input, at + 1);
  if (bits >>> 29 !== 0) return null;
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
}

function containsAscii(bytes: Uint8Array, needle: string): boolean {
  const first = needle.charCodeAt(0);
  for (let start = bytes.indexOf(first); start >= 0 && start <= bytes.length - needle.length; start = bytes.indexOf(first, start + 1)) {
    let matched = true;
    for (let offset = 1; offset < needle.length; offset += 1) {
      if (bytes[start + offset] !== needle.charCodeAt(offset)) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function ascii(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);
}

function u16(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
}

function u24(bytes: Uint8Array, at: number): number {
  return u16(bytes, at) | ((bytes[at + 2] ?? 0) << 16);
}

function u32(bytes: Uint8Array, at: number): number {
  return (u24(bytes, at) | ((bytes[at + 3] ?? 0) << 24)) >>> 0;
}
