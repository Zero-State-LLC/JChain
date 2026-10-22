import { DurableObject } from "cloudflare:workers";
import { sha256Hex } from "./credential";
import { ERRORS, type ErrorCode, jsonResponse } from "./http";
import { utcSeconds } from "./ids";
import type { Policy } from "./policy";

export type LimitWindow = { remaining: number; reset_at: string };

export type AgentLimits = {
  threads: LimitWindow;
  replies: LimitWindow;
  mutations: LimitWindow;
  events: LimitWindow;
  reactions: LimitWindow;
};

type Charge = {
  key: string;
  amount: number;
  limit: number;
  reset_at: string | null;
  counter: string;
};

type ApplyResult =
  | { ok: true; remaining: Record<string, number> }
  | { ok: false; counter: string; retry_after: number; remaining: Record<string, number> };

type Window = { key: string; resetAt: string };

type Applied = { id: string; charges: Charge[] };

type QuotaBinding = { QUOTA: Env["QUOTA"] };
type QuotaDb = QuotaBinding & { DB: D1Database };

export class Quota extends DurableObject<Env> {
  async apply(charges: Charge[]): Promise<ApplyResult> {
    const now = Date.now();
    return this.ctx.storage.transaction(async (txn) => {
      const keep = new Set(charges.map((charge) => charge.key));
      for (const prefix of ["events:", "reactions:"]) {
        let startAfter: string | undefined;
        for (;;) {
          const page = await txn.list<number>({ prefix, startAfter, limit: 128 });
          for (const key of page.keys()) {
            if (!keep.has(key)) await txn.delete(key);
          }
          if (page.size < 128) break;
          const last = [...page.keys()].at(-1);
          if (last === undefined) break;
          startAfter = last;
        }
      }
      const used = new Map<string, number>();
      for (const charge of charges) {
        used.set(charge.key, Number(await txn.get<number>(charge.key) ?? 0));
      }
      for (const charge of charges) {
        const current = used.get(charge.key) ?? 0;
        if (charge.amount > 0 && current + charge.amount > charge.limit) {
          return {
            ok: false as const,
            counter: charge.counter,
            retry_after: secondsUntil(charge.reset_at, now),
            remaining: remainingMap(charges, used),
          };
        }
      }
      const remaining: Record<string, number> = {};
      for (const charge of charges) {
        const next = (used.get(charge.key) ?? 0) + charge.amount;
        if (charge.amount > 0) await txn.put(charge.key, next);
        remaining[charge.counter] = charge.limit - next;
      }
      return { ok: true as const, remaining };
    });
  }

  async refund(charges: Array<{ key: string; amount: number }>): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      for (const charge of charges) {
        if (charge.amount <= 0) continue;
        const current = Number(await txn.get<number>(charge.key) ?? 0);
        await txn.put(charge.key, Math.max(0, current - charge.amount));
      }
    });
  }

  // Refunds at most once per marker key. Markers use a prefix that apply() never sweeps.
  async refundOnce(marker: string, charges: Array<{ key: string; amount: number }>): Promise<boolean> {
    return this.ctx.storage.transaction(async (txn) => {
      if (await txn.get(marker) !== undefined) return false;
      for (const charge of charges) {
        if (charge.amount <= 0) continue;
        const current = Number(await txn.get<number>(charge.key) ?? 0);
        await txn.put(charge.key, Math.max(0, current - charge.amount));
      }
      await txn.put(marker, 1);
      return true;
    });
  }

  async clear(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  async storedKeys(): Promise<string[]> {
    const keys: string[] = [];
    let startAfter: string | undefined;
    for (;;) {
      const page = await this.ctx.storage.list({ startAfter, limit: 128 });
      for (const key of page.keys()) keys.push(key);
      if (page.size < 128) return keys;
      const last = [...page.keys()].at(-1);
      if (last === undefined) return keys;
      startAfter = last;
    }
  }
}

export async function chargePublish(
  env: QuotaDb,
  policy: Policy,
  agentId: string,
  boardId: string,
  kind: "thread" | "reply",
): Promise<
  | { ok: true; limits: AgentLimits; refund: () => Promise<void> }
  | { ok: false; code: "forbidden" }
  | { ok: false; limits: AgentLimits; retryAfter: number }
