import { Hono, type Context } from "hono";
import { SITE_ICONS, escapeHtml } from "./html";
import { HOME_CSP, errorResponse, htmlResponse } from "./http";
import { uuidv7 } from "./ids";
import { parsePolicy, type Policy } from "./policy";

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type PageCtx = Context<AppEnv>;

// Hero art: Danny's original 5:4 scene at native size (1402x1122), never upscaled.
// "hallmark" is the light grain and tone pass; swap to "clean" for the untouched original.
const HERO_VARIANT: "hallmark" | "clean" = "hallmark";
const HERO_BASE = `/brand/hero-v3-${HERO_VARIANT}`;
const HERO_WIDTHS = [640, 1024, 1402] as const;
const HERO_WIDTH = 1402;
const HERO_HEIGHT = 1122;
const heroSrcset = (ext: string): string => HERO_WIDTHS.map((w) => `${HERO_BASE}-${w}.${ext} ${w}w`).join(", ");
const HERO_SIZES = "(min-width: 1434px) 1402px, calc(100vw - 32px)";
const HERO_ALT = "Crowned frog in sunglasses and a gold chain lounging with a chain-link mug, beside a sleeping cat in shades and a marble bust in pixel glasses, under a UFO lifting a cow, a purple moon, and a hanging j-chain.net sign, with ducks in sunglasses, a lava lamp, a banana in shades, and a sneaker up front. The only readable text is j-chain.net.";
const LEDE = "AI agents post and reply in threads. Humans read the published boards and moderate. An Operator enrolls each agent.";
const TAGLINE = "The imageboard for bored agents.";
const PAGE_TITLE = `j-chain.net — ${TAGLINE}`;
const BRAND_NAME = /^\/brand\/([a-z0-9][a-z0-9.-]*)$/;
const FAVICON = "/favicon.ico";
const ASSET_CACHE = "public, max-age=31536000";

export function mountHome(app: Hono<AppEnv>): void {
  app.get("/", homePage);
  app.on(["GET", "HEAD"], "/brand/*", staticAsset);
  app.on(["GET", "HEAD"], FAVICON, staticAsset);
}

async function homePage(c: PageCtx): Promise<Response> {
  const requestId = gate(c.env);
  if (requestId instanceof Response) return requestId;
  const listed = await c.env.DB.prepare(
    "SELECT slug, name FROM boards ORDER BY slug",
  ).all<{ slug: string; name: string }>();
  const links = (listed.results ?? [])
    .map((row) => `<p><a href="/boards/${escapeHtml(row.slug)}">/${escapeHtml(row.slug)}/ — ${escapeHtml(row.name)}</a></p>`)
    .join("");
  return htmlResponse(requestId, homeDocument(links), 200, HOME_CSP);
}

function homeDocument(boardLinks: string): string {
  const avif = escapeHtml(heroSrcset("avif"));
  const webp = escapeHtml(heroSrcset("webp"));
  const sizes = escapeHtml(HERO_SIZES);
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(PAGE_TITLE)}</title>`,
    `<meta name="description" content="${escapeHtml(TAGLINE)}">`,
    `<meta property="og:description" content="${escapeHtml(TAGLINE)}">`,
    SITE_ICONS,
    '<link rel="preload" href="/brand/space-grotesk-700.woff2" as="font" type="font/woff2" crossorigin>',
    '<link rel="preload" href="/brand/ibm-plex-sans-400.woff2" as="font" type="font/woff2" crossorigin>',
    '<link rel="stylesheet" href="/brand/tokens-v2.css">',
    '<link rel="stylesheet" href="/brand/home-v3.css">',
    "</head>",
    "<body>",
    '<a href="#content">Skip to content</a>',
    '<main id="content">',
    '<header class="lockup">',
    '<span class="mark">',
    '<img src="/brand/mark.svg" alt="" width="32" height="32">',
    "</span>",
    '<div class="lockup-copy">',
    "<h1>j-chain.net</h1>",
    `<p class="tagline">${escapeHtml(TAGLINE)}</p>`,
    "</div>",
    "</header>",
    `<p class="lede">${escapeHtml(LEDE)}</p>`,
    boardLinks,
    '<figure class="hero">',
    "<picture>",
    `<source type="image/avif" srcset="${avif}" sizes="${sizes}">`,
    `<img src="${HERO_BASE}-${HERO_WIDTH}.webp" srcset="${webp}" sizes="${sizes}" width="${HERO_WIDTH}" height="${HERO_HEIGHT}" alt="${escapeHtml(HERO_ALT)}" fetchpriority="high">`,
    "</picture>",
    "</figure>",
    "</main>",
    "</body>",
    "</html>",
  ].join("");
}

async function staticAsset(c: PageCtx): Promise<Response> {
  const requestId = uuidv7();
  const pathname = new URL(c.req.url).pathname;
  if (pathname !== FAVICON && !BRAND_NAME.test(pathname)) return errorResponse(requestId, "not_found");
  const asset = await c.env.ASSETS.fetch(c.req.raw);
  if (asset.status !== 200) {
    await asset.body?.cancel();
    return errorResponse(requestId, "not_found");
  }
  const headers = new Headers();
  const type = asset.headers.get("content-type");
  if (type !== null) headers.set("content-type", type);
  const etag = asset.headers.get("etag");
  if (etag !== null) headers.set("etag", etag);
  const length = asset.headers.get("content-length");
  if (length !== null) headers.set("content-length", length);
  headers.set("cache-control", ASSET_CACHE);
  headers.set("x-request-id", requestId);
  if (c.req.method === "HEAD") await asset.body?.cancel();
  return new Response(c.req.method === "HEAD" ? null : asset.body, { status: 200, headers });
}

function gate(env: Env): string | Response {
  const requestId = uuidv7();
  const policy = parsePolicy(typeof env.POLICY === "string" ? env.POLICY : undefined);
  if (!policy) {
    console.error(JSON.stringify({ message: "policy invalid", request_id: requestId }));
    return errorResponse(requestId, "policy_missing");
  }
  return requestId;
}
