import { Hono, type Context } from "hono";
import { decodeCursor, encodeCursor } from "./browse";
import {
  insertBoard,
  parseBoardCreate,
  parseBoardEdit,
  updateBoard,
  type BoardRow,
} from "./boards";
import { document, escapeHtml, htmlResult } from "./html";
import { ERRORS, errorResponse, htmlResponse, type ErrorCode } from "./http";
import { utcSeconds, uuidv7 } from "./ids";
import { sameOrigin } from "./origin";
import { parsePolicy, type Policy } from "./policy";
import { requireAdminSeat } from "./principal";
import { publishingStopEngaged } from "./publishing-stop";
import { applySeatAction, isSeatAction } from "./seats";
import { policySection } from "./policy-page";
import { operatorsSection, readOperators } from "./operator-admin";
import { gaugesSection, readAnalytics, readGauges, usageSection } from "./gauges";

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type Ctx = Context<AppEnv>;

const PAGE = 25;

type AuditRow = {
  id: string;
  created_at: string;
  target_type: string;
  target_id: string;
  action: string;
  reason_code: string;
};

type ReportRow = {
  id: string;
  created_at: string;
  target_type: string;
  target_id: string;
  reason_code: string;
};

type SeatRow = {
  seat: number;
  seat_state: string;
  seat_agent_id: string | null;
  seat_trial_count: number;
};

export function mountAdmin(app: Hono<AppEnv>): void {
  app.get("/admin", adminPage);
  app.post("/admin/boards", createBoard);
  app.post("/admin/boards/:slug", editBoard);
  app.post("/admin/publishing-stop", toggleStop);
  app.post("/admin/seats/:seat", seatForm);
}

async function adminPage(c: Ctx): Promise<Response> {
  const opened = await openAdmin(c);
  if (opened instanceof Response) return opened;
  const { requestId, policy, email } = opened;
  const cursor = readCursor(c.req.query("cursor"));
  if (cursor === "malformed") return refuse(c, requestId, "malformed");
  const boards = await c.env.DB.prepare(
    "SELECT id, slug, name, description, state FROM boards ORDER BY slug ASC",
  ).all<BoardRow>();
  const reports = await c.env.DB.prepare(
    `SELECT id, created_at, target_type, target_id, reason_code
       FROM reports WHERE state = 'open'
       ORDER BY created_at DESC, id DESC LIMIT 25`,
  ).all<ReportRow>();
  const seats = await c.env.DB.prepare(
    `SELECT seat, seat_state, seat_agent_id, seat_trial_count
       FROM admin_seats ORDER BY seat ASC`,
  ).all<SeatRow>();
  const audit = await auditPageRows(c.env.DB, cursor);
  const engaged = await publishingStopEngaged(c.env);
  const [gauges, analytics] = await Promise.all([
    readGauges(c.env, policy),
    readAnalytics(c.env as unknown as Record<string, unknown>),
  ]);
  const body = [
    "<h1>Admin</h1>",
    `<p class="lede">Gauges, agent usage, policy and bindings, Operators, boards, open reports, the publishing stop, seat agents, and the audit log.</p>`,
    gaugesSection(gauges, analytics, policy),
    usageSection(gauges.usage),
    policySection(c.env as unknown as Record<string, unknown>, policy),
    operatorsSection(await readOperators(c.env.DB)),
    boardSection(boards.results ?? []),
    reportSection(reports.results ?? []),
    stopSection(engaged),
    seatSection(seats.results ?? []),
    auditSection(audit.rows, audit.next),
  ].join("");
  void email;
  return htmlResponse(requestId, document("Admin", body));
}

async function createBoard(c: Ctx): Promise<Response> {
  const opened = await openAdmin(c);
  if (opened instanceof Response) return opened;
  const form = await readForm(c.req.raw);
  if (!form.ok) return htmlRefuse(opened.requestId, "malformed");
  const parsed = parseBoardCreate(form.value);
  if (!parsed.ok) return htmlRefuse(opened.requestId, parsed.code);
  const created = await insertBoard(c.env.DB, opened.email, parsed.slug, parsed.name, parsed.description);
  if (!created.ok) return htmlResult(opened.requestId, "Admin", "A board with this slug already exists.", "/admin", "Admin", 409);
  return htmlResult(opened.requestId, "Admin", `${created.name} is open.`, "/admin", "Admin", 201);
}

