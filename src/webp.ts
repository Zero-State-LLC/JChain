// Reads a static WebP from its RIFF container and bitstream headers. It never decodes pixels.
// The agent encodes; the service checks the container, drops metadata chunks, and stores the result.

export type WebpCheck =
  | { ok: true; width: number; height: number; bytes: Uint8Array }
  | { ok: false; reason: "invalid_image" | "animated" };

type Chunk = { fourcc: string; start: number; payload: number; size: number; end: number };

const METADATA = new Set(["ICCP", "EXIF", "XMP "]);
const BITSTREAMS = new Set(["VP8 ", "VP8L"]);
const VP8X_ALPHA = 0x10;
const VP8X_ANIMATION = 0x02;
const INVALID: WebpCheck = { ok: false, reason: "invalid_image" };
const ANIMATED: WebpCheck = { ok: false, reason: "animated" };

export function readWebp(input: Uint8Array): WebpCheck {
  if (input.length < 20 || ascii(input, 0) !== "RIFF" || ascii(input, 8) !== "WEBP") return INVALID;
  if (u32(input, 4) + 8 !== input.length) return INVALID;

  const chunks: Chunk[] = [];
  let offset = 12;
  while (offset < input.length) {
    if (offset + 8 > input.length) return INVALID;
    const size = u32(input, offset + 4);
    const end = offset + 8 + size + (size & 1);
    if (end > input.length) return INVALID;
    chunks.push({ fourcc: ascii(input, offset), start: offset, payload: offset + 8, size, end });
    offset = end;
  }
  if (chunks.some((chunk) => chunk.fourcc === "ANIM" || chunk.fourcc === "ANMF")) return ANIMATED;

  const kept = chunks.filter((chunk) => !METADATA.has(chunk.fourcc));
  const first = kept[0];
  if (!first) return INVALID;

  if (BITSTREAMS.has(first.fourcc)) {
    if (kept.length !== 1) return INVALID;
    const size = bitstreamSize(input, first);
    if (!size) return INVALID;
    return { ok: true, ...size, bytes: kept.length === chunks.length ? input : rebuild(input, kept, null) };
  }

  if (first.fourcc !== "VP8X" || first.size !== 10) return INVALID;
  const flags = input[first.payload] ?? 0;
  if (flags & VP8X_ANIMATION) return ANIMATED;
  const canvas = { width: u24(input, first.payload + 4) + 1, height: u24(input, first.payload + 7) + 1 };
  const rest = kept.slice(1);
  const alpha = rest[0]?.fourcc === "ALPH" ? rest.shift() : undefined;
  const image = rest[0];
  if (!image || rest.length !== 1 || !BITSTREAMS.has(image.fourcc)) return INVALID;
  if (alpha && image.fourcc !== "VP8 ") return INVALID;
  const size = bitstreamSize(input, image);
  if (!size || size.width !== canvas.width || size.height !== canvas.height) return INVALID;
  const cleanFlags = flags & VP8X_ALPHA;
  const unchanged = kept.length === chunks.length && cleanFlags === flags;
  return { ok: true, ...size, bytes: unchanged ? input : rebuild(input, kept, cleanFlags) };
}

function bitstreamSize(input: Uint8Array, chunk: Chunk): { width: number; height: number } | null {
  const at = chunk.payload;
  if (chunk.fourcc === "VP8 ") {
    if (chunk.size < 10) return null;
    // Frame tag (RFC 6386 section 9.1): key-frame bit 0, version 0 to 3, show_frame 1, then the
    // 19-bit first-partition size. Round-2 audit finding 12: a first partition that is empty or
    // runs past the chunk is an inconsistent frame. This is a header check only; the bitstream is
    // never decoded, so bytes inside a well-formed bitstream are not inspected.
    const tag = u24(input, at);
    if ((tag & 0x01) !== 0) return null;
    if (((tag >>> 1) & 0x07) > 3 || ((tag >>> 4) & 0x01) !== 1) return null;
    const firstPartition = tag >>> 5;
    if (firstPartition < 1 || 10 + firstPartition > chunk.size) return null;
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

function rebuild(input: Uint8Array, kept: Chunk[], vp8xFlags: number | null): Uint8Array {
  const length = 12 + kept.reduce((total, chunk) => total + chunk.end - chunk.start, 0);
  const output = new Uint8Array(length);
  output.set(input.subarray(0, 12));
  new DataView(output.buffer).setUint32(4, length - 8, true);
  let offset = 12;
  for (const chunk of kept) {
    output.set(input.subarray(chunk.start, chunk.end), offset);
    if (chunk.fourcc === "VP8X" && vp8xFlags !== null) output[offset + 8] = vp8xFlags;
    offset += chunk.end - chunk.start;
  }
  return output;
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
