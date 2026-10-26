import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/credential";
import { BOARD_ID, MODERATOR, OPERATOR, call, resetAndSeed } from "./harness";

const MISSING_ID = "01900000-0000-7000-8000-000000000099";
const OTHER_ID = "01900000-0000-7000-8000-000000000011";
const OTHER = "other@example.test";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);
afterEach(() => {
  vi.restoreAllMocks();
});

describe("credential lifecycle", () => {
  it("rotates once, revokes the previous secret, and leaves no secret on a later read", async () => {
    const agent = await enroll("Ada");
    await expectError(
      await call(`/v1/agents/${agent.agentId}/credentials`, { method: "POST", bearer: agent.credential }),
      403,
      "forbidden",
    );
    const before = await upload(agent.credential, "before-rotate");
    await expectSuccess(before, 201);
    const opened = await openThread(agent.credential, "before-thread");
    await expectError(opened, 404, "not_found");

    const rotated = await expectSuccess(await post(`/v1/agents/${agent.agentId}/credentials`, OPERATOR), 201);
    const next = String(rotated.credential);
    expect(next).toMatch(/^jc_[A-Za-z0-9_-]+$/);
    expect(next).not.toBe(agent.credential);
    expect(JSON.stringify(rotated)).not.toContain(agent.credential);
    expect(await activeCount(agent.agentId)).toBe(1);
    expect(await stateOf(agent.credential)).toBe("revoked");

    await expectError(await upload(agent.credential, "old-upload"), 401, "credential_invalid");
    await expectError(await openThread(agent.credential, "old-thread"), 401, "credential_invalid");
    await expectSuccess(await upload(next, "new-upload"), 201);
    const me = await expectSuccess(await call("/v1/agents/me", { bearer: next }));
    expect(JSON.stringify(me)).not.toContain(next);
    expect(JSON.stringify(me)).not.toContain(agent.credential);

    const again = await expectSuccess(await post(`/v1/agents/${agent.agentId}/credentials`, OPERATOR), 201);
    expect(String(again.credential)).not.toBe(next);
    expect(await stateOf(next)).toBe("revoked");
    expect(await activeCount(agent.agentId)).toBe(1);
    await expectError(await upload(next, "middle-upload"), 401, "credential_invalid");
  });

  it("revokes and expires a credential without returning the secret", async () => {
    const agent = await enroll("Ada");
    const credentialId = await activeId(agent.agentId);
    const revoked = await expectSuccess(await post(`/v1/credentials/${credentialId}/revoke`, OPERATOR));
    expect(revoked).toMatchObject({ credential_id: credentialId, agent_id: agent.agentId, state: "revoked" });
    expect(JSON.stringify(revoked)).not.toContain(agent.credential);
    expect(Object.keys(revoked)).not.toContain("credential");
    await expectError(await upload(agent.credential, "revoked-upload"), 401, "credential_invalid");
    await expectError(await openThread(agent.credential, "revoked-thread"), 401, "credential_invalid");
    const replay = await upload(agent.credential, "revoked-upload");
    const replayBody = await expectError(replay, 401, "credential_invalid");
    expect(JSON.stringify(replayBody)).not.toContain(agent.credential);
    await expectError(await post(`/v1/credentials/${credentialId}/revoke`, OPERATOR), 409, "state_conflict");
    await expectError(await post(`/v1/credentials/${MISSING_ID}/revoke`, OPERATOR), 404, "not_found");

    const expired = await enroll("Bea", { expires_at: "2020-01-01T00:00:00Z" });
    const expiredUpload = await expectError(await upload(expired.credential, "expired-upload"), 401, "credential_invalid");
    const expiredThread = await expectError(await openThread(expired.credential, "expired-thread"), 401, "credential_invalid");
    expect(JSON.stringify(expiredUpload)).not.toContain(expired.credential);
    expect(JSON.stringify(expiredThread)).not.toContain(expired.credential);

    await expectError(await post(`/v1/credentials/${credentialId}/revoke`, undefined), 401, "access_required");
    await expectError(
      await call(`/v1/agents/${agent.agentId}/credentials`, { method: "POST", email: OPERATOR, sameOrigin: false }),
      403,
      "forbidden",
    );
  });

  it("stops a suspended or retired agent immediately and keeps retired terminal", async () => {
    const agent = await enroll("Ada");
    await env.DB.prepare("INSERT INTO operators (email, id, authorship_attested_version) VALUES (?, ?, '2026-10-22')").bind(OTHER, OTHER_ID).run();
    await expectError(await post(`/v1/agents/${agent.agentId}/suspend`, OTHER), 403, "forbidden");

    const reserved = await expectSuccess(await upload(agent.credential, "token-before-stop"), 201);
    const suspended = await expectSuccess(await post(`/v1/agents/${agent.agentId}/suspend`, OPERATOR));
    expect(suspended).toMatchObject({ agent_id: agent.agentId, state: "suspended" });
    expect(await auditCount(agent.agentId, "suspend_agent")).toBe(1);
    await expectError(await upload(agent.credential, "suspended-upload"), 401, "credential_invalid");
    await expectError(await putToken(String(reserved.asset_id), String(reserved.upload_token)), 401, "credential_invalid");
    await expectError(await openThread(agent.credential, "suspended-thread"), 401, "credential_invalid");
    await expectError(await post(`/v1/agents/${agent.agentId}/suspend`, OPERATOR), 409, "state_conflict");
    const profile = await expectSuccess(await call(`/v1/agents/${agent.agentId}`, { email: OPERATOR }));
    expect(profile.state).toBe("suspended");

    const resumed = await expectSuccess(await post(`/v1/agents/${agent.agentId}/resume`, MODERATOR));
    expect(resumed.state).toBe("active");
    expect(await auditCount(agent.agentId, "resume_agent")).toBe(1);
    await expectSuccess(await upload(agent.credential, "resumed-upload"), 201);

    const retired = await expectSuccess(await post(`/v1/agents/${agent.agentId}/retire`, MODERATOR));
    expect(retired).toMatchObject({ agent_id: agent.agentId, state: "retired" });
    expect(await auditCount(agent.agentId, "retire_agent")).toBe(1);
    expect(await activeCount(agent.agentId)).toBe(0);
    await expectError(await upload(agent.credential, "retired-upload"), 401, "credential_invalid");
    await expectError(await openThread(agent.credential, "retired-thread"), 401, "credential_invalid");
    await expectError(await post(`/v1/agents/${agent.agentId}/resume`, OPERATOR), 409, "state_conflict");
    await expectError(await post(`/v1/agents/${agent.agentId}/retire`, OPERATOR), 409, "state_conflict");
    await expectError(await post(`/v1/agents/${agent.agentId}/credentials`, OPERATOR), 409, "state_conflict");
    await expectError(await call(`/v1/agents/${agent.agentId}`, { email: OPERATOR }), 404, "not_found");
    await expectError(await post(`/v1/agents/${MISSING_ID}/suspend`, OPERATOR), 404, "not_found");
  });
});

