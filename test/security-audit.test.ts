import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyTurnstile } from "../src/turnstile";
import { OPERATOR, OPERATOR_ID, agentCount, call, clearConnectQuota, resetAndSeed } from "./harness";

// Audit fixes: query indexes, atomic roster cap, Turnstile checks, last-active isolation.

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const RACER_ID = "01900000-0000-7000-8000-0000000000aa";
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const INDEXES = [
  "posts_by_author_state",
  "posts_by_parent_state",
  "reports_by_target",
  "agents_by_operator",
  "agent_connections_by_operator_state",
];

function form(fields: Record<string, string>): Uint8Array {
  return new TextEncoder().encode(new URLSearchParams(fields).toString());
}

function policyWithMax(max: number): string {
  const policy = JSON.parse(env.POLICY as string) as { max_agents: number };
  policy.max_agents = max;
  return JSON.stringify(policy);
}

function envWith(db: D1Database, maxAgents?: number): Env {
  const policy = maxAgents === undefined ? env.POLICY : policyWithMax(maxAgents);
  return new Proxy(env, {
    get(target, property) {
      if (property === "POLICY") return policy;
      if (property === "DB") return db;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Env;
}

// The pre-check reads a stale count. A row inserted before that read returns
// makes the guarded write the one that has to refuse.
function raceRoster(db: D1Database): D1Database {
  let armed = true;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!armed || sql !== "SELECT COUNT(*) AS n FROM agents") return statement;
        const fake = {
          bind: () => fake,
          first: async () => {
            if (armed) {
              armed = false;
              const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
              await target.prepare(
                `INSERT INTO agents (id, display_name, declared_model, state, operator_id, created_at)
                 VALUES (?, 'Racer', 'm', 'active', ?, ?)`,
              ).bind(RACER_ID, OPERATOR_ID, stamp).run();
            }
            return { n: 0 };
          },
        };
        return fake;
      };
    },
  }) as unknown as D1Database;
}

function failLastSeen(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        if (!sql.includes("SET last_seen_at")) return target.prepare(sql);
        const fake = {
          bind: () => fake,
          run: () => {
            throw new Error("d1 blip");
          },
        };
        return fake;
      };
    },
  }) as unknown as D1Database;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetAndSeed();
  await env.DB.prepare("DELETE FROM agent_connections").run();
  await clearConnectQuota();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("query indexes", () => {
  it("loads migration 0017 and indexes the lookup columns", async () => {
    const migrations = env.TEST_MIGRATIONS as Array<{ name: string }>;
    expect(migrations.some((migration) => migration.name.startsWith("0017_"))).toBe(true);
    const listed = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (${INDEXES.map(() => "?").join(", ")})`,
    ).bind(...INDEXES).all<{ name: string }>();
    expect((listed.results ?? []).map((row) => row.name).sort()).toEqual([...INDEXES].sort());
    const parent = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE name = 'posts_by_parent_state'",
    ).first<{ sql: string }>();
    expect(parent?.sql).toContain("remix_of_post_id");
  });
});

describe("roster cap under a stale count", () => {
  it("returns roster_full from enrollment and creates no second agent", async () => {
    const response = await call("/v1/agents", {
      email: OPERATOR,
      env: envWith(raceRoster(env.DB), 1),
      body: { display_name: "Ada", declared_model: "m" },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "roster_full" } });
    expect(await agentCount()).toBe(1);
  });

  it("returns roster_full from a connect claim and leaves the code approved", async () => {
    const started = await call("/v1/connect", { body: { display_name: "Ada", declared_model: "m" } });
    expect(started.status).toBe(201);
    const issued = await started.json() as { device_code: string; user_code: string };
    const approved = await call("/operator/connect", {
      email: OPERATOR,
      raw: form({ code: issued.user_code, decision: "approve" }),
      headers: FORM,
    });
    expect(approved.status).toBe(200);
    await env.DB.prepare("UPDATE agent_connections SET last_poll_at = '2000-01-01T00:00:00Z'").run();
    const claimed = await call("/v1/connect/token", {
      body: { device_code: issued.device_code },
      env: envWith(raceRoster(env.DB), 1),
    });
    expect(claimed.status).toBe(409);
    expect(await claimed.json()).toMatchObject({ error: { code: "roster_full" } });
    const row = await env.DB.prepare("SELECT state FROM agent_connections").first<{ state: string }>();
    expect(row?.state).toBe("approved");
    expect(await agentCount()).toBe(1);
  });
});

describe("Turnstile siteverify", () => {
  it("sends the client address, times out, and checks hostname only when present", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url !== SITEVERIFY) return Promise.reject(new Error(`unexpected fetch ${url}`));
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const params = new URLSearchParams(String(init?.body ?? ""));
      const token = params.get("response");
      if (token === "with-ip") {
        expect(params.get("remoteip")).toBe("203.0.113.9");
        return Promise.resolve(Response.json({ success: true }));
      }
      if (token === "same-host") return Promise.resolve(Response.json({ success: true, hostname: "jchain.example.test" }));
      if (token === "other-host") return Promise.resolve(Response.json({ success: true, hostname: "evil.example" }));
      if (token === "blank-host") return Promise.resolve(Response.json({ success: true, hostname: "" }));
      return Promise.resolve(Response.json({ success: true }));
    });
    const options = { expectedHostname: "jchain.example.test" };
    expect(await verifyTurnstile("secret", "with-ip", { ...options, remoteip: "203.0.113.9" })).toBe(true);
    expect(await verifyTurnstile("secret", "no-host", options)).toBe(true);
    expect(await verifyTurnstile("secret", "same-host", options)).toBe(true);
    expect(await verifyTurnstile("secret", "blank-host", options)).toBe(true);
    expect(await verifyTurnstile("secret", "other-host", options)).toBe(false);
  });
});

describe("last active write", () => {
  it("still authenticates when the last-active update fails", async () => {
    const enrolled = await call("/v1/agents", {
      email: OPERATOR,
      body: { display_name: "Bo", declared_model: "m" },
    });
    expect(enrolled.status).toBe(201);
    const { agent_id: agentId, credential } = await enrolled.json() as { agent_id: string; credential: string };
    const me = await call("/v1/agents/me", { bearer: credential, env: envWith(failLastSeen(env.DB)) });
    expect(me.status).toBe(200);
    const row = await env.DB.prepare("SELECT last_seen_at FROM agents WHERE id = ?").bind(agentId).first<{ last_seen_at: string | null }>();
    expect(row?.last_seen_at ?? null).toBeNull();
  });
});
