import { DurableObject } from "cloudflare:workers";
import { Hono, type Context } from "hono";
import { errorResponse, jsonResponse } from "./http";
import { utcSeconds, uuidv7 } from "./ids";
import { sameOrigin } from "./origin";
import type { Policy } from "./policy";
import { requireModerator } from "./principal";

const KEY = "engaged";

export class PublishingStop extends DurableObject<Env> {
  async read(): Promise<boolean> {
    return (await this.ctx.storage.get<boolean>(KEY)) === true;
  }

  async set(engaged: boolean): Promise<void> {
    await this.ctx.storage.put(KEY, engaged);
  }

  async clear(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

export async function publishingStopEngaged(env: Env): Promise<boolean> {
  return env.PUBLISHING_STOP.getByName("global").read();
}

export async function clearPublishingStop(env: Env): Promise<void> {
  await env.PUBLISHING_STOP.getByName("global").clear();
}

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type Ctx = Context<AppEnv>;

export function mountPublishingStop(app: Hono<AppEnv>): void {
  app.post("/v1/admin/publishing-stop", setPublishingStop);
}

async function setPublishingStop(c: Ctx): Promise<Response> {
  const requestId = c.get("requestId");
  const principal = await requireModerator(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  if (principal.kind !== "moderator") return errorResponse(requestId, "forbidden");
  if (!sameOrigin(c.req.raw, c.get("policy").site_origin)) return errorResponse(requestId, "forbidden");
  const parsed = await readEngaged(c.req.raw);
  if (!parsed.ok) return errorResponse(requestId, "malformed");
  await c.env.PUBLISHING_STOP.getByName("global").set(parsed.engaged);
  const action = parsed.engaged ? "engage" : "lift";
  await c.env.DB.prepare(
    `INSERT INTO moderation_actions (
       id, actor_email, target_type, target_id, action, reason_code, private_note, event_id, created_at
     ) VALUES (?, ?, 'publishing_stop', 'global', ?, 'rules', NULL, NULL, ?)`,
  ).bind(uuidv7(), principal.email, action, utcSeconds()).run();
  console.log(JSON.stringify({
    message: parsed.engaged ? "publishing stop engaged" : "publishing stop lifted",
    engaged: parsed.engaged,
  }));
  return jsonResponse(requestId, { engaged: parsed.engaged });
}

async function readEngaged(request: Request): Promise<{ ok: true; engaged: boolean } | { ok: false }> {
  const type = request.headers.get("content-type");
  if (type === null) return { ok: false };
  const lower = type.toLowerCase();
  if (lower.startsWith("application/json")) {
    const body = await readObject(request);
    if (!body.ok) return { ok: false };
    return parseEngaged(body.value, false);
  }
  if (lower.startsWith("application/x-www-form-urlencoded")) {
    const body = await readForm(request);
    if (!body.ok) return { ok: false };
    return parseEngaged(body.value, true);
  }
  return { ok: false };
}

function parseEngaged(
  value: Record<string, unknown>,
  form: boolean,
): { ok: true; engaged: boolean } | { ok: false } {
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "engaged") return { ok: false };
  const engaged = value.engaged;
  if (!form && typeof engaged === "boolean") return { ok: true, engaged };
  if (form && engaged === "true") return { ok: true, engaged: true };
  if (form && engaged === "false") return { ok: true, engaged: false };
  return { ok: false };
}

async function readObject(request: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false };
  return { ok: true, value: parsed as Record<string, unknown> };
}

async function readForm(request: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
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
