import { applyD1Migrations, createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import betaDocument from "../policy/beta.json";
import worker from "../src/index";
import { sha256Hex } from "../src/credential";
import { readWebp } from "../src/webp";
import {
  ALPHA_WEBP,
  ANIMATED_WEBP,
  IMAGE_SVG,
  LARGE_THUMB_WEBP,
  LARGE_WEBP,
  METADATA_WEBP,
  OTHER_WEBP,
  OVERSIZED_BIN,
  SQUARE_THUMB_WEBP,
  VALID_PNG,
  VALID_WEBP,
} from "./fixtures/bytes";
import { OPERATOR, UUID_V7, call, resetAndSeed } from "./harness";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);
afterEach(() => {
  vi.restoreAllMocks();
});

describe("reserve an upload", () => {
  it("returns an asset id and a single-purpose token that expires with the reservation", async () => {
    const agent = await enroll();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    const response = await reserve(agent.credential, VALID_WEBP, "image/webp");
    const body = await expectSuccess(response, 201);
    expect(body.asset_id).toMatch(UUID_V7);
    expect(body.upload_token).toMatch(/^up_[A-Za-z0-9_-]{43}$/);
    expect(body.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const expiresAt = Date.parse(String(body.expires_at));
    expect(expiresAt - Date.now()).toBeGreaterThan(24 * 60 * 60 * 1000 - 5000);
    expect(expiresAt - Date.now()).toBeLessThan(24 * 60 * 60 * 1000 + 5000);
    expect(body.deduped).toBeUndefined();
    const token = String(body.upload_token);
    expect(logs.join("\n")).not.toContain(token);

    // Status never returns the token, so the stored hash is checked with one read.
    const row = await env.DB.prepare(
      "SELECT token_hash, expires_at FROM upload_tokens WHERE asset_id = ?",
    ).bind(body.asset_id).first<{ token_hash: string; expires_at: string }>();
    expect(row?.token_hash).toBe(await sha256Hex(token));
    expect(row?.expires_at).toBe(body.expires_at);
    const status = await expectSuccess(await assetStatus(String(body.asset_id), agent.credential));
    expect(status).toMatchObject({ asset_id: body.asset_id, state: "reserved" });
    expect(JSON.stringify(status)).not.toContain(token);
    expect(await objectCount()).toBe(0);
  });

  it("requires a valid idempotency key and a parseable reservation", async () => {
    const agent = await enroll();
    const missing = await reserve(agent.credential, VALID_WEBP, "image/webp", {}, { "idempotency-key": "" });
    await expectError(missing, 400, "malformed");
    const invalid = await call("/v1/uploads", {
      bearer: agent.credential,
      headers: { "idempotency-key": "run-\u007f" },
      body: await reservation(VALID_WEBP, "image/webp"),
    });
    await expectError(invalid, 400, "malformed");
    const unknown = await reserve(agent.credential, VALID_WEBP, "image/webp", { note: "nope" });
    await expectError(unknown, 400, "malformed");
    const hash = await reserve(agent.credential, VALID_WEBP, "image/webp", { sha256: "abcd" });
    await expectError(hash, 422, "validation_failed");
    const type = await reserve(agent.credential, VALID_WEBP, "image/svg+xml");
    await expectError(type, 415, "unsupported_media");
    const png = await reserve(agent.credential, VALID_PNG, "image/png");
    await expectError(png, 415, "unsupported_media");
    const thumbKey = await reserve(agent.credential, VALID_WEBP, "image/webp", { thumb: { byte_size: 1, sha256: "ab".repeat(32), width: 1 } });
    await expectError(thumbKey, 400, "malformed");
    const thumbShape = await reserve(agent.credential, VALID_WEBP, "image/webp", { thumb: "small" });
    await expectError(thumbShape, 400, "malformed");
    const thumbHash = await reserve(agent.credential, VALID_WEBP, "image/webp", { thumb: { byte_size: 1, sha256: "abcd" } });
    await expectError(thumbHash, 422, "validation_failed");
    const zero = await reserve(agent.credential, VALID_WEBP, "image/webp", { byte_size: 0 });
    await expectError(zero, 422, "validation_failed");
    await expectError(await call("/v1/uploads", { email: OPERATOR, headers: { "idempotency-key": "op" }, body: await reservation(VALID_WEBP, "image/webp") }), 401, "credential_invalid");
  });

  it("rejects a declared size over the policy cap and creates no upload", async () => {
    const agent = await enroll();
    const response = await call("/v1/uploads", {
      bearer: agent.credential,
      headers: { "idempotency-key": "too-big" },
      body: { content_type: "image/webp", byte_size: 1025, sha256: "a".repeat(64) },
      policy: policyJson((policy) => {
        (policy.upload as { max_bytes: number }).max_bytes = 1024;
      }),
    });
    await expectError(response, 413, "payload_too_large");
    await expectError(await assetStatus("01900000-0000-7000-8000-000000000099", agent.credential), 404, "not_found");
  });

  it("replays the same reservation and conflicts when the body changes", async () => {
    const agent = await enroll();
    const first = await expectSuccess(await reserve(agent.credential, OTHER_WEBP, "image/webp", {}, { "idempotency-key": "west run" }), 201);
    const reordered = await call("/v1/uploads", {
      bearer: agent.credential,
      headers: { "idempotency-key": "west run" },
      body: {
        sha256: await sha256HexBytes(OTHER_WEBP),
        byte_size: OTHER_WEBP.byteLength,
        content_type: "image/webp",
      },
    });
    const second = await expectSuccess(reordered, 201);
    expect(second.asset_id).toBe(first.asset_id);
    expect(second.upload_token).toBe(first.upload_token);
    expect(second.expires_at).toBe(first.expires_at);
    const conflict = await reserve(agent.credential, VALID_WEBP, "image/webp", {}, { "idempotency-key": "west run" });
    await expectError(conflict, 409, "idempotency_conflict");
  });

  it("fails closed when the policy binding is missing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await call("/v1/uploads", {
      bearer: "jc_missing",
      headers: { "idempotency-key": "policy" },
      body: { content_type: "image/webp", byte_size: 1, sha256: "ab".repeat(32) },
      policy: null,
    });
    await expectError(response, 503, "policy_missing");
  });
});

