import { describe, expect, it } from "vitest";
import {
  JChainError,
  UploadRejectedError,
  UploadTimeoutError,
  fitsThumbnail,
  needsThumbnail,
  prepareUpload,
  readWebpInfo,
  staticEncoder,
  stripWebpMetadata,
  thumbnailSize,
} from "../src/index.js";
import { ASSET, CREDENTIAL, LIMITS, REQUEST_ID, UPLOAD_TOKEN, errorBody, fixture, makeClient, mockFetch, sha256, type Recorded, type Reply } from "./helpers.js";

const LARGE = fixture("large.webp");
const LARGE_THUMB = fixture("large-thumb.webp");
const SQUARE_THUMB = fixture("square-thumb.webp");
const SMALL = fixture("valid.webp");

/** A fake service that walks an upload through its states. */
function uploadService(statuses: string[], options: { reason?: string; deduped?: boolean } = {}) {
  let polls = 0;
  return mockFetch((request: Recorded): Reply => {
    const path = `${request.method} ${request.url.pathname}`;
    if (path === "POST /v1/uploads") {
      if (options.deduped) return { status: 200, body: { request_id: REQUEST_ID, asset_id: ASSET, deduped: true, limits: LIMITS } };
      return { status: 201, body: { request_id: REQUEST_ID, asset_id: ASSET, upload_token: UPLOAD_TOKEN, expires_at: "2026-10-23T00:00:00Z", limits: LIMITS } };
    }
    if (path === `PUT /v1/uploads/${ASSET}/content` || path === `PUT /v1/uploads/${ASSET}/thumb`) {
      return { body: { request_id: REQUEST_ID, asset_id: ASSET, state: "reserved", limits: LIMITS } };
    }
    if (path === `POST /v1/uploads/${ASSET}/complete`) {
      return { status: 202, body: { request_id: REQUEST_ID, asset_id: ASSET, state: "uploaded", limits: LIMITS } };
    }
    if (path === `GET /v1/assets/${ASSET}/status`) {
      const state = statuses[Math.min(polls, statuses.length - 1)] ?? "ready";
      polls += 1;
      const body: Record<string, unknown> = { request_id: REQUEST_ID, asset_id: ASSET, state };
      if (state === "rejected" && options.reason) body.reason_code = options.reason;
      return { body };
    }
    return { status: 404, body: errorBody("not_found") };
  });
}

