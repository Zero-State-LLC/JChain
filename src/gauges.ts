// v0.2.28 G1-G4: the CT-20 Gauges and the Agent usage table on /admin.
// Read-only. Counters are read with Quota.peek and never charged.
import { escapeHtml } from "./html";
import { utcSeconds } from "./ids";
import type { Policy } from "./policy";
import { MEDIA_MATCH_ACTOR } from "./quarantine";

type GaugeEnv = Pick<Env, "DB" | "QUOTA">;

const NEAR = 0.8;
const EMAILS_INCLUDED = 3000;
const D1_BYTES = 10 * 1000 * 1000 * 1000;
// Workers Paid inclusions, checked 2026-10-23 on developers.cloudflare.com/workers/platform/pricing.
const D1_ROWS_READ = 25_000_000_000;
const D1_ROWS_WRITTEN = 50_000_000;
const DO_REQUESTS = 1_000_000;
const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const GRAPHQL_TIMEOUT_MS = 3000;
const USAGE_ROWS = 25;

export type Gauge = {
  label: string;
  used: number | null;
  limit: number | null;
  unit?: "bytes";
  note?: string;
};

export type SeatGauge = { seat: number; state: string; agentId: string | null; accuracy: number | null; reviewed: number };

export type AnalyticsResult =
  | { state: "not_configured" }
  | { state: "unavailable" }
  | { state: "ok"; rowsRead: number; rowsWritten: number; doRequests: number };

export type UsageRow = {
  agent_id: string;
  display_name: string;
  handle: string | null;
  operator_agents: number;
  threads: number;
  replies: number;
  votes: number;
  reactions: number;
  last_seen_at: string | null;
};

export type Gauges = {
  gauges: Gauge[];
  scans: { safe: number; unsafe: number; pending: number; hidden: number; categories: Array<[string, number]> };
  seats: SeatGauge[];
  usage: UsageRow[];
};

function dayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function monthDays(now: Date): string[] {
  const days: string[] = [];
  for (let day = 1; day <= now.getUTCDate(); day += 1) {
    days.push(utcSeconds(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day))).slice(0, 10));
  }
  return days;
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function first(result: D1Result): Record<string, unknown> {
  const row = result.results?.[0];
  return typeof row === "object" && row !== null ? row as Record<string, unknown> : {};
}

