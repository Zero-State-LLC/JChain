import { Hono, type Context } from "hono";
import { htmlError, htmlResult } from "./html";
import { characterLength, errorResponse, jsonResponse, type ErrorCode } from "./http";
import { uuidv7 } from "./ids";
import { sameOrigin } from "./origin";
import { parsePolicy, type Policy } from "./policy";
import { requireOperator } from "./principal";

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type Ctx = Context<AppEnv>;

const SLUG = /^[a-z][a-z0-9]{0,19}$/;
const DUPLICATE = "A board with this slug already exists.";

type Parsed =
  | { ok: true; slug: string; name: string }
  | { ok: false; code: "malformed" | "validation_failed"; message?: string };

type ReadResult = { ok: true; value: Record<string, unknown> } | { ok: false };

export function mountBoards(app: Hono<AppEnv>): void {
  app.post("/v1/boards", createJson);
  app.post("/boards", createHtml);
}

async function createJson(c: Ctx): Promise<Response> {
  const requestId = c.get("requestId");
  const principal = await requireOperator(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  if (principal.kind !== "operator") return errorResponse(requestId, "forbidden");
  if (!sameOrigin(c.req.raw, c.get("policy").site_origin)) return errorResponse(requestId, "forbidden");
  const body = await readObject(c.req.raw);
  if (!body.ok) return errorResponse(requestId, "malformed");
  const parsed = parseBoardCreate(body.value);
  if (!parsed.ok) return errorResponse(requestId, parsed.code, parsed.message);
  const created = await insertBoard(c.env.DB, parsed.slug, parsed.name);
  if (!created.ok) return errorResponse(requestId, "state_conflict", DUPLICATE);
  return jsonResponse(requestId, { id: created.id, slug: created.slug, name: created.name }, 201);
}

async function createHtml(c: Ctx): Promise<Response> {
  const requestId = uuidv7();
  const policy = parsePolicy(typeof c.env.POLICY === "string" ? c.env.POLICY : undefined);
  if (!policy) return htmlError(requestId, "policy_missing", "Boards", "/boards", "Boards");
  const principal = await requireOperator(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok || principal.kind !== "operator") {
    const code: ErrorCode = principal.ok ? "forbidden" : principal.code;
    return htmlError(requestId, code, "Boards", "/boards", "Boards");
  }
  if (!sameOrigin(c.req.raw, policy.site_origin)) {
    return htmlError(requestId, "forbidden", "Boards", "/boards", "Boards");
  }
  const body = await readForm(c.req.raw);
  if (!body.ok) return htmlError(requestId, "malformed", "Boards", "/boards", "Boards");
  const parsed = parseBoardCreate(body.value);
  if (!parsed.ok) return htmlError(requestId, parsed.code, "Boards", "/boards", "Boards");
  const created = await insertBoard(c.env.DB, parsed.slug, parsed.name);
  if (!created.ok) return htmlResult(requestId, "Boards", DUPLICATE, "/boards", "Boards", 409);
  return htmlResult(requestId, "Board added", `${created.name} is open.`, `/boards/${created.slug}`, `/${created.slug}/`, 201);
}

function parseBoardCreate(body: Record<string, unknown>): Parsed {
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes("slug") || !keys.includes("name")) {
    return { ok: false, code: "malformed" };
  }
  if (typeof body.slug !== "string" || typeof body.name !== "string") {
    return { ok: false, code: "malformed" };
  }
  if (!SLUG.test(body.slug)) {
    return {
      ok: false,
      code: "validation_failed",
      message: "slug must be 1 to 20 lowercase letters and digits, starting with a letter.",
    };
  }
  const name = body.name.trim();
  if (characterLength(name) < 1 || characterLength(name) > 60 || hasControl(name)) {
    return { ok: false, code: "validation_failed", message: "name must be 1 to 60 characters." };
  }
  return { ok: true, slug: body.slug, name };
}

function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 0x20) return true;
  }
  return false;
}

async function insertBoard(
  db: D1Database,
  slug: string,
  name: string,
): Promise<{ ok: true; id: string; slug: string; name: string } | { ok: false; code: "state_conflict" }> {
  const id = uuidv7();
  try {
    await db.prepare("INSERT INTO boards (id, slug, name) VALUES (?, ?, ?)").bind(id, slug, name).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE")) return { ok: false, code: "state_conflict" };
    throw error;
  }
  return { ok: true, id, slug, name };
}

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

async function readForm(request: Request): Promise<ReadResult> {
  const type = request.headers.get("content-type");
  if (type === null || !type.toLowerCase().startsWith("application/x-www-form-urlencoded")) return { ok: false };
  let text: string;
  try {
    text = new TextDecoder().decode(await request.arrayBuffer());
  } catch {
    return { ok: false };
  }
  const params = new URLSearchParams(text);
  const value: Record<string, unknown> = {};
  for (const [key, item] of params.entries()) {
    if (Object.hasOwn(value, key)) return { ok: false };
    value[key] = item;
  }
  return { ok: true, value };
}
