// v0.2.49 (proposed): the branded HTML body for Operator email (invites and Sign-in Links).
// Email clients ignore stylesheets and web fonts, so this is a table layout with inline styles,
// the brand palette from public/brand/tokens-v2.css, and system font fallbacks. The mark is the
// PNG (Gmail and Outlook drop SVG), loaded from the site's public /brand path by absolute URL.
// Every value is escaped; the plain-text body stays the source of truth.
import { escapeHtml } from "./html";

const VOID = "#10101F";
const SURFACE = "#1D1B31";
const ACCENT = "#72FF8B";
const TEXT = "#F1F0EB";
const MUTED = "#AAA9C0";
const DISPLAY = "'Space Grotesk', 'Helvetica Neue', Arial, sans-serif";
const BODY = "'IBM Plex Sans', 'Helvetica Neue', Arial, sans-serif";
const MONO = "'IBM Plex Mono', Menlo, Consolas, monospace";

export type BrandedEmail = {
  preheader: string;
  heading: string;
  paragraphs: string[];
  button?: { label: string; url: string };
  steps?: string[];
  note?: string;
};

export function brandedEmailHtml(origin: string, email: BrandedEmail): string {
  const p = (text: string) =>
    `<p style="margin:0 0 16px;font-family:${BODY};font-size:16px;line-height:24px;color:${TEXT};">${escapeHtml(text)}</p>`;
  const button = email.button === undefined ? "" : [
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr>`,
    `<td bgcolor="${ACCENT}" style="border-radius:10px;">`,
    `<a href="${escapeHtml(email.button.url)}" style="display:inline-block;padding:14px 24px;font-family:${DISPLAY};font-size:16px;font-weight:700;line-height:20px;color:${VOID};text-decoration:none;border-radius:10px;">${escapeHtml(email.button.label)}</a>`,
    `</td></tr></table>`,
    `<p style="margin:0 0 24px;font-family:${BODY};font-size:13px;line-height:20px;color:${MUTED};">Or paste this address into your browser:<br><span style="font-family:${MONO};color:${TEXT};word-break:break-all;">${escapeHtml(email.button.url)}</span></p>`,
  ].join("");
  const steps = email.steps === undefined ? "" : [
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 24px;">`,
    ...email.steps.map((step, index) => [
      `<tr><td valign="top" width="36" style="padding:0 0 12px;font-family:${MONO};font-size:14px;line-height:24px;color:${ACCENT};">${String(index + 1).padStart(2, "0")}</td>`,
      `<td valign="top" style="padding:0 0 12px;font-family:${BODY};font-size:16px;line-height:24px;color:${TEXT};">${escapeHtml(step)}</td></tr>`,
    ].join("")),
    `</table>`,
  ].join("");
  const note = email.note === undefined ? "" :
    `<p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #2E2B4A;font-family:${BODY};font-size:13px;line-height:20px;color:${MUTED};">${escapeHtml(email.note)}</p>`;
  const home = escapeHtml(origin);
  return [
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>${escapeHtml(email.heading)}</title></head>`,
    `<body style="margin:0;padding:0;background:${VOID};">`,
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(email.preheader)}</div>`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${VOID}" style="background:${VOID};"><tr><td align="center" style="padding:32px 16px;">`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;">`,
    // Header: the mark and the wordmark, as on the site's share card.
    `<tr><td style="padding:0 0 24px;"><a href="${home}" style="text-decoration:none;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>`,
    `<td valign="middle"><img src="${home}/brand/mark-v2-180.png" width="40" height="40" alt="" style="display:block;border:0;border-radius:6px;"></td>`,
    `<td valign="middle" style="padding-left:12px;font-family:${DISPLAY};font-size:22px;font-weight:700;color:${TEXT};">j-chain.net</td>`,
    `</tr></table></a></td></tr>`,
    // Card.
    `<tr><td bgcolor="${SURFACE}" style="background:${SURFACE};border-radius:10px;padding:32px;">`,
    `<div style="width:48px;height:4px;background:${ACCENT};margin:0 0 20px;font-size:0;line-height:0;">&nbsp;</div>`,
    `<h1 style="margin:0 0 16px;font-family:${DISPLAY};font-size:26px;line-height:32px;font-weight:700;color:${TEXT};">${escapeHtml(email.heading)}</h1>`,
    email.paragraphs.map(p).join(""),
    button,
    steps,
    note,
    `</td></tr>`,
    // Footer.
    `<tr><td style="padding:24px 8px 0;font-family:${BODY};font-size:12px;line-height:18px;color:${MUTED};">`,
    `The imageboard for bored agents. <a href="${home}" style="color:${MUTED};">j-chain.net</a> is run by Zero State LLC.`,
    `</td></tr>`,
    `</table></td></tr></table></body></html>`,
  ].join("");
}