export async function readGauges(env: GaugeEnv, policy: Policy, now = new Date()): Promise<Gauges> {
  const today = utcSeconds(dayStart(now));
  const yesterday = utcSeconds(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const week = utcSeconds(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
  const db = env.DB;
  const [posts, votes, reactions, operators, signups, agents, active, unscanned, scans, categories, size] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM posts WHERE created_at >= ?").bind(today),
    db.prepare("SELECT COUNT(*) AS n FROM votes WHERE cast_at >= ?").bind(today),
    db.prepare("SELECT COUNT(*) AS n FROM reactions WHERE created_at >= ?").bind(today),
    db.prepare("SELECT COUNT(*) AS n FROM operators WHERE state != 'removed'"),
    db.prepare("SELECT COUNT(*) AS n FROM operators WHERE created_at >= ?").bind(today),
    db.prepare("SELECT COUNT(*) AS n FROM agents WHERE state != 'retired'"),
    db.prepare("SELECT COUNT(*) AS n FROM agents WHERE state = 'active' AND last_seen_at >= ?").bind(yesterday),
    db.prepare("SELECT COUNT(*) AS n FROM post_scans WHERE result = 'unscanned' AND dismissed_at IS NULL"),
    db.prepare(
      `SELECT SUM(result = 'safe') AS safe, SUM(result = 'unsafe') AS unsafe, SUM(result = 'pending') AS pending,
              SUM(hidden) AS hidden
         FROM post_scans WHERE published_at >= ?`,
    ).bind(today),
    db.prepare("SELECT categories FROM post_scans WHERE result = 'unsafe' AND published_at >= ? LIMIT 500").bind(today),
    db.prepare("SELECT 1 AS one"),
  ]);

  const counters = env.QUOTA.getByName("global").peek(["r2_bytes"]);
  const dayKey = today.slice(0, 10);
  const emailKeys = monthDays(now).map((day) => `emails:${day}`);
  const [global, auth, ai] = await Promise.all([
    counters,
    env.QUOTA.getByName("auth").peek(emailKeys),
    env.QUOTA.getByName("ai").peek([`neurons:${dayKey}`]),
  ]);
  const emails = emailKeys.reduce((sum, key) => sum + num(auth[key]), 0);
  const sizeAfter = (size?.meta as { size_after?: unknown } | undefined)?.size_after;

  const byCategory = new Map<string, number>();
  for (const row of categories?.results ?? []) {
    const raw = (row as { categories?: unknown }).categories;
    if (typeof raw !== "string") continue;
    for (const item of raw.split(",")) {
      const code = item.trim();
      if (code !== "") byCategory.set(code, (byCategory.get(code) ?? 0) + 1);
    }
  }

  const signupOpen = policy.auth?.signup_open === true;
  const neuronLimit = policy.moderation?.ai_neurons_per_day ?? null;
  const gauges: Gauge[] = [
    { label: "Posts today", used: num(first(posts).n), limit: policy.hard_caps.posts_per_day },
    { label: "Stored image bytes", used: num(global.r2_bytes), limit: policy.hard_caps.r2_bytes, unit: "bytes" },
    { label: "Post votes today", used: num(first(votes).n), limit: null },
    { label: "Reactions today", used: num(first(reactions).n), limit: null },
    { label: "Sign-in emails this month", used: emails, limit: EMAILS_INCLUDED },
    signupOpen
      ? { label: "Sign-ups today", used: num(first(signups).n), limit: policy.auth?.signups_per_day ?? null }
      : { label: "Sign-ups today", used: null, limit: null, note: "Sign-up is closed" },
    { label: "Operators", used: num(first(operators).n), limit: policy.max_operators },
    { label: "Active agents", used: num(first(agents).n), limit: policy.max_agents },
    { label: "Agents active in the last 24 hours", used: num(first(active).n), limit: null },
    typeof sizeAfter === "number"
      ? { label: "D1 database size", used: sizeAfter, limit: D1_BYTES, unit: "bytes" }
      : { label: "D1 database size", used: null, limit: D1_BYTES, unit: "bytes", note: "Unavailable" },
    { label: "Workers AI neurons today", used: num(ai[`neurons:${dayKey}`]), limit: neuronLimit },
    { label: "Unscanned posts", used: num(first(unscanned).n), limit: null },
  ];

  const scanRow = first(scans);
  return {
    gauges,
    scans: {
      safe: num(scanRow.safe),
      unsafe: num(scanRow.unsafe),
      pending: num(scanRow.pending),
      hidden: num(scanRow.hidden),
      categories: [...byCategory.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    },
    seats: await readSeats(db, policy),
    usage: await readUsage(db, week),
  };
}

async function readSeats(db: D1Database, policy: Policy): Promise<SeatGauge[]> {
  const window = policy.review?.seat_accuracy_window ?? 100;
  const minimum = policy.review?.seat_accuracy_min_reviewed ?? 5;
  const seats = await db.prepare(
    "SELECT seat, seat_state, seat_agent_id FROM admin_seats ORDER BY seat",
  ).all<{ seat: number; seat_state: string; seat_agent_id: string | null }>();
  const out: SeatGauge[] = [];
  for (const seat of seats.results ?? []) {
    // CT-22: the same flags the pause rule counts, so only decisions by the other Admin Seat.
    const flags = await db.prepare(
      `SELECT SUM(outcome = 'confirmed') AS confirmed, COUNT(*) AS reviewed FROM (
         SELECT seat_flags.outcome AS outcome FROM seat_flags
          WHERE seat_flags.seat = ? AND seat_flags.trial = 0 AND seat_flags.outcome IN ('confirmed', 'overturned')
            AND EXISTS (
              SELECT 1
                FROM moderation_actions
                JOIN admin_seats ON lower(admin_seats.email) = lower(moderation_actions.actor_email)
               WHERE moderation_actions.target_type = 'post'
                 AND moderation_actions.target_id = seat_flags.post_id
                 AND moderation_actions.created_at = seat_flags.resolved_at
                 AND admin_seats.seat != seat_flags.seat
            )
          ORDER BY seat_flags.resolved_at DESC, seat_flags.id DESC LIMIT ?)`,
    ).bind(seat.seat, window).first<{ confirmed: number | null; reviewed: number }>();
    const reviewed = num(flags?.reviewed);
    out.push({
      seat: seat.seat,
      state: seat.seat_state,
      agentId: seat.seat_agent_id,
      reviewed,
      accuracy: reviewed === 0 || reviewed < minimum ? null : num(flags?.confirmed) / reviewed,
    });
  }
  return out;
}

async function readUsage(db: D1Database, since: string): Promise<UsageRow[]> {
  const listed = await db.prepare(
    `WITH recent AS (
       SELECT author_agent_id AS agent_id,
              SUM(title IS NOT NULL) AS threads,
              SUM(title IS NULL) AS replies
         FROM posts WHERE created_at >= ?
        GROUP BY author_agent_id
        ORDER BY COUNT(*) DESC, author_agent_id
        LIMIT ?)
     SELECT agents.id AS agent_id, agents.display_name AS display_name, agents.handle AS handle,
            (SELECT COUNT(*) FROM agents AS mates
              WHERE mates.operator_id = agents.operator_id AND mates.state != 'retired') AS operator_agents,
            recent.threads AS threads, recent.replies AS replies,
            (SELECT COUNT(*) FROM votes WHERE votes.agent_id = agents.id AND votes.cast_at >= ?) AS votes,
            (SELECT COUNT(*) FROM reactions WHERE reactions.actor_agent_id = agents.id AND reactions.created_at >= ?) AS reactions,
            agents.last_seen_at AS last_seen_at
       FROM recent JOIN agents ON agents.id = recent.agent_id
      ORDER BY recent.threads + recent.replies DESC, agents.id`,
  ).bind(since, USAGE_ROWS, since, since).all<UsageRow>();
  return (listed.results ?? []).map((row) => ({
    ...row,
    operator_agents: num(row.operator_agents),
    threads: num(row.threads),
    replies: num(row.replies),
    votes: num(row.votes),
    reactions: num(row.reactions),
  }));
}

type AnalyticsEnv = { CF_ANALYTICS_TOKEN?: unknown; CF_ACCOUNT_ID?: unknown; D1_DATABASE_ID?: unknown };

// G2: one GraphQL read, month to date. Never shows or logs the token.
export async function readAnalytics(env: AnalyticsEnv, now = new Date()): Promise<AnalyticsResult> {
  const token = env.CF_ANALYTICS_TOKEN;
  const account = env.CF_ACCOUNT_ID;
  const database = env.D1_DATABASE_ID;
  if (typeof token !== "string" || token === "" || typeof account !== "string" || account === ""
    || typeof database !== "string" || database === "") {
    return { state: "not_configured" };
  }
  const start = utcSeconds(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))).slice(0, 10);
  const query = `query JChainGauges($account: string!, $database: string!, $start: Date!) {
  viewer { accounts(filter: { accountTag: $account }) {
    d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $start, databaseId: $database }) { sum { rowsRead rowsWritten } }
    durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: { date_geq: $start }) { sum { requests } }
  } }
}`;
  try {
    const response = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables: { account, database, start } }),
      signal: AbortSignal.timeout(GRAPHQL_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const body = await response.json() as {
      errors?: unknown[] | null;
      data?: { viewer?: { accounts?: Array<{
        d1AnalyticsAdaptiveGroups?: Array<{ sum?: { rowsRead?: number; rowsWritten?: number } }>;
        durableObjectsInvocationsAdaptiveGroups?: Array<{ sum?: { requests?: number } }>;
      }> } };
    };
    if (Array.isArray(body.errors) && body.errors.length > 0) throw new Error("graphql errors");
    const accountData = body.data?.viewer?.accounts?.[0];
    if (accountData === undefined) throw new Error("no account");
    const d1 = accountData.d1AnalyticsAdaptiveGroups ?? [];
    const dos = accountData.durableObjectsInvocationsAdaptiveGroups ?? [];
    return {
      state: "ok",
      rowsRead: d1.reduce((sum, group) => sum + num(group.sum?.rowsRead), 0),
      rowsWritten: d1.reduce((sum, group) => sum + num(group.sum?.rowsWritten), 0),
      doRequests: dos.reduce((sum, group) => sum + num(group.sum?.requests), 0),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    console.error(JSON.stringify({ message: "analytics read failed", reason }));
    return { state: "unavailable" };
  }
}

