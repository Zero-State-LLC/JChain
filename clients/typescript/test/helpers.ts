import { readFileSync } from "node:fs";
import { JChainClient, type JChainClientOptions } from "../src/index.js";

// An obvious placeholder. Not a real Credential.
export const CREDENTIAL = `jc_${"x".repeat(43)}`;
export const UPLOAD_TOKEN = `up_${"y".repeat(43)}`;
export const BOARD = "01900000-0000-7000-8000-000000000001";
export const ASSET = "01900000-0000-7000-8000-0000000000a1";
export const THREAD = "01900000-0000-7000-8000-0000000000b1";
export const POST = "01900000-0000-7000-8000-0000000000c1";
export const REQUEST_ID = "01900000-0000-7000-8000-0000000000ff";

export const LIMITS = {
  threads: { remaining: 1, reset_at: "2026-10-22T01:00:00Z" },
  replies: { remaining: 6, reset_at: "2026-10-22T01:00:00Z" },
  mutations: { remaining: 20, reset_at: "2026-10-23T00:00:00Z" },
  events: { remaining: 60, reset_at: "2026-10-22T00:01:00Z" },
  reactions: { remaining: 30, reset_at: "2026-10-22T00:01:00Z" },
};

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
}

export type Recorded = {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: Uint8Array | null;
  json: unknown;
};

export type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; raw?: Uint8Array };

/** A scripted fetch. The handler sees each request and returns a reply. Every request is recorded. */
export function mockFetch(handler: (request: Recorded, index: number) => Reply | Promise<Reply>) {
  const calls: Recorded[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(init.headers as Record<string, string>)) headers[name.toLowerCase()] = value;
    let body: Uint8Array | null = null;
    let json: unknown;
    if (typeof init.body === "string") {
      body = new TextEncoder().encode(init.body);
      json = JSON.parse(init.body);
    } else if (init.body instanceof Uint8Array) {
      body = init.body;
    }
    const recorded: Recorded = { method: init.method ?? "GET", url: new URL(url), headers, body, json };
    calls.push(recorded);
    const reply = await handler(recorded, calls.length - 1);
    const status = reply.status ?? 200;
    const responseHeaders = new Headers(reply.headers);
    if (reply.raw !== undefined) {
      if (!responseHeaders.has("content-type")) responseHeaders.set("content-type", "image/webp");
      return new Response(reply.raw, { status, headers: responseHeaders });
    }
    responseHeaders.set("content-type", "application/json");
    responseHeaders.set("x-request-id", REQUEST_ID);
    const payload = reply.body === undefined ? { request_id: REQUEST_ID } : reply.body;
    return new Response(JSON.stringify(payload), { status, headers: responseHeaders });
  };
  return { fetch, calls };
}

export function errorBody(code: string, extra: Record<string, unknown> = {}) {
  return { request_id: REQUEST_ID, error: { code, message: `safe message for ${code}` }, ...extra };
}

export function makeClient(fetch: JChainClientOptions["fetch"], options: Partial<JChainClientOptions> = {}) {
  const sleeps: number[] = [];
  const client = new JChainClient({
    credential: CREDENTIAL,
    fetch,
    // Harness detection reads the environment; tests opt in with env or harness.
    env: {},
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...options,
  });
  return { client, sleeps };
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
