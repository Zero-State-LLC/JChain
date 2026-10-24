// Staging load test for the NFR-01 and NFR-02 receipts (#81, AT-14). Plain Node 22, built-in fetch.
// It only ever talks to the throwaway workers.dev copy that .github/workflows/loadtest.yml deploys.
//
//   node scripts/loadtest.mjs seed --agents <n> --sql <out.sql> --tokens <out.json>
//     Writes the seed SQL (Operators, a Board if none is open, Agents, Credential hashes) and a
//     tokens file holding the plaintext Credentials. The tokens file stays on the runner.
//   node scripts/loadtest.mjs run --base <https://...workers.dev> --tokens <file> --rps <n> \
//     --minutes <n> --out <receipt.json> [--assets <asset-ids.txt>]
//     Runs the load and writes the receipt (no tokens) and a step summary table.
//   node scripts/loadtest.mjs empty-bucket --bucket <name> --assets <asset-ids.txt>
//     Deletes the copy's R2 objects through the Cloudflare API so the bucket can be deleted.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTS_PER_OPERATOR, MAX_AGENTS, operatorsFor } from "./loadtest-config.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AUTHORSHIP_RULE = /AUTHORSHIP_RULE_VERSION\s*=\s*"([^"]+)"/;
// Policy ceilings (src/policy.ts) shared by the one Board and the whole service each hour.
const GLOBAL_THREADS_PER_HOUR = 20;
const GLOBAL_REPLIES_PER_HOUR = 120;
const READY_TARGET_MS = 60_000;
const READY_GIVE_UP_MS = 120_000;
const READ_P95_TARGET_MS = 1000;
const PUBLISH_ACK_TARGET_MS = 2000;
const READY_SHARE_TARGET = 0.95;
const REQUIRED_AGENTS = 50;
const REQUIRED_RPS = 10;
const MAX_IN_FLIGHT = 256;
const REQUEST_TIMEOUT_MS = 30_000;
const USER_AGENT = "jchain-loadtest/1 (staging; #81)";
// Valid WebP fixtures already in the repo. Agents supply finished images: nothing is transcoded.
const FIXTURES = ["test/fixtures/valid.webp", "test/fixtures/other.webp", "test/fixtures/square-thumb.webp"];
const READ_CLASSES = ["board_feed", "thread_read", "events_poll", "agents_me"];

function argValue(args, flag, fallback) {
  const at = args.indexOf(flag);
  if (at === -1) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${flag} is required`);
  }
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

function intArg(args, flag, fallback, min, max) {
  const value = Number(argValue(args, flag, fallback === undefined ? undefined : String(fallback)));
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${flag} must be an integer from ${min} to ${max}`);
  return value;
}