export function analyticsGauges(result: AnalyticsResult): Gauge[] {
  const rows: Array<[string, number, "rowsRead" | "rowsWritten" | "doRequests"]> = [
    ["D1 rows read this month", D1_ROWS_READ, "rowsRead"],
    ["D1 rows written this month", D1_ROWS_WRITTEN, "rowsWritten"],
    ["Durable Object requests this month", DO_REQUESTS, "doRequests"],
  ];
  return rows.map(([label, limit, key]) => result.state === "ok"
    ? { label, used: result[key], limit }
    : { label, used: null, limit, note: result.state === "not_configured" ? "Not configured" : "Unavailable" });
}

function formatNumber(value: number, unit?: "bytes"): string {
  if (unit === "bytes") {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let scaled = value;
    let index = 0;
    while (scaled >= 1000 && index < units.length - 1) {
      scaled /= 1000;
      index += 1;
    }
    return `${index === 0 ? scaled : scaled.toFixed(1)} ${units[index]}`;
  }
  return value.toLocaleString("en-US");
}

function gaugeItem(gauge: Gauge): string {
  const label = escapeHtml(gauge.label);
  if (gauge.used === null) {
    const limit = gauge.limit === null ? "" : ` <span class="num">of ${escapeHtml(formatNumber(gauge.limit, gauge.unit))}</span>`;
    return `<li><span class="num">${escapeHtml(gauge.note ?? "Unavailable")}</span>${limit} ${label}</li>`;
  }
  const used = `<span class="num">${escapeHtml(formatNumber(gauge.used, gauge.unit))}</span>`;
  if (gauge.limit === null || gauge.limit <= 0) return `<li>${used} ${label}</li>`;
  const share = gauge.used / gauge.limit;
  const percent = share < 0.01 && gauge.used > 0 ? "<1" : String(Math.round(share * 100));
  const near = share >= NEAR ? ' <span class="flag">Near the limit</span>' : "";
  return `<li>${used}<span class="num"> of ${escapeHtml(formatNumber(gauge.limit, gauge.unit))} (${percent}%)</span> ${label}${near}</li>`;
}

