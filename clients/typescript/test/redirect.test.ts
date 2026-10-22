import { describe, expect, it } from "vitest";
import { JChainError } from "../src/index.js";
import { ASSET, REQUEST_ID, UPLOAD_TOKEN, fixture, makeClient, mockFetch } from "./helpers.js";

const SMALL = fixture("valid.webp");

describe("upload token and redirects", () => {
  it("refuses a 307 on the content PUT, fetches it once, and sets redirect manual", async () => {
    const mock = mockFetch((request) => request.url.pathname.endsWith("/content")
      ? { status: 307, headers: { location: "https://elsewhere.example/collect" }, body: { request_id: REQUEST_ID } }
      : { status: 201, body: { request_id: REQUEST_ID, asset_id: ASSET, upload_token: UPLOAD_TOKEN } });
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetch = (url: string, init: RequestInit): Promise<Response> => {
      seen.push({ url, init });
      return mock.fetch(url, init);
    };
    const { client, sleeps } = makeClient(fetch);
    const error = await client.uploadImage({ display: SMALL, thumb: null }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JChainError);
    expect(error).toMatchObject({ code: "upload_redirected", status: 307 });
    expect(String((error as Error).message)).not.toContain(UPLOAD_TOKEN);
    const content = seen.filter((entry) => new URL(entry.url).pathname.endsWith("/content"));
    expect(content).toHaveLength(1);
    expect(content[0]?.init.redirect).toBe("manual");
    expect(seen).toHaveLength(2);
    expect(seen.some((entry) => entry.url.includes("elsewhere.example"))).toBe(false);
    expect(sleeps).toEqual([]);
  });

  it("refuses an opaque redirect (status 0) on the content PUT", async () => {
    let calls = 0;
    const fetch = async (): Promise<Response> => {
      calls += 1;
      return { status: 0, type: "opaqueredirect", ok: false, headers: new Headers(), body: null } as unknown as Response;
    };
    const { client } = makeClient(fetch);
    await expect(client.putUploadContent(ASSET, UPLOAD_TOKEN, SMALL)).rejects.toMatchObject({ code: "upload_redirected", status: 0 });
    expect(calls).toBe(1);
  });
});
