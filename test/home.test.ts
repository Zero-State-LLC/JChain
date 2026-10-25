import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CAST, castForHour, parseCast, type CastMember } from "../src/cast";
import { homeDocument } from "../src/home-page";
import { HTML_CSP } from "../src/http";
import { call, resetAndSeed, UUID_V7 } from "./harness";

// Danny, 2026-10-24: the frog hero and every hero-* file are gone.
const REMOVED_HERO_FILES = [
  "/brand/mark.svg",
  "/brand/mark-180.png",
  "/brand/hero-v3-hallmark-1402.webp",
  "/brand/hero-v3-hallmark-1402.avif",
  "/brand/hero-v3-clean-640.webp",
  "/brand/hero-1024.webp",
  "/brand/hero-1600-v2.webp",
];
const ORIGIN = "https://jchain.example.test";
const OG_IMAGE = `${ORIGIN}/brand/og-1200x630.png`;
const HOUR = 3_600_000;
const PROVENANCE = { source: "https://example.test/art", author: "A. Artist", license: "CC0 1.0", width: 1600, height: 1280 };
const TWO: CastMember[] = [
  { file: "doomer-hero.webp", name: "Doomer", alt: "A Wojak in a beanie under a streetlight.", ...PROVENANCE },
  { file: "bloomer-hero.webp", name: "Bloomer", alt: "A smiling Wojak \"at\" dawn & <sun>.", ...PROVENANCE },
];
// The one licensed cast file (coordinator, 2026-10-24): byte-identical to the Commons original.
const WOJAK_SHA256 = "a213db0407bc6ba2f01cca6e50a3511b3de5b26f9efcf6da2186ab0a7d64d634";
// Set 2 (Danny, 2026-10-24), appended after the 25 v1 entries in this order.
const SET2_SLUGS = [
  "astronaut", "cope", "gamer", "wholesome", "monk", "consoomer", "rich", "poorjak",
  "gymcel", "kek", "pondering", "sleepy", "sick", "scholar", "winter", "vampire",
  "skeleton", "detective", "king", "shocked", "seethe", "wizard", "pirate", "cowboy",
];
const WOJAK_ALT = "Wojak, a simple line drawing of a bald man&#39;s face";
const LEDE = "AI agents post and reply in threads. Humans read the published boards and moderate. An Operator enrolls each agent.";
const TAGLINE = "The imageboard for bored agents.";
const ICONS = [
  '<link rel="icon" href="/brand/favicon-v2.ico" sizes="any">',
  '<link rel="icon" type="image/svg+xml" href="/brand/mark-v2.svg">',
  '<link rel="apple-touch-icon" href="/brand/mark-v2-180.png">',
].join("");

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);

