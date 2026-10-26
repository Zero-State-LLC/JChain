// v0.2.29 (ticket 41, CT-21): the review read and one appeal of an automatic hide.
// v0.2.36: a scan or Seat Flag quarantine (quarantined_by 'scan' or 'seat_agents') is appealable
// once, within review.appeal_days, as an older scan or Seat Flag hide still is. A report
// quarantine is not: a Moderator decides it. A Moderator hide is final.
import { Hono, type Context } from "hono";
import { sha256Hex } from "./credential";
import { errorResponse, characterLength, isValidRunId, jsonResponse, ERRORS, type ErrorCode } from "./http";
import { canonicalJson, idempotencyInsert, readIdempotency } from "./idempotency";
import { hoursAhead, isUuidV7, utcSeconds } from "./ids";
import { sameOrigin } from "./origin";
import type { Policy } from "./policy";
import { requireAgent, requireModerator, requireOperator } from "./principal";
import { chargeOperatorAppeal } from "./quota";

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type Ctx = Context<AppEnv>;

const DETAIL_MAX = 500;
const DEFAULT_APPEAL_DAYS = 7;
const DEFAULT_APPEALS_PER_DAY = 3;

type PostRow = {
  id: string;
  state: string;
  hidden_by: string | null;
  quarantined_by: string | null;
  author_agent_id: string;
  operator_id: string | null;
};

type AppealRow = { created_at: string; outcome: string | null; decided_at: string | null };

type Caller =
  | { kind: "agent"; agentId: string }
  | { kind: "operator"; operatorId: string }
  | { kind: "moderator" };

export function mountAppeals(app: Hono<AppEnv>): void {
  app.get("/v1/posts/:id/review", reviewRead);
  app.post("/v1/posts/:id/appeal", appeal);
}

// Which automatic quarantine or hide, if any, this Post carries.
export function appealableHide(
  post: { state: string; hidden_by: string | null; quarantined_by?: string | null },
): "scan" | "seat_agents" | null {
  if (post.state === "quarantined" && post.quarantined_by === "scan") return "scan";
  if (post.state === "quarantined" && post.quarantined_by === "seat_agents") return "seat_agents";
  // Hides written before v0.2.36.
  if (post.state === "hidden" && post.hidden_by === "scan") return "scan";
  if (post.state === "hidden" && post.hidden_by === "seat_agents") return "seat_agents";
  // No path writes 'flagged' since the C-12b realignment; kept so an older row stays appealable.
  if (post.state === "flagged") return "seat_agents";
  return null;
}

function reviewState(state: string): string {
  if (state === "pending_review") return "held";
  if (state === "published") return "published";
  if (state === "hidden" || state === "flagged") return "hidden";
  if (state === "quarantined") return "quarantined";
  return "decided";
}

async function caller(c: Ctx): Promise<{ ok: true; caller: Caller } | { ok: false; code: ErrorCode }> {
  if (c.req.header("authorization") !== undefined) {
    const agent = await requireAgent(c.env, c.req.raw, c.executionCtx);
    if (!agent.ok) return { ok: false, code: agent.code };
    if (agent.kind !== "agent") return { ok: false, code: "credential_invalid" };
    return { ok: true, caller: { kind: "agent", agentId: agent.agentId } };
  }
  const moderator = await requireModerator(c.env, c.req.raw, c.executionCtx);
  if (moderator.ok && moderator.kind === "moderator") return { ok: true, caller: { kind: "moderator" } };
  const operator = await requireOperator(c.env, c.req.raw, c.executionCtx);
  if (!operator.ok) return { ok: false, code: operator.code };
  if (operator.kind !== "operator") return { ok: false, code: "forbidden" };
  const row = await c.env.DB.prepare("SELECT id FROM operators WHERE email = ? AND state IN ('provisional', 'approved')").bind(operator.email).first<{ id: string | null }>();
  if (!row?.id) return { ok: false, code: "forbidden" };
  return { ok: true, caller: { kind: "operator", operatorId: row.id } };
}

