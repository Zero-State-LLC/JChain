// v0.2.28 G1-G4: the CT-20 Gauges and the Agent usage table on /admin.
// Read-only. Counters are read with Quota.peek and never charged.
import { escapeHtml } from "./html";
import { utcSeconds } from "./ids";
import type { Policy } from "./policy";

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
