import { Hono, type Context } from "hono";
import { htmlError, htmlResult } from "./html";
import { characterLength, errorResponse, jsonResponse, type ErrorCode } from "./http";
import { isUuidV7, utcSeconds, uuidv7 } from "./ids";
import { sameOrigin } from "./origin";
import { parsePolicy, type Policy } from "./policy";
import { accessEmail, requireAgent } from "./principal";
import { currentSession } from "./session";
import { turnstileSecret, verifyTurnstile } from "./turnstile";
import { visibleBoardSlug, visibleReportTarget } from "./visibility";

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type Ctx = Context<AppEnv>;

export const REPORT_REASONS = [
  "spam",
  "harassment",
  "sexual-content",
  "real-person-likeness",
  "private-data",
  "prompt-injection",
  "rules",
  "other",
  "id-document",
  "csam",
] as const;

const REASONS = REPORT_REASONS;

const LEGAL_HOLD_REASONS = new Set(["csam", "id-document"]);

const TARGETS = ["post", "thread", "agent"] as const;

const OPERATOR_SENTENCE = "Browser reports are for an Operator.";

type Format = "json" | "html";

export function mountReports(app: Hono<AppEnv>): void {
  app.post("/v1/reports", (c) => report(c, "json"));
  app.post("/reports", (c) => report(c, "html"));
}

