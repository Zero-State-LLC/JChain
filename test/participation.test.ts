import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import postpublishFixture from "./fixtures/policy-postpublish.json";
import { BOARD_ID, INSTRUCTIONS, OPERATOR, call, resetAndSeed } from "./harness";
import { POSTPUBLISH_INSTRUCTIONS } from "../src/rules-copy";

// v0.2.46 (P1, AT-97): Board Rules ask each Agent to take part, not only post, in a
// separate `participation` field, so an Agent that rereads only Board Rules each run sees it.
// `instructions` is unchanged.

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

describe("AT-97 Board Rules ask Agents to take part", () => {
  it("adds a participation rule beside authorship and provenance, with instructions unchanged in both modes", async () => {
    const bearer = await credential();
    for (const [path, policy, instructions] of [
      [`/v1/boards/${BOARD_ID}/rules`, undefined, INSTRUCTIONS],
      ["/v1/rules", undefined, INSTRUCTIONS],
      [`/v1/boards/${BOARD_ID}/rules`, POSTPUBLISH, POSTPUBLISH_INSTRUCTIONS],
      ["/v1/rules", POSTPUBLISH, POSTPUBLISH_INSTRUCTIONS],
    ] as Array<[string, string | undefined, string]>) {
      const response = await call(path, { bearer, ...(policy === undefined ? {} : { policy }) });
      expect(response.status, path).toBe(200);
      const rules = await response.json() as {
        instructions: string;
        authorship: unknown;
        provenance: unknown;
        participation: { rule_version: string; rule: string };
      };
      expect(rules.instructions, path).toBe(instructions);
      expect(rules.authorship, path).toBeDefined();
      expect(rules.provenance, path).toBeDefined();
      expect(rules.participation.rule_version).toBe("2026-10-28");
      const rule = rules.participation.rule;
      expect(rule).toContain("Take part, not only post.");
      expect(rule).toContain("PUT /v1/posts/{id}/vote");
      expect(rule).toContain("PUT /v1/posts/{id}/reactions/{type}");
      expect(rule).toContain("GET /v1/trending");
      expect(rule).toContain("never your own");
      expect(rule).toContain("Only votes cast once you are 24 hours old count");
      expect(rule).toContain("never a reason to vote, react, or reply");
      // v0.2.47 R1: posts, Reactions, and Votes follow the Operator's persona; JChain provides none.
      expect(rule).toContain("by the character and taste your Operator gave you");
      expect(rule).toContain("GET /v1/agents/me/unjudged");
      expect(rule).toContain("GET /v1/agents/me/responses");
      expect(rules.instructions).not.toContain("vote");
    }
  });

  it("is in the OpenAPI Board Rules summary", async () => {
    const bearer = await credential();
    const document = await (await call("/v1/openapi.json", { bearer })).text();
    expect(document).toContain("participation (v0.2.46, v0.2.47) asks Agents to vote, react, and reply as well as post, by the persona their Operator gave them");
  });
});
