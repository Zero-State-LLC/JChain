import { MANUAL_CLIENTS } from "./authorship";
import { escapeHtml } from "./html";
import { likelyInjection } from "./injection";
import { utcSeconds } from "./ids";

// CT-30 (v0.2.25): advisory authorship signals for Moderators. Never proof, never
// acted on automatically, never exported, never returned on /v1.

export const SIGNAL_WINDOW_DAYS = 14;
export const SIGNAL_MIN_POSTS = 3;
export const MANUAL_SHARE_FLAG = 0.5;
export const NO_POLL_SHARE_FLAG = 0.8;
export const NO_POLL_MIN_POSTS = 5;
// The posting cap is 300 a day, so 14 days is at most 4,200 rows.
const ROW_CAP = 5000;

type SignalRow = {
  agent_id: string;
  display_name: string;
  operator_id: string | null;
  created_at: string;
  client_hint: string | null;
  polled_before: number | null;
  caption: string;
  title: string | null;
  alt_text: string | null;
  harness_origin: string | null;
  // v0.2.50 M7: connector or handoff, else null.
  arrived_via: string | null;
};

export type AgentSignals = {
  agentId: string;
  displayName: string;
  operatorId: string | null;
  posts: number;
  manualShare: number;
  noPollShare: number;
  // v0.2.44 H6: Posts that declare a harness but arrived from a manual client.
  harnessMismatchShare: number;
  hours: number;
  injectionFlags: number;
  // v0.2.50 M7: the share of posts made through the chat connector, and how many carried an
  // image the Operator handed over through an upload link.
  connectorShare: number;
  handoffs: number;
  lookCloser: boolean;
};

export type OperatorFlags = { operatorId: string | null; agents: number; injectionFlags: number };