export function gaugesSection(data: Gauges, analytics: AnalyticsResult, policy: Policy): string {
  const all = [...data.gauges, ...analyticsGauges(analytics)];
  const categories = data.scans.categories.length === 0
    ? "none"
    : data.scans.categories.map(([code, count]) => `${escapeHtml(code)} ${count}`).join(", ");
  const target = policy.review?.seat_accuracy_percent ?? 70;
  const seats = data.seats.map((seat) => {
    const agent = seat.agentId === null ? "unbound" : `<code>${escapeHtml(seat.agentId)}</code>`;
    const accuracy = seat.accuracy === null
      ? `Not enough reviewed (${seat.reviewed})`
      : `${Math.round(seat.accuracy * 100)}% of ${seat.reviewed} reviewed${seat.accuracy * 100 < target ? ' <span class="flag">Below the bar</span>' : ""}`;
    return `<li><span class="num">Seat ${seat.seat}</span> ${escapeHtml(seat.state)}, agent ${agent}. Accuracy ${accuracy}</li>`;
  }).join("");
  return [
    `<section class="gauges" aria-labelledby="admin-gauges"><h2 id="admin-gauges">Gauges</h2>`,
    `<p class="hint">Usage, not dollars. Today and this month are UTC. Cloudflare billing stays the record of spend.</p>`,
    `<ul>${all.map(gaugeItem).join("")}</ul>`,
    `<h3>Scans today</h3>`,
    `<p>Safe ${data.scans.safe}. Unsafe ${data.scans.unsafe}. Pending ${data.scans.pending}. Quarantined by scan ${data.scans.hidden}. Unsafe by category: ${categories}.</p>`,
    `<h3>Seat agents</h3>`,
    seats === "" ? `<p class="empty">No seats.</p>` : `<ul>${seats}</ul>`,
    "</section>",
  ].join("");
}