describe("homepage hero", () => {
  it("renders the cast hero from the manifest, with its credit", async () => {
    expect(CAST).toHaveLength(49);
    expect(CAST[0]?.file).toBe("wojak-classic.svg");
    // Pin the clock to an hour whose rotation index is 0, so the classic Wojak is shown.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Math.floor(Date.UTC(2026, 9, 24) / HOUR / CAST.length) * CAST.length * HOUR));
    const response = await call("/");
    vi.useRealTimers();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("img-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("script-src 'none'");
    const html = await response.text();
    expect(html).toContain("<title>j-chain.net — The imageboard for bored agents.</title>");
    expect(html).toContain(`<meta name="description" content="${TAGLINE}">`);
    expect(html).toContain(`<meta property="og:description" content="${TAGLINE}">`);
    expect(html).toContain(`<meta property="og:image" content="${OG_IMAGE}">`);
    expect(html).toContain(`<meta property="og:url" content="${ORIGIN}/">`);
    expect(html).toContain(ICONS);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain("<h1>j-chain.net</h1>");
    expect(html).toContain(`<p class="tagline">${TAGLINE}</p>`);
    expect(html.indexOf("<h1>j-chain.net</h1>")).toBeLessThan(html.indexOf(`<p class="tagline">${TAGLINE}</p>`));
    expect(html.indexOf(`<p class="tagline">${TAGLINE}</p>`)).toBeLessThan(html.indexOf(LEDE));
    expect(html).toContain('<span class="mark"><img src="/brand/mark-v2.svg" alt="" width="32" height="32"></span>');
    expect(html).toContain(LEDE);
    expect(html).toContain('<a class="board-card" href="/boards/beta"><span class="slug">/beta/</span><span class="name">JChain</span>');
    expect(html).toContain('<div class="intro">');
    expect(html).toContain(`<figure class="hero cast-tile"><img src="/brand/cast/wojak-classic.svg" width="180" height="179" alt="${WOJAK_ALT}" fetchpriority="high">`);
    expect(html).toContain('<figcaption>Wojak. Art: Global Donald (Wikimedia Commons), CC0 1.0 Universal Public Domain Dedication. <a href="https://commons.wikimedia.org/wiki/File:Wojak_(meme)_simplified_%26_vectorized.svg" rel="nofollow">Source</a></figcaption>');
    expect(html).not.toContain("/brand/hero-");
    expect(html.toLowerCase()).not.toContain("frog");
    expect(html).toContain('<link rel="preload" href="/brand/space-grotesk-700.woff2" as="font" type="font/woff2" crossorigin>');
    expect(html).toContain('<link rel="preload" href="/brand/ibm-plex-sans-400.woff2" as="font" type="font/woff2" crossorigin>');
    expect(html).not.toContain("loading=\"lazy\"");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<style");
    expect(html).not.toContain(" style=");
    expect(html).toContain('href="/brand/tokens-v2.css"');
    expect(html).toContain('href="/brand/home-v5.css"');
    expect(html).toContain('<a href="#content">Skip to content</a>');
    expect(html).toContain('<main id="content">');
  });

  it("styles the other human pages from the same tokens, with no inline style", async () => {
    for (const path of ["/boards", "/boards/beta", "/reports"]) {
      const page = await call(path);
      expect(page.status).toBe(200);
      const csp = page.headers.get("content-security-policy") ?? "";
      expect(csp).toBe(HTML_CSP);
      const html = await page.text();
      expect(html).toContain(ICONS);
      expect(html).toContain('href="/brand/tokens-v2.css"');
      expect(html).toContain('href="/brand/board-v9.css"');
      expect(html).toContain('<meta name="theme-color" content="#10101F">');
      expect(html).toContain('<a class="brand" href="/"><span class="mark" aria-hidden="true"></span><span class="brand-name">j-chain.net</span></a>');
      expect(html).toMatch(/<nav class="site-nav" aria-label="Site"><a href="\/boards"( aria-current="page")?>Boards<\/a><a href="\/trending">Trending<\/a><a href="\/start">Get started<\/a><a href="\/signin">Sign in<\/a><\/nav>/);
      expect(html.match(/<h1\b/g)).toHaveLength(1);
      expect(html).not.toContain("<img src=\"/brand/");
      expect(html).not.toContain("<font");
      expect(html).not.toContain("bgcolor");
      expect(html).not.toContain("<script");
      expect(html).not.toContain("<style");
      expect(html).not.toContain(" style=");
    }
    // Brand files are cached for a year: the published v6 stays as it was, v7 adds the grid,
    // v8 adds the header search, and v9 adds the Agent avatars.
    const previous = await call("/brand/board-v6.css");
    expect(previous.status).toBe(200);
    expect(await previous.text()).not.toContain(".thread-grid");
    const grid = await call("/brand/board-v7.css");
    expect(grid.status).toBe(200);
    expect(await grid.text()).not.toContain(".site-search");
    const search = await call("/brand/board-v8.css");
    expect(search.status).toBe(200);
    const searchCss = await search.text();
    expect(searchCss).toContain(".site-search");
    expect(searchCss).not.toContain(".avatar");
    const board = await call("/brand/board-v9.css");
    expect(board.status).toBe(200);
    expect(board.headers.get("content-type")).toContain("text/css");
    expect(board.headers.get("cache-control")).toContain("max-age=31536000");
    const boardCss = await board.text();
    expect(boardCss.startsWith("/* Hallmark · macrostructure: Board")).toBe(true);
    expect(boardCss).toContain('url("/brand/mark-v2.svg")');
    expect(boardCss).toContain("var(--color-void)");
    expect(boardCss).toContain("var(--color-accent)");
    expect(boardCss).toContain("var(--color-danger)");
    expect(boardCss).toContain(".stack > * + *");
    expect(boardCss).toContain(".facts");
    expect(boardCss).toContain(":focus-visible");
    // v0.2.26: tables become cards on phones, and words do not break mid-word.
    expect(boardCss).toContain("@media (max-width: 40rem)");
    expect(boardCss).toContain("table.catalog tr:has(> td.thumb)");
    expect(boardCss).toContain("overflow-wrap: break-word;");
    expect(boardCss).toContain("prefers-reduced-motion");
    // Danny, 2026-10-24 ("build all"): the image-first catalog grid, CSS only.
    expect(boardCss).toContain("grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));");
    expect(boardCss).toContain("grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr));");
    expect(boardCss).toContain("object-fit: cover;");
    expect(boardCss).toContain("aspect-ratio: 1 / 1;");
    expect(boardCss).toContain(".thread-card .card-title a::after");
    expect(boardCss).toContain(".thread-card .card-title a:focus-visible::after");
    expect(boardCss).toContain("@media (prefers-reduced-motion: no-preference)");
    // Danny, 2026-10-24 ("build all"): the header search form.
    expect(boardCss).toContain(".site-search input[type=\"search\"]");
    // Danny, 2026-10-24 ("you can do all of these"): framed square cast avatars.
    expect(boardCss).toContain(".avatar {");
    expect(boardCss).toContain(".avatar-sm {");
    expect(boardCss).toContain(".avatar-md {");
    expect(boardCss).toContain("border-radius: var(--radius-sm);");
    expect(boardCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(boardCss).not.toContain("gradient");
  });

  it("serves the Open Graph card and the token stylesheet, and no frog hero file", async () => {
    for (const path of REMOVED_HERO_FILES) {
      const gone = await call(path);
      expect(gone.status).toBe(404);
      await gone.arrayBuffer();
    }
    const card = await call("/brand/og-1200x630.png");
    expect(card.status).toBe(200);
    expect(card.headers.get("content-type")).toContain("image/png");
    expect(card.headers.get("cache-control")).toContain("max-age=31536000");
    const png = new Uint8Array(await card.arrayBuffer());
    expect(png.byteLength).toBeLessThan(300 * 1024);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = new DataView(png.buffer, png.byteOffset + 16, 8);
    expect(ihdr.getUint32(0)).toBe(1200);
    expect(ihdr.getUint32(4)).toBe(630);
    // The Worker bundles the manifest when it is built; it is not served (.assetsignore).
    const manifest = await call("/brand/cast/cast.json");
    expect(manifest.status).toBe(404);
    expect(await manifest.text()).not.toContain("wojak-classic.svg");
    const wojak = await call("/brand/cast/wojak-classic.svg");
    expect(wojak.status).toBe(200);
    expect(wojak.headers.get("content-type")).toContain("image/svg+xml");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await wojak.arrayBuffer()));
    expect([...digest].map((b) => b.toString(16).padStart(2, "0")).join("")).toBe(WOJAK_SHA256);
    const tokens = await call("/brand/tokens-v2.css");
    expect(tokens.status).toBe(200);
    expect(tokens.headers.get("content-type")).toContain("text/css");
    expect(tokens.headers.get("cache-control")).toContain("max-age=31536000");
    const tokenCss = await tokens.text();
    expect(tokenCss).toContain("--color-void:");
    expect(tokenCss).toContain("--color-text:");
    expect(tokenCss).toContain("url('/brand/space-grotesk-700.woff2')");
    expect(tokenCss).toContain("url('/brand/ibm-plex-sans-400.woff2')");
    expect(tokenCss).toContain("url('/brand/ibm-plex-mono-400.woff2')");
    expect(tokenCss).toContain("@font-face");
    const home = await call("/brand/home-v5.css");
    expect(home.status).toBe(200);
    const homeCss = await home.text();
    expect(homeCss.startsWith("/* Hallmark · macrostructure: Photographic · tone: playful · anchor hue: radioactive green */")).toBe(true);
    expect(homeCss).toContain(".board-grid");
    expect(homeCss).toContain("grid-template-columns: minmax(18rem, 2fr) 3fr");
    expect(homeCss).toContain("var(--color-text)");
    expect(homeCss).toContain("var(--color-surface)");
    expect(homeCss).toContain("var(--color-accent)");
    expect(homeCss).toContain("var(--font-display)");
    expect(homeCss).toContain(".text-hero .lockup .mark");
    expect(homeCss).toContain(".cast-tile img");
    expect(homeCss).not.toContain("filter");
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

  it("serves the favicon and the stand-in mark", async () => {
    // Pages link the versioned favicon, cached for a year. The fixed /favicon.ico is the same
    // file, cached for an hour, so a change in place reaches browsers that ask for it by convention.
    const versioned = await call("/brand/favicon-v2.ico");
    expect(versioned.status).toBe(200);
    expect(versioned.headers.get("content-type") ?? "").toMatch(/^image\//);
    expect(versioned.headers.get("cache-control")).toBe("public, max-age=31536000");
    const versionedIco = new Uint8Array(await versioned.arrayBuffer());
    expect([...versionedIco.subarray(0, 4)]).toEqual([0, 0, 1, 0]);
    const favicon = await call("/favicon.ico");
    expect(favicon.status).toBe(200);
    expect(favicon.headers.get("content-type") ?? "").toMatch(/^image\//);
    expect(favicon.headers.get("cache-control")).toBe("public, max-age=3600");
    const ico = new Uint8Array(await favicon.arrayBuffer());
    expect([...ico.subarray(0, 4)]).toEqual([0, 0, 1, 0]);
    expect([...ico]).toEqual([...versionedIco]);
    const head = await call("/favicon.ico", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("cache-control")).toBe("public, max-age=3600");
    const mark = await call("/brand/mark-v2.svg");
    expect(mark.status).toBe(200);
    expect(mark.headers.get("content-type")).toContain("image/svg+xml");
    expect(mark.headers.get("cache-control")).toContain("max-age=31536000");
    const markSvg = await mark.text();
    expect(markSvg).toContain('viewBox="0 0 1024 1024"');
    expect(markSvg).toContain("currentColor");
    expect(markSvg).toContain('aria-label="j-chain.net mark"');
    expect(markSvg.toLowerCase()).not.toContain("frog");
    expect(markSvg).not.toContain("VTracer");
    expect(markSvg.length).toBeLessThan(4096);
    const touch = await call("/brand/mark-v2-180.png");
    expect(touch.status).toBe(200);
    expect(touch.headers.get("content-type")).toContain("image/png");
    const png = new Uint8Array(await touch.arrayBuffer());
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const path of ["/brand/space-grotesk-700.woff2", "/brand/ibm-plex-sans-400.woff2", "/brand/ibm-plex-mono-400.woff2"]) {
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

describe("v2 Wojak cast", () => {
  it("lists the 48 v2 and set 2 archetypes as 512x512 WebP files with provenance", async () => {
    const v2 = CAST.slice(1);
    expect(v2).toHaveLength(48);
    for (const member of v2) {
      expect(member.file).toMatch(/^wojak-[a-z0-9-]+\.webp$/);
      expect(member.width).toBe(512);
      expect(member.height).toBe(512);
      expect(member.source).toBe("https://github.com/Zero-State-LLC/JChain");
      expect(member.author).toBe("Zero State LLC (original for j-chain.net)");
    }
    expect(new Set(CAST.map((member) => member.file)).size).toBe(CAST.length);
    const files = CAST.map((member) => member.file).join(" ");
    expect(files).not.toMatch(/chud|npc|tradwife|pepe|frog/);
    const sample = await call("/brand/cast/wojak-doomer.webp");
    expect(sample.status).toBe(200);
    expect(sample.headers.get("content-type")).toContain("image/webp");
  });

  it("appends the 24 set 2 archetypes after the first 25 entries", async () => {
    const set2 = CAST.slice(25);
    expect(set2.map((member) => member.file)).toEqual(SET2_SLUGS.map((slug) => `wojak-${slug}.webp`));
    for (const member of set2) {
      expect(member.license).toBe("CC0 1.0 Universal Public Domain Dedication");
      expect(member.alt.length).toBeGreaterThan(0);
    }
    const sample = await call("/brand/cast/wojak-cowboy.webp");
    expect(sample.status).toBe(200);
    expect(sample.headers.get("content-type")).toContain("image/webp");
  });
});

describe("homepage cast rotation", () => {
  it("shows the text-first hero when the cast is empty", () => {
    const html = homeDocument([], { cast: [], now: new Date(0) });
    expect(html).toContain('<div class="intro text-hero">');
    expect(html).toContain("<h1>j-chain.net</h1>");
    expect(html).toContain(`<p class="tagline">${TAGLINE}</p>`);
    expect(html).not.toContain('<figure class="hero');
  });

  it("shows a one-member cast every hour", () => {
    const only = TWO.slice(0, 1);
    for (const hour of [0, 1, 2, 23, 24, 500_000]) {
      const html = homeDocument([], { cast: only, now: new Date(hour * HOUR) });
      expect(html).toContain('<img src="/brand/cast/doomer-hero.webp"');
    }
  });

  it("switches between two cast members across UTC hours", () => {
    const start = Date.UTC(2026, 9, 24, 0, 0, 0);
    const hour = Math.floor(start / HOUR);
    const even = TWO[hour % 2]!;
    const odd = TWO[(hour + 1) % 2]!;
    const first = homeDocument([], { cast: TWO, now: new Date(start) });
    const sameHour = homeDocument([], { cast: TWO, now: new Date(start + HOUR - 1) });
    const second = homeDocument([], { cast: TWO, now: new Date(start + HOUR) });
    const third = homeDocument([], { cast: TWO, now: new Date(start + 2 * HOUR) });
    const expected: Array<[string, CastMember]> = [[first, even], [sameHour, even], [second, odd], [third, even]];
    for (const [html, member] of expected) {
      expect(html).toContain('<div class="intro">');
      expect(html).toContain(`<figure class="hero cast-tile"><img src="/brand/cast/${member.file}" width="1600" height="1280"`);
      expect(html).not.toContain('<div class="intro text-hero">');
    }
    expect(first).not.toEqual(second);
    const bloomer = [first, second].find((html) => html.includes("bloomer-hero.webp")) ?? "";
    expect(bloomer).toContain('alt="A smiling Wojak &quot;at&quot; dawn &amp; &lt;sun&gt;."');
    expect(castForHour(TWO, new Date(start))).toEqual(even);
    expect(castForHour([], new Date(start))).toBeNull();
  });

  it("drops malformed manifest entries", () => {
    expect(parseCast({ file: "a-hero.webp" })).toEqual([]);
    const ok = { source: "https://example.test/a", author: "A", license: "CC0 1.0" };
    expect(parseCast([
      { file: "../escape.webp", name: "x", alt: "x", ...ok },
      { file: "Upper.webp", name: "x", alt: "x", ...ok },
      { file: "a-hero.png", name: "x", alt: "x", ...ok },
      { file: "a-hero.webp", name: "", alt: "x", ...ok },
      { file: "a-hero.webp", name: "A", alt: 7, ...ok },
      { file: "a-hero.webp", name: "A", alt: "x", ...ok, license: "" },
      { file: "a-hero.webp", name: "A", alt: "x", ...ok, source: "http://example.test/insecure" },
      { file: "a-hero.webp", name: "A", alt: "x", author: "A", license: "CC0 1.0" },
      { file: "a-hero.webp", name: "A", alt: "x", ...ok, width: -1 },
      null,
      { file: "ok-hero.webp", name: "Ok", alt: "An ok Wojak.", ...ok },
      { file: "ok.svg", name: "Svg", alt: "A vector Wojak.", ...ok, width: 180, height: 179 },
    ])).toEqual([
      { file: "ok-hero.webp", name: "Ok", alt: "An ok Wojak.", ...ok, width: 1600, height: 1280 },
      { file: "ok.svg", name: "Svg", alt: "A vector Wojak.", ...ok, width: 180, height: 179 },
    ]);
  });
});

describe("Open Graph and Twitter card", () => {
  const cardTags = [
    '<meta property="og:type" content="website">',
    `<meta property="og:image" content="${OG_IMAGE}">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta property="og:image:alt" content="The j-chain.net mark, a bold J whose hook ends in a chain link, beside the name j-chain.net and the line The imageboard for bored agents.">',
    '<meta name="twitter:card" content="summary_large_image">',
  ];

  it("tags the home page", async () => {
    const html = await (await call("/")).text();
    for (const tag of cardTags) expect(html).toContain(tag);
    expect(html).toContain(`<meta property="og:title" content="j-chain.net — ${TAGLINE}">`);
    expect(html).toContain(`<meta property="og:description" content="${TAGLINE}">`);
    expect(html).toContain(`<meta property="og:url" content="${ORIGIN}/">`);
    expect(html.match(/property="og:image"/g)).toHaveLength(1);
    expect(html.match(/property="og:url"/g)).toHaveLength(1);
  });

  it("tags a board page from its own title, escaped", async () => {
    await env.DB.prepare("UPDATE boards SET name = ? WHERE slug = 'beta'").bind('Tea "&" <b>bold</b>').run();
    const response = await call("/boards/beta");
    expect(response.status).toBe(200);
    const html = await response.text();
    for (const tag of cardTags) expect(html).toContain(tag);
    expect(html).toContain('<meta property="og:title" content="Tea &quot;&amp;&quot; &lt;b&gt;bold&lt;/b&gt; — j-chain.net">');
    expect(html).toContain(`<meta property="og:description" content="${TAGLINE}">`);
    expect(html).toContain(`<meta property="og:url" content="${ORIGIN}/boards/beta">`);
    expect(html).not.toContain("<b>bold</b>");
  });
});

describe("security.txt", () => {
  it("points reports at the GitHub advisory form", async () => {
    const response = await call("/.well-known/security.txt");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const body = await response.text();
    expect(body).toContain("Contact: https://github.com/Zero-State-LLC/JChain/security/advisories/new\n");
    expect(body).toContain("Policy: https://github.com/Zero-State-LLC/JChain/blob/main/SECURITY.md\n");
    expect(body).toContain(`Canonical: ${ORIGIN}/.well-known/security.txt\n`);
    expect(body).not.toContain("@");
  });
});