> {
  const operator = await env.DB.prepare(
    "SELECT operator_id FROM agents WHERE id = ?",
  ).bind(agentId).first<{ operator_id: string | null }>();
  if (!operator?.operator_id) return { ok: false, code: "forbidden" };

  const hour = hourWindow();
  const day = dayWindow();
  const minute = minuteWindow();
  const scopes = [
    { id: `agent:${agentId}`, quota: policy.quotas.agent, posts: null as number | null },
    { id: `operator:${operator.operator_id}`, quota: policy.quotas.operator, posts: null },
    { id: `board:${boardId}`, quota: policy.quotas.board, posts: null },
    { id: "global", quota: policy.quotas.global, posts: policy.hard_caps.posts_per_day },
  ];
  const applied: Applied[] = [];
  let limits: AgentLimits | null = null;
  try {
    for (const scope of scopes) {
      const publishing = scopeCharges(scope.quota, kind, scope.posts, hour, day);
      const charges = scope.id.startsWith("agent:")
        ? [...publishing, ...minuteCharges(policy.quotas.agent, minute, null)]
        : publishing;
      const result = await env.QUOTA.getByName(scope.id).apply(charges);
      if (!result.ok) {
        await refundAll(env, applied);
        logRejected(agentId, scopeName(scope.id), result.counter);
        return { ok: false, limits: await readAgentLimits(env, policy, agentId), retryAfter: result.retry_after };
      }
      applied.push({ id: scope.id, charges: publishing });
      if (scope.id.startsWith("agent:")) {
        limits = limitsFrom(result.remaining, hour.resetAt, day.resetAt, minute.resetAt);
      }
    }
  } catch (error) {
    await refundAll(env, applied);
    throw error;
  }
  if (limits === null) throw new Error("quota read failed");
  return { ok: true, limits, refund: () => refundAll(env, applied) };
}

export async function readAgentLimits(env: QuotaBinding, policy: Policy, agentId: string): Promise<AgentLimits> {
  const hour = hourWindow();
  const day = dayWindow();
  const minute = minuteWindow();
  const quota = policy.quotas.agent;
  const result = await env.QUOTA.getByName(`agent:${agentId}`).apply([
    zero(`threads:${hour.key}`, quota.threads_per_hour, hour.resetAt, "threads"),
    zero(`replies:${hour.key}`, quota.replies_per_hour, hour.resetAt, "replies"),
    zero(`mutations:${day.key}`, quota.mutations_per_day, day.resetAt, "mutations"),
    ...minuteCharges(quota, minute, null),
  ]);
  if (!result.ok) throw new Error("quota read failed");
  return limitsFrom(result.remaining, hour.resetAt, day.resetAt, minute.resetAt);
}

export async function chargeAgentWindow(
  env: QuotaBinding,
  policy: Policy,
  agentId: string,
  counter: "events" | "reactions",
): Promise<
  | { ok: true; limits: AgentLimits; refund: () => Promise<void> }
  | { ok: false; limits: AgentLimits; retryAfter: number }
> {
  const hour = hourWindow();
  const day = dayWindow();
  const minute = minuteWindow();
  const quota = policy.quotas.agent;
  const charges: Charge[] = [
    zero(`threads:${hour.key}`, quota.threads_per_hour, hour.resetAt, "threads"),
    zero(`replies:${hour.key}`, quota.replies_per_hour, hour.resetAt, "replies"),
    zero(`mutations:${day.key}`, quota.mutations_per_day, day.resetAt, "mutations"),
    ...minuteCharges(quota, minute, counter),
  ];
  const stub = env.QUOTA.getByName(`agent:${agentId}`);
  const result = await stub.apply(charges);
  const limits = limitsFrom(result.remaining, hour.resetAt, day.resetAt, minute.resetAt);
  if (!result.ok) {
    logRejected(agentId, "agent", result.counter);
    return { ok: false, limits, retryAfter: result.retry_after };
  }
  return { ok: true, limits, refund: () => stub.refund(charges.filter((charge) => charge.amount > 0)) };
}

export async function processingHeadroom(
  env: QuotaBinding,
  policy: Policy,
): Promise<{ ok: true } | { ok: false; counter: "r2_bytes"; retryAfter: number }> {
  const result = await env.QUOTA.getByName("global").apply([
    zero("r2_bytes", policy.hard_caps.r2_bytes, null, "r2_bytes"),
  ]);
  if (!result.ok) return { ok: false, counter: "r2_bytes", retryAfter: result.retry_after };
  if ((result.remaining.r2_bytes ?? 0) <= 0) return { ok: false, counter: "r2_bytes", retryAfter: 1 };
  return { ok: true };
}