describe("content put", () => {
  it("accepts a static webp, with or without alpha, that matches the reservation", async () => {
    const agent = await enroll();
    for (const bytes of [VALID_WEBP, ALPHA_WEBP]) {
      const reserved = await expectSuccess(await reserve(agent.credential, bytes, "image/webp"), 201);
      const response = await put(String(reserved.asset_id), String(reserved.upload_token), bytes);
      const body = await expectSuccess(response);
      expect(body).toMatchObject({ asset_id: reserved.asset_id, state: "reserved" });
      expect(await storedCopies(bytes)).toBe(1);
    }
  });

  it("rejects svg, animation, spoofed bytes, and oversized bodies with the spec reason codes", async () => {
    const agent = await enroll();
    await expectRejected(agent.credential, IMAGE_SVG, "image/webp", 415, "unsupported_type");
    await expectRejected(agent.credential, ANIMATED_WEBP, "image/webp", 422, "animated");
    await expectRejected(agent.credential, VALID_PNG, "image/webp", 422, "signature_mismatch");

    const tight = policyJson((policy) => {
      (policy.upload as { max_bytes: number }).max_bytes = 1024;
    });
    const before = await objectCount();
    const reserved = await expectSuccess(await call("/v1/uploads", {
      bearer: agent.credential,
      headers: { "idempotency-key": "oversize-reserve" },
      body: { content_type: "image/webp", byte_size: 1024, sha256: "ab".repeat(32) },
      policy: tight,
    }), 201);
    const oversized = await put(String(reserved.asset_id), String(reserved.upload_token), OVERSIZED_BIN, "oversize-put", tight);
    await expectError(oversized, 413, "payload_too_large");
    const status = await expectSuccess(await assetStatus(String(reserved.asset_id), agent.credential));
    expect(status).toMatchObject({ state: "rejected", reason_code: "too_large" });
    await expectError(await assetContent(String(reserved.asset_id), agent.credential, "display"), 404, "not_found");
    expect(await storedCopies(OVERSIZED_BIN)).toBe(0);
    expect(await objectCount()).toBe(before);
  });

  it("leaves the reservation open when the hash or the size does not match", async () => {
    const agent = await enroll();
    const wrongHash = await expectSuccess(await reserve(agent.credential, OTHER_WEBP, "image/webp", {
      sha256: await sha256HexBytes(VALID_WEBP),
    }), 201);
    const mismatch = await put(String(wrongHash.asset_id), String(wrongHash.upload_token), OTHER_WEBP, "hash-once");
    await expectError(mismatch, 422, "validation_failed");
    expect((await expectSuccess(await assetStatus(String(wrongHash.asset_id), agent.credential))).state).toBe("reserved");
    await expectError(await put(String(wrongHash.asset_id), String(wrongHash.upload_token), OTHER_WEBP, "hash-once"), 422, "validation_failed");
    await expectError(await put(String(wrongHash.asset_id), String(wrongHash.upload_token), VALID_WEBP, "hash-once"), 409, "idempotency_conflict");

    const short = await expectSuccess(await reserve(agent.credential, VALID_WEBP, "image/webp", { byte_size: 8 }), 201);
    await expectError(await put(String(short.asset_id), String(short.upload_token), VALID_WEBP, "short"), 422, "validation_failed");
    expect((await expectSuccess(await assetStatus(String(short.asset_id), agent.credential))).state).toBe("reserved");
  });

  it("accepts only the token for that asset", async () => {
    const agent = await enroll();
    const first = await expectSuccess(await reserve(agent.credential, VALID_WEBP, "image/webp", {}, { "idempotency-key": "a" }), 201);
    const second = await expectSuccess(await reserve(agent.credential, OTHER_WEBP, "image/webp", {}, { "idempotency-key": "b" }), 201);
    await expectError(await put(String(first.asset_id), String(second.upload_token), VALID_WEBP), 401, "credential_invalid");
    await expectError(await call(`/v1/uploads/${first.asset_id}/content`, {
      method: "PUT",
      bearer: agent.credential,
      raw: VALID_WEBP,
      headers: { "idempotency-key": "no-token" },
    }), 401, "credential_invalid");
    await env.DB.prepare("UPDATE upload_tokens SET expires_at = ? WHERE asset_id = ?").bind("2020-01-01T00:00:00Z", first.asset_id).run();
    await expectError(await put(String(first.asset_id), String(first.upload_token), VALID_WEBP, "expired"), 401, "credential_invalid");
    expect((await expectSuccess(await assetStatus(String(first.asset_id), agent.credential))).state).toBe("reserved");
  });
});

