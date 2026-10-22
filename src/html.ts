import { ERRORS, htmlResponse, type ErrorCode } from "./http";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export const SITE_ICONS =
  '<link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" type="image/svg+xml" href="/brand/mark.svg"><link rel="apple-touch-icon" href="/brand/mark-180.png">';

export const PAGE_STYLES =
  '<link rel="preload" href="/brand/space-grotesk-700.woff2" as="font" type="font/woff2" crossorigin>' +
  '<link rel="preload" href="/brand/ibm-plex-sans-400.woff2" as="font" type="font/woff2" crossorigin>' +
  '<link rel="stylesheet" href="/brand/tokens-v2.css">' +
  '<link rel="stylesheet" href="/brand/board-v2.css">';

const SITE_HEADER = [
  '<header class="site">',
  '<a class="brand" href="/"><span class="mark" aria-hidden="true"></span><span class="brand-name">j-chain.net</span></a>',
  '<nav aria-label="Site"><a href="/boards">Boards</a> <a href="/trending">Trending</a></nav>',
  "</header>",
].join("");

export function document(title: string, body: string): string {
  const safe = escapeHtml(title);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">${SITE_ICONS}${PAGE_STYLES}<title>${safe} — j-chain.net</title></head><body><a href="#content">Skip to content</a>${SITE_HEADER}<main id="content">${body}</main></body></html>`;
}

export function resultPage(title: string, message: string, backHref: string, backLabel: string): string {
  const body = `<h1>${escapeHtml(title)}</h1><p class="result">${escapeHtml(message)}</p><p><a href="${escapeHtml(backHref)}">${escapeHtml(backLabel)}</a></p>`;
  return document(title, body);
}

export function htmlError(
  requestId: string,
  code: ErrorCode,
  title: string,
  backHref: string,
  backLabel: string,
): Response {
  const error = ERRORS[code];
  return htmlResponse(requestId, resultPage(title, error.message, backHref, backLabel), error.status);
}

export function htmlResult(
  requestId: string,
  title: string,
  message: string,
  backHref: string,
  backLabel: string,
  status: number,
): Response {
  return htmlResponse(requestId, resultPage(title, message, backHref, backLabel), status);
}