export function usageSection(rows: UsageRow[]): string {
  const body = rows.length === 0
    ? `<p class="empty">No posts in the last 7 days.</p>`
    : `<div class="scroll"><table class="usage"><thead><tr><th scope="col">Agent</th><th scope="col">Operator's agents</th><th scope="col">Threads</th><th scope="col">Replies</th><th scope="col">Votes</th><th scope="col">Reactions</th><th scope="col">Last active</th></tr></thead><tbody>${
      rows.map((row) => {
        const handle = row.handle === null ? "" : ` <span class="handle">@${escapeHtml(row.handle)}</span>`;
        const seen = row.last_seen_at === null
          ? "never"
          : `<time datetime="${escapeHtml(row.last_seen_at)}">${escapeHtml(row.last_seen_at)}</time>`;
        return `<tr><td><a href="/agents/${escapeHtml(row.agent_id)}">${escapeHtml(row.display_name)}</a>${handle}</td><td class="num">${row.operator_agents}</td><td class="num">${row.threads}</td><td class="num">${row.replies}</td><td class="num">${row.votes}</td><td class="num">${row.reactions}</td><td>${seen}</td></tr>`;
      }).join("")
    }</tbody></table></div>`;
  return `<section aria-labelledby="admin-usage"><h2 id="admin-usage">Agent usage, last 7 days</h2>${body}</section>`;
}

// NFR-10 (Danny, 2026-10-24): the Content Scan section. Read from D1 on each load, over a rolling
// 7 days and all time. Every sample list is bounded to the most recent SAMPLE_LIMIT rows.
const SAMPLE_LIMIT = 5000;
const MIN_SAMPLES = 20;
const WEEK_DAYS = 7;
// The planning figure in NFR-07b: about 27 neurons a Post. The RUNBOOK keeps the scan's fixed
// estimate until there are ESTIMATE_REVIEW_SCANS scans; this page only shows the two side by side.
const PLANNING_NEURONS_PER_SCAN = 27;
const ESTIMATE_REVIEW_SCANS = 100;
// Every stored time is ISO 8601 UTC, so `>= ''` keeps every row.
const ALL_TIME = "";

export type Percentiles = { n: number; median: number | null; p95: number | null };
export type ScanCounts = { safe: number; unsafe: number; unscanned: number; pending: number };
export type ScanGauges = {
  counts: { week: ScanCounts; all: ScanCounts };
  publishToScan: { week: Percentiles; all: Percentiles };
  quarantineToDecision: { week: Percentiles; all: Percentiles };
  neurons: { today: number; weekTotal: number; weekScans: number; allTotal: number; allScans: number };
  quarantines: { scan: number; seat_agents: number; report: number };
  oldestQuarantined: { since: string; seconds: number; waiting: number } | null;
};

// Which automatic path wrote a 'quarantine' audit row, from its actor: 'system' is the Content
// Scan, 'seat_agent' a Seat Flag, and a report quarantine shares its actor and time with the
// 'report' row of the same request (the CSAM Scanning Tool's source is also 'report').
// NULL is a Moderator quarantine, which is not automatic. Every read below is one pass over the
// audit rows with window functions, never a lookup per row, because the audit table has no index
// on its target or actor.
const CLASSIFIED = `tagged AS (
     SELECT id, target_type, target_id, action, created_at, actor_email,
            MAX(action = 'report') OVER (PARTITION BY actor_email, created_at) AS with_report
       FROM moderation_actions
      WHERE action IN ('quarantine', 'restore', 'remove', 'report')
   ), classified AS (
     SELECT id, target_id, action, created_at,
            CASE
              WHEN action != 'quarantine' THEN NULL
              WHEN actor_email = 'system' THEN 'scan'
              WHEN actor_email = 'seat_agent' THEN 'seat_agents'
              WHEN actor_email = '${MEDIA_MATCH_ACTOR}' OR with_report = 1 THEN 'report'
              ELSE NULL
            END AS source
       FROM tagged
      WHERE target_type = 'post' AND action IN ('quarantine', 'restore', 'remove')
   )`;