describe("thumbnail put", () => {
  it("takes a declared thumbnail and refuses complete until it arrives", async () => {
    const agent = await enroll();
    const reserved = await expectSuccess(await reserve(agent.credential, LARGE_WEBP, "image/webp", await thumbOf(LARGE_THUMB_WEBP)), 201);
    const assetId = String(reserved.asset_id);
    const token = String(reserved.upload_token);
    await expectSuccess(await put(assetId, token, LARGE_WEBP));
    await expectError(await complete(assetId, agent.credential, "early"), 409, "state_conflict");
    await expectError(await putThumb(assetId, token, LARGE_WEBP), 422, "validation_failed");
    const body = await expectSuccess(await putThumb(assetId, token, LARGE_THUMB_WEBP, "thumb-once"));
    expect(body).toMatchObject({ asset_id: assetId, state: "reserved" });
    const replay = await expectSuccess(await putThumb(assetId, token, LARGE_THUMB_WEBP, "thumb-once"));
    expect(replay.asset_id).toBe(assetId);
    await expectSuccess(await complete(assetId, agent.credential, "late"), 202);
  });

  it("conflicts when the reservation declared no thumbnail", async () => {
    const agent = await enroll();
    const reserved = await expectSuccess(await reserve(agent.credential, VALID_WEBP, "image/webp"), 201);
    await expectError(await putThumb(String(reserved.asset_id), String(reserved.upload_token), VALID_WEBP), 409, "state_conflict");
  });

  it("rejects an animated thumbnail with the asset", async () => {
    const agent = await enroll();
    const reserved = await expectSuccess(await reserve(agent.credential, VALID_WEBP, "image/webp", await thumbOf(ANIMATED_WEBP)), 201);
    const assetId = String(reserved.asset_id);
    await expectSuccess(await put(assetId, String(reserved.upload_token), VALID_WEBP));
    await expectError(await putThumb(assetId, String(reserved.upload_token), ANIMATED_WEBP), 422, "validation_failed");
    expect(await expectSuccess(await assetStatus(assetId, agent.credential))).toMatchObject({ state: "rejected", reason_code: "animated" });
  });
});

