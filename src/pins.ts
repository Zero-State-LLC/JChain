import { Hono, type Context } from "hono";
import { escapeHtml, htmlError, htmlResult } from "./html";
import { errorResponse, jsonResponse, type ErrorCode } from "./http";
import { isUuidV7, utcSeconds, uuidv7 } from "./ids";
import { sameOrigin } from "./origin";
import { parsePolicy, type Policy } from "./policy";
import { requireAdminSeat } from "./principal";
import { VISIBLE_POST } from "./visibility";

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type Ctx = Context<AppEnv>;

// Admin pins (Danny, 2026-10-24, "build all"). An Admin pins at most one Thread per Board and
// unpins it. A pin is not a Post state and not a moderation outcome: it adds no transition. Each
// change is audited as a moderation_actions row. Pinning a Thread on a Board that already has a
// pin replaces it, with one unpin_thread row for the old Thread and one pin_thread row for the new.
export const PIN_ACTIONS = ["pin_thread", "unpin_thread"] as const;
type PinAction = (typeof PIN_ACTIONS)[number];

type PinResult =
  | { ok: true; boardId: string; threadId: string; pinned: boolean; replaced: string | null }
  | { ok: false; code: ErrorCode; message?: string };

const NOT_PUBLISHED = "Only a Thread whose Opening Post is published can be pinned.";
const ALREADY = "This Thread is already pinned.";
const NOT_PINNED = "This Thread is not pinned.";

export function mountPins(app: Hono<AppEnv>): void {
  app.post("/v1/admin/pins", pinJson);
  app.post("/admin/pins", pinForm);
}

async function pinJson(c: Ctx): Promise<Response> {
  const requestId = c.get("requestId");
  const principal = await requireAdminSeat(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  if (principal.kind !== "admin") return errorResponse(requestId, "forbidden");
  if (!sameOrigin(c.req.raw, c.get("policy").site_origin)) return errorResponse(requestId, "forbidden");
  const body = await readJson(c.req.raw);
  if (body === null) return errorResponse(requestId, "malformed");
  const parsed = parsePin(body);
  if (!parsed.ok) return errorResponse(requestId, parsed.code);
  const applied = await applyPin(c.env.DB, principal.email, parsed.action, parsed.threadId);
  if (!applied.ok) return errorResponse(requestId, applied.code, applied.message);
  return jsonResponse(requestId, {
    board_id: applied.boardId,
    thread_id: applied.threadId,
    pinned: applied.pinned,
    replaced_thread_id: applied.replaced,
  });
}

async function pinForm(c: Ctx): Promise<Response> {
  const requestId = uuidv7();
  const policy = parsePolicy(typeof c.env.POLICY === "string" ? c.env.POLICY : undefined);
  if (!policy) return htmlError(requestId, "policy_missing", "Admin", "/admin", "Admin");
  const principal = await requireAdminSeat(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok || principal.kind !== "admin") {
    return htmlError(requestId, principal.ok ? "forbidden" : principal.code, "Admin", "/admin", "Admin");
  }
  if (!sameOrigin(c.req.raw, policy.site_origin)) return htmlError(requestId, "forbidden", "Admin", "/admin", "Admin");
  const body = await readForm(c.req.raw);
  if (body === null) return htmlError(requestId, "malformed", "Admin", "/admin", "Admin");
  const parsed = parsePin(body);
  if (!parsed.ok) return htmlError(requestId, parsed.code, "Admin", "/admin", "Admin");
  const applied = await applyPin(c.env.DB, principal.email, parsed.action, parsed.threadId);
  if (!applied.ok) {
    if (applied.message !== undefined) return htmlResult(requestId, "Admin", applied.message, "/admin", "Admin", 409);
    return htmlError(requestId, applied.code, "Admin", "/admin", "Admin");
  }
  const sentence = applied.pinned
    ? applied.replaced === null ? "The Thread is pinned." : "The Thread is pinned and replaces the earlier pin."
    : "The Thread is unpinned.";
  return htmlResult(requestId, "Admin", sentence, "/admin", "Admin", 200);
}

function parsePin(
  body: Record<string, unknown>,
): { ok: true; action: PinAction; threadId: string } | { ok: false; code: "malformed" | "validation_failed" } {
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes("action") || !keys.includes("thread_id")) return { ok: false, code: "malformed" };
  const action = body.action;
  if (typeof action !== "string" || !(PIN_ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, code: "validation_failed" };
  }
  const threadId = body.thread_id;
  if (typeof threadId !== "string" || !isUuidV7(threadId)) return { ok: false, code: "validation_failed" };
  return { ok: true, action: action as PinAction, threadId };
}

