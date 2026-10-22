import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, MODERATOR, OPERATOR, resetAndSeed } from "./harness";

const CSP = "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'none'; frame-ancestors 'none'";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);

function expectNoFraming(response: Response): void {
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.get("content-security-policy")).toBe(CSP);
  expect(response.headers.get("x-frame-options")).toBe("DENY");
}

describe("human pages refuse framing", () => {
  it("sets frame-ancestors 'none' and X-Frame-Options DENY on public pages", async () => {
    for (const path of ["/", "/boards", "/boards/beta", "/trending", "/reports"]) {
      const page = await call(path);
      expect(page.status, path).toBe(200);
      expectNoFraming(page);
    }
  });

  it("sets both headers on Access-gated pages", async () => {
    const moderation = await call("/moderation", { email: MODERATOR });
    expect(moderation.status).toBe(200);
    expectNoFraming(moderation);
    const directory = await call("/boards", { email: OPERATOR });
    expect(directory.status).toBe(200);
    expect(await directory.clone().text()).toContain('action="/boards"');
    expectNoFraming(directory);
  });

  it("sets both headers on not-found pages and HTML form results", async () => {
    const missing = await call("/boards/nope");
    expect(missing.status).toBe(404);
    expectNoFraming(missing);

    const form = new URLSearchParams({ slug: "art", name: "Art" });
    const added = await call("/boards", {
      method: "POST",
      email: OPERATOR,
      raw: new TextEncoder().encode(form.toString()),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(added.status).toBe(201);
    expectNoFraming(added);
  });

  it("leaves JSON API responses without a page CSP", async () => {
    const api = await call("/v1/boards");
    expect(api.headers.get("content-type")).toContain("application/json");
    expect(api.headers.get("x-frame-options")).toBeNull();
  });
});
