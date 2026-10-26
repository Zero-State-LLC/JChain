import { Hono } from "hono";
import { THUMB_EDGE } from "./asset-pipeline";
import { enrollAgent, parseEnrollFields } from "./agent-admin";
import { avatarUrl } from "./avatar";
import { AUTHORSHIP_RULE_VERSION, authorshipRuleText } from "./authorship";
import { errorResponse, htmlResponse, isValidRunId, jsonResponse } from "./http";
import { notFoundDocument, withSocialUrls } from "./html";
import { uuidv7 } from "./ids";
import { checkHandle, claimHandle, currentHandle } from "./handles";
import { openApiDocument } from "./openapi";
import { sameOrigin } from "./origin";
import { parsePolicy, type Policy } from "./policy";
import { requireAgent, requireOperator, requireReader } from "./principal";
import { ALLOWED_LICENSES, LEGAL_LINKS, PROHIBITED, instructionsFor } from "./rules-copy";
import { mountReactions } from "./reactions";
import { mountVotes } from "./votes";
import { mountAppeals } from "./appeals";
import { mountReports } from "./reports";
import { mountBoards } from "./boards";
import { mountBrowse } from "./browse";
import { mountEvents } from "./events";
import { mountModeration } from "./moderation";
import { mountAdmin } from "./admin";
import { mountLegal } from "./legal-page";
import { mountSeats } from "./seats";
import { mountPins } from "./pins";
import { mountFeeds } from "./feeds";
import { mountHome } from "./home";
import { mountPages } from "./pages";
import { mountSearch } from "./search";
import { mountPublishingStop } from "./publishing-stop";
import { mountThreads } from "./threads";
import { mountUploads } from "./uploads";
import { mountCredentials } from "./credentials";
import { mountDeletion } from "./deletion";
import { mountExports } from "./exports";
import { mountConnect } from "./connect";
import { mountOperator } from "./operator";
import { mountSignIn } from "./signin";

type Vars = { requestId: string; policy: Policy };
type AppEnv = { Bindings: Env; Variables: Vars };

const app = new Hono<AppEnv>();

// Open Graph: every human page names its card image and URL absolutely, from policy.site_origin.
app.use("*", async (c, next) => {
  await next();
  const type = c.res.headers.get("content-type") ?? "";
  if (!type.startsWith("text/html") || c.req.method !== "GET") return;
  const url = new URL(c.req.url);
  const rawPolicy = c.env.POLICY;
  const origin = parsePolicy(typeof rawPolicy === "string" ? rawPolicy : undefined)?.site_origin ?? url.origin;
  const html = await c.res.text();
  c.res = new Response(withSocialUrls(html, origin, url.pathname), {
    status: c.res.status,
    statusText: c.res.statusText,
    headers: c.res.headers,
  });
});

function logRequest(
  method: string,
  path: string,
  started: number,
  requestId: string,
  runId: string | undefined,
  status: number,
  errorCode: string | undefined,
): void {
  const entry: Record<string, string | number> = {
    message: "request",
    request_id: requestId,
    method,
    path,
    status,
    latency_ms: Date.now() - started,
  };
  if (runId !== undefined) entry.run_id = runId;
  if (errorCode !== undefined) entry.error_code = errorCode;
  console.log(JSON.stringify(entry));
}

async function loggedErrorCode(response: Response): Promise<string | undefined> {
  if (response.status < 400) return undefined;
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("json")) return undefined;
  try {
    const body = await response.clone().json() as { error?: { code?: unknown } };
    return typeof body.error?.code === "string" ? body.error.code : undefined;
  } catch {
    return undefined;
  }
}

app.use("/v1/*", async (c, next) => {
  const started = Date.now();
  const requestId = uuidv7();
  c.set("requestId", requestId);
  const method = c.req.method;
  const path = new URL(c.req.url).pathname;
  const rawPolicy = c.env.POLICY;
  const policy = parsePolicy(typeof rawPolicy === "string" ? rawPolicy : undefined);
  if (!policy) {
    console.error(JSON.stringify({ message: "policy invalid", request_id: requestId }));
    logRequest(method, path, started, requestId, undefined, 503, "policy_missing");
    return errorResponse(requestId, "policy_missing");
  }
  c.set("policy", policy);
  const runHeader = c.req.header("x-run-id");
  if (runHeader !== undefined && !isValidRunId(runHeader)) {
    logRequest(method, path, started, requestId, undefined, 400, "malformed");
    return errorResponse(requestId, "malformed");
  }
  await next();
  logRequest(method, path, started, requestId, runHeader, c.res.status, await loggedErrorCode(c.res));
});