export function uuidv7(now = Date.now()) {
  const bytes = randomBytes(16);
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function utcSeconds(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sqlText(value) {
  return value === null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
}

// Same shape the Worker issues (src/credential.ts): jc_ and 32 random bytes, base64url. D1 keeps
// only the SHA-256 of it (credentials.secret_hash), exactly as enrollment does.
function newCredential() {
  return `jc_${randomBytes(32).toString("base64url")}`;
}

// Each Operator's first Agent opens a Thread; the rest reply into it. Agents past the hourly
// Thread or Reply ceiling of the one Board skip the publish, and the receipt says so.
export function publishRoles(agents) {
  const roles = [];
  let threads = 0;
  let replies = 0;
  for (let index = 0; index < agents; index += 1) {
    if (index % AGENTS_PER_OPERATOR === 0) {
      if (threads < GLOBAL_THREADS_PER_HOUR) {
        threads += 1;
        roles.push("opener");
      } else roles.push("skip");
    } else if (replies < GLOBAL_REPLIES_PER_HOUR) {
      replies += 1;
      roles.push("replier");
    } else roles.push("skip");
  }
  return roles;
}

function seed(args) {
  const agents = intArg(args, "--agents", 50, 1, MAX_AGENTS);
  const sqlPath = resolve(argValue(args, "--sql"));
  const tokensPath = resolve(argValue(args, "--tokens"));
  const authorship = AUTHORSHIP_RULE.exec(readFileSync(resolve(ROOT, "src/authorship.ts"), "utf8"))?.[1] ?? null;
  const now = utcSeconds();
  const operators = Array.from({ length: operatorsFor(agents) }, (_, index) => ({
    id: uuidv7(),
    email: `loadtest-operator-${index + 1}@loadtest.invalid`,
  }));
  const roles = publishRoles(agents);
  const lines = [
    "-- Staging load test seed (#81). Throwaway database only. Credential hashes only, no secrets.",
  ];
  for (const operator of operators) {
    lines.push(
      `INSERT INTO operators (email, id, state, authorship_attested_version, authorship_attested_at, created_at) VALUES (${sqlText(operator.email)}, ${sqlText(operator.id)}, 'approved', ${sqlText(authorship)}, ${sqlText(authorship === null ? null : now)}, ${sqlText(now)});`,
    );
  }
  // The migrations seed the starter Boards. Add one only when no Board is open.
  lines.push(
    `INSERT INTO boards (id, slug, name, description, state) SELECT ${sqlText(uuidv7())}, 'loadtest', 'Load test', 'Staging load test board.', 'open' WHERE NOT EXISTS (SELECT 1 FROM boards WHERE state = 'open');`,
  );
  const records = [];
  for (let index = 0; index < agents; index += 1) {
    const operator = operators[Math.floor(index / AGENTS_PER_OPERATOR)];
    const agentId = uuidv7();
    const token = newCredential();
    lines.push(
      `INSERT INTO agents (id, display_name, declared_model, state, operator_id, created_at) VALUES (${sqlText(agentId)}, ${sqlText(`Load agent ${index + 1}`)}, 'loadtest-fixture', 'active', ${sqlText(operator.id)}, ${sqlText(now)});`,
      `INSERT INTO credentials (id, agent_id, secret_hash, state, expires_at, created_at) VALUES (${sqlText(uuidv7())}, ${sqlText(agentId)}, ${sqlText(sha256Hex(token))}, 'active', NULL, ${sqlText(now)});`,
    );
    records.push({ index, agent_id: agentId, operator: Math.floor(index / AGENTS_PER_OPERATOR), role: roles[index], token });
  }
  writeFileSync(sqlPath, `${lines.join("\n")}\n`);
  writeFileSync(tokensPath, `${JSON.stringify({ operators: operators.length, agents: records })}\n`, { mode: 0o600 });
  chmodSync(tokensPath, 0o600);
  console.log(`seed: ${operators.length} Operators, ${agents} Agents (${roles.filter((role) => role === "opener").length} open a Thread, ${roles.filter((role) => role === "replier").length} reply, ${roles.filter((role) => role === "skip").length} skip the publish)`);
}

export function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return Math.round(sorted[rank] * 10) / 10;
}

function newClass() {
  return { count: 0, ok: 0, latencies: [], statuses: {}, rate_limited: 0, network_errors: 0 };
}

function summarize(stats) {
  const errors = {};
  for (const [status, count] of Object.entries(stats.statuses)) {
    if (!status.startsWith("2")) errors[status] = count;
  }
  return {
    requests: stats.count,
    ok: stats.ok,
    p50_ms: percentile(stats.latencies, 0.5),
    p95_ms: percentile(stats.latencies, 0.95),
    p99_ms: percentile(stats.latencies, 0.99),
    max_ms: stats.latencies.length === 0 ? null : Math.round(Math.max(...stats.latencies) * 10) / 10,
    errors_by_status: errors,
    rate_limited_429: stats.rate_limited,
    network_errors: stats.network_errors,
  };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, Math.max(0, ms)));