describe("ready asset", () => {
  it("stores the agent's webp without a paid transform, deletes the staged bytes, and serves only the owner", async () => {
    const owner = await enroll("Owner");
    const other = await enroll("Other");
    const reserved = await expectSuccess(await reserve(owner.credential, VALID_WEBP, "image/webp"), 201);
    const assetId = String(reserved.asset_id);
    await expectSuccess(await put(assetId, String(reserved.upload_token), VALID_WEBP));
    expect(await storedCopies(VALID_WEBP)).toBe(1);

    await expectError(await assetContent(assetId, owner.credential, "display"), 404, "not_found");
    await expectError(await call(`/v1/uploads/${assetId}/complete`, {
      method: "POST",
      headers: { "idempotency-key": "token-complete", "upload-token": String(reserved.upload_token) },
    }), 401, "credential_invalid");

    let sends = 0;
    const counting = new Proxy(env, {
      get(target, property, receiver) {
        if (property === "ASSET_UPLOAD") {
          return {
            send(body: unknown) {
              sends += 1;
              expect(body).toEqual({ asset_id: assetId });
              return env.ASSET_UPLOAD.send(body);
            },
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as Env;
    const completed = await expectSuccess(await complete(assetId, owner.credential, "done", counting), 202);
    expect(completed).toMatchObject({ asset_id: assetId, state: "uploaded" });
    const replay = await expectSuccess(await complete(assetId, owner.credential, "done", counting), 202);
    expect(replay).toMatchObject({ asset_id: assetId, state: "uploaded" });
    await expectError(await complete(assetId, owner.credential, "other-key", counting), 409, "state_conflict");
    expect(sends).toBe(1);

    const result = await settle(assetId);
    expect(result.retryMessages).toEqual([]);

    const status = await expectSuccess(await assetStatus(assetId, owner.credential));
    expect(status).toEqual({ asset_id: assetId, state: "ready", request_id: status.request_id });
    expect(await stagedCount()).toBe(0);
    expect(await objectCount()).toBe(2);

    const display = await assetContent(assetId, owner.credential, "display");
    const thumb = await assetContent(assetId, owner.credential, "thumb");
    expect(display.status).toBe(200);
    expect(display.headers.get("content-type")).toContain("image/webp");
    expect(display.headers.get("cache-control")).toBe("no-store");
    expect(display.headers.get("x-request-id")).toMatch(UUID_V7);
    // A display image inside the thumbnail box is its own thumbnail.
    expect(sameBytes(new Uint8Array(await display.arrayBuffer()), VALID_WEBP)).toBe(true);
    expect(sameBytes(new Uint8Array(await thumb.arrayBuffer()), VALID_WEBP)).toBe(true);

    await expectError(await assetContent(assetId, other.credential, "display"), 404, "not_found");
    await expectError(await assetStatus(assetId, other.credential), 404, "not_found");
    await expectError(await assetContent(assetId, owner.credential, "original"), 400, "malformed");
    await expectError(await call(`/v1/assets/${assetId}/content?variant=display`), 401, "credential_invalid");
    await expectError(await call(`/v1/assets/${assetId}/status`, {
      headers: { "upload-token": String(reserved.upload_token) },
    }), 401, "credential_invalid");
    await expectError(await call(`/v1/assets/${assetId}/status`, { email: OPERATOR }), 401, "credential_invalid");

    const before = await objectCount();
    const deduped = await expectSuccess(await reserve(owner.credential, VALID_WEBP, "image/webp", {}, { "idempotency-key": "again" }));
    expect(deduped).toMatchObject({ asset_id: assetId, deduped: true });
    expect(deduped.upload_token).toBeUndefined();
    expect(deduped.expires_at).toBeUndefined();
    expect(await objectCount()).toBe(before);

    const outsider = await expectSuccess(await reserve(other.credential, VALID_WEBP, "image/webp", {}, { "idempotency-key": "theirs" }), 201);
    expect(outsider.asset_id).not.toBe(assetId);
    expect(outsider.upload_token).toMatch(/^up_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(outsider)).not.toContain(assetId);
    expect(await objectCount()).toBe(before);
  });

  it("serves the agent's thumbnail for an image larger than the thumbnail box", async () => {
    const agent = await enroll();
    const assetId = await uploaded(agent.credential, LARGE_WEBP, LARGE_THUMB_WEBP);
    await settle(assetId);
    expect((await expectSuccess(await assetStatus(assetId, agent.credential))).state).toBe("ready");
    expect(await stagedCount()).toBe(0);
    const display = new Uint8Array(await (await assetContent(assetId, agent.credential, "display")).arrayBuffer());
    const thumb = new Uint8Array(await (await assetContent(assetId, agent.credential, "thumb")).arrayBuffer());
    expect(sameBytes(display, LARGE_WEBP)).toBe(true);
    expect(sameBytes(thumb, LARGE_THUMB_WEBP)).toBe(true);
  });

  it("drops metadata chunks before storing", async () => {
    const agent = await enroll();
    const assetId = await uploaded(agent.credential, METADATA_WEBP);
    await settle(assetId);
    expect((await expectSuccess(await assetStatus(assetId, agent.credential))).state).toBe("ready");
    const display = new Uint8Array(await (await assetContent(assetId, agent.credential, "display")).arrayBuffer());
    const text = new TextDecoder("latin1").decode(display);
    expect(text).not.toContain("EXIF");
    expect(text).not.toContain("ICCP");
    expect(text).not.toContain("secret caption");
    expect(readWebp(display)).toMatchObject({ ok: true, width: 2, height: 2 });
    expect(display.byteLength).toBeLessThan(METADATA_WEBP.byteLength);
  });

  it("rejects a missing or misshapen thumbnail", async () => {
    const agent = await enroll();
    const bare = await uploaded(agent.credential, LARGE_WEBP);
    await settle(bare);
    expect(await expectSuccess(await assetStatus(bare, agent.credential))).toMatchObject({ state: "rejected", reason_code: "invalid_image" });

    const square = await uploaded(agent.credential, LARGE_WEBP, SQUARE_THUMB_WEBP);
    await settle(square);
    expect(await expectSuccess(await assetStatus(square, agent.credential))).toMatchObject({ state: "rejected", reason_code: "invalid_image" });
    await expectError(await assetContent(square, agent.credential, "thumb"), 404, "not_found");
  });

  it("rejects dimensions and a broken container from the headers alone", async () => {
    const agent = await enroll();
    const edgeId = await uploaded(agent.credential, METADATA_WEBP);
    await settle(edgeId, queueEnv(policyJson((policy) => {
      (policy.upload as { max_edge_px: number }).max_edge_px = 1;
    })));
    expect((await expectSuccess(await assetStatus(edgeId, agent.credential))).reason_code).toBe("edge_too_long");

    const pixelsId = await uploaded(agent.credential, withLosslessSize(VALID_WEBP, 2000, 2000), VALID_WEBP);
    await settle(pixelsId, queueEnv(policyJson((policy) => {
      (policy.upload as { max_megapixels: number }).max_megapixels = 1;
    })));
    expect((await expectSuccess(await assetStatus(pixelsId, agent.credential))).reason_code).toBe("too_many_pixels");

    const trailing = new Uint8Array(VALID_WEBP.byteLength + 1);
    trailing.set(VALID_WEBP);
    const brokenId = await uploaded(agent.credential, trailing);
    await settle(brokenId);
    expect((await expectSuccess(await assetStatus(brokenId, agent.credential))).reason_code).toBe("invalid_image");
    await expectError(await assetContent(brokenId, agent.credential, "thumb"), 404, "not_found");
  });

  it("rejects a dead-letter message as processing_failed", async () => {
    const agent = await enroll();
    const abandoned = await uploaded(agent.credential, OTHER_WEBP);
    await settle(abandoned, env, "asset-upload-dlq");
    expect((await expectSuccess(await assetStatus(abandoned, agent.credential))).reason_code).toBe("processing_failed");
  });

  it("acks a queue message that is not an asset id", async () => {
    const ctx = createExecutionContext();
    const batch = createMessageBatch("asset-upload", [{
      id: "not-an-asset",
      timestamp: new Date(),
      attempts: 1,
      body: { asset_id: "not-a-uuid", extra: true },
    }]);
    if (!worker.queue) throw new Error("queue handler missing");
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.retryMessages).toEqual([]);
  });

  it("keeps the reservation when the queue cannot accept the message", async () => {
    const agent = await enroll();
    const assetId = await storedOnly(agent.credential, VALID_WEBP);
    const down = new Proxy(env, {
      get(target, property, receiver) {
        if (property === "ASSET_UPLOAD") return { send: async () => { throw new Error("queue down"); } };
        return Reflect.get(target, property, receiver);
      },
    }) as Env;
    await expectError(await complete(assetId, agent.credential, "queued", down), 503, "processing_unavailable");
    expect((await expectSuccess(await assetStatus(assetId, agent.credential))).state).toBe("reserved");
    await expectSuccess(await complete(assetId, agent.credential, "queued"), 202);
  });

  it("does not process an asset rejected at put", async () => {
    const agent = await enroll();
    const reserved = await expectSuccess(await reserve(agent.credential, ANIMATED_WEBP, "image/webp"), 201);
    await expectError(await put(String(reserved.asset_id), String(reserved.upload_token), ANIMATED_WEBP), 422, "validation_failed");
    await settle(String(reserved.asset_id));
    expect((await expectSuccess(await assetStatus(String(reserved.asset_id), agent.credential))).reason_code).toBe("animated");
    await expectError(await call(`/v1/uploads/${reserved.asset_id}/complete`, {
      method: "POST",
      bearer: agent.credential,
      headers: { "idempotency-key": "late" },
    }), 409, "state_conflict");
  });
});

type ErrorBody = { request_id: string; error: { code: string; message: string } };
type SuccessBody = Record<string, unknown> & { request_id?: string };

async function expectError(response: Response, status: number, code: string): Promise<ErrorBody> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/json");
  const requestId = response.headers.get("x-request-id");
  expect(requestId).toMatch(UUID_V7);
  const body = await response.json() as ErrorBody;
  expect(body.request_id).toBe(requestId);
  expect(body.error.code).toBe(code);
  return body;
}

async function expectSuccess(response: Response, status?: number): Promise<SuccessBody> {
  if (status === undefined) expect(response.status).toBeGreaterThanOrEqual(200);
  else expect(response.status).toBe(status);
  expect(response.status).toBeLessThan(300);
  const requestId = response.headers.get("x-request-id");
  expect(requestId).toMatch(UUID_V7);
  const body = await response.json() as SuccessBody;
  expect(body.request_id).toBe(requestId);
  return body;
}

async function enroll(name = "Ada"): Promise<{ credential: string }> {
  const response = await call("/v1/agents", {
    email: OPERATOR,
    body: { display_name: name, declared_model: "fixture-model" },
  });
  const body = await expectSuccess(response, 201);
  return { credential: String(body.credential) };
}

async function reservation(bytes: Uint8Array, contentType: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return {
    content_type: contentType,
    byte_size: bytes.byteLength,
    sha256: await sha256HexBytes(bytes),
    ...extra,
  };
}

async function reserve(
  credential: string,
  bytes: Uint8Array,
  contentType: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  return call("/v1/uploads", {
    bearer: credential,
    headers: { "idempotency-key": crypto.randomUUID(), ...headers },
    body: await reservation(bytes, contentType, extra),
  });
}

function put(assetId: string, token: string, bytes: Uint8Array, key = crypto.randomUUID(), policy?: string): Promise<Response> {
  return call(`/v1/uploads/${assetId}/content`, {
    method: "PUT",
    raw: bytes,
    headers: { "idempotency-key": key, "upload-token": token },
    policy,
  });
}

function complete(assetId: string, credential: string, key: string, bindings?: Env): Promise<Response> {
  return call(`/v1/uploads/${assetId}/complete`, {
    method: "POST",
    bearer: credential,
    headers: { "idempotency-key": key },
    env: bindings,
  });
}

function assetStatus(assetId: string, credential: string): Promise<Response> {
  return call(`/v1/assets/${assetId}/status`, { bearer: credential });
}

function assetContent(assetId: string, credential: string, variant: string): Promise<Response> {
  return call(`/v1/assets/${assetId}/content?variant=${variant}`, { bearer: credential });
}

async function thumbOf(bytes: Uint8Array): Promise<Record<string, unknown>> {
  return { thumb: { byte_size: bytes.byteLength, sha256: await sha256HexBytes(bytes) } };
}

function putThumb(assetId: string, token: string, bytes: Uint8Array, key = crypto.randomUUID()): Promise<Response> {
  return call(`/v1/uploads/${assetId}/thumb`, {
    method: "PUT",
    raw: bytes,
    headers: { "idempotency-key": key, "upload-token": token },
  });
}

async function storedOnly(credential: string, bytes: Uint8Array, thumb?: Uint8Array): Promise<string> {
  const extra = thumb === undefined ? {} : await thumbOf(thumb);
  const reserved = await expectSuccess(await reserve(credential, bytes, "image/webp", extra), 201);
  await expectSuccess(await put(String(reserved.asset_id), String(reserved.upload_token), bytes));
  if (thumb !== undefined) await expectSuccess(await putThumb(String(reserved.asset_id), String(reserved.upload_token), thumb));
  return String(reserved.asset_id);
}

async function uploaded(credential: string, bytes: Uint8Array, thumb?: Uint8Array): Promise<string> {
  const assetId = await storedOnly(credential, bytes, thumb);
  await expectSuccess(await complete(assetId, credential, crypto.randomUUID()), 202);
  return assetId;
}

// A lossless header that claims another size. The pipeline reads headers only, so the pixels never matter.
function withLosslessSize(bytes: Uint8Array, width: number, height: number): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  const bits = view.getUint32(21, true);
  view.setUint32(21, ((bits & 0x10000000) | (width - 1) | ((height - 1) << 14)) >>> 0, true);
  return copy;
}

async function expectRejected(
  credential: string,
  bytes: Uint8Array,
  contentType: string,
  status: number,
  reason: string,
): Promise<void> {
  const reserved = await expectSuccess(await reserve(credential, bytes, contentType), 201);
  const response = await put(String(reserved.asset_id), String(reserved.upload_token), bytes);
  await expectError(response, status, status === 415 ? "unsupported_media" : "validation_failed");
  const body = await expectSuccess(await assetStatus(String(reserved.asset_id), credential));
  expect(body).toMatchObject({ state: "rejected", reason_code: reason });
  await expectError(await assetContent(String(reserved.asset_id), credential, "display"), 404, "not_found");
}

async function settle(assetId: string, bindings: Env = env, queueName = "asset-upload") {
  const ctx = createExecutionContext();
  const batch = createMessageBatch(queueName, [{
    id: `msg-${assetId}-${queueName}`,
    timestamp: new Date(),
    attempts: 1,
    body: { asset_id: assetId },
  }]);
  if (!worker.queue) throw new Error("queue handler missing");
  await worker.queue(batch, bindings, ctx);
  return getQueueResult(batch, ctx);
}

function queueEnv(policy: string): Env {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "POLICY") return policy;
      return Reflect.get(target, property, receiver);
    },
  }) as Env;
}

function policyJson(mutate: (policy: Record<string, unknown>) => void): string {
  const policy = JSON.parse(JSON.stringify(betaDocument)) as Record<string, unknown>;
  mutate(policy);
  return JSON.stringify(policy);
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

async function objectCount(): Promise<number> {
  const page = await env.MEDIA.list();
  return page.objects.length;
}

async function stagedCount(): Promise<number> {
  const page = await env.MEDIA.list({ prefix: "originals/" });
  return page.objects.length;
}

async function storedCopies(bytes: Uint8Array): Promise<number> {
  const page = await env.MEDIA.list();
  let count = 0;
  for (const object of page.objects) {
    const stored = await env.MEDIA.get(object.key);
    if (!stored) continue;
    if (sameBytes(new Uint8Array(await stored.arrayBuffer()), bytes)) count += 1;
  }
  return count;
}
