import { applyD1Migrations, createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { VALID_WEBP } from "./fixtures/bytes";
import { BOARD_ID, MODERATOR, OPERATOR, call, resetAndSeed } from "./harness";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);
afterEach(() => {
  vi.restoreAllMocks();
});

describe("publishing stop", () => {
  it("audits every engage and lift, including a repeat", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    const key = crypto.randomUUID();
    const engaged = await expectSuccess(await stop(true, { "idempotency-key": key }));
    expect(engaged.engaged).toBe(true);
    expect(Object.keys(engaged).sort()).toEqual(["engaged", "request_id"]);
    expect(JSON.stringify(engaged)).not.toContain(MODERATOR);

    const again = await expectSuccess(await stop(true, { "idempotency-key": key }));
    expect(again.engaged).toBe(true);
    const lifted = await expectSuccess(await stop(false));
    expect(lifted.engaged).toBe(false);

    expect(await stopAudits()).toEqual([
      auditRow("engage"),
      auditRow("engage"),
      auditRow("lift"),
    ]);
    const stored = await env.DB.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").first<{ n: number }>();
    expect(Number(stored?.n ?? 0)).toBe(0);
    const stopLogs = logs
      .map((line) => JSON.parse(line) as { message?: string; engaged?: boolean })
      .filter((entry) => entry.message === "publishing stop engaged" || entry.message === "publishing stop lifted");
    expect(stopLogs).toEqual([
      { message: "publishing stop engaged", engaged: true },
      { message: "publishing stop engaged", engaged: true },
      { message: "publishing stop lifted", engaged: false },
    ]);
    expect(logs.join("")).not.toContain(MODERATOR);
  });

  it("refuses operators, agents, strangers, and a cross-origin write", async () => {
    const agent = await enroll();
    await expectError(await stop(true, {}, { email: OPERATOR }), 403, "forbidden");
    await expectError(await stop(true, {}, { bearer: agent.credential }), 403, "forbidden");
    await expectError(await stop(true, {}, { bearer: "jc_not-valid" }), 401, "credential_invalid");
    await expectError(await stop(true, {}, { email: "stranger@example.test" }), 403, "not_enrolled");
    await expectError(await stop(true, {}, {}), 401, "access_required");
    await expectError(await call("/v1/admin/publishing-stop", {
      email: MODERATOR,
      sameOrigin: false,
      headers: { origin: "https://evil.example" },
      body: { engaged: true },
    }), 403, "forbidden");
    expect(await stopAudits()).toEqual([]);
    expect(await (await call("/moderation", { email: MODERATOR })).text()).toContain("<p>Disengaged</p>");
  });

  it("rejects a malformed body and leaves the flag disengaged", async () => {
    await expectError(await stopBody({ engaged: true, note: "no" }), 400, "malformed");
    await expectError(await stopBody({ engaged: "true" }), 400, "malformed");
    await expectError(await stopBody({}), 400, "malformed");
    await expectError(await stopBody({ engaged: 1 }), 400, "malformed");
    await expectError(await stopBody([]), 400, "malformed");
    const yes = new URLSearchParams({ engaged: "yes" });
    await expectError(await call("/v1/admin/publishing-stop", {
      method: "POST",
      email: MODERATOR,
      raw: new TextEncoder().encode(yes.toString()),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }), 400, "malformed");
    const doubled = new URLSearchParams("engaged=true&engaged=false");
    await expectError(await call("/v1/admin/publishing-stop", {
      method: "POST",
      email: MODERATOR,
      raw: new TextEncoder().encode(doubled.toString()),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }), 400, "malformed");
    await expectError(await call("/v1/admin/publishing-stop", {
      method: "POST",
      email: MODERATOR,
      raw: new TextEncoder().encode("engaged=true"),
      headers: { "content-type": "text/plain" },
    }), 400, "malformed");
    expect(await stopAudits()).toEqual([]);
    expect(await (await call("/moderation", { email: MODERATOR })).text()).toContain("<p>Disengaged</p>");
  });

  it("shows the stop on the moderation page and accepts the form", async () => {
    const before = await call("/moderation", { email: MODERATOR });
    expect(before.headers.get("content-security-policy")).toContain("script-src 'none'");
    const html = await before.text();
    expect(html).toContain("<p>Disengaged</p>");
    expect(html).toContain('<section class="stop" aria-labelledby="publishing-stop">');
    expect(html).toContain('action="/moderation/publishing-stop"');
    expect(html).toContain('name="engaged" value="true"');
    expect(html).toContain('name="engaged" value="false"');
    expect(html).toContain(">Engage</button>");
    expect(html).toContain(">Lift</button>");
    expect(html).not.toContain("<script");

    const form = new URLSearchParams({ engaged: "true" });
    const engaged = await expectSuccess(await call("/v1/admin/publishing-stop", {
      method: "POST",
      email: MODERATOR,
      raw: new TextEncoder().encode(form.toString()),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }));
    expect(engaged.engaged).toBe(true);
    const after = await (await call("/moderation", { email: MODERATOR })).text();
    expect(after).toContain("<p>Engaged</p>");
    expect(after).toContain('<section class="stop stop-engaged" aria-labelledby="publishing-stop">');
    expect(after).not.toContain("<p>Disengaged</p>");
  });

  it("blocks approve and restore while engaged and leaves a committed post published", async () => {
    const agent = await enroll();
    const { threadId, postId } = await publishedThread(agent.credential);
    const published = await env.DB.prepare(
      "SELECT id FROM events WHERE type = 'post.published' AND resource_id = ?",
    ).bind(postId).first<{ id: string }>();
    const eventId = published?.id ?? "";
    expect(eventId).not.toBe("");

    const replyId = await replyTo(agent.credential, threadId);
    const otherId = await replyTo(agent.credential, threadId);
    await expectSuccess(await stop(true));
    expect(await postState(postId)).toBe("published");
    expect(await (await call("/boards/beta")).text()).toContain("Visible title");

    await expectError(await act("post", replyId, "approve"), 409, "state_conflict");
    expect(await postState(replyId)).toBe("pending_review");
    expect(await eventCount(replyId)).toBe(0);
    expect(await actionCount(replyId, "approve")).toBe(0);
    const pendingPage = await (await call(`/threads/${threadId}`)).text();
    expect(pendingPage).not.toContain("a pending reply");
    expect(await (await call("/boards/beta")).text()).toContain("Visible title");

    const hidden = await expectSuccess(await act("post", postId, "hide"));
    expect(hidden.state).toBe("hidden");
    expect(await (await call("/boards/beta")).text()).not.toContain("Visible title");
    await expectError(await act("post", postId, "restore"), 409, "state_conflict");
    expect(await postState(postId)).toBe("hidden");
    expect(await eventCount(postId)).toBe(2);

    const rejected = await expectSuccess(await act("post", otherId, "reject"));
    expect(rejected.state).toBe("rejected");
    expect(await postState(replyId)).toBe("pending_review");

    const withdrawn = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE type = 'post.withdrawn'",
    ).first<{ n: number }>();
    expect(Number(withdrawn?.n ?? 0)).toBe(1);

    const lifted = await expectSuccess(await stop(false));
    expect(lifted.engaged).toBe(false);
    const lift = await env.DB.prepare(
      "SELECT action FROM moderation_actions WHERE target_type = 'publishing_stop' AND action = 'lift'",
    ).first<{ action: string }>();
    expect(lift?.action).toBe("lift");

    const approved = await expectSuccess(await act("post", replyId, "approve"));
    expect(approved.state).toBe("published");
    expect(approved.event_id).toEqual(expect.any(String));
    expect(approved.event_id).not.toBe(eventId);
    const restored = await expectSuccess(await act("post", postId, "restore"));
    expect(restored.state).toBe("published");
    expect(restored.event_id).toEqual(expect.any(String));
    expect(restored.event_id).not.toBe(eventId);
    expect(await eventCount(postId)).toBe(3);
    expect(await (await call(`/threads/${threadId}`)).text()).toContain("a pending reply");
    expect(await (await call("/boards/beta")).text()).toContain("Visible title");
  });

  it("restores the previous flag when the audit insert fails", async () => {
    const failedEngage = await call("/v1/admin/publishing-stop", {
      email: MODERATOR,
      body: { engaged: true },
      env: failingAuditEnv(),
    });
    expect(failedEngage.status).toBeGreaterThanOrEqual(500);
    expect(await (await call("/moderation", { email: MODERATOR })).text()).toContain("<p>Disengaged</p>");
    expect(await stopAudits()).toHaveLength(0);

    await expectSuccess(await stop(true));
    const failedLift = await call("/v1/admin/publishing-stop", {
      email: MODERATOR,
      body: { engaged: false },
      env: failingAuditEnv(),
    });
    expect(failedLift.status).toBeGreaterThanOrEqual(500);
    const page = await (await call("/moderation", { email: MODERATOR })).text();
    expect(page).toContain("<p>Engaged</p>");
    expect(page).not.toContain("<p>Disengaged</p>");
    expect((await stopAudits()).some((row) => row.action === "lift")).toBe(false);
  });
});

