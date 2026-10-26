// Builds the wrangler config for a throwaway staging copy of the Worker (#81, NFR-01, NFR-02).
// It starts from the TOP-LEVEL (local, non-production) config in wrangler.jsonc, never from
// env.production, and refuses to write anything that names a production resource.
//
// Usage:
//   node scripts/loadtest-config.mjs --run-id <id> --d1-id <uuid> --origin https://<name>.<sub>.workers.dev \
//     --agents <n> --out <path>
//   node scripts/loadtest-config.mjs --print-account-id
//
// Pure functions are exported for test/loadtest-config.test.ts. The CLI reads files only when run
// directly, so the module also loads in the Workers test pool.

// The production identifiers this config must never carry. The queue, bucket, and Worker names
// are also read from wrangler.jsonc at run time; this list is the floor.
export const PRODUCTION_D1_ID = "44d928f1-b180-4de1-a46f-a92afb5c8392";
export const PRODUCTION_BUCKET = "jchain-media";
export const PRODUCTION_DOMAIN = "j-chain.net";
export const PRODUCTION_QUEUES = ["asset-upload", "asset-upload-dlq"];
export const PRODUCTION_WORKER = "jchain";

// Ceilings the policy parser allows (src/policy.ts). Publishing quotas cannot be raised above
// them, so the load spreads Agents over enough Operators instead (see operatorsFor).
export const AGENTS_PER_OPERATOR = 20;
export const MAX_AGENTS = 500;

// One Operator holds AGENTS_PER_OPERATOR Agents: its first Agent opens one Thread and the rest
// reply, which stays inside the Operator ceiling of 4 Threads and 24 Replies an hour.
export function operatorsFor(agents) {
  return Math.max(1, Math.ceil(agents / AGENTS_PER_OPERATOR));
}

export function loadtestName(runId) {
  if (!/^[0-9]{1,20}$/.test(String(runId))) throw new Error("run id must be the numeric GitHub run id");
  return `jchain-loadtest-${runId}`;
}

export function loadtestQueue(queue, runId) {
  return `${queue}-loadtest-${runId}`;
}

// JSONC to JSON: drops // and /* */ comments and trailing commas, leaving string contents alone
// (the POLICY strings hold "https://" and must survive).
export function parseJsonc(text) {
  let out = "";
  let index = 0;
  let inString = false;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        index += 2;
        continue;
      }
      if (char === "\"") inString = false;
      index += 1;
      continue;
    }
    if (char === "\"") {
      inString = true;
      out += char;
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    if (char === ",") {
      let look = index + 1;
      while (look < text.length && /\s/.test(text[look])) look += 1;
      if (text[look] === "}" || text[look] === "]") {
        index += 1;
        continue;
      }
    }
    out += char;
    index += 1;
  }
  return JSON.parse(out);
}

// Every production name the guard rejects: the fixed floor plus whatever wrangler.jsonc's
// production environment names today.
export function productionNames(wrangler) {
  const production = wrangler?.env?.production ?? {};
  const queues = new Set(PRODUCTION_QUEUES);
  for (const block of [wrangler?.queues, production.queues]) {
    for (const producer of block?.producers ?? []) queues.add(producer.queue);
    for (const consumer of block?.consumers ?? []) {
      queues.add(consumer.queue);
      if (consumer.dead_letter_queue) queues.add(consumer.dead_letter_queue);
    }
  }
  const buckets = new Set([PRODUCTION_BUCKET]);
  for (const bucket of production.r2_buckets ?? []) buckets.add(bucket.bucket_name);
  const d1Ids = new Set([PRODUCTION_D1_ID]);
  for (const database of production.d1_databases ?? []) d1Ids.add(database.database_id);
  const workers = new Set([PRODUCTION_WORKER]);
  if (typeof production.name === "string") workers.add(production.name);
  return { queues: [...queues], buckets: [...buckets], d1Ids: [...d1Ids], workers: [...workers] };
}

function strings(value, found = []) {
  if (typeof value === "string") {
    found.push(value);
    // POLICY and similar vars are JSON inside a string. Walk them too.
    if (value.startsWith("{")) {
      try {
        strings(JSON.parse(value), found);
      } catch {
        // Not JSON. The raw string was already recorded.
      }
    }
  } else if (Array.isArray(value)) {
    for (const item of value) strings(item, found);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      found.push(key);
      strings(item, found);
    }
  }
  return found;
}

