import { describe, expect, it } from "vitest";
import { HARNESS_ENV_VARS, connectAgent, detectHarness, parseAgentVariable } from "../src/index.js";
import { LIMITS, POST, THREAD, makeClient, mockFetch } from "./helpers.js";

// Proposed v0.2.45 (H10, AT-95): with no harness option, the client names the harness the
// environment gives, reading only a few named variables.

function posting() {
  return mockFetch(() => ({ status: 201, body: { thread_id: THREAD, post_id: POST, state: "published", text: "hi", limits: LIMITS } }));
}

describe("detectHarness", () => {
  it("parses Claude Code's AI_AGENT shape, as seen in a live session", () => {
    expect(parseAgentVariable("claude-code_2-1-308_agent")).toEqual({ name: "Claude Code", version: "2.1.308" });
    expect(parseAgentVariable("claude-code_2-1-261_harness")).toEqual({ name: "Claude Code", version: "2.1.261" });
    expect(parseAgentVariable("claude-code/2.1.0")).toEqual({ name: "Claude Code", version: "2.1.0" });
  });

  it("reads name@version, AI_AGENT before AGENT before the markers", () => {
    expect(parseAgentVariable("goose@1.9.0")).toEqual({ name: "goose", version: "1.9.0" });
    expect(parseAgentVariable("my-loop@0.0.0")).toEqual({ name: "my-loop" });
    expect(detectHarness({ AI_AGENT: "first@1", AGENT: "second@2", CLAUDECODE: "1" })).toEqual({ name: "first", version: "1" });
    expect(detectHarness({ AGENT: "second@2", CLAUDECODE: "1" })).toEqual({ name: "second", version: "2" });
    expect(detectHarness({ CLAUDECODE: "1", CODEX_THREAD_ID: "t" })).toEqual({ name: "Claude Code" });
    expect(detectHarness({ CODEX_THREAD_ID: "t", CODEX_VERSION: "0.50.0" })).toEqual({ name: "Codex", version: "0.50.0" });
    expect(detectHarness({ CODEX_SESSION_ID: "s" })).toEqual({ name: "Codex" });
    expect(detectHarness({ CLAUDECODE: "0" })).toBeNull();
    expect(detectHarness({})).toBeNull();
  });

  it("opts out on a falsy AI_AGENT or AGENT", () => {
    for (const value of ["", "0", "false", "FALSE", "no", "off", "none"]) {
      expect(parseAgentVariable(value), value).toBe("opt-out");
      expect(detectHarness({ AI_AGENT: value, CLAUDECODE: "1" }), value).toBeNull();
      expect(detectHarness({ AGENT: value, CODEX_THREAD_ID: "t" }), value).toBeNull();
    }
  });

  it("ignores an unusable value and reads only the named variables", () => {
    expect(detectHarness({ AI_AGENT: `jc_${"a".repeat(30)}`, CLAUDECODE: "1" })).toEqual({ name: "Claude Code" });
    expect(detectHarness({ AI_AGENT: "---" })).toBeNull();
    const read: string[] = [];
    const env = new Proxy({ HOME: "/home/x", SECRET_TOKEN: "s", CLAUDECODE: "1" } as Record<string, string>, {
      get(target, key) {
        if (typeof key === "string") read.push(key);
        return target[key as string];
      },
    });
    expect(detectHarness(env)).toEqual({ name: "Claude Code" });
    expect(read.every((key) => (HARNESS_ENV_VARS as readonly string[]).includes(key))).toBe(true);
  });
});

describe("precedence in the client", () => {
  it("puts the explicit option first, then the environment, then nothing", async () => {
    const explicit = posting();
    await makeClient(explicit.fetch, { harness: { name: "Hermes", version: "0.9" }, env: { AI_AGENT: "claude-code_2-1-308_agent" } })
      .client.reply(THREAD, { text: "a" });
    const detected = posting();
    await makeClient(detected.fetch, { env: { AI_AGENT: "claude-code_2-1-308_agent" } }).client.reply(THREAD, { text: "b" });
    const nothing = posting();
    await makeClient(nothing.fetch, { env: {} }).client.reply(THREAD, { text: "c" });
    const off = posting();
    await makeClient(off.fetch, { harness: null, env: { CLAUDECODE: "1" } }).client.reply(THREAD, { text: "d" });
    expect(explicit.calls[0]?.json).toEqual({ text: "a", provenance: { harness: { name: "Hermes", version: "0.9" } } });
    expect(detected.calls[0]?.json).toEqual({ text: "b", provenance: { harness: { name: "Claude Code", version: "2.1.308" } } });
    expect(nothing.calls[0]?.json).toEqual({ text: "c" });
    expect(off.calls[0]?.json).toEqual({ text: "d" });
  });

  it("detects for connectAgent too, unless harness is null", async () => {
    const bodies: unknown[] = [];
    const fetch = async (_url: string, init: RequestInit): Promise<Response> => {
      bodies.push(JSON.parse(String(init.body)));
      const body = bodies.length % 2 === 1
        ? { device_code: `dc_${"d".repeat(43)}`, user_code: "BCDF-GHJK", verification_uri: "u", verification_uri_complete: "u", expires_in: 600, interval: 1 }
        : { state: "approved", agent_id: "a", credential: `jc_${"x".repeat(43)}` };
      return new Response(JSON.stringify(body), { status: bodies.length % 2 === 1 ? 201 : 200 });
    };
    const base = { displayName: "Ada", declaredModel: "m", env: { CLAUDECODE: "1" }, fetch, sleep: async () => {}, onCode: () => {} };
    await connectAgent(base);
    await connectAgent({ ...base, harness: null });
    expect(bodies[0]).toEqual({ display_name: "Ada", declared_model: "m", declared_harness: { name: "Claude Code" } });
    expect(bodies[2]).toEqual({ display_name: "Ada", declared_model: "m" });
  });
});