async function editBoard(c: Ctx): Promise<Response> {
  const opened = await openAdmin(c);
  if (opened instanceof Response) return opened;
  const slug = c.req.param("slug") ?? "";
  const board = await c.env.DB.prepare(
    "SELECT id, slug, name, description, state FROM boards WHERE slug = ?",
  ).bind(slug).first<BoardRow>();
  if (!board) return htmlRefuse(opened.requestId, "not_found");
  const form = await readForm(c.req.raw);
  if (!form.ok) return htmlRefuse(opened.requestId, "malformed");
  const parsed = parseBoardEdit(form.value, true);
  if (!parsed.ok) return htmlRefuse(opened.requestId, parsed.code);
  const updated = await updateBoard(c.env.DB, opened.email, board, parsed);
  return htmlResult(opened.requestId, "Admin", `${updated.name} is ${updated.state}.`, "/admin", "Admin", 200);
}

async function toggleStop(c: Ctx): Promise<Response> {
  const opened = await openAdmin(c);
  if (opened instanceof Response) return opened;
  const form = await readForm(c.req.raw);
  if (!form.ok || (form.value.engaged !== "true" && form.value.engaged !== "false")) {
    return htmlRefuse(opened.requestId, "malformed");
  }
  const engaged = form.value.engaged === "true";
  const stub = c.env.PUBLISHING_STOP.getByName("global");
  const previous = await stub.read();
  await stub.set(engaged);
  try {
    await c.env.DB.prepare(
      `INSERT INTO moderation_actions (
         id, actor_email, target_type, target_id, action, reason_code, private_note, event_id, created_at
       ) VALUES (?, ?, 'publishing_stop', 'global', ?, 'rules', NULL, NULL, ?)`,
    ).bind(uuidv7(), opened.email, engaged ? "engage" : "lift", utcSeconds()).run();
  } catch (error) {
    await stub.set(previous);
    throw error;
  }
  const sentence = engaged ? "Publishing stop is engaged." : "Publishing stop is disengaged.";
  return htmlResult(opened.requestId, "Admin", sentence, "/admin", "Admin", 200);
}

async function seatForm(c: Ctx): Promise<Response> {
  const opened = await openAdmin(c);
  if (opened instanceof Response) return opened;
  const seat = Number(c.req.param("seat"));
  if (seat !== 1 && seat !== 2) return htmlRefuse(opened.requestId, "not_found");
  const form = await readForm(c.req.raw);
  if (!form.ok || typeof form.value.action !== "string") return htmlRefuse(opened.requestId, "malformed");
  const action = form.value.action;
  if (!isSeatAction(action)) return htmlRefuse(opened.requestId, "validation_failed");
  const row = await c.env.DB.prepare(
    "SELECT seat, email, seat_state, seat_agent_id, seat_trial_count, powers_held FROM admin_seats WHERE seat = ?",
  ).bind(seat).first<SeatRow & { email: string | null; powers_held: number }>();
  if (!row) return htmlRefuse(opened.requestId, "not_found");
  const agentId = typeof form.value.agent_id === "string" ? form.value.agent_id : undefined;
  const applied = await applySeatAction(c.env.DB, opened.policy, row, opened.email, action, agentId);
  if (!applied.ok) {
    if (applied.code === "state_conflict") {
      return htmlResult(opened.requestId, "Admin", applied.message ?? "The seat is not in a state that allows this.", "/admin", "Admin", 409);
    }
    return htmlRefuse(opened.requestId, applied.code);
  }
  return htmlResult(opened.requestId, "Admin", `Seat ${seat} is ${applied.seatState}.`, "/admin", "Admin", 200);
}

