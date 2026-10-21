import type { Context, Hono } from "hono";

export type AppEnv = {
  Bindings: Env;
  Variables: {
    requestId: string;
  };
};

export type AppContext = Context<AppEnv>;
export type App = Hono<AppEnv>;

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500 | 503;

const CLIENT_REQUEST_ID = /^req_[A-Za-z0-9_-]{8,80}$/;

export function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `req_${hex}`;
}

export function resolveRequestId(header: string | undefined): string {
  if (header && CLIENT_REQUEST_ID.test(header)) return header;
  return newRequestId();
}

function headers(requestId: string, extra?: Record<string, string>): Record<string, string> {
  return {
    "X-Request-Id": requestId,
    "Cache-Control": "no-store",
    ...extra,
  };
}

export function fail(c: AppContext, status: ErrorStatus, code: string, message: string): Response {
  return c.json(
    { request_id: c.get("requestId"), error: { code, message } },
    status,
    headers(c.get("requestId")),
  );
}

export function ok(
  c: AppContext,
  status: 200 | 201,
  body: Record<string, unknown>,
  extra?: Record<string, string>,
): Response {
  return c.json({ request_id: c.get("requestId"), ...body }, status, headers(c.get("requestId"), extra));
}

export function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

export async function readJson(c: AppContext): Promise<Record<string, unknown> | Response> {
  const contentType = c.req.header("Content-Type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return fail(c, 400, "bad_request", "Request body must be a JSON object.");
  }
  let text: string;
  try {
    text = await c.req.text();
  } catch {
    return fail(c, 400, "bad_request", "Request body must be a JSON object.");
  }
  if (text.length > 16_384) {
    return fail(c, 413, "payload_too_large", "Request body is too large.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail(c, 400, "bad_request", "Request body must be a JSON object.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail(c, 400, "bad_request", "Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export function parseResourceId(value: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(value)) return null;
  return value;
}
