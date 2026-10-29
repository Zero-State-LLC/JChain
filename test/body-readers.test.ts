import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ADMIN, BOARD_ID, OPERATOR, call, resetAndSeed } from "./harness";
import { readForm, readFormOrJson, readJsonObject } from "../src/forms";

// One set of body readers for every route (gap analysis, 2026-10-29). A JSON body needs an
// application/json content type, a form body needs application/x-www-form-urlencoded, and a
// repeated form field is malformed.

const ORIGIN = "https://jchain.example.test";

function request(body: string, type: string | null): Request {
  const headers = new Headers();
  if (type !== null) headers.set("content-type", type);
  return new Request(`${ORIGIN}/x`, { method: "POST", headers, body });
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);

describe("the shared readers", () => {
  it("reads a JSON object only with a JSON content type", async () => {
    expect(await readJsonObject(request('{"a":1}', "application/json; charset=utf-8"))).toEqual({ ok: true, value: { a: 1 } });
    expect(await readJsonObject(request('{"a":1}', null))).toEqual({ ok: false });
    expect(await readJsonObject(request('{"a":1}', "text/plain"))).toEqual({ ok: false });
    expect(await readJsonObject(request("[1]", "application/json"))).toEqual({ ok: false });
    expect(await readJsonObject(request("null", "application/json"))).toEqual({ ok: false });
    expect(await readJsonObject(request("{", "application/json"))).toEqual({ ok: false });
  });

  it("reads a form only with a form content type, and refuses a repeated field", async () => {
    const form = "application/x-www-form-urlencoded";
    expect(await readForm(request("a=1&b=two", form))).toEqual({ ok: true, value: { a: "1", b: "two" } });
    expect(await readForm(request("a=1&a=2", form))).toEqual({ ok: false });
    expect(await readForm(request("a=1", null))).toEqual({ ok: false });
    expect(await readForm(request("a=1", "application/json"))).toEqual({ ok: false });
  });

  it("reads either by content type, and nothing else", async () => {
    expect(await readFormOrJson(request('{"a":1}', "application/json"))).toEqual({ ok: true, value: { a: 1 }, form: false });
    expect(await readFormOrJson(request("a=1", "application/x-www-form-urlencoded"))).toEqual({ ok: true, value: { a: "1" }, form: true });
    expect(await readFormOrJson(request("a=1", "text/plain"))).toEqual({ ok: false });
    expect(await readFormOrJson(request("a=1", null))).toEqual({ ok: false });
  });
});

describe("routes that read JSON without checking the content type", () => {
  it("POST /v1/exports refuses a JSON body sent without application/json", async () => {
    const raw = new TextEncoder().encode(JSON.stringify({ board_id: BOARD_ID, purpose: "archive" }));
    const response = await call("/v1/exports", { email: ADMIN, raw });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("malformed");
    expect((await call("/v1/exports", { email: ADMIN, body: { board_id: BOARD_ID, purpose: "archive" } })).status).toBe(201);
  });

  it("POST /v1/deletion-requests refuses a JSON body sent without application/json", async () => {
    const created = await call("/v1/agents", { email: OPERATOR, body: { display_name: "Ada", declared_model: "m" } });
    const agentId = String((await created.json() as { agent_id: string }).agent_id);
    const raw = new TextEncoder().encode(JSON.stringify({ agent_id: agentId }));
    const response = await call("/v1/deletion-requests", { email: OPERATOR, raw });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("malformed");
  });
});
