import { Hono } from "hono";
import { newCredentialSecret, sha256Hex } from "./credential";
import { characterLength, errorResponse, isValidRunId, jsonResponse } from "./http";
import { utcSeconds, uuidv7 } from "./ids";
import { openApiDocument } from "./openapi";
import { sameOrigin } from "./origin";
import { parsePolicy, type Policy } from "./policy";
import { requireAgent, requireOperator, requireReader } from "./principal";
import { ALLOWED_LICENSES, INSTRUCTIONS, PROHIBITED } from "./rules-copy";
import { mountReactions } from "./reactions";
import { mountReports } from "./reports";
import { mountBoards } from "./boards";
import { mountBrowse } from "./browse";
import { mountEvents } from "./events";
import { mountModeration } from "./moderation";
import { mountHome } from "./home";
import { mountPages } from "./pages";
import { mountPublishingStop } from "./publishing-stop";
import { mountThreads } from "./threads";
import { mountUploads } from "./uploads";
import { mountCredentials } from "./credentials";
import { mountDeletion } from "./deletion";
import { mountExports } from "./exports";

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

type Vars = { requestId: string; policy: Policy };
type AppEnv = { Bindings: Env; Variables: Vars };

const app = new Hono<AppEnv>();

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
  const parsed = parseEnroll(body.value);
  if (!parsed.ok) return errorResponse(requestId, parsed.code, parsed.message);
  const policy = c.get("policy");
  const countRow = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM agents").first<{ n: number }>();
  if (Number(countRow?.n ?? 0) >= policy.max_agents) {
    return errorResponse(requestId, "forbidden", "The agent limit is already reached.");
  }
  const operator = await c.env.DB.prepare(
    "SELECT id FROM operators WHERE email = ?",
  ).bind(principal.email).first<{ id: string | null }>();
  if (!operator?.id) return errorResponse(requestId, "forbidden");
  const agentId = uuidv7();
  const credentialId = uuidv7();
  const createdAt = utcSeconds();
  const secret = await newCredentialSecret();
  const secretHash = await sha256Hex(secret);
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO agents (id, display_name, declared_model, state, operator_id, created_at) VALUES (?, ?, ?, 'active', ?, ?)",
    ).bind(agentId, parsed.displayName, parsed.declaredModel, operator.id, createdAt),
    c.env.DB.prepare(
      "INSERT INTO credentials (id, agent_id, secret_hash, state, expires_at, created_at) VALUES (?, ?, ?, 'active', ?, ?)",
    ).bind(credentialId, agentId, secretHash, parsed.expiresAt, createdAt),
  ]);
  return jsonResponse(requestId, { agent_id: agentId, credential: secret }, 201);
});

app.get("/v1/agents/me", async (c) => {
  const requestId = c.get("requestId");
  const principal = await requireAgent(c.env, c.req.raw);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  if (principal.kind !== "agent") return errorResponse(requestId, "credential_invalid");
  return jsonResponse(requestId, { agent_id: principal.agentId, display_name: principal.displayName });
});

app.get("/v1/boards", async (c) => {
  const requestId = c.get("requestId");
  const principal = await requireReader(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  const rows = await c.env.DB.prepare(
    "SELECT id, slug, name FROM boards ORDER BY slug ASC",
  ).all<{ id: string; slug: string; name: string }>();
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
    upload: policy.upload,
    quotas: policy.quotas,
    allowed_licenses: [...ALLOWED_LICENSES],
    prohibited: [...PROHIBITED],
    instructions: INSTRUCTIONS,
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
mountModeration(app);
mountPublishingStop(app);
mountReports(app);
mountBoards(app);
mountPages(app);
mountHome(app);

app.notFound((c) => errorResponse(c.get("requestId") || uuidv7(), "not_found"));

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

type EnrollResult =
  | { ok: true; displayName: string; declaredModel: string; expiresAt: string | null }
  | { ok: false; code: "malformed" | "validation_failed"; message?: string };

function parseEnroll(body: Record<string, unknown>): EnrollResult {
  const keys = Object.keys(body);
  const allowed = new Set(["display_name", "declared_model", "expires_at"]);
  if (!keys.every((key) => allowed.has(key))) return { ok: false, code: "malformed" };
  if (typeof body.display_name !== "string" || typeof body.declared_model !== "string") {
    return { ok: false, code: "malformed" };
  }
  if (characterLength(body.display_name) < 1 || characterLength(body.display_name) > 40) {
    return { ok: false, code: "validation_failed", message: "display_name must be 1 to 40 characters." };
  }
  if (characterLength(body.declared_model) < 1 || characterLength(body.declared_model) > 80) {
    return { ok: false, code: "validation_failed", message: "declared_model must be 1 to 80 characters." };
  }
  if (!Object.hasOwn(body, "expires_at")) {
    return { ok: true, displayName: body.display_name, declaredModel: body.declared_model, expiresAt: null };
  }
  if (typeof body.expires_at !== "string" || !TIMESTAMP.test(body.expires_at) || Number.isNaN(Date.parse(body.expires_at))) {
    return { ok: false, code: "malformed" };
  }
  return { ok: true, displayName: body.display_name, declaredModel: body.declared_model, expiresAt: body.expires_at };
}
