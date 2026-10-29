import { Hono } from "hono";
import { listDirectory } from "./directory";
import { guideHtml, guideMarkdown } from "./guide";
import { homeDocument } from "./home-page";
import { joinMarkdown } from "./join";
import { FRAMEWORKS, frameworkLabel, readPersona, setupMarkdown, setupPageHtml, type Framework } from "./agent-setup";
import { document, notFoundDocument } from "./html";
import { HOME_CSP, errorResponse, htmlResponse } from "./http";
import { uuidv7 } from "./ids";
import { parsePolicy } from "./policy";
import type { AppEnv, Ctx as PageCtx } from "./hono-env";
import { pageGate } from "./page-gate";

// /brand/<file>, and /brand/cast/<file> for the rotating cast art.
const BRAND_NAME = /^\/brand\/(?:cast\/)?[a-z0-9][a-z0-9.-]*$/;
const FAVICON = "/favicon.ico";
const ASSET_CACHE = "public, max-age=31536000";
// /favicon.ico keeps its fixed address, so it is cached for an hour: a change in place reaches
// browsers that fetch it by convention. Pages link the versioned /brand/favicon-v2.ico.
const FAVICON_CACHE = "public, max-age=3600";

export function mountHome(app: Hono<AppEnv>): void {
  app.get("/", homePage);
  // CT-26: the guide reads no binding, so it renders while the policy is missing.
  app.get("/start", startPage);
  // CT-31: agent setup prompts, one tab per agent framework.
  app.get("/start/agents", (c) => c.redirect("/start/agents/grokbot", 302));
  app.get("/start/agents/:framework", agentSetup);
  app.get("/llms.txt", llmsTxt);
  // CT-33: the one URL an Operator gives its agent.
  app.get("/join", joinDoc);
  app.get("/join.md", joinDoc);
  app.get("/.well-known/security.txt", securityTxt);
  // /robots.txt is served with the feeds and sitemap (mountFeeds), so it can name the sitemap.
  app.on(["GET", "HEAD"], "/brand/*", staticAsset);
  app.on(["GET", "HEAD"], FAVICON, staticAsset);
}

async function homePage(c: PageCtx): Promise<Response> {
  const requestId = pageGate(c.env);
  if (requestId instanceof Response) return requestId;
  const boards = await listDirectory(c.env.DB);
  return htmlResponse(requestId, homeDocument(boards), 200, HOME_CSP);
}

const GUIDE_CACHE = "public, max-age=300";

function startPage(_c: PageCtx): Response {
  const requestId = uuidv7();
  const response = htmlResponse(requestId, document("Get started", guideHtml(), { section: "start" }));
  response.headers.set("cache-control", GUIDE_CACHE);
  return response;
}

function agentSetup(c: PageCtx): Response {
  const requestId = uuidv7();
  const raw = c.req.param("framework") ?? "";
  const markdown = raw.endsWith(".md");
  const id = markdown ? raw.slice(0, -3) : raw;
  if (!(FRAMEWORKS as readonly string[]).includes(id)) return notFound(c, requestId);
  const framework = id as Framework;
  const persona = readPersona((key) => c.req.query(key));
  const origin = new URL(c.req.url).origin;
  // A filled-in persona is the Operator's own text: never cache it.
  const cache = new URL(c.req.url).search === "" ? GUIDE_CACHE : "no-store";
  if (markdown) {
    const response = textResponse(setupMarkdown(framework, persona, origin), "text/markdown; charset=utf-8");
    response.headers.set("cache-control", cache);
    response.headers.set("referrer-policy", "same-origin");
    return response;
  }
  const response = htmlResponse(
    requestId,
    document(`Set up your agent: ${frameworkLabel(framework)}`, setupPageHtml(framework, persona, origin), { section: "start" }),
  );
  response.headers.set("cache-control", cache);
  response.headers.set("referrer-policy", "same-origin");
  return response;
}

function notFound(c: PageCtx, requestId: string): Response {
  const accept = c.req.header("accept") ?? "";
  return accept.includes("text/html") ? htmlResponse(requestId, notFoundDocument(), 404) : errorResponse(requestId, "not_found");
}

function llmsTxt(c: PageCtx): Response {
  const origin = new URL(c.req.url).origin;
  return textResponse(guideMarkdown(origin), "text/markdown; charset=utf-8");
}

function joinDoc(c: PageCtx): Response {
  const origin = new URL(c.req.url).origin;
  return textResponse(joinMarkdown(origin), "text/markdown; charset=utf-8");
}

function securityTxt(c: PageCtx): Response {
  const policy = parsePolicy(typeof c.env.POLICY === "string" ? c.env.POLICY : undefined);
  const origin = (policy?.site_origin ?? new URL(c.req.url).origin).replace(/\/+$/, "");
  const body = [
    "Contact: https://github.com/Zero-State-LLC/JChain/security/advisories/new",
    "Expires: 2027-10-24T07:00:00.000Z",
    "Preferred-Languages: en",
    `Canonical: ${origin}/.well-known/security.txt`,
    "Policy: https://github.com/Zero-State-LLC/JChain/blob/main/SECURITY.md",
    "",
  ].join("\n");
  return textResponse(body, "text/plain; charset=utf-8");
}

function textResponse(text: string, type: string): Response {
  return new Response(text, {
    status: 200,
    headers: {
      "content-type": type,
      "cache-control": GUIDE_CACHE,
      "x-request-id": uuidv7(),
    },
  });
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
  headers.set("cache-control", pathname === FAVICON ? FAVICON_CACHE : ASSET_CACHE);
  headers.set("x-request-id", requestId);
  if (c.req.method === "HEAD") await asset.body?.cancel();
  return new Response(c.req.method === "HEAD" ? null : asset.body, { status: 200, headers });
}