async function report(c: Ctx, format: Format): Promise<Response> {
  const requestId = c.get("requestId") || uuidv7();
  const policy = c.get("policy") ?? parsePolicy(typeof c.env.POLICY === "string" ? c.env.POLICY : undefined);
  if (!policy) {
    if (format === "html") {
      const href = await reportBoardHref(c.env.DB);
      return htmlError(requestId, "policy_missing", "Report", href, "Board");
    }
    return errorResponse(requestId, "policy_missing");
  }
  const email = await operatorEmail(c);
  const operator = email === null
    ? null
    : await c.env.DB.prepare("SELECT email FROM operators WHERE email = ? AND state IN ('provisional', 'approved')").bind(email).first<{ email: string }>();
  if (format === "html" && operator === null) {
    const href = await reportBoardHref(c.env.DB);
    return htmlResult(requestId, "Report", OPERATOR_SENTENCE, href, "Board", 403);
  }

  if (format === "json") {
    const header = c.req.raw.headers.get("authorization");
    if (header !== null) {
      const agent = await requireAgent(c.env, c.req.raw, c.executionCtx);
      if (!agent.ok) return errorResponse(requestId, agent.code);
      return errorResponse(requestId, "forbidden");
    }
  }

  if (email !== null && !sameOrigin(c.req.raw, policy.site_origin)) {
    return reportError(c, requestId, format, "forbidden");
  }

  const parsed = await readReport(c.req.raw);
  if (!parsed.ok) return reportError(c, requestId, format, "malformed");
  const body = parseReport(parsed.value);
  if (!body.ok) return reportError(c, requestId, format, body.code);

  if (format === "json" && !operator) {
    const secret = turnstileSecret(c.env);
    if (secret === null) return errorResponse(requestId, "policy_missing");
    if (body.token === null) return errorResponse(requestId, "validation_failed");
    const passed = await verifyTurnstile(secret, body.token, {
      remoteip: c.req.header("cf-connecting-ip"),
      expectedHostname: new URL(policy.site_origin).hostname,
    });
    if (!passed) return errorResponse(requestId, "validation_failed");
  }

  const exists = await targetExists(c.env.DB, body.targetType, body.targetId);
  if (!exists) return reportError(c, requestId, format, "not_found", body.targetType, body.targetId);

  const reportId = uuidv7();
  const createdAt = utcSeconds();
  const actor = email ?? "";
  const hold = operator !== null && body.targetType === "post" && LEGAL_HOLD_REASONS.has(body.reasonCode);
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO reports (id, actor_email, target_type, target_id, reason_code, detail, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
    ).bind(reportId, email, body.targetType, body.targetId, body.reasonCode, body.detail, createdAt),
    c.env.DB.prepare(
      `INSERT INTO moderation_actions (
         id, actor_email, target_type, target_id, action, reason_code, private_note, event_id, created_at
       ) VALUES (?, ?, ?, ?, 'report', ?, NULL, NULL, ?)`,
    ).bind(uuidv7(), actor, body.targetType, body.targetId, body.reasonCode, createdAt),
  ];
  if (hold) {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO events (id, type, resource_id, occurred_at)
         SELECT ?, 'post.withdrawn', id, ? FROM posts WHERE id = ? AND state = 'published'`,
      ).bind(uuidv7(), createdAt, body.targetId),
      c.env.DB.prepare(
        `INSERT INTO moderation_actions (
           id, actor_email, target_type, target_id, action, reason_code, private_note, event_id, created_at
         ) VALUES (?, ?, 'post', ?, 'quarantine', ?, NULL, NULL, ?)`,
      ).bind(uuidv7(), actor, body.targetId, body.reasonCode, createdAt),
      c.env.DB.prepare(
        `UPDATE posts
            SET state = 'quarantined', legal_hold = 1, legal_hold_reason = ?
          WHERE id = ? AND state NOT IN ('removed', 'removal_pending')`,
      ).bind(body.reasonCode, body.targetId),
    );
  }
  await c.env.DB.batch(statements);
  console.log(JSON.stringify({ message: "report filed", report_id: reportId, target_type: body.targetType }));
  if (format === "html") {
    const href = await reportBoardHref(c.env.DB, body.targetType, body.targetId);
    return htmlResult(requestId, "Report", `Report ${reportId} filed.`, href, "Board", 201);
  }
  return jsonResponse(requestId, {
    report_id: reportId,
    target_type: body.targetType,
    target_id: body.targetId,
  }, 201);
}

async function operatorEmail(c: Ctx): Promise<string | null> {
  const access = await accessEmail(c.executionCtx, c.req.raw);
  if (access !== null) return access;
  const session = await currentSession(c.env, c.req.raw);
  return session?.email ?? null;
}

async function reportError(
  c: Ctx,
  requestId: string,
  format: Format,
  code: ErrorCode,
  targetType?: string,
  targetId?: string,
): Promise<Response> {
  if (format === "json") return errorResponse(requestId, code);
  const href = await reportBoardHref(c.env.DB, targetType, targetId);
  return htmlError(requestId, code, "Report", href, "Board");
}

async function reportBoardHref(db: D1Database, targetType?: string, targetId?: string): Promise<string> {
  if (
    (targetType === "post" || targetType === "thread")
    && targetId !== undefined
    && isUuidV7(targetId)
  ) {
    const slug = await visibleBoardSlug(db, targetType, targetId);
    if (slug !== null) return `/boards/${slug}`;
  }
  const listed = await db.prepare("SELECT slug FROM boards WHERE state = 'open' ORDER BY slug").all<{ slug: string }>();
  const slug = listed.results?.[0]?.slug;
  return slug === undefined ? "/" : `/boards/${slug}`;
}

async function targetExists(db: D1Database, targetType: string, targetId: string): Promise<boolean> {
  return visibleReportTarget(db, targetType, targetId);
}

type ReportInput = {
  targetType: string;
  targetId: string;
  reasonCode: string;
  detail: string | null;
  token: string | null;
};

function parseReport(
  body: Record<string, unknown>,
): { ok: true } & ReportInput | { ok: false; code: "malformed" | "validation_failed" } {
  const allowed = new Set(["target_type", "target_id", "reason_code", "detail", "turnstile_token"]);
  if (!Object.keys(body).every((key) => allowed.has(key))) return { ok: false, code: "malformed" };
  if (!["target_type", "target_id", "reason_code"].every((key) => Object.hasOwn(body, key))) {
    return { ok: false, code: "malformed" };
  }
  if (
    typeof body.target_type !== "string"
    || typeof body.target_id !== "string"
    || typeof body.reason_code !== "string"
  ) {
    return { ok: false, code: "malformed" };
  }
  if (!(TARGETS as readonly string[]).includes(body.target_type)) return { ok: false, code: "validation_failed" };
  if (!isUuidV7(body.target_id)) return { ok: false, code: "malformed" };
  if (!(REASONS as readonly string[]).includes(body.reason_code)) return { ok: false, code: "validation_failed" };
  let detail: string | null = null;
  if (Object.hasOwn(body, "detail")) {
    if (typeof body.detail !== "string") return { ok: false, code: "malformed" };
    if (characterLength(body.detail) > 500) return { ok: false, code: "validation_failed" };
    detail = body.detail;
  }
  let token: string | null = null;
  if (Object.hasOwn(body, "turnstile_token")) {
    if (typeof body.turnstile_token !== "string") return { ok: false, code: "malformed" };
    if (body.turnstile_token.length < 1 || body.turnstile_token.length > 2048) {
      return { ok: false, code: "validation_failed" };
    }
    token = body.turnstile_token;
  }
  return {
    ok: true,
    targetType: body.target_type,
    targetId: body.target_id,
    reasonCode: body.reason_code,
    detail,
    token,
  };
}

async function readReport(request: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  const type = request.headers.get("content-type");
  if (type === null) return { ok: false };
  const lower = type.toLowerCase();
  if (lower.startsWith("application/json")) return readObject(request);
  if (lower.startsWith("application/x-www-form-urlencoded")) return readForm(request);
  return { ok: false };
}

async function readObject(request: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false };
  return { ok: true, value: parsed as Record<string, unknown> };
}

async function readForm(request: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  let text: string;
  try {
    text = new TextDecoder().decode(await request.arrayBuffer());
  } catch {
    return { ok: false };
  }
  const params = new URLSearchParams(text);
  const value: Record<string, unknown> = {};
  for (const [key, item] of params.entries()) {
    if (Object.hasOwn(value, key)) return { ok: false };
    value[key] = item;
  }
  return { ok: true, value };
}
