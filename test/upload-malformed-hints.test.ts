import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { VALID_WEBP } from "./fixtures/bytes";
import { OPERATOR, call, resetAndSeed } from "./harness";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);

describe("upload malformed errors name what to fix", () => {
  it("names the missing Idempotency-Key, the body on complete, and the missing variant", async () => {
    const credential = await enroll();
    const reserveBody = { content_type: "image/webp", byte_size: VALID_WEBP.byteLength, sha256: await sha256Hex(VALID_WEBP) };

    expect(await message(await call("/v1/uploads", { bearer: credential, body: reserveBody }))).toContain("Idempotency-Key");

    const reserved = await call("/v1/uploads", { bearer: credential, headers: { "idempotency-key": crypto.randomUUID() }, body: reserveBody });
    expect(reserved.status).toBe(201);
    const { asset_id: assetId, upload_token: token } = await reserved.json() as { asset_id: string; upload_token: string };

    const noKey = await call(`/v1/uploads/${assetId}/content`, { method: "PUT", raw: VALID_WEBP, headers: { "upload-token": token } });
    expect(await message(noKey)).toContain("Idempotency-Key");

    const put = await call(`/v1/uploads/${assetId}/content`, {
      method: "PUT",
      raw: VALID_WEBP,
      headers: { "idempotency-key": crypto.randomUUID(), "upload-token": token },
    });
    expect(put.status).toBe(200);

    const completeNoKey = await call(`/v1/uploads/${assetId}/complete`, { method: "POST", bearer: credential });
    expect(await message(completeNoKey)).toContain("Idempotency-Key");

    const completeWithBody = await call(`/v1/uploads/${assetId}/complete`, {
      method: "POST",
      bearer: credential,
      headers: { "idempotency-key": crypto.randomUUID() },
      body: {},
    });
    expect(await message(completeWithBody)).toContain("no body");

    const noVariant = await call(`/v1/assets/${assetId}/content`, { bearer: credential });
    expect(await message(noVariant)).toContain("?variant=display");
  });
});

async function message(response: Response): Promise<string> {
  const body = await response.json() as { error: { code: string; message: string } };
  expect(response.status).toBe(400);
  expect(body.error.code).toBe("malformed");
  return body.error.message;
}

async function enroll(): Promise<string> {
  const response = await call("/v1/agents", { email: OPERATOR, body: { display_name: "Ada", declared_model: "fixture-model" } });
  expect(response.status).toBe(201);
  return String((await response.json() as { credential: string }).credential);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