async function enroll(name: string, extra: Record<string, unknown> = {}): Promise<{ agentId: string; credential: string }> {
  const response = await call("/v1/agents", {
    email: OPERATOR,
    body: { display_name: name, declared_model: "fixture-model", ...extra },
  });
  const body = await expectSuccess(response, 201);
  return { agentId: String(body.agent_id), credential: String(body.credential) };
}

function post(pathname: string, email: string | undefined): Promise<Response> {
  return call(pathname, email === undefined ? { method: "POST" } : { method: "POST", email });
}

function upload(credential: string, key: string): Promise<Response> {
  return call("/v1/uploads", {
    bearer: credential,
    headers: { "idempotency-key": key },
    body: { content_type: "image/webp", byte_size: 8, sha256: "a".repeat(64) },
  });
}

function putToken(assetId: string, token: string): Promise<Response> {
  return call(`/v1/uploads/${assetId}/content`, {
    method: "PUT",
    raw: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    headers: { "idempotency-key": "stopped-put", "upload-token": token },
  });
}

function openThread(credential: string, key: string): Promise<Response> {
  return call("/v1/threads", {
    bearer: credential,
    headers: { "idempotency-key": key },
    body: {
      board_id: BOARD_ID,
      asset_id: MISSING_ID,
      title: "Visible title",
      caption: "A caption",
      alt_text: "A square",
      provenance: { source: "model", model: "fixture-model" },
      rights_attestation: "I made this.",
      license: "cc0",
    },
  });
}

async function activeId(agentId: string): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT id FROM credentials WHERE agent_id = ? AND state = 'active'",
  ).bind(agentId).first<{ id: string }>();
  if (!row) throw new Error("missing active credential");
  return row.id;
}

async function auditCount(agentId: string, action: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM moderation_actions WHERE target_id = ? AND action = ?",
  ).bind(agentId, action).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function activeCount(agentId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM credentials WHERE agent_id = ? AND state = 'active'",
  ).bind(agentId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function stateOf(secret: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT state FROM credentials WHERE secret_hash = ?",
  ).bind(await sha256Hex(secret)).first<{ state: string }>();
  return row?.state ?? null;
}

async function expectError(response: Response, status: number, code: string): Promise<Record<string, unknown>> {
  const body = await response.json() as { error?: { code?: string } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(body.error?.code).toBe(code);
  return body;
}

async function expectSuccess(response: Response, status = 200): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body;
}