async function run(args) {
  const base = argValue(args, "--base").replace(/\/+$/, "");
  const url = new URL(base);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".workers.dev") || !url.hostname.startsWith("jchain-loadtest-")) {
    throw new Error("--base must be the jchain-loadtest-<run id> workers.dev URL; this script never targets production");
  }
  const tokens = JSON.parse(readFileSync(resolve(argValue(args, "--tokens")), "utf8"));
  const rps = intArg(args, "--rps", 10, 1, 50);
  const minutes = intArg(args, "--minutes", 10, 1, 30);
  const out = resolve(argValue(args, "--out", "loadtest-receipt.json"));
  const assetsOut = args.includes("--assets") ? resolve(argValue(args, "--assets")) : null;
  const agents = tokens.agents;
  if (!Array.isArray(agents) || agents.length === 0) throw new Error("the tokens file holds no Agents");
  const fixtures = FIXTURES.map((path) => {
    const bytes = readFileSync(resolve(ROOT, path));
    if (bytes.subarray(0, 4).toString("latin1") !== "RIFF" || bytes.subarray(8, 12).toString("latin1") !== "WEBP") {
      throw new Error(`${path} is not a WebP`);
    }
    return { path, bytes, sha256: sha256Hex(bytes) };
  });

  const classes = {};
  for (const name of [...READ_CLASSES, "publish", "upload_reserve", "upload_put", "upload_complete", "asset_status"]) {
    classes[name] = newClass();
  }
  let inFlight = 0;
  let readsSent = 0;
  let readsDropped = 0;

  async function request(className, path, { method = "GET", agent, headers = {}, body, raw } = {}) {
    const stats = classes[className];
    const sent = new Headers({ "user-agent": USER_AGENT, accept: "application/json", ...headers });
    if (agent !== undefined) sent.set("authorization", `Bearer ${agent.token}`);
    let payload;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) {
      sent.set("content-type", "application/json");
      payload = JSON.stringify(body);
    }
    stats.count += 1;
    inFlight += 1;
    const started = performance.now();
    try {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: sent,
        body: payload,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await response.text();
      const ms = performance.now() - started;
      const status = String(response.status);
      stats.statuses[status] = (stats.statuses[status] ?? 0) + 1;
      if (response.status === 429) stats.rate_limited += 1;
      // Latency percentiles are over successful answers. Errors are counted by status instead.
      if (response.ok) {
        stats.ok += 1;
        stats.latencies.push(ms);
      }
      let json = null;
      try {
        json = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: response.status, ms, json };
    } catch {
      stats.network_errors += 1;
      stats.statuses.network = (stats.statuses.network ?? 0) + 1;
      return { status: 0, ms: performance.now() - started, json: null };
    } finally {
      inFlight -= 1;
    }
  }

  // Setup reads, not timed into any class.
  const version = await fetch(`${base}/version`, { headers: { "user-agent": USER_AGENT } })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  const boardsResponse = await fetch(`${base}/v1/boards`, {
    headers: { authorization: `Bearer ${agents[0].token}`, "user-agent": USER_AGENT },
  });
  if (boardsResponse.status !== 200) {
    throw new Error(`GET /v1/boards answered ${boardsResponse.status}: the seeded Credential does not authenticate`);
  }
  const boards = (await boardsResponse.json()).items ?? [];
  const board = boards.find((item) => item.state === "open");
  if (board === undefined) throw new Error("no open Board on the staging copy");

  const durationMs = minutes * 60_000;
  const startedAt = new Date();
  const t0 = performance.now();
  const threads = [];
  const threadByOperator = new Map();
  const assetIds = [];
  const uploads = [];
  const publishes = [];

  function rememberThread(threadId) {
    if (typeof threadId === "string" && !threads.includes(threadId)) threads.push(threadId);
  }

  async function oneRead(sequence) {
    const agent = agents[sequence % agents.length];
    let className = READ_CLASSES[sequence % READ_CLASSES.length];
    if (className === "thread_read" && threads.length === 0) className = "board_feed";
    if (className === "board_feed") {
      const result = await request("board_feed", `/v1/boards/${board.id}/threads?limit=20`, { agent });
      for (const item of result.json?.items ?? []) rememberThread(item.thread_id);
    } else if (className === "thread_read") {
      const threadId = threads[Math.floor(sequence / READ_CLASSES.length) % threads.length];
      const path = Math.floor(sequence / READ_CLASSES.length) % 2 === 0
        ? `/v1/threads/${threadId}`
        : `/v1/threads/${threadId}/posts?limit=20`;
      await request("thread_read", path, { agent });
    } else if (className === "events_poll") {
      await request("events_poll", "/v1/events?limit=50", { agent });
    } else {
      await request("agents_me", "/v1/agents/me", { agent });
    }
  }

  async function readLoad() {
    const interval = 1000 / rps;
    const pending = new Set();
    for (let sequence = 0; ; sequence += 1) {
      const due = t0 + sequence * interval;
      if (due - t0 >= durationMs) break;
      await sleep(due - performance.now());
      if (inFlight >= MAX_IN_FLIGHT) {
        readsDropped += 1;
        continue;
      }
      readsSent += 1;
      const task = oneRead(sequence).finally(() => pending.delete(task));
      pending.add(task);
    }
    await Promise.all(pending);
  }

  async function waitReady(agent, assetId, completedAt) {
    while (performance.now() - completedAt < READY_GIVE_UP_MS) {
      await sleep(1000);
      const status = await request("asset_status", `/v1/assets/${assetId}/status`, { agent });
      const state = status.json?.state;
      if (state === "ready") return { state, ms: performance.now() - completedAt };
      if (state === "rejected" || state === "quarantined") return { state, ms: performance.now() - completedAt, reason: status.json?.reason_code ?? null };
    }
    return { state: "timed_out", ms: READY_GIVE_UP_MS };
  }

  async function agentFlow(agent, startDelay) {
    await sleep(startDelay);
    const fixture = fixtures[agent.index % fixtures.length];
    const upload = { fixture: fixture.path, state: "not_started", ready_ms: null, total_ms: null, reason: null };
    uploads.push(upload);
    const began = performance.now();
    const reserved = await request("upload_reserve", "/v1/uploads", {
      method: "POST",
      agent,
      headers: { "idempotency-key": randomUUID() },
      body: { content_type: "image/webp", byte_size: fixture.bytes.byteLength, sha256: fixture.sha256 },
    });
    const assetId = reserved.json?.asset_id;
    if (reserved.status !== 201 || typeof assetId !== "string" || typeof reserved.json?.upload_token !== "string") {
      upload.state = `reserve_${reserved.status}`;
      return;
    }
    assetIds.push(assetId);
    const put = await request("upload_put", `/v1/uploads/${assetId}/content`, {
      method: "PUT",
      headers: {
        "idempotency-key": randomUUID(),
        "upload-token": reserved.json.upload_token,
        "content-type": "image/webp",
      },
      raw: fixture.bytes,
    });
    if (put.status !== 200) {
      upload.state = `put_${put.status}`;
      return;
    }
    const completed = await request("upload_complete", `/v1/uploads/${assetId}/complete`, {
      method: "POST",
      agent,
      headers: { "idempotency-key": randomUUID() },
    });
    if (completed.status !== 202) {
      upload.state = `complete_${completed.status}`;
      return;
    }
    // NFR-02: from the accepted upload to the Asset observed `ready`, polled once a second.
    const completedAt = performance.now();
    const ready = await waitReady(agent, assetId, completedAt);
    upload.state = ready.state;
    upload.ready_ms = Math.round(ready.ms);
    upload.total_ms = Math.round(performance.now() - began);
    upload.reason = ready.reason ?? null;
    if (ready.state !== "ready") return;

    const publish = { role: agent.role, state: "skipped", status: null, ack_ms: null };
    publishes.push(publish);
    if (agent.role === "skip") return;
    const declarations = {
      asset_id: assetId,
      alt_text: "A small test image",
      provenance: { source: "model", model: "loadtest-fixture" },
      rights_attestation: "Made for the staging load test.",
      license: "cc0",
    };
    let result;
    if (agent.role === "opener") {
      result = await request("publish", "/v1/threads", {
        method: "POST",
        agent,
        headers: { "idempotency-key": randomUUID() },
        body: { board_id: board.id, title: `Load test ${agent.index + 1}`, caption: "Staging load test.", ...declarations },
      });
      if (result.status === 201 && typeof result.json?.thread_id === "string") {
        threadByOperator.set(agent.operator, result.json.thread_id);
        rememberThread(result.json.thread_id);
      }
    } else {
      let threadId = threadByOperator.get(agent.operator);
      const waitUntil = performance.now() + 60_000;
      while (threadId === undefined && performance.now() < waitUntil) {
        await sleep(1000);
        threadId = threadByOperator.get(agent.operator) ?? threadByOperator.values().next().value;
      }
      if (threadId === undefined) {
        publish.state = "no_thread";
        return;
      }
      result = await request("publish", `/v1/threads/${threadId}/posts`, {
        method: "POST",
        agent,
        headers: { "idempotency-key": randomUUID() },
        body: { text: `Reply ${agent.index + 1}`, ...declarations },
      });
    }
    publish.status = result.status;
    publish.ack_ms = Math.round(result.ms);
    publish.state = result.status === 201 ? (result.json?.state ?? "created") : `status_${result.status}`;
  }

  // Openers start in the first tenth of the run, repliers across the next half, so every upload
  // and publish happens under the read load.
  const openerWindow = durationMs * 0.1;
  const replierWindow = durationMs * 0.5;
  const flows = agents.map((agent, position) => {
    const delay = agent.role === "opener"
      ? (openerWindow * (agent.operator + 1)) / (tokens.operators + 1)
      : openerWindow + (replierWindow * position) / agents.length;
    return agentFlow(agent, delay);
  });

  await Promise.all([readLoad(), ...flows]);
  const elapsedMs = performance.now() - t0;
  const finishedAt = new Date();

  const reads = Object.fromEntries(READ_CLASSES.map((name) => [name, summarize(classes[name])]));
  const allReads = newClass();
  for (const name of READ_CLASSES) {
    const stats = classes[name];
    allReads.count += stats.count;
    allReads.ok += stats.ok;
    allReads.latencies.push(...stats.latencies);
    allReads.rate_limited += stats.rate_limited;
    allReads.network_errors += stats.network_errors;
    for (const [status, count] of Object.entries(stats.statuses)) allReads.statuses[status] = (allReads.statuses[status] ?? 0) + count;
  }
  const readSummary = summarize(allReads);
  const publishSummary = summarize(classes.publish);
  const attemptedUploads = uploads.length;
  const ready = uploads.filter((upload) => upload.state === "ready");
  const readyWithin = ready.filter((upload) => upload.ready_ms !== null && upload.ready_ms <= READY_TARGET_MS);
  const readyShare = attemptedUploads === 0 ? 0 : readyWithin.length / attemptedUploads;
  const uploadStates = {};
  for (const upload of uploads) uploadStates[upload.state] = (uploadStates[upload.state] ?? 0) + 1;
  const publishStates = {};
  for (const publish of publishes) publishStates[publish.state] = (publishStates[publish.state] ?? 0) + 1;
  const totalRequests = Object.values(classes).reduce((sum, stats) => sum + stats.count, 0);
  const readRps = allReads.count / (Math.min(elapsedMs, durationMs) / 1000);
  const rateLimited = Object.fromEntries(Object.entries(classes).map(([name, stats]) => [name, stats.rate_limited]));
  const loadMatches = agents.length >= REQUIRED_AGENTS && readRps >= REQUIRED_RPS * 0.95;
  const publishP95 = publishSummary.p95_ms;

  const receipt = {
    message: "nfr loadtest receipt",
    issue: 81,
    target_kind: "ephemeral workers.dev staging copy",
    spec: version?.spec ?? null,
    build: version?.build ?? null,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    requested: { agents: agents.length, rps, minutes },
    observed: {
      agents: agents.length,
      operators: tokens.operators,
      read_duration_s: Math.round(Math.min(elapsedMs, durationMs) / 100) / 10,
      wall_duration_s: Math.round(elapsedMs / 100) / 10,
      read_requests: allReads.count,
      read_requests_dropped: readsDropped,
      read_rps: Math.round(readRps * 100) / 100,
      total_requests: totalRequests,
      total_rps: Math.round((totalRequests / (elapsedMs / 1000)) * 100) / 100,
    },
    metadata_reads: { all: readSummary, ...reads },
    publish_ack: { ...publishSummary, attempted: publishes.length, by_state: publishStates },
    upload_steps: {
      reserve: summarize(classes.upload_reserve),
      put: summarize(classes.upload_put),
      complete: summarize(classes.upload_complete),
      status_poll: summarize(classes.asset_status),
    },
    assets: {
      attempted: attemptedUploads,
      by_state: uploadStates,
      ready: ready.length,
      ready_within_60s: readyWithin.length,
      share_ready_within_60s: Math.round(readyShare * 10000) / 10000,
      ready_ms_p50: percentile(ready.map((upload) => upload.ready_ms), 0.5),
      ready_ms_p95: percentile(ready.map((upload) => upload.ready_ms), 0.95),
      ready_ms_p99: percentile(ready.map((upload) => upload.ready_ms), 0.99),
      ready_ms_max: ready.length === 0 ? null : Math.max(...ready.map((upload) => upload.ready_ms)),
    },
    rate_limited_429: { total: Object.values(rateLimited).reduce((sum, count) => sum + count, 0), by_class: rateLimited },
    targets: {
      agents: REQUIRED_AGENTS,
      rps: REQUIRED_RPS,
      read_p95_ms_under: READ_P95_TARGET_MS,
      publish_ack_p95_ms_under: PUBLISH_ACK_TARGET_MS,
      ready_within_ms: READY_TARGET_MS,
      ready_share_at_least: READY_SHARE_TARGET,
    },
    load_matches_target: loadMatches,
    nfr_01_achieved: loadMatches && readSummary.p95_ms !== null && readSummary.p95_ms < READ_P95_TARGET_MS
      && publishP95 !== null && publishP95 < PUBLISH_ACK_TARGET_MS,
    nfr_02_achieved: loadMatches && attemptedUploads > 0 && readyShare >= READY_SHARE_TARGET,
  };

  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  for (const agent of agents) {
    if (serialized.includes(agent.token)) throw new Error("refusing to write a receipt that contains a Credential");
  }
  writeFileSync(out, serialized);
  if (assetsOut !== null) writeFileSync(assetsOut, assetIds.map((id) => `${id}\n`).join(""), { flag: "a" });
  console.log(JSON.stringify({ message: receipt.message, nfr_01_achieved: receipt.nfr_01_achieved, nfr_02_achieved: receipt.nfr_02_achieved, observed: receipt.observed }));

  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(receipt));

  const failedReads = allReads.count - allReads.ok - allReads.rate_limited;
  if (allReads.count > 0 && failedReads / allReads.count > 0.5) {
    console.error(`more than half of the metadata reads failed (${failedReads} of ${allReads.count}); the run is not a receipt`);
    process.exit(2);
  }
}

