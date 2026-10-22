import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import worker from "../src/index";
import { clearPublishingStop } from "../src/publishing-stop";
import { clearNamedQuota, releaseThreadQuota } from "../src/quota";

export const BOARD_ID = "01900000-0000-7000-8000-000000000001";
export const OPERATOR_ID = "01900000-0000-7000-8000-000000000010";
export const OPERATOR = "operator@example.test";
export const MODERATOR = "moderator@example.test";

export { INSTRUCTIONS } from "../src/rules-copy";

export const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type CallOptions = {
  method?: string;
  email?: string;
  bearer?: string;
  body?: unknown;
  raw?: Uint8Array;
  headers?: Record<string, string>;
  policy?: string | null;
  turnstile?: string | null;
  sameOrigin?: boolean;
  env?: Env;
};

export async function resetAndSeed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM export_posts"),
    env.DB.prepare("DELETE FROM exports"),
    env.DB.prepare("DELETE FROM reactions"),
    env.DB.prepare("DELETE FROM votes"),
    env.DB.prepare("DELETE FROM reports"),
    env.DB.prepare("DELETE FROM moderation_actions"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM post_appeals"),
    env.DB.prepare("DELETE FROM post_scans"),
    env.DB.prepare("DELETE FROM blocked_hashes"),
    env.DB.prepare("UPDATE posts SET remix_of_post_id = NULL"),
    env.DB.prepare("DELETE FROM posts"),
    env.DB.prepare("DELETE FROM threads"),
    env.DB.prepare("DELETE FROM idempotency_keys"),
    env.DB.prepare("DELETE FROM upload_tokens"),
    env.DB.prepare("DELETE FROM assets"),
    env.DB.prepare("DELETE FROM credentials"),
    env.DB.prepare("DELETE FROM agents"),
    env.DB.prepare("DELETE FROM boards"),
    env.DB.prepare("DELETE FROM moderators"),
    env.DB.prepare("DELETE FROM operators"),
  ]);
  let cursor: string | undefined;
  do {
    const page = await env.MEDIA.list(cursor === undefined ? {} : { cursor });
    if (page.objects.length > 0) await env.MEDIA.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO operators (email, id) VALUES (?, ?)").bind(OPERATOR, OPERATOR_ID),
    env.DB.prepare("INSERT INTO moderators (email) VALUES (?)").bind(MODERATOR),
    env.DB.prepare("INSERT INTO boards (id, slug, name) VALUES (?, ?, ?)").bind(BOARD_ID, "beta", "JChain"),
  ]);
  await clearNamedQuota(env, `operator:${OPERATOR_ID}`);
  await clearNamedQuota(env, `board:${BOARD_ID}`);
  await clearNamedQuota(env, "global");
  await clearPublishingStop(env);
}

export async function releaseThread(credential: string): Promise<void> {
  await releaseThreadQuota(env, credential);
}

export async function call(pathname: string, options: CallOptions = {}): Promise<Response> {
  const hasJson = options.body !== undefined;
  const hasRaw = options.raw !== undefined;
  const method = options.method ?? (hasJson || hasRaw ? "POST" : "GET");
  const headers = new Headers(options.headers);
  if (options.bearer !== undefined) headers.set("authorization", `Bearer ${options.bearer}`);
  if (
    options.email !== undefined
    && options.sameOrigin !== false
    && method !== "GET"
    && method !== "HEAD"
    && !headers.has("origin")
    && !headers.has("sec-fetch-site")
  ) {
    headers.set("origin", "https://jchain.example.test");
  }
  if (hasJson) headers.set("content-type", "application/json");
  const request = new Request(`https://jchain.example.test${pathname}`, {
    method,
    headers,
    body: hasRaw ? options.raw : hasJson ? JSON.stringify(options.body) : undefined,
  });
  const base = createExecutionContext();
  const ctx = withIdentity(base, options.email);
  const bindings = options.env ?? bindEnv(options.policy, options.turnstile);
  const response = await worker.fetch(request, bindings, ctx);
  await waitOnExecutionContext(base);
  return response;
}

export async function agentCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM agents").first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function credentialRow(agentId: string): Promise<{
  id: string;
  agent_id: string;
  secret_hash: string;
  state: string;
  expires_at: string | null;
  created_at: string;
} | null> {
  return env.DB.prepare(
    "SELECT id, agent_id, secret_hash, state, expires_at, created_at FROM credentials WHERE agent_id = ?",
  ).bind(agentId).first();
}

function withIdentity(ctx: ExecutionContext, email?: string): ExecutionContext {
  const access = email === undefined
    ? undefined
    : { aud: "jchain-test", getIdentity: async () => ({ email }) };
  try {
    Object.defineProperty(ctx, "access", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: access,
    });
    return ctx;
  } catch {
    return new Proxy(ctx, {
      get(target, property, receiver) {
        if (property === "access") return access;
        return Reflect.get(target, property, receiver);
      },
    }) as ExecutionContext;
  }
}

function bindEnv(policy: string | null | undefined, turnstile: string | null | undefined): Env {
  if (policy === undefined && turnstile === undefined) return env;
  return new Proxy(env, {
    get(target, property) {
      if (property === "POLICY" && policy !== undefined) return policy === null ? undefined : policy;
      if (property === "TURNSTILE_SECRET" && turnstile !== undefined) return turnstile ?? "";
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Env;
}
