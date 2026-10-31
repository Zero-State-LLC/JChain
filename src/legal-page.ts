import { Hono } from "hono";
import { DESCRIPTIONS, document } from "./html";
import { htmlResponse } from "./http";
import { uuidv7 } from "./ids";
import { acceptableUse, privacy, terms } from "./legal-documents";
import { renderMarkdown } from "./markdown";
import { parsePolicy } from "./policy";
import { PROHIBITED, instructionsFor } from "./rules-copy";
import type { AppEnv, Ctx as PageCtx } from "./hono-env";

const DRAFT_BANNER = "Draft - pending counsel review";

const DOCUMENTS = {
  terms: { title: "Terms", markdown: terms },
  privacy: { title: "Privacy", markdown: privacy },
  "acceptable-use": { title: "Acceptable use", markdown: acceptableUse },
} as const;

export type LegalSlug = keyof typeof DOCUMENTS;

export function mountLegal(app: Hono<AppEnv>): void {
  app.get("/terms", (c) => legalPage(c, "terms"));
  app.get("/privacy", (c) => legalPage(c, "privacy"));
  app.get("/acceptable-use", (c) => legalPage(c, "acceptable-use"));
  app.get("/rules", rulesPage);
}

function legalPage(c: PageCtx, slug: LegalSlug): Response {
  const requestId = gate(c.env);
  if (requestId instanceof Response) return requestId;
  const doc = DOCUMENTS[slug];
  const body = [
    `<p class="banner" role="note">${DRAFT_BANNER}</p>`,
    renderMarkdown(doc.markdown),
  ].join("");
  return htmlResponse(requestId, document(legalTitle(slug), body, { description: DESCRIPTIONS.legal(legalTitle(slug)) }));
}

function rulesPage(c: PageCtx): Response {
  const requestId = gate(c.env);
  if (requestId instanceof Response) return requestId;
  const mode = parsePolicy(typeof c.env.POLICY === "string" ? c.env.POLICY : undefined)?.moderation_mode ?? "prepublish";
  const items = PROHIBITED.map((item) => `<li><q>${escape(item.code)}</q> ${escape(item.description)}</li>`).join("");
  const body = [
    "<h1>Rules</h1>",
    "<blockquote>",
    `<p>${escape(instructionsFor(mode))}</p>`,
    `<ul>${items}</ul>`,
    "</blockquote>",
    `<p><a href="/terms">Terms</a> <a href="/privacy">Privacy</a> <a href="/acceptable-use">Acceptable use</a></p>`,
  ].join("");
  return htmlResponse(requestId, document("Rules", body, { description: DESCRIPTIONS.rules() }));
}

function legalTitle(slug: LegalSlug): string {
  switch (slug) {
    case "terms":
      return "Terms of service";
    case "privacy":
      return "Privacy policy";
    case "acceptable-use":
      return "Acceptable use policy";
    default: {
      const neverSlug: never = slug;
      return neverSlug;
    }
  }
}

function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function gate(env: Env): string | Response {
  const requestId = uuidv7();
  const policy = parsePolicy(typeof env.POLICY === "string" ? env.POLICY : undefined);
  if (!policy) return htmlResponse(requestId, document("Unavailable", "<h1>Unavailable</h1><p>Policy is not available.</p>"), 503);
  return requestId;
}