type StopAudit = {
  actor_email: string;
  target_type: string;
  target_id: string;
  action: string;
  reason_code: string;
  private_note: string | null;
  event_id: string | null;
};

function auditRow(action: "engage" | "lift"): StopAudit {
  return {
    actor_email: MODERATOR,
    target_type: "publishing_stop",
    target_id: "global",
    action,
    reason_code: "rules",
    private_note: null,
    event_id: null,
  };
}

function stop(engaged: boolean, headers: Record<string, string> = {}, extra: {
  email?: string;
  bearer?: string;
} = { email: MODERATOR }): Promise<Response> {
  return call("/v1/admin/publishing-stop", { ...extra, headers, body: { engaged } });
}

function stopBody(body: unknown): Promise<Response> {
  return call("/v1/admin/publishing-stop", { email: MODERATOR, body });
}

function failingAuditEnv(): Env {
  const db = new Proxy(env.DB, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (property !== "prepare") return typeof value === "function" ? value.bind(target) : value;
      return (sql: string) => {
        const statement = target.prepare(sql);
        return sql.includes("'publishing_stop'") ? failOnRun(statement) : statement;
      };
    },
  });
  return new Proxy(env, {
    get(target, property) {
      if (property === "DB") return db;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Env;
}

function failOnRun(statement: D1PreparedStatement): D1PreparedStatement {
  return new Proxy(statement, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (property === "run") return () => Promise.reject(new Error("audit failed"));
      if (property === "bind") {
        return (...args: Parameters<D1PreparedStatement["bind"]>) => failOnRun(target.bind(...args));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function stopAudits(): Promise<StopAudit[]> {
  const rows = await env.DB.prepare(
    `SELECT actor_email, target_type, target_id, action, reason_code, private_note, event_id
       FROM moderation_actions
      WHERE target_type = 'publishing_stop'
      ORDER BY created_at ASC, id ASC`,
  ).all<StopAudit>();
  return rows.results ?? [];
}

function actionBody(
  targetType: string,
  targetId: string,
  action: string,
): Record<string, unknown> {
  return { target_type: targetType, target_id: targetId, action, reason_code: "rules" };
}

function act(targetType: string, targetId: string, action: string): Promise<Response> {
  return call("/v1/moderation/actions", { email: MODERATOR, body: actionBody(targetType, targetId, action) });
}

async function enroll(): Promise<{ credential: string; agentId: string }> {
  const response = await call("/v1/agents", {
    email: OPERATOR,
    body: { display_name: "Ada", declared_model: "fixture-model" },
  });
  const body = await expectSuccess(response, 201);
  return { credential: String(body.credential), agentId: String(body.agent_id) };
}

async function replyTo(credential: string, threadId: string): Promise<string> {
  const replied = await expectSuccess(await call(`/v1/threads/${threadId}/posts`, {
    bearer: credential,
    headers: { "idempotency-key": crypto.randomUUID() },
    body: { text: "a pending reply" },
  }), 201);
  return String(replied.post_id);
}

async function publishedThread(credential: string): Promise<{ threadId: string; postId: string }> {
  const assetId = await readyAsset(credential);
  const opened = await expectSuccess(await call("/v1/threads", {
    bearer: credential,
    headers: { "idempotency-key": crypto.randomUUID() },
    body: {
      board_id: BOARD_ID,
      asset_id: assetId,
      title: "Visible title",
      caption: "A caption",
      alt_text: "A square",
      provenance: { source: "model", model: "fixture-model" },
      rights_attestation: "I made this.",
      license: "cc0",
    },
  }), 201);
  const threadId = String(opened.thread_id);
  const postId = String(opened.post_id);
  await expectSuccess(await act("post", postId, "approve"));
  return { threadId, postId };
}

async function readyAsset(credential: string): Promise<string> {
  const sha256 = await sha256HexBytes(VALID_WEBP);
  const reserved = await expectSuccess(await call("/v1/uploads", {
    bearer: credential,
    headers: { "idempotency-key": crypto.randomUUID() },
    body: { content_type: "image/webp", byte_size: VALID_WEBP.byteLength, sha256 },
  }), 201);
  const assetId = String(reserved.asset_id);
  await expectSuccess(await call(`/v1/uploads/${assetId}/content`, {
    method: "PUT",
    raw: VALID_WEBP,
    headers: { "idempotency-key": crypto.randomUUID(), "upload-token": String(reserved.upload_token) },
  }));
  await expectSuccess(await call(`/v1/uploads/${assetId}/complete`, {
    method: "POST",
    bearer: credential,
    headers: { "idempotency-key": crypto.randomUUID() },
  }), 202);
  await settle(assetId);
  return assetId;
}

async function settle(assetId: string): Promise<void> {
  const ctx = createExecutionContext();
  const batch = createMessageBatch("asset-upload", [{
    id: `msg-${assetId}`,
    timestamp: new Date(),
    attempts: 1,
    body: { asset_id: assetId },
  }]);
  if (!worker.queue) throw new Error("queue handler missing");
  await worker.queue(batch, env, ctx);
  await getQueueResult(batch, ctx);
}

async function postState(postId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT state FROM posts WHERE id = ?").bind(postId).first<{ state: string }>();
  return row?.state ?? "";
}

async function eventCount(resourceId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE resource_id = ?",
  ).bind(resourceId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function actionCount(targetId: string, action: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM moderation_actions WHERE target_id = ? AND action = ?",
  ).bind(targetId, action).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function expectError(response: Response, status: number, code: string): Promise<void> {
  const body = await response.json() as { error?: { code?: string } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(body.error?.code).toBe(code);
}

async function expectSuccess(response: Response, status = 200): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body;
}
