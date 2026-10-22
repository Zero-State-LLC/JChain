import { uuidv7 } from "./ids";

export const SPEC_VERSION = "0.2.22";

const BUILD_SHA = /^[0-9a-fA-F]{7,40}$/;

export function opsResponse(request: Request, env: Env): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const { pathname } = new URL(request.url);
  if (pathname === "/health") return opsJson(request, { ok: true });
  if (pathname === "/version") return opsJson(request, { spec: SPEC_VERSION, build: buildSha(env) });
  return null;
}

export function withSecurityHeaders(response: Response): Response {
  const secured = new Response(response.body, response);
  secured.headers.set("strict-transport-security", "max-age=31536000");
  secured.headers.set("x-content-type-options", "nosniff");
  return secured;
}

function buildSha(env: Env): string {
  const value = (env as Env & { BUILD_SHA?: unknown }).BUILD_SHA;
  if (typeof value !== "string" || !BUILD_SHA.test(value)) return "unknown";
  return value;
}

function opsJson(request: Request, body: Record<string, unknown>): Response {
  return new Response(request.method === "HEAD" ? null : JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-request-id": uuidv7(),
    },
  });
}
