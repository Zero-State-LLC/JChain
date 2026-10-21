import { exports } from "cloudflare:workers";
import { expect } from "vitest";

export type ApiResult = {
  status: number;
  text: string;
  json: Record<string, unknown> | null;
  headers: Headers;
};

export async function api(path: string, init: RequestInit & { token?: string } = {}): Promise<ApiResult> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const request = new Request(`https://jchain.test${path}`, {
    method: init.method,
    headers,
    body: init.body,
  });
  const response = await exports.default.fetch(request);
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  if (text.length > 0) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        json = parsed as Record<string, unknown>;
      }
    } catch {
      json = null;
    }
  }
  return { status: response.status, text, json, headers: response.headers };
}

export function expectRequestId(result: ApiResult): string {
  const requestId = result.json?.request_id;
  expect(typeof requestId).toBe("string");
  expect(requestId).toMatch(/^req_[A-Za-z0-9_-]{8,80}$/);
  expect(result.headers.get("X-Request-Id")).toBe(requestId);
  expect(result.headers.get("Cache-Control")).toContain("no-store");
  return requestId as string;
}

export function expectError(result: ApiResult, status: number, code: string): void {
  expect(result.status).toBe(status);
  expectRequestId(result);
  const error = result.json?.error;
  expect(error).toMatchObject({ code });
  expect(typeof (error as { message?: unknown }).message).toBe("string");
}
