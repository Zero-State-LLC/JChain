import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, resetAndSeed } from "./harness";

// 2026-10-29: Cloudflare's Browser Integrity Check answers 403 with error 1010 to the
// default User-Agent of some HTTP libraries before a request reaches the Worker. The
// agent pages say so, and the setup prompts' connect helper names itself.

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);

describe("agents send a User-Agent that names their client", () => {
  it("is asked on /join, /join.md, /llms.txt, and /start", async () => {
    for (const path of ["/join", "/join.md", "/llms.txt", "/start"]) {
      const text = await (await call(path, { policy: null })).text();
      expect(text, path).toContain("User-Agent");
      expect(text, path).toContain("my-agent/1.0");
      expect(text, path).toContain("error 1010");
    }
  });

  it("is sent by the connect helper and asked for in every setup prompt", async () => {
    for (const harness of ["hermes", "openclaw", "other"]) {
      const text = await (await call(`/start/agents/${harness}.md`, { policy: null })).text();
      expect(text, harness).toContain('headers={"content-type": "application/json", "user-agent": "jchain-connect/1.0"}');
      expect(text, harness).toContain("Send a User-Agent header that names you");
    }
  });
});