describe("upload state machine", () => {
  it("reserves, puts the content and thumb, completes, and polls with backoff until ready", async () => {
    const service = uploadService(["uploaded", "validating", "validating", "ready"]);
    const { client, sleeps } = makeClient(service.fetch);
    const uploaded = await client.uploadImage({ display: LARGE, thumb: LARGE_THUMB }, { idempotencyKey: "upload-1" });

    expect(uploaded).toMatchObject({ asset_id: ASSET, state: "ready", deduped: false, width: 640, height: 320, thumb: { width: 320, height: 160 } });
    expect(service.calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "POST /v1/uploads",
      `PUT /v1/uploads/${ASSET}/content`,
      `PUT /v1/uploads/${ASSET}/thumb`,
      `POST /v1/uploads/${ASSET}/complete`,
      `GET /v1/assets/${ASSET}/status`,
      `GET /v1/assets/${ASSET}/status`,
      `GET /v1/assets/${ASSET}/status`,
      `GET /v1/assets/${ASSET}/status`,
    ]);
    const [reserve, content, thumb, complete] = service.calls;
    expect(reserve?.json).toEqual({
      content_type: "image/webp",
      byte_size: LARGE.byteLength,
      sha256: await sha256(LARGE),
      thumb: { byte_size: LARGE_THUMB.byteLength, sha256: await sha256(LARGE_THUMB) },
    });
    expect(reserve?.headers.authorization).toBe(`Bearer ${CREDENTIAL}`);
    expect(content?.headers["upload-token"]).toBe(UPLOAD_TOKEN);
    expect(content?.headers.authorization).toBeUndefined();
    expect(content?.headers["content-type"]).toBe("application/octet-stream");
    expect(Array.from(content?.body ?? [])).toEqual(Array.from(LARGE));
    expect(Array.from(thumb?.body ?? [])).toEqual(Array.from(LARGE_THUMB));
    expect(complete?.body).toBeNull();
    expect(service.calls.slice(0, 4).map((call) => call.headers["idempotency-key"])).toEqual([
      "upload-1.reserve",
      "upload-1.content",
      "upload-1.thumb",
      "upload-1.complete",
    ]);
    expect(sleeps).toEqual([250, 500, 1000]);
  });

  it("skips the thumbnail for an image that already fits 320", async () => {
    const service = uploadService(["ready"]);
    const { client } = makeClient(service.fetch);
    const uploaded = await client.uploadImage({ display: SMALL, thumb: SQUARE_THUMB });
    expect(uploaded.thumb).toBeNull();
    expect((service.calls[0]?.json as Record<string, unknown>).thumb).toBeUndefined();
    expect(service.calls.some((call) => call.url.pathname.endsWith("/thumb"))).toBe(false);
  });

  it("returns at once when the service already holds the same image", async () => {
    const service = uploadService([], { deduped: true });
    const { client } = makeClient(service.fetch);
    const uploaded = await client.uploadImage({ display: SMALL, thumb: null });
    expect(uploaded).toMatchObject({ asset_id: ASSET, deduped: true, state: "ready" });
    expect(service.calls).toHaveLength(1);
  });

  it("throws UploadRejectedError with the safe reason code", async () => {
    const service = uploadService(["validating", "rejected"], { reason: "invalid_image" });
    const { client } = makeClient(service.fetch);
    const error = await client.uploadImage({ display: LARGE, thumb: LARGE_THUMB }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UploadRejectedError);
    expect(error).toMatchObject({ code: "upload_rejected", assetId: ASSET, reasonCode: "invalid_image" });
  });

  it.each(["deletion_pending", "deleted"])("stops polling when the Asset is %s", async (state) => {
    const service = uploadService(["validating", state]);
    const { client } = makeClient(service.fetch);
    const error = await client.uploadImage({ display: SMALL, thumb: null }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UploadRejectedError);
    expect(error).toMatchObject({ code: "upload_rejected", assetId: ASSET });
    expect(service.calls.filter((call) => call.url.pathname.endsWith("/status"))).toHaveLength(2);
  });

  it("gives up with UploadTimeoutError after the poll budget", async () => {
    const service = uploadService(["validating"]);
    const { client, sleeps } = makeClient(service.fetch, { uploadPoll: { initialDelayMs: 100, maxDelayMs: 400, timeoutMs: 1000 } });
    const error = await client.uploadImage({ display: SMALL, thumb: null }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UploadTimeoutError);
    expect(error).toMatchObject({ code: "upload_timeout", lastState: "validating" });
    expect(sleeps).toEqual([100, 200, 400, 300]);
  });

  it("stops at the first refused step", async () => {
    const mock = mockFetch((request) => request.url.pathname.endsWith("/content")
      ? { status: 422, body: errorBody("validation_failed", { limits: LIMITS }) }
      : { status: 201, body: { request_id: REQUEST_ID, asset_id: ASSET, upload_token: UPLOAD_TOKEN } });
    const { client } = makeClient(mock.fetch);
    await expect(client.uploadImage({ display: SMALL, thumb: null })).rejects.toMatchObject({ code: "validation_failed", status: 422 });
    expect(mock.calls).toHaveLength(2);
  });

  it("encodes raw input through the injected encoder, and asks for one when missing", async () => {
    const service = uploadService(["ready"]);
    const { client } = makeClient(service.fetch, { encoder: staticEncoder({ display: LARGE, thumb: LARGE_THUMB }) });
    const uploaded = await client.uploadImage("/any/path.png");
    expect(uploaded.width).toBe(640);
    const bare = makeClient(service.fetch).client;
    await expect(bare.uploadImage(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({ code: "encoder_missing" });
  });
});

describe("thumbnail rule", () => {
  it("needs a thumbnail only when either edge is over 320", () => {
    expect(needsThumbnail(320, 320)).toBe(false);
    expect(needsThumbnail(321, 10)).toBe(true);
    expect(needsThumbnail(10, 321)).toBe(true);
  });

  it("sizes thumbnails to fit 320 and keep the shape within 1 px", () => {
    for (const [width, height] of [[640, 320], [1001, 333], [333, 1001], [8192, 1], [321, 321], [4000, 3000], [100, 50]] as const) {
      const size = thumbnailSize(width, height);
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(320);
      expect(fitsThumbnail({ width, height }, size)).toBe(true);
    }
    expect(thumbnailSize(1001, 333)).toEqual({ width: 320, height: 106 });
    expect(fitsThumbnail({ width: 640, height: 320 }, { width: 320, height: 162 })).toBe(false);
    expect(fitsThumbnail({ width: 640, height: 320 }, { width: 321, height: 160 })).toBe(false);
    expect(fitsThumbnail({ width: 640, height: 320 }, { width: 319, height: 159 })).toBe(true);
  });

  it("refuses a missing or misshapen thumbnail before any request", () => {
    expect(() => prepareUpload({ display: LARGE, thumb: null })).toThrow(/thumbnail is required/);
    expect(() => prepareUpload({ display: LARGE, thumb: SQUARE_THUMB })).toThrow(/keep the display shape/);
    expect(() => prepareUpload({ display: LARGE, thumb: LARGE })).toThrow(/fit 320/);
    const prepared = prepareUpload({ display: LARGE, thumb: LARGE_THUMB });
    expect(prepared.thumbSize).toEqual({ width: 320, height: 160 });
  });

  it("refuses PNG and animated WebP", () => {
    let error: unknown;
    try {
      prepareUpload({ display: fixture("valid.png"), thumb: null });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(JChainError);
    expect(error).toMatchObject({ code: "invalid_argument", status: 0 });
    expect(() => prepareUpload({ display: fixture("animated.webp"), thumb: null })).toThrow(/Animated/);
  });

  it("removes metadata chunks before hashing", () => {
    const withMetadata = fixture("metadata.webp");
    const before = readWebpInfo(withMetadata);
    expect(before.ok && before.info.metadata.length).toBeGreaterThan(0);
    const prepared = prepareUpload({ display: withMetadata, thumb: null });
    const after = readWebpInfo(prepared.display);
    expect(after.ok && after.info.metadata).toEqual([]);
    expect(prepared.display.byteLength).toBeLessThan(withMetadata.byteLength);
    expect(stripWebpMetadata(SMALL)).toBe(SMALL);
  });
});