export async function applyPin(db: D1Database, actor: string, action: PinAction, threadId: string): Promise<PinResult> {
  const thread = await db.prepare(
    `SELECT threads.id AS id, threads.board_id AS board_id,
            EXISTS (SELECT 1 FROM posts WHERE posts.thread_id = threads.id AND posts.title IS NOT NULL
                       AND ${VISIBLE_POST}) AS visible,
            (SELECT board_pins.thread_id FROM board_pins WHERE board_pins.board_id = threads.board_id) AS current
       FROM threads WHERE threads.id = ?`,
  ).bind(threadId).first<{ id: string; board_id: string; visible: number; current: string | null }>();
  if (!thread) return { ok: false, code: "not_found" };
  const now = utcSeconds();
  if (action === "unpin_thread") {
    if (thread.current !== thread.id) return { ok: false, code: "state_conflict", message: NOT_PINNED };
    // The audit row is written only while the pin row still exists, before the DELETE in the same
    // batch, so of two racing unpins only the one that removes the pin writes a row; the other is
    // state_conflict, as if it had read the Board after the first (independent review, v0.2.40).
    const results = await db.batch([
      unpinAudit(db, actor, thread.board_id, thread.id, now),
      db.prepare("DELETE FROM board_pins WHERE board_id = ? AND thread_id = ?").bind(thread.board_id, thread.id),
    ]);
    if (changes(results[1]) === 0) return { ok: false, code: "state_conflict", message: NOT_PINNED };
    return { ok: true, boardId: thread.board_id, threadId: thread.id, pinned: false, replaced: null };
  }
  if (Number(thread.visible) !== 1) return { ok: false, code: "state_conflict", message: NOT_PUBLISHED };
  if (thread.current === thread.id) return { ok: false, code: "state_conflict", message: ALREADY };
  const statements: D1PreparedStatement[] = [];
  // A replacement unpins the old Thread the same way: an unpin that raced ahead of this write
  // already wrote that Thread's unpin_thread row, so this batch writes none for it.
  if (thread.current !== null) {
    statements.push(
      unpinAudit(db, actor, thread.board_id, thread.current, now),
      db.prepare("DELETE FROM board_pins WHERE board_id = ? AND thread_id = ?").bind(thread.board_id, thread.current),
    );
  }
  statements.push(
    db.prepare("INSERT INTO board_pins (board_id, thread_id, pinned_at) VALUES (?, ?, ?)")
      .bind(thread.board_id, thread.id, now),
    audit(db, actor, thread.id, "pin_thread", now),
  );
  let results: D1Result[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    // A concurrent pin on the same Board won the primary key: nothing in this batch is kept.
    if (error instanceof Error && error.message.includes("UNIQUE")) {
      return { ok: false, code: "state_conflict", message: "The Board's pin changed. Try again." };
    }
    throw error;
  }
  const replaced = thread.current !== null && changes(results[1]) > 0 ? thread.current : null;
  return { ok: true, boardId: thread.board_id, threadId: thread.id, pinned: true, replaced };
}

function changes(result: D1Result | undefined): number {
  return Number(result?.meta.changes ?? 0);
}