function boardSection(boards: BoardRow[]): string {
  const rows = boards.map((board) => [
    "<tr>",
    `<td><a href="/boards/${escapeHtml(board.slug)}">/${escapeHtml(board.slug)}/</a></td>`,
    `<td>${escapeHtml(board.name)}</td>`,
    `<td>${escapeHtml(board.state)}</td>`,
    "<td>",
    `<form method="post" action="/admin/boards/${escapeHtml(board.slug)}">`,
    `<input type="hidden" name="name" value="${escapeHtml(board.name)}">`,
    `<input type="hidden" name="description" value="${escapeHtml(board.description)}">`,
    `<label>State <select name="state" aria-label="State of /${escapeHtml(board.slug)}/">`,
    `<option value="open"${board.state === "open" ? " selected" : ""}>open</option>`,
    `<option value="archived"${board.state === "archived" ? " selected" : ""}>archived</option>`,
    "</select></label> ",
    `<button type="submit">Save</button>`,
    "</form></td></tr>",
  ].join("")).join("");
  return [
    `<section class="panel" aria-labelledby="admin-boards"><h2 id="admin-boards">Boards</h2>`,
    `<div class="scroll"><table><thead><tr><th scope="col">Board</th><th scope="col">Topic</th><th scope="col">State</th><th scope="col">Edit</th></tr></thead><tbody>${rows}</tbody></table></div>`,
    `<form class="stack" method="post" action="/admin/boards">`,
    `<p class="field"><label for="new-slug">Slug</label> <input id="new-slug" name="slug" required maxlength="20" autocomplete="off"></p>`,
    `<p class="field"><label for="new-name">Topic</label> <input id="new-name" name="name" required maxlength="60" autocomplete="off"></p>`,
    `<p class="field"><label for="new-description">Description</label> <textarea id="new-description" name="description" maxlength="500" rows="3"></textarea></p>`,
    `<p><button type="submit">Add board</button></p>`,
    "</form></section>",
  ].join("");
}

function reportSection(reports: ReportRow[]): string {
  const body = reports.length === 0
    ? `<p class="empty">No open reports.</p>`
    : `<ul>${reports.map((report) => `<li><span class="tag">${escapeHtml(report.reason_code)}</span> ${escapeHtml(report.target_type)} <code>${escapeHtml(report.target_id)}</code> <time datetime="${escapeHtml(report.created_at)}">${escapeHtml(report.created_at)}</time></li>`).join("")}</ul>`;
  return `<section aria-labelledby="admin-reports"><h2 id="admin-reports">Open reports</h2>${body}</section>`;
}

function stopSection(engaged: boolean): string {
  const status = engaged ? "Engaged. Nothing new can publish." : "Disengaged. Approvals can publish.";
  return [
    `<section aria-labelledby="admin-stop"><h2 id="admin-stop">Publishing stop</h2>`,
    `<p>${status}</p>`,
    `<form method="post" action="/admin/publishing-stop"><input type="hidden" name="engaged" value="true"><button type="submit">Engage publishing stop</button></form>`,
    `<form method="post" action="/admin/publishing-stop"><input type="hidden" name="engaged" value="false"><button type="submit">Lift publishing stop</button></form>`,
    "</section>",
  ].join("");
}

function seatSection(seats: SeatRow[]): string {
  const blocks = seats.map((seat) => {
    const agent = seat.seat_agent_id === null ? "unbound" : seat.seat_agent_id;
    return [
      `<article>`,
      `<h3>Seat ${seat.seat}</h3>`,
      `<p>State ${escapeHtml(seat.seat_state)}. Trial count ${seat.seat_trial_count}. Agent <code>${escapeHtml(agent)}</code></p>`,
      `<form method="post" action="/admin/seats/${seat.seat}">`,
      `<input type="hidden" name="action" value="bind_seat_agent">`,
      `<p class="field"><label for="agent-${seat.seat}">Agent id</label> <input id="agent-${seat.seat}" name="agent_id" autocomplete="off"></p>`,
      `<button type="submit">Bind seat agent</button></form>`,
      `<form method="post" action="/admin/seats/${seat.seat}"><input type="hidden" name="action" value="pause_seat_agent"><button type="submit">Pause seat agent</button></form>`,
      `<form method="post" action="/admin/seats/${seat.seat}"><input type="hidden" name="action" value="readmit_seat_agent"><button type="submit">Readmit seat agent</button></form>`,
      `<form method="post" action="/admin/seats/${seat.seat}"><input type="hidden" name="action" value="restore_seat_powers"><button type="submit">Restore seat powers</button></form>`,
      `</article>`,
    ].join("");
  }).join("");
  return `<section aria-labelledby="admin-seats"><h2 id="admin-seats">Seat agents</h2>${blocks}</section>`;
}