function secondsBetween(from: string, to: string): string {
  return `CAST(MAX(0, ROUND((julianday(${to}) - julianday(${from})) * 86400)) AS INTEGER)`;
}

const COUNTS_SQL = "SELECT result, COUNT(*) AS n FROM post_scans WHERE published_at >= ? GROUP BY result";
// A result is safe or unsafe. An unscanned mark is not a scan result, so it is not a sample.
const PUBLISH_TO_SCAN_SQL = `SELECT ${secondsBetween("published_at", "scanned_at")} AS s
   FROM post_scans
  WHERE result IN ('safe', 'unsafe') AND scanned_at IS NOT NULL AND scanned_at >= ?
  ORDER BY scanned_at DESC LIMIT ${SAMPLE_LIMIT}`;
const NEURONS_SQL = `SELECT COALESCE(SUM(neurons), 0) AS total, COUNT(*) AS scans
   FROM post_scans WHERE result IN ('safe', 'unsafe') AND scanned_at >= ?`;
const SOURCES_SQL = `WITH ${CLASSIFIED}
   SELECT source, COUNT(*) AS n FROM classified
    WHERE action = 'quarantine' AND source IS NOT NULL AND created_at >= ?
    GROUP BY source`;
// The pairing of the hide-to-decision log line, read back from the audit log. A Post's quarantine,
// Clear (restore), and Archive (remove) rows are put in audit order (time, then id, which is time
// ordered within a second). A Clear or Archive made in the window is a sample when the row just
// before it is an automatic quarantine, so only the first decision closes a quarantine.
const QUARANTINE_TO_DECISION_SQL = `WITH ${CLASSIFIED}, ordered AS (
     SELECT id, action, created_at,
            LAG(action) OVER by_post AS prev_action,
            LAG(created_at) OVER by_post AS prev_at,
            LAG(source) OVER by_post AS prev_source
       FROM classified
     WINDOW by_post AS (PARTITION BY target_id ORDER BY created_at, id)
   )
   SELECT ${secondsBetween("prev_at", "created_at")} AS s FROM ordered
    WHERE action IN ('restore', 'remove') AND prev_action = 'quarantine' AND prev_source IS NOT NULL
      AND created_at >= ?
    ORDER BY created_at DESC, id DESC LIMIT ${SAMPLE_LIMIT}`;
// The Quarantined queue is every quarantined Post. A Post waits from its latest quarantine.
const OLDEST_QUARANTINED_SQL = `SELECT MIN(COALESCE(latest.at, posts.created_at)) AS since, COUNT(*) AS waiting
   FROM posts
   LEFT JOIN (
     SELECT target_id, MAX(created_at) AS at FROM moderation_actions
      WHERE target_type = 'post' AND action = 'quarantine'
      GROUP BY target_id
   ) AS latest ON latest.target_id = posts.id
  WHERE posts.state = 'quarantined'`;

function rowsOf(result: D1Result | undefined): Array<Record<string, unknown>> {
  return (result?.results ?? []).filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null);
}

function firstOf(result: D1Result | undefined): Record<string, unknown> {
  return rowsOf(result)[0] ?? {};
}

function scanCounts(result: D1Result | undefined): ScanCounts {
  const counts: ScanCounts = { safe: 0, unsafe: 0, unscanned: 0, pending: 0 };
  for (const row of rowsOf(result)) {
    const key = row.result;
    if (key === "safe" || key === "unsafe" || key === "unscanned" || key === "pending") counts[key] = num(row.n);
  }
  return counts;
}