// The unpin_thread row, written only while the Board's pin row for the Thread exists.
function unpinAudit(db: D1Database, actor: string, boardId: string, threadId: string, at: string): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO moderation_actions (
       id, actor_email, target_type, target_id, action, reason_code, private_note, event_id, created_at
     )
     SELECT ?, ?, 'thread', ?, 'unpin_thread', 'rules', NULL, NULL, ?
      WHERE EXISTS (SELECT 1 FROM board_pins WHERE board_id = ? AND thread_id = ?)`,
  ).bind(uuidv7(), actor, threadId, at, boardId, threadId);
}

function audit(db: D1Database, actor: string, threadId: string, action: PinAction, at: string): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO moderation_actions (
       id, actor_email, target_type, target_id, action, reason_code, private_note, event_id, created_at
     ) VALUES (?, ?, 'thread', ?, ?, 'rules', NULL, NULL, ?)`,
  ).bind(uuidv7(), actor, threadId, action, at);
}

type PinRow = { slug: string; thread_id: string; pinned_at: string; opening_state: string | null };

// The Pinned threads section of /admin: each Board's pin with an Unpin form, and a Pin form.
export async function readPins(db: D1Database): Promise<PinRow[]> {
  const listed = await db.prepare(
    `SELECT boards.slug AS slug, board_pins.thread_id AS thread_id, board_pins.pinned_at AS pinned_at,
            (SELECT posts.state FROM posts WHERE posts.thread_id = board_pins.thread_id AND posts.title IS NOT NULL)
              AS opening_state
       FROM board_pins JOIN boards ON boards.id = board_pins.board_id
      ORDER BY boards.slug ASC`,
  ).all<PinRow>();
  return listed.results ?? [];
}

export function pinsSection(rows: PinRow[]): string {
  const table = rows.length === 0
    ? `<p class="empty">No pinned threads.</p>`
    : `<div class="scroll" tabindex="0" role="region" aria-label="Pinned threads table"><table><thead><tr><th scope="col">Board</th><th scope="col">Thread</th><th scope="col">Opening Post</th><th scope="col">Pinned</th><th scope="col">Unpin</th></tr></thead><tbody>${
      rows.map((row) => [
        "<tr>",
        `<td>/${escapeHtml(row.slug)}/</td>`,
        `<td><a href="/threads/${escapeHtml(row.thread_id)}"><code>${escapeHtml(row.thread_id)}</code></a></td>`,
        `<td>${escapeHtml(row.opening_state ?? "missing")}</td>`,
        `<td><time datetime="${escapeHtml(row.pinned_at)}">${escapeHtml(row.pinned_at)}</time></td>`,
        `<td><form method="post" action="/admin/pins"><input type="hidden" name="action" value="unpin_thread">`,
        `<input type="hidden" name="thread_id" value="${escapeHtml(row.thread_id)}">`,
        `<button type="submit">Unpin</button></form></td>`,
        "</tr>",
      ].join("")).join("")
    }</tbody></table></div>`;
  return [
    `<section aria-labelledby="admin-pins"><h2 id="admin-pins">Pinned threads</h2>`,
    `<p>One pinned Thread per Board leads its New and Active pages while its Opening Post is published. Pinning another Thread on the same Board replaces the pin.</p>`,
    table,
    `<form class="stack" method="post" action="/admin/pins"><input type="hidden" name="action" value="pin_thread">`,
    `<p class="field"><label for="pin-thread">Thread id</label> <input id="pin-thread" name="thread_id" required autocomplete="off"></p>`,
    `<p><button type="submit">Pin thread</button></p></form>`,
    "</section>",
  ].join("");
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const type = request.headers.get("content-type");
  if (type === null || !type.toLowerCase().startsWith("application/json")) return null;
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

async function readForm(request: Request): Promise<Record<string, unknown> | null> {
  const type = request.headers.get("content-type");
  if (type === null || !type.toLowerCase().startsWith("application/x-www-form-urlencoded")) return null;
  const params = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
  const value: Record<string, unknown> = {};
  for (const [key, item] of params.entries()) {
    if (Object.hasOwn(value, key)) return null;
    value[key] = item;
  }
  return value;
}