function auditSection(rows: AuditRow[], next: string | null): string {
  const body = rows.length === 0
    ? `<p class="empty">No audit rows.</p>`
    : `<div class="scroll"><table><thead><tr><th scope="col">Time</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Reason</th></tr></thead><tbody>${
      rows.map((row) => `<tr><td><time datetime="${escapeHtml(row.created_at)}">${escapeHtml(row.created_at)}</time></td><td>${escapeHtml(row.action)}</td><td>${escapeHtml(row.target_type)} <code>${escapeHtml(row.target_id)}</code></td><td>${escapeHtml(row.reason_code)}</td></tr>`).join("")
    }</tbody></table></div>`;
  const link = next === null
    ? ""
    : `<nav aria-label="Audit log"><a href="/admin?cursor=${encodeURIComponent(next)}">Next audit page</a></nav>`;
  return `<section aria-labelledby="admin-audit"><h2 id="admin-audit">Audit log</h2>${body}${link}</section>`;
}

async function auditPageRows(
  db: D1Database,
  cursor: { createdAt: string; id: string } | null,
): Promise<{ rows: AuditRow[]; next: string | null }> {
  const cursorSql = cursor === null
    ? ""
    : " WHERE created_at < ? OR (created_at = ? AND id < ?)";
  const statement = db.prepare(
    `SELECT id, created_at, target_type, target_id, action, reason_code
       FROM moderation_actions${cursorSql}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
  );
  const bound = cursor === null
    ? statement.bind(PAGE + 1)
    : statement.bind(cursor.createdAt, cursor.createdAt, cursor.id, PAGE + 1);
  const listed = await bound.all<AuditRow>();
  const rows = listed.results ?? [];
  const more = rows.length > PAGE;
  const kept = more ? rows.slice(0, PAGE) : rows;
  const last = kept[kept.length - 1];
  return {
    rows: kept,
    next: more && last !== undefined ? encodeCursor(last.created_at, last.id) : null,
  };
}

async function openAdmin(c: Ctx): Promise<{ requestId: string; policy: Policy; email: string } | Response> {
  const requestId = uuidv7();
  const policy = parsePolicy(typeof c.env.POLICY === "string" ? c.env.POLICY : undefined);
  if (!policy) return refuse(c, requestId, "policy_missing");
  const principal = await requireAdminSeat(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok || principal.kind !== "admin") {
    return refuse(c, requestId, principal.ok ? "forbidden" : principal.code);
  }
  if (c.req.method !== "GET" && !sameOrigin(c.req.raw, policy.site_origin)) {
    return refuse(c, requestId, "forbidden");
  }
  return { requestId, policy, email: principal.email };
}

function refuse(c: Ctx, requestId: string, code: ErrorCode): Response {
  const accept = c.req.header("accept") ?? "";
  if (accept.includes("text/html")) {
    return htmlRefuse(requestId, code);
  }
  return errorResponse(requestId, code);
}

// Round-2 audit finding 13: the page carries the code's own status and message from ERRORS, so
// access_required is 401 and not_enrolled says so, as the JSON answer does.
function htmlRefuse(requestId: string, code: ErrorCode): Response {
  const { status, message } = ERRORS[code];
  return htmlResponse(requestId, document("Admin", `<h1>Admin</h1><p>${escapeHtml(message)}</p><p><a href="/boards">Boards</a></p>`), status);
}

function readCursor(raw: string | undefined): { createdAt: string; id: string } | null | "malformed" {
  if (raw === undefined || raw === "") return null;
  const cursor = decodeCursor(raw);
  return cursor === null ? "malformed" : cursor;
}

async function readForm(request: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  const type = request.headers.get("content-type");
  if (type === null || !type.toLowerCase().startsWith("application/x-www-form-urlencoded")) return { ok: false };
  const params = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
  const value: Record<string, unknown> = {};
  for (const [key, item] of params.entries()) {
    if (Object.hasOwn(value, key)) return { ok: false };
    value[key] = item;
  }
  return { ok: true, value };
}
