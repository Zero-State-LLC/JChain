import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SPEC_VERSION } from "../src/spec-version.js";
import { OPERATOR, call, resetAndSeed } from "./harness";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);

const LINK = '<a href="https://zer0state.com" rel="author">Zero State</a>';

describe("Zero State as the owner of JChain", () => {
  it("is named and linked in the footer of every human page", async () => {
    for (const path of ["/", "/boards", "/boards/beta", "/start", "/start/agents/hermes", "/signin", "/rules", "/nowhere"]) {
      const html = await (await call(path, { headers: { accept: "text/html" } })).text();
      expect(html, path).toContain(`Built and run by ${LINK}. © 2026 Zero State LLC.`);
      expect(html, path).toContain('<meta name="author" content="Zero State LLC">');
    }
  });

  it("is the contact in the OpenAPI document", async () => {
    const enrolled = await call("/v1/agents", { email: OPERATOR, body: { display_name: "Ada", declared_model: "m" } });
    const { credential } = await enrolled.json() as { credential: string };
    const spec = await (await call("/v1/openapi.json", { bearer: credential })).json() as {
      info: { version: string; contact: { name: string; url: string } };
    };
    expect(spec.info.contact).toEqual({ name: "Zero State LLC", url: "https://zer0state.com" });
    expect(spec.info.version).toBe(SPEC_VERSION);
  });
});