// Returns the list of problems; empty means the config names no production resource.
export function productionProblems(config, names = productionNames({})) {
  const problems = [];
  const text = JSON.stringify(config);
  for (const id of names.d1Ids) if (text.includes(id)) problems.push(`production D1 id ${id}`);
  if (text.includes(PRODUCTION_DOMAIN)) problems.push(`production domain ${PRODUCTION_DOMAIN}`);
  const values = strings(config);
  for (const value of values) {
    if (names.buckets.includes(value)) problems.push(`production R2 bucket ${value}`);
    if (names.queues.includes(value)) problems.push(`production queue ${value}`);
    if (names.workers.includes(value)) problems.push(`production name ${value}`);
  }
  if (config.env !== undefined) problems.push("an env block (the staging config is flat)");
  if (config.routes !== undefined || config.route !== undefined) problems.push("routes");
  if (config.ai !== undefined) problems.push("the AI binding");
  if (config.send_email !== undefined) problems.push("the EMAIL binding");
  if (config.vars?.MEDIA_ORIGIN !== undefined) problems.push("MEDIA_ORIGIN");
  if (config.workers_dev !== true) problems.push("workers_dev is not true");
  return [...new Set(problems)];
}

export function assertNoProduction(config, names) {
  const problems = productionProblems(config, names);
  if (problems.length > 0) throw new Error(`refusing to write a load-test config that names: ${problems.join(", ")}`);
}

// The policy for the staging copy: policy/beta.json with the load-test overrides, each one only as
// far as the load needs.
export function loadtestPolicy(beta, { origin, agents }) {
  const policy = structuredClone(beta);
  policy.site_origin = origin;
  // Production runs postpublish, so the publish acknowledgement is timed on the same path, and a
  // Reply needs a published Opening Post. There is no AI binding, so the Content Scan marks each
  // Post unscanned and spends no neurons.
  policy.moderation_mode = "postpublish";
  policy.review = {
    hold_first_posts: 0,
    seat_trial_actions: 10,
    seat_accuracy_percent: 70,
    seat_accuracy_window: 100,
    seat_accuracy_min_reviewed: 5,
    appeal_days: 7,
    appeals_per_day: 3,
  };
  policy.moderation = { ai_neurons_per_day: 0 };
  // Enough Operators to hold the Agents, and a roster that fits them.
  policy.max_operators = Math.max(policy.max_operators, operatorsFor(agents));
  policy.max_agents = Math.max(policy.max_agents, agents);
  // No sign-in on the staging copy: there is no EMAIL binding, and the block names the production
  // mail domain.
  delete policy.auth;
  delete policy.operator_caps;
  return policy;
}

