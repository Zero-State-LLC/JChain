import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ERRORS } from "../src/http";
import { VALID_WEBP } from "./fixtures/bytes";
import { OPERATOR, UUID_V7, call, resetAndSeed } from "./harness";

const UPLOAD_TOKEN = /^up_[A-Za-z0-9_-]{43}$/;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);

describe("AT-47 upload token is never stored in plaintext", () => {
  it("stores only the token hash and rotates the token on reservation replay", async () => {
    const { credential } = await enroll();
    const key = crypto.randomUUID();
    const body = {
      content_type: "image/webp",
      byte_size: VALID_WEBP.byteLength,
      sha256: await sha256HexBytes(VALID_WEBP),
    };

    const first = await expectSuccess(await reserve(credential, key, body), 201);
    const oldToken = String(first.upload_token);
    const assetId = String(first.asset_id);
    expect(oldToken).toMatch(UPLOAD_TOKEN);
    expect(assetId).toMatch(UUID_V7);
    expect(await plaintextHits([oldToken])).toEqual([]);
    const record = await env.DB.prepare("SELECT response_json FROM idempotency_keys WHERE idempotency_key = ?")
      .bind(key).first<{ response_json: string }>();
    expect(record?.response_json).toContain(assetId);

    const replay = await expectSuccess(await reserve(credential, key, body), 201);
    const newToken = String(replay.upload_token);
    expect(replay.asset_id).toBe(assetId);
    expect(replay.expires_at).toBe(first.expires_at);
    expect(newToken).toMatch(UPLOAD_TOKEN);
    expect(newToken).not.toBe(oldToken);
    expect(await plaintextHits([oldToken, newToken])).toEqual([]);
    const row = await env.DB.prepare("SELECT token_hash FROM upload_tokens WHERE asset_id = ?")
      .bind(assetId).first<{ token_hash: string }>();
    expect(row?.token_hash).toBe(await sha256HexText(newToken));

    await expectError(await putContent(assetId, oldToken), ERRORS.credential_invalid.status, "credential_invalid");
    const stored = await expectSuccess(await putContent(assetId, newToken));
    expect(stored.state).toBe("reserved");
    expect(await plaintextHits([oldToken, newToken])).toEqual([]);

    await expectError(
      await reserve(credential, key, { ...body, byte_size: body.byte_size + 1 }),
      ERRORS.idempotency_conflict.status,
      "idempotency_conflict",
    );
  });

  it("answers a replay with state_conflict once the reservation has moved on", async () => {
    const { credential } = await enroll();
    const key = crypto.randomUUID();
    const body = {
      content_type: "image/webp",
      byte_size: VALID_WEBP.byteLength,
      sha256: await sha256HexBytes(VALID_WEBP),
    };
    const first = await expectSuccess(await reserve(credential, key, body), 201);
    const assetId = String(first.asset_id);
    await expectSuccess(await putContent(assetId, String(first.upload_token)));
    await expectSuccess(await call(`/v1/uploads/${assetId}/complete`, {
      method: "POST",
      bearer: credential,
      headers: { "idempotency-key": crypto.randomUUID() },
    }), 202);

    const replay = await expectError(await reserve(credential, key, body), ERRORS.state_conflict.status, "state_conflict");
    expect(JSON.stringify(replay)).not.toContain("up_");
  });
});

async function reserve(credential: string, key: string, body: Record<string, unknown>): Promise<Response> {
  return call("/v1/uploads", { bearer: credential, headers: { "idempotency-key": key }, body });
}

async function putContent(assetId: string, token: string): Promise<Response> {
  return call(`/v1/uploads/${assetId}/content`, {
    method: "PUT",
    raw: VALID_WEBP,
    headers: { "idempotency-key": crypto.randomUUID(), "upload-token": token },
  });
}

async function plaintextHits(tokens: string[]): Promise<string[]> {
  const hits: string[] = [];
  for (const table of ["idempotency_keys", "upload_tokens", "assets"]) {
    const rows = await env.DB.prepare(`SELECT * FROM ${table}`).all<Record<string, unknown>>();
    for (const row of rows.results ?? []) {
      for (const [column, value] of Object.entries(row)) {
        const text = value === null || value === undefined
          ? ""
          : value instanceof ArrayBuffer
            ? new TextDecoder().decode(value)
            : String(value);
        for (const token of tokens) if (text.includes(token)) hits.push(`${table}.${column}`);
      }
    }
  }
  return hits;
}

async function enroll(name = "Ada"): Promise<{ credential: string; agentId: string }> {
  const response = await call("/v1/agents", {
    email: OPERATOR,
    body: { display_name: name, declared_model: "fixture-model" },
  });
  const body = await expectSuccess(response, 201);
  return { credential: String(body.credential), agentId: String(body.agent_id) };
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256HexText(text: string): Promise<string> {
  return sha256HexBytes(new TextEncoder().encode(text));
}

async function expectError(response: Response, status: number, code: string): Promise<ErrorBody> {
  const body = await response.json() as ErrorBody;
  expect(response.status).toBe(status);
  expect(body.error.code).toBe(code);
  expect(body.request_id).toMatch(UUID_V7);
  return body;
}

async function expectSuccess(response: Response, status = 200): Promise<SuccessBody> {
  const body = await response.json() as SuccessBody;
  expect(response.status).toBe(status);
  expect(body.request_id).toMatch(UUID_V7);
  return body;
}

type ErrorBody = { request_id: string; error: { code: string; message: string } };
type SuccessBody = Record<string, unknown>;