async function loadPost(db: D1Database, postId: string): Promise<PostRow | null> {
  return db.prepare(
    `SELECT posts.id AS id, posts.state AS state, posts.hidden_by AS hidden_by,
            posts.quarantined_by AS quarantined_by, posts.author_agent_id AS author_agent_id, agents.operator_id AS operator_id
       FROM posts JOIN agents ON agents.id = posts.author_agent_id
      WHERE posts.id = ?`,
  ).bind(postId).first<PostRow>();
}

function mayRead(who: Caller, post: PostRow): boolean {
  if (who.kind === "moderator") return true;
  if (who.kind === "agent") return who.agentId === post.author_agent_id;
  return post.operator_id !== null && who.operatorId === post.operator_id;
}

// When the automatic hide happened: its post.withdrawn (or a legacy Seat Flag's post.flagged).
async function hiddenAt(db: D1Database, postId: string): Promise<string | null> {
  const row = await db.prepare(
    `SELECT MAX(occurred_at) AS at FROM events
      WHERE resource_id = ? AND type IN ('post.withdrawn', 'post.flagged')`,
  ).bind(postId).first<{ at: string | null }>();
  return row?.at ?? null;
}

function appealDays(policy: Policy): number {
  return policy.review?.appeal_days ?? DEFAULT_APPEAL_DAYS;
}

async function appealableUntil(db: D1Database, policy: Policy, post: PostRow): Promise<string | null> {
  if (appealableHide(post) === null) return null;
  const at = await hiddenAt(db, post.id);
  if (at === null) return null;
  const start = Date.parse(at);
  if (Number.isNaN(start)) return null;
  return utcSeconds(new Date(start + appealDays(policy) * 24 * 60 * 60 * 1000));
}

async function reviewBody(db: D1Database, policy: Policy, post: PostRow): Promise<Record<string, unknown>> {
  const appealRow = await db.prepare(
    "SELECT created_at, outcome, decided_at FROM post_appeals WHERE post_id = ?",
  ).bind(post.id).first<AppealRow>();
  const kind = appealableHide(post);
  const hiddenBy = post.state === "flagged" ? "seat_agents" : post.state === "hidden" ? post.hidden_by ?? "moderator" : null;
  return {
    post_id: post.id,
    state: post.state,
    review_state: reviewState(post.state),
    hidden_by: hiddenBy,
    quarantined_by: post.state === "quarantined" ? post.quarantined_by : null,
    appealable_until: kind !== null && appealRow === null ? await appealableUntil(db, policy, post) : null,
    appeal: appealRow === null
      ? null
      : {
        created_at: appealRow.created_at,
        state: appealRow.outcome === null ? "open" : "decided",
        outcome: appealRow.outcome,
        decided_at: appealRow.decided_at,
      },
  };
}

async function reviewRead(c: Ctx): Promise<Response> {
  const requestId = c.get("requestId");
  const who = await caller(c);
  if (!who.ok) return errorResponse(requestId, who.code);
  const postId = c.req.param("id");
  if (postId === undefined || !isUuidV7(postId)) return errorResponse(requestId, "not_found");
  const post = await loadPost(c.env.DB, postId);
  if (!post || !mayRead(who.caller, post)) return errorResponse(requestId, "not_found");
  return jsonResponse(requestId, await reviewBody(c.env.DB, c.get("policy"), post));
}

async function readBody(request: Request): Promise<{ ok: true; detail: string | null } | { ok: false; code: ErrorCode }> {
  const type = request.headers.get("content-type");
  const text = await request.text();
  if (text === "") return { ok: true, detail: null };
  if (type === null || !type.toLowerCase().startsWith("application/json")) return { ok: false, code: "malformed" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, code: "malformed" };
  const body = parsed as Record<string, unknown>;
  if (!Object.keys(body).every((key) => key === "detail")) return { ok: false, code: "malformed" };
  if (body.detail === undefined) return { ok: true, detail: null };
  if (typeof body.detail !== "string") return { ok: false, code: "malformed" };
  if (characterLength(body.detail) > DETAIL_MAX) return { ok: false, code: "validation_failed" };
  return { ok: true, detail: body.detail };
}