function cell(value) {
  return value === null || value === undefined ? "-" : String(value);
}

function errorsText(errors) {
  const entries = Object.entries(errors);
  return entries.length === 0 ? "none" : entries.map(([status, count]) => `${status}: ${count}`).join(", ");
}

export function summaryMarkdown(receipt) {
  const rows = [
    ["All metadata reads", receipt.metadata_reads.all],
    ["Board feed", receipt.metadata_reads.board_feed],
    ["Thread read", receipt.metadata_reads.thread_read],
    ["Events poll", receipt.metadata_reads.events_poll],
    ["agents/me", receipt.metadata_reads.agents_me],
    ["Publish acknowledgement", receipt.publish_ack],
  ];
  const lines = [
    "## Staging load test (NFR-01, NFR-02)",
    "",
    `Spec ${cell(receipt.spec)}, build ${cell(receipt.build)}. ${receipt.observed.agents} Agents, ${receipt.observed.operators} Operators, ${receipt.observed.read_rps} metadata reads/s over ${receipt.observed.read_duration_s} s (${receipt.observed.total_requests} requests in all).`,
    "",
    "| Class | Requests | OK | p50 ms | p95 ms | p99 ms | Errors by status | 429 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(([label, row]) => `| ${label} | ${row.requests} | ${row.ok} | ${cell(row.p50_ms)} | ${cell(row.p95_ms)} | ${cell(row.p99_ms)} | ${errorsText(row.errors_by_status)} | ${row.rate_limited_429} |`),
    "",
    `Assets: ${receipt.assets.ready_within_60s} of ${receipt.assets.attempted} ready within 60 s (${Math.round(receipt.assets.share_ready_within_60s * 1000) / 10}%), ready p95 ${cell(receipt.assets.ready_ms_p95)} ms. 429 answers in all: ${receipt.rate_limited_429.total}.`,
    "",
    `NFR-01 achieved: ${receipt.nfr_01_achieved}. NFR-02 achieved: ${receipt.nfr_02_achieved}. Load matched the target: ${receipt.load_matches_target}.`,
    "",
  ];
  return `${lines.join("\n")}\n`;
}

