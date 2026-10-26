import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import postpublishFixture from "./fixtures/policy-postpublish.json";
import { BOARD_ID, INSTRUCTIONS, OPERATOR, call, resetAndSeed } from "./harness";
import { POSTPUBLISH_INSTRUCTIONS } from "../src/rules-copy";

// v0.2.45 (H11, AT-96): Board Rules ask each Agent to name its harness in a separate
// `provenance` field, and `instructions` is unchanged. The agent pages ask for it too.

const POSTPUBLISH = JSON.stringify(postpublishFixture);

async function credential(): Promise<string> {
  const response = await call("/v1/agents", { email: OPERATOR, body: { display_name: "Ada", declared_model: "m" } });
  expect(response.status).toBe(201);
  return String((await response.json() as { credential: string }).credential);
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);

describe("AT-96 Board Rules ask for the harness", () => {
  it("adds a provenance rule beside authorship, with instructions unchanged in both modes", async () => {
    const bearer = await credential();
    for (const [path, policy, instructions] of [
      [`/v1/boards/${BOARD_ID}/rules`, undefined, INSTRUCTIONS],
      ["/v1/rules", undefined, INSTRUCTIONS],
      [`/v1/boards/${BOARD_ID}/rules`, POSTPUBLISH, POSTPUBLISH_INSTRUCTIONS],
      ["/v1/rules", POSTPUBLISH, POSTPUBLISH_INSTRUCTIONS],
    ] as Array<[string, string | undefined, string]>) {
      const response = await call(path, { bearer, ...(policy === undefined ? {} : { policy }) });
      expect(response.status, path).toBe(200);
      const rules = await response.json() as { instructions: string; provenance: { rule_version: string; rule: string }; authorship: unknown };
      expect(rules.instructions, path).toBe(instructions);
      expect(rules.authorship, path).toBeDefined();
      expect(rules.provenance.rule_version).toBe("2026-10-26");
      expect(rules.provenance.rule).toContain("provenance.harness");
      expect(rules.provenance.rule).toContain("declared_harness");
      expect(rules.provenance.rule).toContain("optional");
      expect(rules.provenance.rule).toContain("a declaration, not a verified fact");
      expect(rules.instructions).not.toContain("harness");
    }
  });

  it("asks on /join, /join.md, /llms.txt, and /start, and says it is optional", async () => {
    for (const path of ["/join", "/join.md"]) {
      const text = await (await call(path, { policy: null })).text();
      expect(text, path).toContain("On each Post, name your harness in `provenance.harness`");
      expect(text, path).toContain("It is optional");
      expect(text, path).toContain("{\"display_name\": \"Ada\", \"declared_model\": \"my-model-1\"}");
    }
    const llms = await (await call("/llms.txt", { policy: null })).text();
    expect(llms).toContain("name it on each Post in `provenance.harness`");
    expect(llms).toContain("It is optional, and a declaration, not a verified fact.");
    const start = await (await call("/start", { policy: null })).text();
    expect(start).toContain("<code>provenance.harness</code>");
    expect(start).toContain("It is optional, and a declaration, not a verified fact.");
  });
});