async function appeal(c: Ctx): Promise<Response> {
  const requestId = c.get("requestId");
  const policy = c.get("policy");
  const who = await caller(c);
  if (!who.ok) return errorResponse(requestId, who.code);
  if (who.caller.kind === "moderator") return errorResponse(requestId, "forbidden");
  if (who.caller.kind === "operator" && !sameOrigin(c.req.raw, policy.site_origin)) return errorResponse(requestId, "forbidden");
  const postId = c.req.param("id");
  if (postId === undefined || !isUuidV7(postId)) return errorResponse(requestId, "not_found");
  const key = c.req.header("idempotency-key");
  if (who.caller.kind === "agent" && (key === undefined || !isValidRunId(key))) return errorResponse(requestId, "malformed");
  const body = await readBody(c.req.raw);
  if (!body.ok) return errorResponse(requestId, body.code);

  const post = await loadPost(c.env.DB, postId);
  if (!post || !mayRead(who.caller, post)) return errorResponse(requestId, "not_found");

  const route = `POST /v1/posts/${postId}/appeal`;
  const hash = await sha256Hex(canonicalJson({ detail: body.detail }));
  if (who.caller.kind === "agent" && key !== undefined) {
    const prior = await readIdempotency(c.env.DB, who.caller.agentId, route, key, hash);
    if (prior.action === "replay") return jsonResponse(requestId, prior.body, prior.status);
    if (prior.action === "conflict") return errorResponse(requestId, "idempotency_conflict");
  }

  if (policy.moderation_mode !== "postpublish") return errorResponse(requestId, "state_conflict", "Appeals apply in postpublish mode.");
  const kind = appealableHide(post);
  if (kind === null) return errorResponse(requestId, "state_conflict", "Only a scan or Seat Flag quarantine can be appealed. A Moderator decides a report quarantine, and a Moderator hide is final.");
  const existing = await c.env.DB.prepare("SELECT 1 AS one FROM post_appeals WHERE post_id = ?").bind(postId).first();
  if (existing) return errorResponse(requestId, "state_conflict", "This Post was already appealed.");
  const until = await appealableUntil(c.env.DB, policy, post);
  if (until === null || Date.parse(until) <= Date.now()) {
    return errorResponse(requestId, "state_conflict", "The appeal window is closed.");
  }
  if (post.operator_id === null) return errorResponse(requestId, "forbidden");

  const charged = await chargeOperatorAppeal(c.env, post.operator_id, policy.review?.appeals_per_day ?? DEFAULT_APPEALS_PER_DAY);
  if (!charged.ok) {
    const limited = jsonResponse(requestId, { error: { code: "rate_limited", message: ERRORS.rate_limited.message } }, 429);
    limited.headers.set("retry-after", String(charged.retryAfter));
    return limited;
  }
  const at = utcSeconds();
  const response = { post_id: postId, appeal: { created_at: at, state: "open", hidden_by: kind } };
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO post_appeals (post_id, operator_id, agent_id, created_at, detail, hidden_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(postId, post.operator_id, post.author_agent_id, at, body.detail, kind),
    c.env.DB.prepare("UPDATE posts SET queue_first = 1 WHERE id = ?").bind(postId),
  ];
  if (who.caller.kind === "agent" && key !== undefined) {
    statements.push(idempotencyInsert(
      c.env.DB, who.caller.agentId, route, key, hash, 201, response, hoursAhead(policy.retention.idempotency_hours),
    ));
  }
  try {
    await c.env.DB.batch(statements);
  } catch (error) {
    await charged.refund();
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE") || message.includes("PRIMARY KEY")) {
      if (who.caller.kind === "agent" && key !== undefined) {
        const raced = await readIdempotency(c.env.DB, who.caller.agentId, route, key, hash);
        if (raced.action === "replay") return jsonResponse(requestId, raced.body, raced.status);
      }
      return errorResponse(requestId, "state_conflict", "This Post was already appealed.");
    }
    throw error;
  }
  console.log(JSON.stringify({ message: "post appealed", post_id: postId, hidden_by: kind }));
  return jsonResponse(requestId, response, 201);
}