// Cloudflare API, only for emptying the copy's own bucket before it is deleted.
async function emptyBucket(args) {
  const bucket = argValue(args, "--bucket");
  if (!/^jchain-loadtest-[0-9]+$/.test(bucket)) throw new Error("--bucket must be a jchain-loadtest-<run id> bucket");
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required");
  const api = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${bucket}/objects`;
  const headers = { authorization: `Bearer ${token}` };
  const keys = new Set();
  const assetsPath = args.includes("--assets") ? resolve(argValue(args, "--assets")) : null;
  if (assetsPath !== null && existsSync(assetsPath)) {
    for (const id of readFileSync(assetsPath, "utf8").split("\n").map((line) => line.trim())) {
      if (!/^[0-9a-f-]{36}$/.test(id)) continue;
      for (const key of [`originals/${id}`, `originals/${id}/thumb`, `derivatives/${id}/display`, `derivatives/${id}/thumb`]) keys.add(key);
    }
  }
  let listed = false;
  let cursor = "";
  for (let page = 0; page < 100; page += 1) {
    const response = await fetch(`${api}?per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { headers })
      .catch(() => null);
    // A failed list (or a missing bucket) falls back to the keys derived from the Asset ids. The
    // bucket delete that follows fails loudly if anything is left.
    if (response === null || !response.ok) break;
    const body = await response.json().catch(() => null);
    if (!body?.success || !Array.isArray(body.result)) break;
    listed = true;
    for (const object of body.result) if (typeof object?.key === "string") keys.add(object.key);
    cursor = body.result_info?.cursor ?? "";
    if (!body.result_info?.is_truncated || !cursor) break;
  }
  console.log(`emptying ${bucket}: ${keys.size} keys (${listed ? "listed and" : "list unavailable,"} from the Asset ids)`);
  let failed = 0;
  const queue = [...keys];
  async function worker() {
    for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
      const path = key.split("/").map(encodeURIComponent).join("/");
      const response = await fetch(`${api}/${path}`, { method: "DELETE", headers }).catch(() => null);
      if (response === null || (!response.ok && response.status !== 404)) {
        failed += 1;
        console.error(`could not delete ${key}: ${response === null ? "network error" : response.status}`);
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  if (failed > 0) throw new Error(`${failed} objects could not be deleted from ${bucket}`);
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "seed") seed(rest);
  else if (command === "run") await run(rest);
  else if (command === "empty-bucket") await emptyBucket(rest);
  else throw new Error("usage: loadtest.mjs seed|run|empty-bucket ...");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
