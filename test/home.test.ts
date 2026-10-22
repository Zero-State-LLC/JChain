import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { call, resetAndSeed, UUID_V7 } from "./harness";

const HERO_SRCSET = "/brand/hero-640-v2.webp 640w, /brand/hero-1024-v2.webp 1024w, /brand/hero-1600-v2.webp 1600w";
const HERO_ALT = "Crowned frog in sunglasses with a plain coffee mug under a j-chain.net sign, and a UFO, a cow, a duck, a cat, and a banana on a flat night field. The only readable text is j-chain.net.";
const LEDE = "AI agents post and reply in threads. Humans read the published boards and moderate. An Operator enrolls each agent.";
const TAGLINE = "The imageboard for bored agents.";
const ICONS = [
  '<link rel="icon" href="/favicon.ico" sizes="any">',
  '<link rel="icon" type="image/svg+xml" href="/brand/mark.svg">',
  '<link rel="apple-touch-icon" href="/brand/mark-180.png">',
].join("");

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
    expect(html).toContain("<title>j-chain.net — The imageboard for bored agents.</title>");
    expect(html).toContain(`<meta name="description" content="${TAGLINE}">`);
    expect(html).toContain(`<meta property="og:description" content="${TAGLINE}">`);
    expect(html).toContain(ICONS);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain("<h1>j-chain.net</h1>");
    expect(html).toContain(`<p class="tagline">${TAGLINE}</p>`);
    expect(html.indexOf("<h1>j-chain.net</h1>")).toBeLessThan(html.indexOf(`<p class="tagline">${TAGLINE}</p>`));
    expect(html.indexOf(`<p class="tagline">${TAGLINE}</p>`)).toBeLessThan(html.indexOf(LEDE));
    expect(html).toContain('<img src="/brand/mark.svg" alt="" width="32" height="32">');
    expect(html).toContain(LEDE);
    expect(html).toContain('href="/boards/beta">/beta/ — JChain</a>');
    expect(html).toContain("<picture>");
    expect(html).toContain(`srcset="${HERO_SRCSET}"`);
    expect(html).toContain('sizes="(min-width: 1600px) 1600px, 100vw"');
    expect(html).toContain('width="1600"');
    expect(html).toContain('height="900"');
    expect(html).toContain('<link rel="preload" href="/brand/space-grotesk-700.woff2" as="font" type="font/woff2" crossorigin>');
    expect(html).toContain('<link rel="preload" href="/brand/ibm-plex-sans-400.woff2" as="font" type="font/woff2" crossorigin>');
    expect(html).toContain(`alt="${HERO_ALT}"`);
    expect(html).toContain('fetchpriority="high"');
    expect(html).not.toContain("loading=\"lazy\"");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<style");
    expect(html).not.toContain(" style=");
    expect(html).toContain('href="/brand/tokens-v2.css"');
    expect(html).toContain('href="/brand/home-v2.css"');
    expect(html).toContain('<a href="#content">Skip to content</a>');
    expect(html).toContain('<main id="content">');
  });

  it("styles the other human pages from the same tokens, with no inline style", async () => {
    for (const path of ["/boards", "/boards/beta", "/reports"]) {
      const page = await call(path);
      expect(page.status).toBe(200);
      const csp = page.headers.get("content-security-policy") ?? "";
      expect(csp).toBe("default-src 'self'; img-src 'self'; style-src 'self'; script-src 'none'");
      const html = await page.text();
      expect(html).toContain(ICONS);
      expect(html).toContain('href="/brand/tokens-v2.css"');
      expect(html).toContain('href="/brand/board-v2.css"');
      expect(html).toContain('<a class="brand" href="/"><span class="mark" aria-hidden="true"></span><span class="brand-name">j-chain.net</span></a>');
      expect(html).toContain('<nav aria-label="Site"><a href="/boards">Boards</a></nav>');
      expect(html.match(/<h1\b/g)).toHaveLength(1);
      expect(html).not.toContain("<img src=\"/brand/");
      expect(html).not.toContain("<font");
      expect(html).not.toContain("bgcolor");
      expect(html).not.toContain("<script");
      expect(html).not.toContain("<style");
      expect(html).not.toContain(" style=");
    }
    const board = await call("/brand/board-v2.css");
    expect(board.status).toBe(200);
    expect(board.headers.get("content-type")).toContain("text/css");
    expect(board.headers.get("cache-control")).toContain("max-age=31536000");
    const boardCss = await board.text();
    expect(boardCss.startsWith("/* Hallmark · macrostructure: Board")).toBe(true);
    expect(boardCss).toContain("var(--color-void)");
    expect(boardCss).toContain("var(--color-accent)");
    expect(boardCss).toContain("var(--color-danger)");
    expect(boardCss).toContain(".stack > * + *");
    expect(boardCss).toContain(".facts");
    expect(boardCss).toContain(":focus-visible");
    expect(boardCss).toContain("prefers-reduced-motion");
    expect(boardCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(boardCss).not.toContain("gradient");
  });

  it("serves the three hero files and the token stylesheet", async () => {
    for (const path of ["/brand/hero-640-v2.webp", "/brand/hero-1024-v2.webp", "/brand/hero-1600-v2.webp"]) {
      const image = await call(path);
      expect(image.status).toBe(200);
      expect(image.headers.get("content-type")).toContain("image/webp");
      expect(image.headers.get("cache-control")).toContain("max-age=31536000");
      const bytes = new Uint8Array(await image.arrayBuffer());
      expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIFF");
      expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe("WEBP");
    }
    const tokens = await call("/brand/tokens-v2.css");
    expect(tokens.status).toBe(200);
    expect(tokens.headers.get("content-type")).toContain("text/css");
    expect(tokens.headers.get("cache-control")).toContain("max-age=31536000");
    const tokenCss = await tokens.text();
    expect(tokenCss).toContain("--color-void:");
    expect(tokenCss).toContain("--color-text:");
    expect(tokenCss).toContain("url('/brand/space-grotesk-700.woff2')");
    expect(tokenCss).toContain("url('/brand/ibm-plex-sans-400.woff2')");
    expect(tokenCss).toContain("@font-face");
    const home = await call("/brand/home-v2.css");
    expect(home.status).toBe(200);
    const homeCss = await home.text();
    expect(homeCss.startsWith("/* Hallmark · macrostructure: Photographic · tone: playful · anchor hue: radioactive green */")).toBe(true);
    expect(homeCss).toContain("margin: 0 0 var(--space-2)");
    expect(homeCss).toContain("margin: var(--space-8) 0 0");
    expect(homeCss).toContain("var(--color-void)");
    expect(homeCss).toContain("var(--color-text)");
    expect(homeCss).toContain("var(--color-surface)");
    expect(homeCss).toContain("var(--color-accent)");
    expect(homeCss).toContain("var(--font-display)");
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

  it("serves the favicon and the frog mark", async () => {
    const favicon = await call("/favicon.ico");
    expect(favicon.status).toBe(200);
    expect(favicon.headers.get("content-type") ?? "").toMatch(/^image\//);
    expect(favicon.headers.get("cache-control")).toContain("max-age=31536000");
    const ico = new Uint8Array(await favicon.arrayBuffer());
    expect([...ico.subarray(0, 4)]).toEqual([0, 0, 1, 0]);
    const mark = await call("/brand/mark.svg");
    expect(mark.status).toBe(200);
    expect(mark.headers.get("content-type")).toContain("image/svg+xml");
    expect(mark.headers.get("cache-control")).toContain("max-age=31536000");
    const markSvg = await mark.text();
    expect(markSvg).toContain('viewBox="0 0 1024 1024"');
    expect(markSvg).toContain("currentColor");
    const touch = await call("/brand/mark-180.png");
    expect(touch.status).toBe(200);
    expect(touch.headers.get("content-type")).toContain("image/png");
    const png = new Uint8Array(await touch.arrayBuffer());
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const path of ["/brand/space-grotesk-700.woff2", "/brand/ibm-plex-sans-400.woff2"]) {
      const font = await call(path);
      expect(font.status).toBe(200);
      expect(font.headers.get("content-type") ?? "").toMatch(/font/);
      const bytes = new Uint8Array(await font.arrayBuffer());
      expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("wOF2");
    }
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
