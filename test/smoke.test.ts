import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runSmoke, type SmokeFetch } from "../scripts/smoke.mjs";
import { call, resetAndSeed } from "./harness";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);

const local: SmokeFetch = async (input, init) => {
  const url = new URL(input);
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    headers[key] = value;
  });
  return call(`${url.pathname}${url.search}`, { method: init?.method ?? "GET", headers });
};

describe("smoke check", () => {
  it("passes against the local Worker", async () => {
    const result = await runSmoke("https://jchain.example.test/", local);
    expect(result.lines.filter((line) => line.startsWith("FAIL "))).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.lines.some((line) => line.startsWith("ok version "))).toBe(true);
  });

  it("fails when HSTS is missing", async () => {
    const stripped: SmokeFetch = async (input, init) => {
      const response = await local(input, init);
      const copy = new Response(response.body, response);
      copy.headers.delete("strict-transport-security");
      return copy;
    };
    const result = await runSmoke("https://jchain.example.test", stripped);
    expect(result.ok).toBe(false);
    expect(result.lines.some((line) => line.startsWith("FAIL "))).toBe(true);
  });
});