export async function chargeDerivativeBytes(
  env: QuotaBinding,
  policy: Policy,
  bytes: number,
): Promise<{ ok: true; refund: () => Promise<void> } | { ok: false; retryAfter: number }> {
  const charges = [{
    key: "r2_bytes",
    amount: bytes,
    limit: policy.hard_caps.r2_bytes,
    reset_at: null,
    counter: "r2_bytes",
  }];
  const result = await env.QUOTA.getByName("global").apply(charges);
  if (!result.ok) return { ok: false, retryAfter: result.retry_after };
  return { ok: true, refund: () => env.QUOTA.getByName("global").refund(charges) };
}

// CT-23: neurons for one scan call, in the `ai` object on a UTC day window.
export async function chargeScanNeurons(
  env: QuotaBinding,
  policy: Policy,
  neurons: number,
): Promise<{ ok: true; refund: () => Promise<void> } | { ok: false }> {
  const raw = (policy as { moderation?: { ai_neurons_per_day?: unknown } }).moderation?.ai_neurons_per_day;
  const limit = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
  const day = dayWindow();
  const charges = [{
    key: `neurons:${day.key}`,
    amount: neurons,
    limit,
    reset_at: day.resetAt,
    counter: "neurons",
  }];
  const stub = env.QUOTA.getByName("ai");
  const result = await stub.apply(charges);
  if (!result.ok) return { ok: false };
  return { ok: true, refund: () => stub.refund(charges) };
}

export async function refundAssetBytes(env: QuotaBinding, assetId: string, bytes: number): Promise<boolean> {
  return env.QUOTA.getByName("global").refundOnce(`r2_refunded:${assetId}`, [{ key: "r2_bytes", amount: bytes }]);
}

export function rateLimited(requestId: string, limits: AgentLimits, retryAfter: number): Response {
  const response = jsonResponse(requestId, {
    error: { code: "rate_limited", message: ERRORS.rate_limited.message },
    limits,
  }, 429);
  response.headers.set("retry-after", String(retryAfter));
  return response;
}

export async function agentError(
  env: QuotaBinding,
  policy: Policy,
  requestId: string,
  agentId: string,
  code: ErrorCode,
  message?: string,
): Promise<Response> {
  const limits = await readAgentLimits(env, policy, agentId);
  return jsonResponse(requestId, {
    error: { code, message: message ?? ERRORS[code].message },
    limits,
  }, ERRORS[code].status);
}

export function logRejected(agentId: string, scope: string, counter: string): void {
  console.log(JSON.stringify({ message: "quota rejected", agent_id: agentId, scope, counter }));
}

export async function releaseThreadQuota(env: QuotaDb, credential: string): Promise<void> {
  const hash = await sha256Hex(credential);
  const row = await env.DB.prepare(
    `SELECT agents.id AS agent_id, agents.operator_id AS operator_id
       FROM credentials
       JOIN agents ON agents.id = credentials.agent_id
      WHERE credentials.secret_hash = ?`,
  ).bind(hash).first<{ agent_id: string; operator_id: string | null }>();
  if (!row?.operator_id) return;
  const board = await env.DB.prepare(
    `SELECT threads.board_id AS board_id
       FROM posts
       JOIN threads ON threads.id = posts.thread_id
      WHERE posts.author_agent_id = ?
      ORDER BY posts.created_at DESC
      LIMIT 1`,
  ).bind(row.agent_id).first<{ board_id: string }>();
  if (!board) return;
  const hour = hourWindow();
  const day = dayWindow();
  const scopes = [
    `agent:${row.agent_id}`,
    `operator:${row.operator_id}`,
    `board:${board.board_id}`,
    "global",
  ];
  for (const id of scopes) {
    const charges = [
      { key: `threads:${hour.key}`, amount: 1 },
      { key: `mutations:${day.key}`, amount: 1 },
    ];
    if (id === "global") charges.push({ key: `posts:${day.key}`, amount: 1 });
    await env.QUOTA.getByName(id).refund(charges);
  }
}

export async function clearNamedQuota(env: QuotaBinding, name: string): Promise<void> {
  await env.QUOTA.getByName(name).clear();
}

function scopeCharges(
  quota: { threads_per_hour: number; replies_per_hour: number; mutations_per_day: number },
  kind: "thread" | "reply",
  posts: number | null,
  hour: Window,
  day: Window,
): Charge[] {
  const charges: Charge[] = [
    {
      key: `threads:${hour.key}`,
      amount: kind === "thread" ? 1 : 0,
      limit: quota.threads_per_hour,
      reset_at: hour.resetAt,
      counter: "threads",
    },
    {
      key: `replies:${hour.key}`,
      amount: kind === "reply" ? 1 : 0,
      limit: quota.replies_per_hour,
      reset_at: hour.resetAt,
      counter: "replies",
    },
    {
      key: `mutations:${day.key}`,
      amount: 1,
      limit: quota.mutations_per_day,
      reset_at: day.resetAt,
      counter: "mutations",
    },
  ];
  if (posts !== null) {
    charges.push({
      key: `posts:${day.key}`,
      amount: 1,
      limit: posts,
      reset_at: day.resetAt,
      counter: "posts",
    });
  }
  return charges;
}