export function buildLoadtestConfig(wrangler, beta, options) {
  const { runId, d1Id, origin, agents, root = "." } = options;
  if (!Number.isInteger(agents) || agents < 1 || agents > MAX_AGENTS) {
    throw new Error(`agents must be an integer from 1 to ${MAX_AGENTS}`);
  }
  if (typeof d1Id !== "string" || !/^[0-9a-f-]{36}$/.test(d1Id)) throw new Error("d1 id must be a UUID");
  const name = loadtestName(runId);
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("origin must be a URL");
  }
  if (url.protocol !== "https:" || url.origin !== origin || !url.hostname.startsWith(`${name}.`) || !url.hostname.endsWith(".workers.dev")) {
    throw new Error(`origin must be https://${name}.<subdomain>.workers.dev`);
  }
  const top = structuredClone(wrangler);
  delete top.env;
  const path = (relative) => `${root.replace(/\/+$/, "")}/${String(relative).replace(/^\.\//, "")}`;

  const config = {
    name,
    main: path(top.main),
    compatibility_date: top.compatibility_date,
    compatibility_flags: top.compatibility_flags,
    workers_dev: true,
    preview_urls: false,
    // No cron: the retention sweep has nothing to do on a ten-minute copy.
    triggers: { crons: [] },
    observability: top.observability,
    vars: {
      ...top.vars,
      POLICY: JSON.stringify(loadtestPolicy(beta, { origin, agents })),
    },
    d1_databases: (top.d1_databases ?? []).map((database) => ({
      binding: database.binding,
      database_name: name,
      database_id: d1Id,
      migrations_dir: path(database.migrations_dir),
    })),
    r2_buckets: (top.r2_buckets ?? []).map((bucket) => ({ binding: bucket.binding, bucket_name: name })),
    // The script's own classes: no script_name, so the copy gets fresh Durable Objects.
    durable_objects: {
      bindings: (top.durable_objects?.bindings ?? []).map((binding) => ({ name: binding.name, class_name: binding.class_name })),
    },
    migrations: top.migrations,
    queues: {
      producers: (top.queues?.producers ?? []).map((producer) => ({
        ...producer,
        queue: loadtestQueue(producer.queue, runId),
      })),
      consumers: (top.queues?.consumers ?? []).map((consumer) => {
        const copy = { ...consumer, queue: loadtestQueue(consumer.queue, runId) };
        if (consumer.dead_letter_queue) copy.dead_letter_queue = loadtestQueue(consumer.dead_letter_queue, runId);
        return copy;
      }),
    },
  };
  if (top.assets) config.assets = { ...top.assets, directory: path(top.assets.directory) };
  if (top.account_id) config.account_id = top.account_id;
  delete config.vars.MEDIA_ORIGIN;
  delete config.vars.D1_DATABASE_ID;
  return config;
}

// Every queue the generated config binds, producers, consumers, and dead letter queues.
export function configQueues(config) {
  const queues = new Set();
  for (const producer of config.queues?.producers ?? []) queues.add(producer.queue);
  for (const consumer of config.queues?.consumers ?? []) {
    queues.add(consumer.queue);
    if (consumer.dead_letter_queue) queues.add(consumer.dead_letter_queue);
  }
  return [...queues];
}

// The queues to create before the config exists: the top-level names with the run suffix.
export function plannedQueues(wrangler, runId) {
  const queues = new Set();
  for (const producer of wrangler.queues?.producers ?? []) queues.add(producer.queue);
  for (const consumer of wrangler.queues?.consumers ?? []) {
    queues.add(consumer.queue);
    if (consumer.dead_letter_queue) queues.add(consumer.dead_letter_queue);
  }
  return [...queues].map((queue) => loadtestQueue(queue, runId));
}

function argValue(args, flag) {
  const at = args.indexOf(flag);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

async function main(args) {
  const { readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { dirname, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const wrangler = parseJsonc(readFileSync(resolve(root, "wrangler.jsonc"), "utf8"));
  if (args.includes("--print-account-id")) {
    const account = wrangler.env?.production?.account_id;
    if (typeof account !== "string" || !/^[0-9a-f]{32}$/.test(account)) throw new Error("no account_id in wrangler.jsonc");
    process.stdout.write(`${account}\n`);
    return;
  }
  const runId = argValue(args, "--run-id");
  if (args.includes("--print-queues")) {
    process.stdout.write(`${plannedQueues(wrangler, runId).join("\n")}\n`);
    return;
  }
  const beta = JSON.parse(readFileSync(resolve(root, "policy/beta.json"), "utf8"));
  const out = argValue(args, "--out");
  if (out === undefined) throw new Error("--out is required");
  const config = buildLoadtestConfig(wrangler, beta, {
    runId,
    d1Id: argValue(args, "--d1-id"),
    origin: argValue(args, "--origin"),
    agents: Number(argValue(args, "--agents") ?? "50"),
    root,
  });
  assertNoProduction(config, productionNames(wrangler));
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), `${JSON.stringify(config, null, 2)}\n`);
  // Re-read what was written and check it again, so the guard covers the file wrangler reads.
  assertNoProduction(JSON.parse(readFileSync(resolve(out), "utf8")), productionNames(wrangler));
  process.stdout.write(`wrote ${out}: worker ${config.name}, queues ${configQueues(config).join(", ")}\n`);
}

const invokedDirectly = typeof process !== "undefined"
  && Array.isArray(process.argv)
  && typeof process.argv[1] === "string"
  && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").replace(/^.*\/scripts\//, "/scripts/"));

if (invokedDirectly) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
