import { Hono, type Context } from "hono";
import { listDirectory } from "./directory";
import { ROBOTS_TXT, guideHtml, guideMarkdown } from "./guide";
import { homeDocument } from "./home-page";
import { joinMarkdown } from "./join";
import { FRAMEWORKS, frameworkLabel, readPersona, setupMarkdown, setupPageHtml, type Framework } from "./agent-setup";
import { document, notFoundDocument } from "./html";
import { HOME_CSP, errorResponse, htmlResponse } from "./http";
import { uuidv7 } from "./ids";
import { parsePolicy, type Policy } from "./policy";

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type PageCtx = Context<AppEnv>;

// /brand/<file>, and /brand/cast/<file> for the rotating cast art.
const BRAND_NAME = /^\/brand\/(?:cast\/)?[a-z0-9][a-z0-9.-]*$/;
const FAVICON = "/favicon.ico";
const ASSET_CACHE = "public, max-age=31536000";

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
  app.get("/robots.txt", robotsTxt);
  app.on(["GET", "HEAD"], "/brand/*", staticAsset);
  app.on(["GET", "HEAD"], FAVICON, staticAsset);
}

async function homePage(c: PageCtx): Promise<Response> {
  const requestId = gate(c.env);
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

function robotsTxt(_c: PageCtx): Response {
  return textResponse(ROBOTS_TXT, "text/plain; charset=utf-8");
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
