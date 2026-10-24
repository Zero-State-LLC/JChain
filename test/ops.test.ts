import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bytesResponse } from "../src/http";
import { withSecurityHeaders } from "../src/ops";
import { call, OPERATOR, resetAndSeed, UUID_V7 } from "./harness";

const CSP = "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'none'; frame-ancestors 'none'";
const LEAKS = ["POLICY", "DB", "MEDIA", "TURNSTILE", "QUOTA", "ASSETS", "production", "site_origin", "retention"];

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);

function withBuild(value: unknown): Env {
  return new Proxy(env, {
    get(target, property) {
      if (property === "BUILD_SHA") return value;
      const found = Reflect.get(target, property, target) as unknown;
      return typeof found === "function" ? found.bind(target) : found;
    },
  }) as Env;
}

function expectSecurity(response: Response): void {
  expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

function expectNoLeak(text: string): void {
  for (const leak of LEAKS) expect(text, leak).not.toContain(leak);
}

async function versionFor(value: unknown): Promise<{ spec: string; build: string }> {
  const response = await call("/version", { env: withBuild(value) });
  expect(response.status).toBe(200);
  return response.json();
}

describe("AT-45 health and version", () => {
  it("answers /health while the policy is missing", async () => {
    const response = await call("/health", { policy: null });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ ok: true });
    expectNoLeak(text);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toMatch(UUID_V7);
    expectSecurity(response);
  });

  it("answers HEAD /health without a body", async () => {
    const response = await call("/health", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("reports build unknown without BUILD_SHA", async () => {
    const response = await call("/version", { env: withBuild(undefined) });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ spec: "0.2.41", build: "unknown" });
    expectNoLeak(text);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toMatch(UUID_V7);
    expectSecurity(response);
  });

  it("reports a valid BUILD_SHA", async () => {
    expect(await versionFor("1a2b3c4")).toEqual({ spec: "0.2.41", build: "1a2b3c4" });
    const full = "0123456789abcdef0123456789abcdef01234567";
    expect((await versionFor(full)).build).toBe(full);
  });

  it("reports unknown for an invalid BUILD_SHA", async () => {
    for (const value of ["abc12", "abcdefg", "a".repeat(41), "", 1234567]) {
      const body = await versionFor(value);
      expect(body.build, String(value)).toBe("unknown");
      expect(Object.keys(body).sort()).toEqual(["build", "spec"]);
    }
  });

  it("keeps /health and /version out of the OpenAPI document", async () => {
    const response = await call("/v1/openapi.json", { email: OPERATOR });
    expect(response.status).toBe(200);
    const document = await response.json<{ paths?: Record<string, unknown> }>();
    const paths = Object.keys(document.paths ?? {});
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path.endsWith("/health"), path).toBe(false);
      expect(path.endsWith("/version"), path).toBe(false);
    }
  });
});

describe("R2 security headers", () => {
  it("adds both headers to a JSON error", async () => {
    const response = await call("/v1/openapi.json");
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    expectSecurity(response);
    const boards = await call("/v1/boards");
    expectSecurity(boards);
  });

  it("adds both headers to an HTML page and keeps the page CSP", async () => {
    const response = await call("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toBe(CSP);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expectSecurity(response);
  });

  it("adds both headers to an asset byte response", async () => {
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    const response = withSecurityHeaders(bytesResponse("req", bytes, "image/webp"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expectSecurity(response);
  });

  it("adds both headers to a redirect with immutable headers", async () => {
    const response = withSecurityHeaders(Response.redirect("https://jchain.example.test/boards", 302));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://jchain.example.test/boards");
    expectSecurity(response);
  });
});