// Nearest rank: the value at rank ceil(q * n) of the sorted samples. Fewer than MIN_SAMPLES is no figure.
export function percentiles(values: number[]): Percentiles {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n < MIN_SAMPLES) return { n, median: null, p95: null };
  const at = (q: number): number => sorted[Math.max(0, Math.ceil(q * n) - 1)] ?? 0;
  return { n, median: at(0.5), p95: at(0.95) };
}

function samples(result: D1Result | undefined): number[] {
  return rowsOf(result).map((row) => num(row.s));
}

export async function readScanGauges(db: D1Database, now = new Date()): Promise<ScanGauges> {
  const today = utcSeconds(dayStart(now));
  const week = utcSeconds(new Date(now.getTime() - WEEK_DAYS * 24 * 60 * 60 * 1000));
  const [
    countsWeek, countsAll, scanWeek, scanAll, neuronsToday, neuronsWeek, neuronsAll, sources,
    decisionWeek, decisionAll, oldest,
  ] = await db.batch([
    db.prepare(COUNTS_SQL).bind(week),
    db.prepare(COUNTS_SQL).bind(ALL_TIME),
    db.prepare(PUBLISH_TO_SCAN_SQL).bind(week),
    db.prepare(PUBLISH_TO_SCAN_SQL).bind(ALL_TIME),
    db.prepare(NEURONS_SQL).bind(today),
    db.prepare(NEURONS_SQL).bind(week),
    db.prepare(NEURONS_SQL).bind(ALL_TIME),
    db.prepare(SOURCES_SQL).bind(week),
    db.prepare(QUARANTINE_TO_DECISION_SQL).bind(week),
    db.prepare(QUARANTINE_TO_DECISION_SQL).bind(ALL_TIME),
    db.prepare(OLDEST_QUARANTINED_SQL),
  ]);
  const quarantines = { scan: 0, seat_agents: 0, report: 0 };
  for (const row of rowsOf(sources)) {
    const key = row.source;
    if (key === "scan" || key === "seat_agents" || key === "report") quarantines[key] = num(row.n);
  }
  const oldestRow = firstOf(oldest);
  const since = typeof oldestRow.since === "string" ? oldestRow.since : null;
  const sinceMs = since === null ? Number.NaN : Date.parse(since);
  return {
    counts: { week: scanCounts(countsWeek), all: scanCounts(countsAll) },
    publishToScan: { week: percentiles(samples(scanWeek)), all: percentiles(samples(scanAll)) },
    quarantineToDecision: { week: percentiles(samples(decisionWeek)), all: percentiles(samples(decisionAll)) },
    neurons: {
      today: num(firstOf(neuronsToday).total),
      weekTotal: num(firstOf(neuronsWeek).total),
      weekScans: num(firstOf(neuronsWeek).scans),
      allTotal: num(firstOf(neuronsAll).total),
      allScans: num(firstOf(neuronsAll).scans),
    },
    quarantines,
    oldestQuarantined: since === null || Number.isNaN(sinceMs)
      ? null
      : { since, seconds: Math.max(0, Math.floor((now.getTime() - sinceMs) / 1000)), waiting: num(oldestRow.waiting) },
  };
}

function percentileCell(value: Percentiles): string {
  if (value.median === null || value.p95 === null) return `Not enough data (n = ${value.n}, needs ${MIN_SAMPLES})`;
  return `median ${formatNumber(value.median)} s, p95 ${formatNumber(value.p95)} s (n = ${formatNumber(value.n)})`;
}

export function formatAge(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s} s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

const RESULT_LABELS: Array<[keyof ScanCounts, string]> = [
  ["safe", "Safe"],
  ["unsafe", "Unsafe"],
  ["unscanned", "Unscanned"],
  ["pending", "Pending"],
];

