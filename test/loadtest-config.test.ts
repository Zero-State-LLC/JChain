import { describe, expect, it } from "vitest";
import beta from "../policy/beta.json";
import {
  PRODUCTION_D1_ID,
  assertNoProduction,
  buildLoadtestConfig,
  configQueues,
  operatorsFor,
  parseJsonc,
  plannedQueues,
  productionNames,
  productionProblems,
} from "../scripts/loadtest-config.mjs";
import { parsePolicy } from "../src/policy";

// #81: the staging load-test config is built from the top-level (local) wrangler config and must
// never name a production resource. No network: these are pure functions.
const WRANGLER_JSONC = `{
  // top-level is the local config
  "name": "jchain",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-20",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": "./public", "binding": "ASSETS", "run_worker_first": ["/*"] },
  "workers_dev": false,
  "triggers": { "crons": ["17 11 * * *"] },
  "vars": { "POLICY": "{\\"site_origin\\":\\"https://jchain.example.test\\"}", "TURNSTILE_SECRET": "turnstile-secret-test" },
  "d1_databases": [{ "binding": "DB", "database_name": "jchain", "database_id": "00000000-0000-0000-0000-000000000000", "migrations_dir": "migrations" }],
  "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "jchain-media" }],
  "durable_objects": { "bindings": [{ "name": "QUOTA", "class_name": "Quota" }, { "name": "PUBLISHING_STOP", "class_name": "PublishingStop" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Quota"] }],
  "queues": {
    "producers": [{ "binding": "ASSET_UPLOAD", "queue": "asset-upload" }],
    "consumers": [
      { "queue": "asset-upload", "max_retries": 3, "dead_letter_queue": "asset-upload-dlq" },
      { "queue": "asset-upload-dlq", "max_retries": 1 },
    ],
  },
  "env": {
    "production": {
      "name": "jchain",
      "routes": [{ "pattern": "j-chain.net", "custom_domain": true }],
      "vars": { "MEDIA_ORIGIN": "https://img-origin.j-chain.net", "D1_DATABASE_ID": "${PRODUCTION_D1_ID}" },
      "d1_databases": [{ "binding": "DB", "database_name": "jchain", "database_id": "${PRODUCTION_D1_ID}" }],
      "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "jchain-media" }],
      "ai": { "binding": "AI" },
      "send_email": [{ "name": "EMAIL" }],
    },
  },
}`;

const RUN = "123456789";
const ORIGIN = `https://jchain-loadtest-${RUN}.example-sub.workers.dev`;
const D1 = "0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b";

function build(agents = 50): Record<string, unknown> & { name: string; vars: Record<string, string> } {
  return buildLoadtestConfig(parseJsonc(WRANGLER_JSONC), beta, { runId: RUN, d1Id: D1, origin: ORIGIN, agents, root: "/repo" });
}

describe("staging load-test config", () => {
  it("keeps strings intact while dropping JSONC comments and trailing commas", () => {
    const parsed = parseJsonc(WRANGLER_JSONC) as { vars: { POLICY: string } };
    expect(JSON.parse(parsed.vars.POLICY)).toEqual({ site_origin: "https://jchain.example.test" });
  });

  it("renames every resource with the run id and drops production-only bindings", () => {
    const config = build();
    const names = productionNames(parseJsonc(WRANGLER_JSONC));
    expect(productionProblems(config, names)).toEqual([]);
    expect(config.name).toBe(`jchain-loadtest-${RUN}`);
    expect(config.workers_dev).toBe(true);
    expect(config.env).toBeUndefined();
    expect(config.routes).toBeUndefined();
    expect(config.ai).toBeUndefined();
    expect(config.send_email).toBeUndefined();
    expect(config.vars.MEDIA_ORIGIN).toBeUndefined();
    expect(config.d1_databases).toEqual([
      { binding: "DB", database_name: `jchain-loadtest-${RUN}`, database_id: D1, migrations_dir: "/repo/migrations" },
    ]);
    expect(config.r2_buckets).toEqual([{ binding: "MEDIA", bucket_name: `jchain-loadtest-${RUN}` }]);
    expect(configQueues(config).sort()).toEqual(
      [`asset-upload-dlq-loadtest-${RUN}`, `asset-upload-loadtest-${RUN}`],
    );
    expect(plannedQueues(parseJsonc(WRANGLER_JSONC), RUN).sort()).toEqual(configQueues(config).sort());
    expect(JSON.stringify(config.durable_objects)).not.toContain("script_name");
  });

  it("writes a policy the Worker accepts, at the workers.dev origin, with room for the Agents", () => {
    const config = build(140);
    const policy = parsePolicy(config.vars.POLICY);
    expect(policy).not.toBeNull();
    expect(policy?.site_origin).toBe(ORIGIN);
    expect(policy?.moderation_mode).toBe("postpublish");
    expect(policy?.moderation?.ai_neurons_per_day).toBe(0);
    expect(policy?.auth).toBeUndefined();
    expect(policy?.max_agents).toBeGreaterThanOrEqual(140);
    expect(policy?.max_operators).toBeGreaterThanOrEqual(operatorsFor(140));
  });

  it("rejects a config that names the production D1 id, bucket, domain, or a queue", () => {
    const names = productionNames(parseJsonc(WRANGLER_JSONC));
    const cases: Array<(config: Record<string, unknown>) => void> = [
      (config) => {
        (config.d1_databases as Array<Record<string, unknown>>)[0]!.database_id = PRODUCTION_D1_ID;
      },
      (config) => {
        (config.r2_buckets as Array<Record<string, unknown>>)[0]!.bucket_name = "jchain-media";
      },
      (config) => {
        (config.vars as Record<string, string>).SITE = "https://j-chain.net";
      },
      (config) => {
        const queues = config.queues as { producers: Array<Record<string, unknown>> };
        queues.producers[0]!.queue = "asset-upload";
      },
      (config) => {
        const queues = config.queues as { consumers: Array<Record<string, unknown>> };
        queues.consumers[0]!.dead_letter_queue = "asset-upload-dlq";
      },
    ];
    for (const mutate of cases) {
      const config = build();
      mutate(config);
      expect(() => assertNoProduction(config, names)).toThrow(/refusing/);
    }
  });

  it("refuses a production origin or an out-of-range Agent count", () => {
    const wrangler = parseJsonc(WRANGLER_JSONC);
    expect(() => buildLoadtestConfig(wrangler, beta, { runId: RUN, d1Id: D1, origin: "https://j-chain.net", agents: 50 }))
      .toThrow(/workers\.dev/);
    expect(() => buildLoadtestConfig(wrangler, beta, { runId: RUN, d1Id: D1, origin: ORIGIN, agents: 501 })).toThrow(/agents/);
    expect(() => buildLoadtestConfig(wrangler, beta, { runId: "x", d1Id: D1, origin: ORIGIN, agents: 50 })).toThrow(/run id/);
  });
});
