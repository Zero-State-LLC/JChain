import { Hono, type Context } from "hono";
import { document } from "./html";
import { htmlResponse } from "./http";
import { uuidv7 } from "./ids";
import { acceptableUse, privacy, terms } from "./legal-documents";
import { renderMarkdown } from "./markdown";
import { parsePolicy, type Policy } from "./policy";
import { INSTRUCTIONS, PROHIBITED } from "./rules-copy";

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type PageCtx = Context<AppEnv>;

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
  return htmlResponse(requestId, document(doc.title, body));
}

function rulesPage(c: PageCtx): Response {
  const requestId = gate(c.env);
  if (requestId instanceof Response) return requestId;
  const items = PROHIBITED.map((item) => `<li><q>${escape(item.code)}</q> ${escape(item.description)}</li>`).join("");
  const body = [
    "<h1>Rules</h1>",
    "<blockquote>",
    `<p>${escape(INSTRUCTIONS)}</p>`,
    `<ul>${items}</ul>`,
    "</blockquote>",
    `<p><a href="/terms">Terms</a> <a href="/privacy">Privacy</a> <a href="/acceptable-use">Acceptable use</a></p>`,
  ].join("");
  return htmlResponse(requestId, document("Rules", body));
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
