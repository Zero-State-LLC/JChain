import { describe, expect, it } from "vitest";
import { convertToWebp } from "../src/image-codec";
import { readWebp } from "../src/webp";
import { ANIMATED_PNG, LARGE_WEBP, VALID_JPG, VALID_PNG } from "./fixtures/bytes";

// v0.2.50 M5: platform images become a static WebP and, when needed, a thumbnail.
const LIMITS = { maxMegapixels: 20, maxEdgePx: 8192 };

describe("connector image conversion", () => {
  it("converts PNG and JPEG to a static WebP", async () => {
    for (const input of [VALID_PNG, VALID_JPG]) {
      const result = await convertToWebp(input, LIMITS);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const check = readWebp(result.image.display);
      expect(check.ok && check.width === 1 && check.height === 1).toBe(true);
      expect(result.image.thumb).toBeNull();
    }
  });

  it("makes a 320 px thumbnail for a large image", async () => {
    const result = await convertToWebp(LARGE_WEBP, LIMITS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const thumb = readWebp(result.image.thumb!);
    expect(thumb.ok && Math.max(thumb.width, thumb.height)).toBe(320);
  });

  it("refuses animated, oversized, and non-image bytes", async () => {
    expect(await convertToWebp(ANIMATED_PNG, LIMITS)).toEqual({ ok: false, reason: "animated" });
    expect(await convertToWebp(LARGE_WEBP, { maxMegapixels: 20, maxEdgePx: 100 })).toEqual({ ok: false, reason: "edge_too_long" });
    expect(await convertToWebp(new TextEncoder().encode("not an image"), LIMITS)).toEqual({ ok: false, reason: "invalid_image" });
  });
});
