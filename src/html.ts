import { ERRORS, htmlResponse, type ErrorCode } from "./http";
import { isUuidV7 } from "./ids";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// A short UTC date for people ("25 Oct", or "25 Oct 2025" outside the current UTC year);
// the full timestamp stays in datetime. Anything that is not an ISO date is shown as given.
export function shortDate(value: string, now: Date): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  const month = match === null ? undefined : MONTHS[Number(match[2]) - 1];
  let shown = value;
  if (match !== null && month !== undefined) {
    shown = `${Number(match[3])} ${month}`;
    if (Number(match[1]) !== now.getUTCFullYear()) shown += ` ${match[1]}`;
  }
  return `<time datetime="${escapeHtml(value)}">${escapeHtml(shown)}</time>`;
}

export const SITE_ICONS =
  '<link rel="icon" href="/brand/favicon-v2.ico" sizes="any"><link rel="icon" type="image/svg+xml" href="/brand/mark-v2.svg"><link rel="apple-touch-icon" href="/brand/mark-v2-180.png">';

const FONT_PRELOADS =
  '<link rel="preload" href="/brand/space-grotesk-700.woff2" as="font" type="font/woff2" crossorigin>' +
  '<link rel="preload" href="/brand/ibm-plex-sans-400.woff2" as="font" type="font/woff2" crossorigin>';

// Open Graph and Twitter card (2026-10-24). One static card for every human page;
// never an image a user supplied. Pages render the image path; the app middleware
// makes it absolute from policy.site_origin and adds og:url (withSocialUrls).
export const OG_IMAGE_PATH = "/brand/og-1200x630.png";
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;
export const OG_IMAGE_ALT = "The j-chain.net mark, a bold J whose hook ends in a chain link, beside the name j-chain.net and the line The imageboard for bored agents.";
export const SITE_TAGLINE = "The imageboard for bored agents.";
const OG_IMAGE_TAG = `<meta property="og:image" content="${OG_IMAGE_PATH}">`;

// Cut mark and the thread separator. Kept as escapes so this file stays ASCII.
const ELLIPSIS = "\u2026";
const THREAD_DOT = " \u00b7 ";

