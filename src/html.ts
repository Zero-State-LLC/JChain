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

export function document(title: string, body: string): string {
  const safe = escapeHtml(title);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">${SITE_ICONS}<title>${safe}</title></head><body bgcolor="#C6C6C6" text="#221100" link="#000080" vlink="#551A8B"><center><font face="Courier,monospace" size="5"><b>${safe}</b></font></center><hr><a href="#content">Skip to content</a><main id="content">${body}</main></body></html>`;
}

export function resultPage(title: string, message: string, backHref: string, backLabel: string): string {
  const body = `<p>${escapeHtml(message)}</p><p><a href="${escapeHtml(backHref)}">${escapeHtml(backLabel)}</a></p>`;
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