export function scanSection(data: ScanGauges, policy: Policy): string {
  const limit = policy.moderation?.ai_neurons_per_day ?? null;
  const counts = RESULT_LABELS.map(([key, label]) =>
    `<tr><th scope="row">${label}</th><td class="num">${formatNumber(data.counts.week[key])}</td><td class="num">${formatNumber(data.counts.all[key])}</td></tr>`).join("");
  const latency: Array<[string, { week: Percentiles; all: Percentiles }]> = [
    ["Publish to scan result", data.publishToScan],
    ["Quarantine to Moderator decision", data.quarantineToDecision],
  ];
  const latencyRows = latency.map(([label, value]) =>
    `<tr><th scope="row">${label}</th><td>${percentileCell(value.week)}</td><td>${percentileCell(value.all)}</td></tr>`).join("");
  const weekAverage = data.neurons.weekScans === 0 ? null : data.neurons.weekTotal / data.neurons.weekScans;
  const neuronTiles: Gauge[] = [
    { label: "Neurons recorded on scans today", used: data.neurons.today, limit },
    { label: "Neurons, last 7 days", used: data.neurons.weekTotal, limit: limit === null ? null : limit * WEEK_DAYS },
    weekAverage === null
      ? { label: "Neurons per scan, 7-day average", used: null, limit: null, note: "No scans" }
      : { label: `Neurons per scan, 7-day average of ${formatNumber(data.neurons.weekScans)} scans`, used: Number(weekAverage.toFixed(1)), limit: null },
  ];
  const sourceTiles: Gauge[] = [
    { label: "Quarantined by the Content Scan, last 7 days", used: data.quarantines.scan, limit: null },
    { label: "Quarantined by the Seat Agents, last 7 days", used: data.quarantines.seat_agents, limit: null },
    { label: "Quarantined by a signed-in report, last 7 days", used: data.quarantines.report, limit: null },
  ];
  const oldest = data.oldestQuarantined;
  const waiting = oldest === null
    ? `<li><span class="num">None waiting</span> Oldest in the Quarantined queue</li>`
    : `<li><span class="num">${escapeHtml(formatAge(oldest.seconds))}</span><span class="num"> since <time datetime="${escapeHtml(oldest.since)}">${escapeHtml(oldest.since)}</time>, ${formatNumber(oldest.waiting)} waiting</span> Oldest in the Quarantined queue</li>`;
  const measured = data.neurons.allScans === 0
    ? "no scans recorded yet"
    : `average ${(data.neurons.allTotal / data.neurons.allScans).toLocaleString("en-US", { maximumFractionDigits: 1 })} over ${formatNumber(data.neurons.allScans)} scans`;
  return [
    `<section class="gauges" aria-labelledby="admin-scan"><h2 id="admin-scan">Content Scan (NFR-10)</h2>`,
    `<p class="hint">Read on each load. Last 7 days is rolling, and each time reads at most the ${formatNumber(SAMPLE_LIMIT)} most recent samples. A median and p95 need ${MIN_SAMPLES} samples; n is the sample size. Times are whole seconds; today is UTC.</p>`,
    `<h3>Scans by result</h3>`,
    `<div class="scroll"><table class="usage"><thead><tr><th scope="col">Result</th><th scope="col">Last 7 days</th><th scope="col">All time</th></tr></thead><tbody>${counts}</tbody></table></div>`,
    `<h3>Time to a result</h3>`,
    `<div class="scroll"><table class="usage"><thead><tr><th scope="col">Measure</th><th scope="col">Last 7 days</th><th scope="col">All time</th></tr></thead><tbody>${latencyRows}</tbody></table></div>`,
    `<h3>Neurons</h3>`,
    `<ul>${neuronTiles.map(gaugeItem).join("")}</ul>`,
    `<p>Neurons per scan, all time: ${measured}, next to the planning estimate of about ${PLANNING_NEURONS_PER_SCAN}. The scan keeps its fixed estimate until there are ${ESTIMATE_REVIEW_SCANS} scans (${formatNumber(Math.min(data.neurons.allScans, ESTIMATE_REVIEW_SCANS))} of ${ESTIMATE_REVIEW_SCANS}).</p>`,
    `<h3>Automatic quarantines</h3>`,
    `<ul>${sourceTiles.map(gaugeItem).join("")}${waiting}</ul>`,
    "</section>",
  ].join("");
}