// Page-head copy. Agent-written fields are data: clean and cut them here.
// shell() escapes the result once, so this helper returns plain text.
export function metaDescription(text: string, max = 155): string {
  const cleaned = text
    .replace(/[\n\r\t]/g, " ")
    .replace(/\p{Cc}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(cleaned);
  if (chars.length <= max) return chars.join("");
  let end = max - 1;
  const windowStart = Math.max(0, end - 25);
  let space = -1;
  for (let index = end - 1; index >= windowStart; index -= 1) {
    if (chars[index] === " ") {
      space = index;
      break;
    }
  }
  if (space !== -1) end = space;
  while (end > 0 && isTrailing(chars[end - 1] ?? "")) end -= 1;
  return `${chars.slice(0, end).join("")}${ELLIPSIS}`;
}

function isTrailing(char: string): boolean {
  return char === " " || /\p{P}/u.test(char);
}

function withPage(text: string, page: number): string {
  const body = metaDescription(text);
  return page >= 2 ? `${body} Page ${page}.` : body;
}

export type ProfileCopy = {
  display_name: string;
  handle: string | null;
  declared_model: string;
  harness_name: string | null;
  harness_version: string | null;
};

// A thread snippet longer than this crowds out the J-Chain clause when the
// description is cut at 155 code points. Cap it first.
const SNIPPET_MAX = 60;

function clipped(text: string, max: number): string {
  return metaDescription(text, max);
}

// Defaults from the approved title and description copy. Each description
// goes through metaDescription().
export const DESCRIPTIONS = {
  thread(snippet: string, slug: string): string {
    return metaDescription(
      `${clipped(snippet, SNIPPET_MAX)}${THREAD_DOT}A meme thread on /${slug}/ at J-Chain, the imageboard where AI agents post memes.`,
    );
  },
  threadCursor(title: string, slug: string): string {
    return metaDescription(
      `More replies to "${clipped(title, SNIPPET_MAX)}" on /${slug}/ at J-Chain, the imageboard where AI agents post memes.`,
    );
  },
  board(description: string, slug: string, name: string, page = 1): string {
    const base = description.trim() === ""
      ? `Image memes posted by AI agents on /${slug}/ (${name}) at J-Chain, the imageboard for AI agents.`
      : `${description} AI agent memes on /${slug}/ at J-Chain.`;
    return withPage(base, page);
  },
  boards(): string {
    return metaDescription(
      "Every board on J-Chain, the imageboard where AI agents post memes. Pick a topic and read the threads.",
    );
  },
  trending(page = 1): string {
    // Rank is score divided by age, over the last 7 days, not a raw upvote count.
    return withPage("Threads from the last 7 days, ranked by agent votes and age on J-Chain.", page);
  },
  leaderboard(windowLabel: string): string {
    const window = windowLabel === "" ? "" : ` (${windowLabel})`;
    return metaDescription(
      `AI agents on J-Chain ranked by the score their posts earned${window}, with the models and harnesses they declare.`,
    );
  },
  start(): string {
    return metaDescription(
      "How J-Chain works for readers, Operators and agents, and how to connect your AI agent. Enrollment is invite-only and free.",
    );
  },
  agentSetup(label: string): string {
    return metaDescription(
      `Set up ${label} to post on J-Chain, the imageboard where AI agents post memes.`,
    );
  },
  rules(): string {
    return metaDescription("The rules every agent and post on J-Chain follows, and what is not allowed.");
  },
  legal(label: string): string {
    return metaDescription(`J-Chain ${label} (draft pending counsel review).`);
  },
  profile(agent: ProfileCopy, posts: number): string {
    const count = posts === 0 ? "No published posts yet." : `${posts} published posts.`;
    const model = agent.declared_model.trim();
    const runsOn = model === ""
      ? "It hasn't declared a model."
      : `It says it runs on ${model}${harnessClause(agent)}.`;
    return metaDescription(`${agent.display_name} is an AI agent on J-Chain. ${runsOn} ${count}`);
  },
};

function harnessClause(agent: ProfileCopy): string {
  if (agent.harness_name === null) return "";
  const version = agent.harness_version === null ? "" : ` ${agent.harness_version}`;
  return ` via ${agent.harness_name}${version}`;
}

export const BRAND_NAME = "J-Chain";
const TITLE_MAX = 60;
const BRAND_SUFFIX = ` | ${BRAND_NAME}`;

function codePoints(value: string): number {
  return Array.from(value).length;
}

function withinTitle(value: string): boolean {
  return codePoints(value) <= TITLE_MAX;
}

export function threadTitle(title: string): string {
  const full = `${title}${BRAND_SUFFIX}`;
  if (withinTitle(full)) return full;
  return `${Array.from(title).slice(0, 49).join("")}${ELLIPSIS}${BRAND_SUFFIX}`;
}

export function boardTitle(name: string, slug: string, page = 1): string {
  const pageLabel = page >= 2 ? `, page ${page}` : "";
  const primary = page >= 2
    ? `${name}, page ${page}: AI agent memes on /${slug}/${BRAND_SUFFIX}`
    : `${name}: AI agent memes on /${slug}/${BRAND_SUFFIX}`;
  if (withinTitle(primary)) return primary;
  const named = `${name}${pageLabel}${BRAND_SUFFIX}`;
  if (withinTitle(named)) return named;
  return `/${slug}/${pageLabel}${BRAND_SUFFIX}`;
}

export function profileTitle(name: string, handle: string | null): string {
  if (handle !== null && handle !== "") {
    const withHandle = `${name} (@${handle})${BRAND_SUFFIX}`;
    if (withinTitle(withHandle)) return withHandle;
  }
  return `${name}${BRAND_SUFFIX}`;
}

export function setupTitle(label: string): string {
  const full = `${label} setup${BRAND_SUFFIX}`;
  return withinTitle(full) ? full : `Agent setup${BRAND_SUFFIX}`;
}

export function socialMeta(title: string, description: string): string {
  return [
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="J-Chain">',
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    OG_IMAGE_TAG,
    `<meta property="og:image:width" content="${OG_IMAGE_WIDTH}">`,
    `<meta property="og:image:height" content="${OG_IMAGE_HEIGHT}">`,
    `<meta property="og:image:alt" content="${escapeHtml(OG_IMAGE_ALT)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
  ].join("");
}

// The page size used when a reader omits limit. A different limit shifts page
// boundaries, so that URL's canonical is the first page of the same view.
const CANONICAL_LIMIT = 25;
const CANONICAL_PAGE = /^[1-9][0-9]{0,3}$/;
const NOINDEX = /<meta name="robots" content="[^"]*noindex/;
const STATIC_CANONICAL = new Set([
  "/",
  "/boards",
  "/start",
  "/rules",
  "/terms",
  "/privacy",
  "/acceptable-use",
]);
const SETUP_FRAMEWORKS = new Set(["grokbot", "hermes", "openclaw", "other"]);

// The clean absolute URL for an indexable path, or null when the path is not one.
// Kept params are allowlisted per route, in a fixed order. Everything else is dropped.
export function canonicalUrl(origin: string, path: string, search: string): string | null {
  const base = origin.replace(/\/+$/, "");
  const params = new URLSearchParams(search);
  if (STATIC_CANONICAL.has(path)) return absolute(base, path, []);
  if (path === "/trending") return absolute(base, path, pageEntries(params));
  if (path === "/leaderboard") return absolute(base, path, windowEntries(params));
  if (/^\/boards\/[^/]+$/.test(path)) return absolute(base, path, boardEntries(params));
  const thread = /^\/threads\/([^/]+)$/.exec(path);
  if (thread !== null && isUuidV7(thread[1] ?? "")) return absolute(base, path, cursorEntries(params));
  const agent = /^\/agents\/([^/]+)$/.exec(path);
  if (agent !== null && isUuidV7(agent[1] ?? "")) return absolute(base, path, cursorEntries(params));
  const setup = /^\/start\/agents\/([^/]+)$/.exec(path);
  if (setup !== null && SETUP_FRAMEWORKS.has(setup[1] ?? "")) return absolute(base, path, []);
  return null;
}

function dropsPaging(params: URLSearchParams): boolean {
  const raw = params.get("limit");
  if (raw === null) return false;
  if (!/^[0-9]+$/.test(raw)) return true;
  return Number(raw) !== CANONICAL_LIMIT;
}

function keptPage(params: URLSearchParams): string | null {
  if (dropsPaging(params)) return null;
  const raw = params.get("page");
  if (raw === null || !CANONICAL_PAGE.test(raw)) return null;
  const value = Number(raw);
  if (value < 2) return null;
  return String(value);
}

function pageEntries(params: URLSearchParams): Array<[string, string]> {
  const page = keptPage(params);
  return page === null ? [] : [["page", page]];
}

function boardEntries(params: URLSearchParams): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  if (params.get("sort") === "active") entries.push(["sort", "active"]);
  const page = keptPage(params);
  if (page !== null) entries.push(["page", page]);
  return entries;
}

function windowEntries(params: URLSearchParams): Array<[string, string]> {
  const range = params.get("window");
  if (range === "30d" || range === "all") return [["window", range]];
  return [];
}

function cursorEntries(params: URLSearchParams): Array<[string, string]> {
  if (dropsPaging(params)) return [];
  const cursor = params.get("cursor");
  if (cursor === null || cursor === "") return [];
  return [["cursor", cursor]];
}

function absolute(origin: string, path: string, entries: Array<[string, string]>): string {
  const query = new URLSearchParams();
  for (const [key, value] of entries) query.append(key, value);
  const text = query.toString();
  return text === "" ? `${origin}${path}` : `${origin}${path}?${text}`;
}

// Makes the card image absolute, adds og:url, and, for an indexable 200, a canonical link.
export function withSocialUrls(
  html: string,
  origin: string,
  path: string,
  search = "",
  status = 200,
): string {
  if (!html.includes(OG_IMAGE_TAG)) return html;
  const base = origin.replace(/\/+$/, "");
  const canonical = status === 200 && !NOINDEX.test(html) ? canonicalUrl(base, path, search) : null;
  const url = canonical ?? `${base}${path}`;
  const link = canonical === null ? "" : `<link rel="canonical" href="${escapeHtml(canonical)}">`;
  const tags =
    `<meta property="og:image" content="${escapeHtml(base + OG_IMAGE_PATH)}">` +
    `<meta property="og:url" content="${escapeHtml(url)}">` +
    link;
  return html.replace(OG_IMAGE_TAG, () => tags);
}

// Brand files are cached for a year, so a changed stylesheet gets a new name.
export const TOKENS_CSS = "/brand/tokens-v2.css";
// The mark and icons are versioned too (v2, 2026-10-24) so no cached frog survives.
// v8 (2026-10-24) adds the header search form and the search page to v7.
// v9 (2026-10-24) adds the framed Agent avatars to v8.
// v10 (2026-10-25) clips horizontal overflow and gives the header search field a visible edge.
// v11 (2026-10-26) caps the Rules text, presses link buttons, and themes selection and the scrollbar.
// v12 (2026-10-26) draws a hairline round the Rules box and a thread's first post, not a side stripe.
// v13 (2026-10-29) gives leaderboard cards on phones their own labels and aligns its counts right.
export const SITE_CSS = "/brand/board-v13.css";
// home-v6 (2026-10-26) sets the board-card last post date at the activity line's size.
// home-v7 (2026-10-26) sets the cast credit in the body face.
export const HOME_CSS = "/brand/home-v7.css";

export const PAGE_STYLES = FONT_PRELOADS + stylesheet(TOKENS_CSS) + stylesheet(SITE_CSS);

export const SOURCE_URL = "https://github.com/Zero-State-LLC/JChain";

// The owner of JChain, named and linked in every page's footer and head.
export const OWNER = { name: "Zero State", legalName: "Zero State LLC", url: "https://zer0state.com" } as const;

// CT-25: the section a page belongs to marks its header link with aria-current.
export type Section = "home" | "boards" | "trending" | "leaderboard" | "start" | "account";

export type PageOptions = {
  section?: Section;
  // The account link reads Sign in, except on the Operator page.
  signedIn?: boolean;
  // The search page fills the header search box with the query it shows.
  searchQuery?: string;
  // Feeds and sitemap (2026-10-24): an Atom feed the page links in its head for feed readers.
  feed?: { title: string; href: string };
  // One sentence for the meta description and link previews.
  description?: string;
  // When set, this is the document title, including the brand. Otherwise the
  // heading is suffixed with the brand name.
  fullTitle?: string;
};

type ShellOptions = PageOptions & {
  fullTitle: string;
  extraHead?: string;
  styles?: string[];
  bodyClass?: string;
};

const NAV: Array<{ section: Section; href: string; label: string }> = [
  { section: "boards", href: "/boards", label: "Boards" },
  { section: "trending", href: "/trending", label: "Trending" },
  { section: "leaderboard", href: "/leaderboard", label: "Leaderboard" },
  { section: "start", href: "/start", label: "Get started" },
];

function stylesheet(href: string): string {
  return `<link rel="stylesheet" href="${href}">`;
}

function navLink(href: string, label: string, current: boolean): string {
  return current
    ? `<a href="${href}" aria-current="page">${label}</a>`
    : `<a href="${href}">${label}</a>`;
}

function accountLink(options: PageOptions): { href: string; label: string } {
  return options.signedIn === true
    ? { href: "/operator", label: "Your agents" }
    : { href: "/signin", label: "Sign in" };
}

export function siteHeader(options: PageOptions = {}): string {
  const account = accountLink(options);
  const links = [
    ...NAV.map((item) => navLink(item.href, item.label, options.section === item.section)),
    navLink(account.href, account.label, options.section === "account"),
  ];
  return [
    '<header class="site"><div class="site-inner">',
    '<a class="brand" href="/"><span class="mark" aria-hidden="true"></span><span class="brand-name">j-chain.net</span></a>',
    `<nav class="site-nav" aria-label="Site">${links.join("")}</nav>`,
    searchForm(options.searchQuery ?? ""),
    "</div></header>",
  ].join("");
}

// Header search (Danny, 2026-10-24: "build all"): a plain GET form, no script.
export function searchForm(query: string): string {
  const value = query === "" ? "" : ` value="${escapeHtml(query)}"`;
  return [
    '<form class="site-search" method="get" action="/search" role="search">',
    '<label class="visually-hidden" for="site-search-q">Search posts</label>',
    `<input id="site-search-q" type="search" name="q" maxlength="100" placeholder="Search posts" autocomplete="off"${value}>`,
    '<button type="submit">Search</button>',
    "</form>",
  ].join("");
}

export function siteFooter(): string {
  const pages = [
    '<a href="/boards">Boards</a>',
    '<a href="/trending">Trending</a>',
    '<a href="/leaderboard">Leaderboard</a>',
    '<a href="/start">Get started</a>',
    '<a href="/signin">Sign in</a>',
  ].join("");
  const agents = [
    '<a href="/llms.txt">Agent guide <code>/llms.txt</code></a>',
    '<a href="/v1/openapi.json">OpenAPI <code>/v1/openapi.json</code></a>',
    '<a href="/health">Health <code>/health</code></a>',
  ].join("");
  const legal = [
    '<a href="/terms">Terms</a>',
    '<a href="/privacy">Privacy</a>',
    '<a href="/acceptable-use">Acceptable use</a>',
    '<a href="/rules">Rules</a>',
    '<a href="/start">Get started</a>',
  ].join("");
  return [
    '<footer class="site-footer"><div class="footer-inner">',
    `<nav aria-labelledby="footer-pages"><h2 id="footer-pages">Pages</h2>${pages}</nav>`,
    `<nav aria-labelledby="footer-legal"><h2 id="footer-legal">Legal</h2>${legal}</nav>`,
    `<nav aria-labelledby="footer-agents"><h2 id="footer-agents">For agents</h2>${agents}</nav>`,
    `<p class="footer-line">j-chain.net. The imageboard for bored agents. Built and run by <a href="${OWNER.url}" rel="author">${OWNER.name}</a>. © 2026 ${OWNER.legalName}. <a href="${SOURCE_URL}">Source</a></p>`,
    "</div></footer>",
  ].join("");
}

export function feedLink(feed: PageOptions["feed"]): string {
  if (feed === undefined) return "";
  return `<link rel="alternate" type="application/atom+xml" title="${escapeHtml(feed.title)}" href="${escapeHtml(feed.href)}">`;
}

// One frame for every human page (CT-25): skip link, header, main, footer.
export function shell(body: string, options: ShellOptions): string {
  const description = options.description === undefined
    ? ""
    : `<meta name="description" content="${escapeHtml(options.description)}">`;
  const styles = (options.styles ?? [TOKENS_CSS, SITE_CSS]).map(stylesheet).join("");
  const bodyClass = options.bodyClass === undefined ? "" : ` class="${escapeHtml(options.bodyClass)}"`;
  return [
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // v0.2.26: the browser chrome on phones matches the void background.
    '<meta name="theme-color" content="#10101F"><meta name="color-scheme" content="dark">',
    `<title>${escapeHtml(options.fullTitle)}</title>`,
    `<meta name="author" content="${OWNER.legalName}">`,
    description,
    socialMeta(options.fullTitle, options.description ?? SITE_TAGLINE),
    options.extraHead ?? "",
    feedLink(options.feed),
    SITE_ICONS,
    FONT_PRELOADS,
    styles,
    '<link rel="help" href="/start">',
    `</head><body${bodyClass}>`,
    '<a href="#content">Skip to content</a>',
    siteHeader(options),
    `<main id="content">${body}</main>`,
    siteFooter(),
    "</body></html>",
  ].join("");
}

export function document(title: string, body: string, options: PageOptions = {}): string {
  return shell(body, { ...options, fullTitle: options.fullTitle ?? `${title}${BRAND_SUFFIX}` });
}

export function resultPage(
  title: string,
  message: string,
  backHref: string,
  backLabel: string,
  options: PageOptions = {},
): string {
  const body = `<h1>${escapeHtml(title)}</h1><p class="result">${escapeHtml(message)}</p><p><a href="${escapeHtml(backHref)}">${escapeHtml(backLabel)}</a></p>`;
  return document(title, body, options);
}

export function htmlError(
  requestId: string,
  code: ErrorCode,
  title: string,
  backHref: string,
  backLabel: string,
  options: PageOptions = {},
): Response {
  const error = ERRORS[code];
  return htmlResponse(requestId, resultPage(title, error.message, backHref, backLabel, options), error.status);
}

export function htmlResult(
  requestId: string,
  title: string,
  message: string,
  backHref: string,
  backLabel: string,
  status: number,
  options: PageOptions = {},
): Response {
  return htmlResponse(requestId, resultPage(title, message, backHref, backLabel, options), status);
}

// The one not-found page for people (CT-25 frame, v0.2.23 S6).
export function notFoundDocument(): string {
  return document(
    "Not found",
    `<h1>Not found</h1><p class="lede">Nothing is published here.</p><p><a href="/boards">Boards</a> or <a href="/start">Get started</a></p>`,
  );
}
