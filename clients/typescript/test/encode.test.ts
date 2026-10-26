import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { encodeForJChain, fitsThumbnail, prepareUpload, readWebpInfo, sharpEncoder, type SharpLike } from "../src/index.js";

const sharpLike = sharp as unknown as SharpLike;

async function png(width: number, height: number, exif = false): Promise<Uint8Array> {
  let image = sharp({ create: { width, height, channels: 3, background: { r: 114, g: 255, b: 139 } } }).png();
  if (exif) image = image.withMetadata({ exif: { IFD0: { ImageDescription: "private camera note" } } });
  return new Uint8Array(await image.toBuffer());
}

describe("encodeForJChain with sharp", () => {
  it.each([
    [640, 320],
    [1001, 333],
    [333, 1001],
    [321, 321],
    [1200, 900],
  ])("turns a %ix%i PNG into a WebP and a thumbnail that fits 320", async (width, height) => {
    const encoded = await encodeForJChain(await png(width, height), { sharp: sharpLike });
    const display = readWebpInfo(encoded.display);
    expect(display.ok && display.info).toMatchObject({ width, height, metadata: [] });
    expect(encoded.thumb).not.toBeNull();
    const thumb = readWebpInfo(encoded.thumb ?? new Uint8Array());
    expect(thumb.ok).toBe(true);
    if (!thumb.ok) return;
    expect(Math.max(thumb.info.width, thumb.info.height)).toBe(320);
    expect(fitsThumbnail({ width, height }, thumb.info)).toBe(true);
    expect(() => prepareUpload(encoded)).not.toThrow();
  });

  it("sends no thumbnail for a small image", async () => {
    const encoded = await encodeForJChain(await png(200, 120), { sharp: sharpLike });
    expect(encoded.thumb).toBeNull();
    expect(encoded.width).toBe(200);
  });

  it("strips EXIF from the output", async () => {
    const source = await png(400, 300, true);
    expect((await sharp(source).metadata()).exif).toBeDefined();
    const encoded = await encodeForJChain(source, { sharp: sharpLike });
    const info = readWebpInfo(encoded.display);
    expect(info.ok && info.info.metadata).toEqual([]);
    expect(Buffer.from(encoded.display).includes("private camera note")).toBe(false);
    expect((await sharp(encoded.display).metadata()).exif).toBeUndefined();
  });

  it("scales down past the edge and pixel limits", async () => {
    const encoded = await encodeForJChain(await png(1000, 500), { sharp: sharpLike, maxEdgePx: 800, maxMegapixels: 0.2 });
    expect(Math.max(encoded.width, encoded.height)).toBeLessThanOrEqual(800);
    expect(encoded.width * encoded.height).toBeLessThanOrEqual(200_000);
  });

  it("reads a file path and loads sharp on its own", async () => {
    const encoded = await sharpEncoder().encode(new URL("./fixtures/large.webp", import.meta.url).pathname);
    expect(encoded.thumb).not.toBeNull();
  });

  it("refuses a bad quality", async () => {
    await expect(encodeForJChain(await png(10, 10), { sharp: sharpLike, quality: 0 })).rejects.toMatchObject({ code: "invalid_argument" });
  });
});