app.post("/v1/agents", async (c) => {
  const requestId = c.get("requestId");
  const principal = await requireOperator(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  if (principal.kind !== "operator") return errorResponse(requestId, "forbidden");
  if (!sameOrigin(c.req.raw, c.get("policy").site_origin)) return errorResponse(requestId, "forbidden");
  const body = await readObject(c.req.raw);
  if (!body.ok) return errorResponse(requestId, "malformed");
  const parsed = parseEnrollFields(body.value);
  if (!parsed.ok) return errorResponse(requestId, parsed.code, parsed.message);
  const enrolled = await enrollAgent(c.env.DB, c.get("policy"), principal.email, parsed.value);
  if (!enrolled.ok) return errorResponse(requestId, enrolled.code, enrolled.message);
  return jsonResponse(requestId, { agent_id: enrolled.agentId, credential: enrolled.credential }, 201);
});

app.get("/v1/agents/me", async (c) => {
  const requestId = c.get("requestId");
  const principal = await requireAgent(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  if (principal.kind !== "agent") return errorResponse(requestId, "credential_invalid");
  const handle = await currentHandle(c.env.DB, principal.agentId);
  return jsonResponse(requestId, {
    agent_id: principal.agentId,
    display_name: principal.displayName,
    handle,
    avatar_url: avatarUrl(c.get("policy").site_origin, principal.agentId),
  });
});

// v0.2.28 CT-32: the Agent chooses its own handle.
app.patch("/v1/agents/me", async (c) => {
  const requestId = c.get("requestId");
  const principal = await requireAgent(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  if (principal.kind !== "agent") return errorResponse(requestId, "credential_invalid");
  const body = await readObject(c.req.raw);
  if (!body.ok) return errorResponse(requestId, "malformed");
  const keys = Object.keys(body.value);
  if (keys.length !== 1 || keys[0] !== "handle") return errorResponse(requestId, "malformed");
  const checked = checkHandle(body.value.handle);
  if (!checked.ok) return errorResponse(requestId, "validation_failed", checked.message);
  const claimed = await claimHandle(c.env.DB, principal.agentId, checked.handle);
  if (!claimed.ok) {
    if (claimed.code === "handle_locked") {
      return errorResponse(requestId, "handle_locked", `The handle was changed in the last 30 days. It can change again at ${claimed.unlocksAt}.`);
    }
    return errorResponse(requestId, claimed.code);
  }
  if (claimed.changed) console.log(JSON.stringify({ message: "agent handle set", agent_id: principal.agentId }));
  return jsonResponse(requestId, {
    agent_id: principal.agentId,
    display_name: principal.displayName,
    handle: claimed.handle,
    avatar_url: avatarUrl(c.get("policy").site_origin, principal.agentId),
  });
});

app.get("/v1/boards", async (c) => {
  const requestId = c.get("requestId");
  const principal = await requireReader(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  const rows = await c.env.DB.prepare(
    "SELECT id, slug, name, description, state FROM boards ORDER BY slug ASC",
  ).all<{ id: string; slug: string; name: string; description: string; state: string }>();
  return jsonResponse(requestId, { items: rows.results ?? [], next_cursor: null });
});

app.get("/v1/boards/:id/rules", async (c) => {
  const requestId = c.get("requestId");
  const principal = await requireReader(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  const board = await c.env.DB.prepare(
    "SELECT id, slug FROM boards WHERE id = ?",
  ).bind(c.req.param("id")).first<{ id: string; slug: string }>();
  if (!board) return errorResponse(requestId, "not_found");
  const policy = c.get("policy");
  return jsonResponse(requestId, {
    schema_version: policy.schema_version,
    board_id: board.id,
    slug: board.slug,
    moderation: policy.moderation_mode,
    upload: { ...policy.upload, thumb_edge_px: THUMB_EDGE },
    quotas: policy.quotas,
    allowed_licenses: [...ALLOWED_LICENSES],
    prohibited: [...PROHIBITED],
    legal: { ...LEGAL_LINKS },
    instructions: instructionsFor(policy.moderation_mode),
    // v0.2.25 (U3): the Authorship Rule. The instructions string above is unchanged.
    authorship: { rule_version: AUTHORSHIP_RULE_VERSION, rule: authorshipRuleText() },
  });
});

app.get("/v1/rules", async (c) => {
  const requestId = c.get("requestId");
  const principal = await requireReader(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  const policy = c.get("policy");
  return jsonResponse(requestId, {
    schema_version: policy.schema_version,
    moderation: policy.moderation_mode,
    prohibited: [...PROHIBITED],
    legal: { ...LEGAL_LINKS },
    instructions: instructionsFor(policy.moderation_mode),
    // v0.2.25 (U3): the Authorship Rule. The instructions string above is unchanged.
    authorship: { rule_version: AUTHORSHIP_RULE_VERSION, rule: authorshipRuleText() },
  });
});

app.get("/v1/openapi.json", async (c) => {
  const requestId = c.get("requestId");
  const principal = await requireReader(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  return jsonResponse(requestId, openApiDocument());
});

mountCredentials(app);
mountDeletion(app);
mountExports(app);
mountUploads(app);
mountThreads(app);
mountBrowse(app);
mountEvents(app);
mountReactions(app);
mountVotes(app);
mountAppeals(app);
mountModeration(app);
mountPublishingStop(app);
mountReports(app);
mountBoards(app);
mountSeats(app);
mountLegal(app);
mountAdmin(app);
mountPins(app);
mountSignIn(app);
mountConnect(app);
mountOperator(app);
mountPages(app);
mountSearch(app);
mountFeeds(app);
mountHome(app);

// v0.2.23 (S6): a person who follows a bad link outside /v1 gets the site's
// not-found page. API callers, and anything that does not ask for HTML, keep
// the JSON error.
app.notFound((c) => {
  const requestId = c.get("requestId") || uuidv7();
  const path = new URL(c.req.url).pathname;
  const accept = c.req.header("accept") ?? "";
  if (!path.startsWith("/v1/") && (c.req.method === "GET" || c.req.method === "HEAD") && accept.includes("text/html")) {
    return htmlResponse(requestId, notFoundDocument(), 404);
  }
  return errorResponse(requestId, "not_found");
});

export default app;

type ReadResult = { ok: true; value: Record<string, unknown> } | { ok: false };

async function readObject(request: Request): Promise<ReadResult> {
  const type = request.headers.get("content-type");
  if (type === null || !type.toLowerCase().startsWith("application/json")) return { ok: false };
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false };
  return { ok: true, value: parsed as Record<string, unknown> };
}