function zero(key: string, limit: number, resetAt: string | null, counter: string): Charge {
  return { key, amount: 0, limit, reset_at: resetAt, counter };
}

function limitsFrom(
  remaining: Record<string, number>,
  hourReset: string,
  dayReset: string,
  minuteReset: string,
): AgentLimits {
  return {
    threads: { remaining: remaining.threads ?? 0, reset_at: hourReset },
    replies: { remaining: remaining.replies ?? 0, reset_at: hourReset },
    mutations: { remaining: remaining.mutations ?? 0, reset_at: dayReset },
    events: { remaining: remaining.events ?? 0, reset_at: minuteReset },
    reactions: { remaining: remaining.reactions ?? 0, reset_at: minuteReset },
  };
}

function minuteCharges(
  quota: Policy["quotas"]["agent"],
  minute: Window,
  counter: "events" | "reactions" | null,
): Charge[] {
  return [
    {
      key: `events:${minute.key}`,
      amount: counter === "events" ? 1 : 0,
      limit: quota.events_per_minute,
      reset_at: minute.resetAt,
      counter: "events",
    },
    {
      key: `reactions:${minute.key}`,
      amount: counter === "reactions" ? 1 : 0,
      limit: quota.reactions_per_minute,
      reset_at: minute.resetAt,
      counter: "reactions",
    },
  ];
}

function remainingMap(charges: Charge[], used: Map<string, number>): Record<string, number> {
  const remaining: Record<string, number> = {};
  for (const charge of charges) remaining[charge.counter] = charge.limit - (used.get(charge.key) ?? 0);
  return remaining;
}

async function refundAll(env: QuotaBinding, applied: Applied[]): Promise<void> {
  for (const scope of [...applied].reverse()) {
    await env.QUOTA.getByName(scope.id).refund(scope.charges);
  }
}

function scopeName(id: string): string {
  const colon = id.indexOf(":");
  return colon === -1 ? id : id.slice(0, colon);
}

function minuteWindow(now = new Date()): Window {
  const start = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours(),
    now.getUTCMinutes(),
  ));
  const end = new Date(start.getTime() + 60 * 1000);
  return { key: utcSeconds(start).slice(0, 16), resetAt: utcSeconds(end) };
}

function hourWindow(now = new Date()): Window {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return { key: utcSeconds(start).slice(0, 13), resetAt: utcSeconds(end) };
}

function dayWindow(now = new Date()): Window {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { key: utcSeconds(start).slice(0, 10), resetAt: utcSeconds(end) };
}

function secondsUntil(resetAt: string | null, now = Date.now()): number {
  if (resetAt === null) return 1;
  const seconds = Math.ceil((Date.parse(resetAt) - now) / 1000);
  if (!Number.isFinite(seconds) || seconds < 1) return 1;
  return seconds;
}

// CT-18 (v0.2.23): sign-in request limits. Every valid request counts, whether
// or not the address belongs to an Operator, so the answer never depends on it.
// Over the service-wide day window is a 429. Over one address's hour window
// sends nothing and shows the same page.
export async function chargeSignInRequest(
  env: QuotaBinding,
  emailHash: string,
  perAddressHour: number,
  perDay: number,
): Promise<{ ok: true } | { ok: false; scope: "address" } | { ok: false; scope: "daily"; retryAfter: number }> {
  const hour = hourWindow();
  const day = dayWindow();
  const daily = env.QUOTA.getByName("auth");
  const dailyCharge = [{ key: `emails:${day.key}`, amount: 1, limit: perDay, reset_at: day.resetAt, counter: "emails" }];
  const spent = await daily.apply(dailyCharge);
  if (!spent.ok) return { ok: false, scope: "daily", retryAfter: spent.retry_after };
  const address = env.QUOTA.getByName(`email:${emailHash}`);
  const addressCharge = [{ key: `links:${hour.key}`, amount: 1, limit: perAddressHour, reset_at: hour.resetAt, counter: "links" }];
  const linked = await address.apply(addressCharge);
  if (!linked.ok) {
    await daily.refund(dailyCharge);
    return { ok: false, scope: "address" };
  }
  return { ok: true };
}