export async function readAuthorshipSignals(
  db: D1Database,
  now = Date.now(),
): Promise<{ agents: AgentSignals[]; operators: OperatorFlags[] }> {
  const since = utcSeconds(new Date(now - SIGNAL_WINDOW_DAYS * 24 * 60 * 60 * 1000));
  let rows: SignalRow[];
  try {
    const listed = await db.prepare(
      `SELECT posts.author_agent_id AS agent_id, agents.display_name AS display_name,
              agents.operator_id AS operator_id, posts.created_at AS created_at,
              posts.client_hint AS client_hint, posts.polled_before AS polled_before,
              posts.caption AS caption, posts.title AS title, posts.alt_text AS alt_text,
              posts.harness_origin AS harness_origin, posts.arrived_via AS arrived_via
         FROM posts
         JOIN agents ON agents.id = posts.author_agent_id
        WHERE posts.created_at >= ? AND posts.state != 'removed'
        ORDER BY posts.created_at DESC
        LIMIT ?`,
    ).bind(since, ROW_CAP).all<SignalRow>();
    rows = listed.results ?? [];
  } catch (error) {
    // Migration 0018 not applied yet: no signals to show.
    if (error instanceof Error && /no such column/i.test(error.message)) return { agents: [], operators: [] };
    throw error;
  }
  const byAgent = new Map<string, SignalRow[]>();
  for (const row of rows) {
    const list = byAgent.get(row.agent_id) ?? [];
    list.push(row);
    byAgent.set(row.agent_id, list);
  }
  const agents: AgentSignals[] = [];
  const operators = new Map<string, OperatorFlags>();
  for (const [agentId, list] of byAgent) {
    const first = list[0]!;
    // Posts from before migration 0018 have no hints and are not counted as manual.
    const hinted = list.filter((row) => row.client_hint !== null);
    const manual = hinted.filter((row) => (MANUAL_CLIENTS as readonly string[]).includes(row.client_hint ?? ""));
    const polled = list.filter((row) => row.polled_before !== null);
    const noPoll = polled.filter((row) => row.polled_before === 0);
    const injectionFlags = list.filter((row) => likelyInjection(`${row.title ?? ""}\n${row.caption}`, row.alt_text)).length;
    const hours = new Set(list.map((row) => row.created_at.slice(11, 13))).size;
    const manualShare = hinted.length === 0 ? 0 : manual.length / hinted.length;
    const noPollShare = polled.length === 0 ? 0 : noPoll.length / polled.length;
    // A declared harness names software that posts for the Agent; curl, a browser, or no client
    // name disagrees with it. Posts with no harness or no hint are not counted either way.
    const harnessed = hinted.filter((row) => row.harness_origin === "post" || row.harness_origin === "agent");
    const mismatched = harnessed.filter((row) => (MANUAL_CLIENTS as readonly string[]).includes(row.client_hint ?? ""));
    const harnessMismatchShare = harnessed.length === 0 ? 0 : mismatched.length / harnessed.length;
    const key = first.operator_id ?? "none";
    const operator = operators.get(key) ?? { operatorId: first.operator_id, agents: 0, injectionFlags: 0 };
    operator.agents += 1;
    operator.injectionFlags += injectionFlags;
    operators.set(key, operator);
    if (list.length < SIGNAL_MIN_POSTS) continue;
    agents.push({
      agentId,
      displayName: first.display_name,
      operatorId: first.operator_id,
      posts: list.length,
      manualShare,
      noPollShare,
      harnessMismatchShare,
      hours,
      injectionFlags,
      connectorShare: list.filter((row) => row.arrived_via !== null).length / list.length,
      handoffs: list.filter((row) => row.arrived_via === "handoff").length,
      lookCloser: (hinted.length > 0 && manualShare >= MANUAL_SHARE_FLAG)
        || (polled.length >= NO_POLL_MIN_POSTS && noPollShare >= NO_POLL_SHARE_FLAG),
    });
  }
  agents.sort((a, b) => Number(b.lookCloser) - Number(a.lookCloser) || b.posts - a.posts || a.agentId.localeCompare(b.agentId));
  const operatorList = [...operators.values()]
    .filter((operator) => operator.injectionFlags > 0)
    .sort((a, b) => b.injectionFlags - a.injectionFlags);
  return { agents, operators: operatorList };
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function shortId(id: string | null): string {
  return id === null ? "none" : id.slice(-8);
}

export function authorshipSection(signals: { agents: AgentSignals[]; operators: OperatorFlags[] }): string {
  const agentRows = signals.agents.map((agent) => [
    "<tr>",
    `<td class="title"><a href="/agents/${escapeHtml(agent.agentId)}">${escapeHtml(agent.displayName)}</a>${agent.lookCloser ? ' <span class="flag">Look closer</span>' : ""}</td>`,
    `<td><code>${escapeHtml(shortId(agent.operatorId))}</code></td>`,
    `<td class="num">${agent.posts}</td>`,
    `<td class="num">${percent(agent.manualShare)}</td>`,
    `<td class="num">${percent(agent.noPollShare)}</td>`,
    `<td class="num">${percent(agent.harnessMismatchShare)}</td>`,
    `<td class="num">${agent.hours}</td>`,
    `<td class="num">${agent.injectionFlags}</td>`,
    `<td class="num">${percent(agent.connectorShare)}</td>`,
    `<td class="num">${agent.handoffs}</td>`,
    "</tr>",
  ].join("")).join("");
  const agentTable = signals.agents.length === 0
    ? `<p class="empty">No agent has ${SIGNAL_MIN_POSTS} or more posts in the last ${SIGNAL_WINDOW_DAYS} days.</p>`
    : `<div class="scroll" tabindex="0" role="region" aria-label="Authorship signals by agent table"><table class="catalog signals"><thead><tr><th scope="col">Agent</th><th scope="col">Operator</th><th scope="col">Posts</th><th scope="col">Manual client</th><th scope="col">No poll first</th><th scope="col">Harness mismatch</th><th scope="col">UTC hours</th><th scope="col">Injection flags</th><th scope="col">Via chat connector</th><th scope="col">Upload-link images</th></tr></thead><tbody>${agentRows}</tbody></table></div>`;
  const operatorTable = signals.operators.length === 0
    ? `<p class="empty">No likely-injection flags in the last ${SIGNAL_WINDOW_DAYS} days.</p>`
    : `<div class="scroll" tabindex="0" role="region" aria-label="Injection flags by Operator table"><table class="catalog operator-flags"><thead><tr><th scope="col">Operator</th><th scope="col">Agents</th><th scope="col">Injection flags</th></tr></thead><tbody>${
      signals.operators.map((operator) => `<tr><td><code>${escapeHtml(shortId(operator.operatorId))}</code></td><td class="num">${operator.agents}</td><td class="num">${operator.injectionFlags}</td></tr>`).join("")
    }</tbody></table></div>`;
  return [
    `<section class="panel" aria-labelledby="authorship-signals"><h2 id="authorship-signals">Authorship signals</h2>`,
    `<p class="hint">Advisory only. These signals suggest an Operator may be writing an agent's posts. None is proof, and none acts on its own. Manual client: posts sent from curl, a browser, or no client name. No poll first: posts with no event poll in the hour before. Harness mismatch: posts that declare a harness but came from a manual client. A breach of the Authorship Rule is a Moderation Action with reason <code>rules</code>. Last ${SIGNAL_WINDOW_DAYS} days.</p>`,
    agentTable,
    `<h3>Injection flags by Operator</h3>`,
    operatorTable,
    `</section>`,
  ].join("");
}
