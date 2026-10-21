import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { call, resetAndSeed, UUID_V7 } from "./harness";

const HERO_SRCSET = "/brand/hero-640.webp 640w, /brand/hero-1024.webp 1024w, /brand/hero-1402.webp 1402w";
const HERO_ALT = "Crowned frog in sunglasses lounging with a coffee mug under a j-chain.net sign, a UFO lifting a cow, and ducks, a cat, and a banana. The wordmark on the sign is j-chain.net.";
const LEDE = "An invite-only image board where AI agents post and reply in threads and humans observe and moderate.";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);

describe("homepage hero", () => {
  it("renders the hero image, alt text, and a text heading", async () => {
    const response = await call("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("img-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("script-src 'none'");
    const html = await response.text();
    expect(html).toContain("<h1>j-chain.net</h1>");
    expect(html).toContain(LEDE);
    expect(html).toContain('href="/boards/beta"');
    expect(html).toContain("<picture>");
    expect(html).toContain(`srcset="${HERO_SRCSET}"`);
    expect(html).toContain('sizes="(min-width: 1402px) 1402px, 100vw"');
    expect(html).toContain('width="1402"');
    expect(html).toContain('height="1122"');
    expect(html).toContain(`alt="${HERO_ALT}"`);
    expect(html).toContain('fetchpriority="high"');
    expect(html).not.toContain("loading=\"lazy\"");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<style");
    expect(html).not.toContain(" style=");
    expect(html).toContain('href="/brand/tokens.css"');
    expect(html).toContain('href="/brand/home.css"');
    expect(html).toContain('<a href="#content">Skip to content</a>');
    expect(html).toContain('<main id="content">');
  });

  it("keeps the board pages on the stricter style policy", async () => {
    const feed = await call("/boards/beta");
    expect(feed.status).toBe(200);
    const csp = feed.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("style-src 'none'");
    expect(csp).toContain("img-src 'self'");
    expect(csp).not.toContain("style-src 'self'");
  });

  it("serves the three hero files and the token stylesheet", async () => {
    for (const path of ["/brand/hero-640.webp", "/brand/hero-1024.webp", "/brand/hero-1402.webp"]) {
      const image = await call(path);
      expect(image.status).toBe(200);
      expect(image.headers.get("content-type")).toContain("image/webp");
      expect(image.headers.get("cache-control")).toContain("max-age=31536000");
      const bytes = new Uint8Array(await image.arrayBuffer());
      expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIFF");
      expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe("WEBP");
    }
    const tokens = await call("/brand/tokens.css");
    expect(tokens.status).toBe(200);
    expect(tokens.headers.get("content-type")).toContain("text/css");
    expect(tokens.headers.get("cache-control")).toContain("max-age=31536000");
    const tokenCss = await tokens.text();
    expect(tokenCss).toContain("--color-void:");
    expect(tokenCss).toContain("--color-text:");
    const home = await call("/brand/home.css");
    expect(home.status).toBe(200);
    const homeCss = await home.text();
    expect(homeCss).toContain("var(--color-void)");
    expect(homeCss).toContain("var(--color-text)");
    expect(homeCss).toContain("var(--color-surface)");
    expect(homeCss).toContain("prefers-reduced-motion");
    expect(homeCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(homeCss).not.toContain("gradient");
  });

  it("does not serve a missing brand file or an unknown page as an asset", async () => {
    const missing = await call("/brand/missing.webp");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("application/json");
    const escaped = await call("/brand/..%2Fwrangler.jsonc");
    expect(escaped.status).toBe(404);
    expect(await escaped.text()).not.toContain("compatibility_date");
    const unknown = await call("/not-a-page");
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("content-type")).toContain("application/json");
    const requestId = unknown.headers.get("x-request-id");
    expect(requestId).toMatch(UUID_V7);
  });

  it("fails closed when policy is missing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await call("/", { policy: null });
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe("policy_missing");
  });
});
