import { describe, expect, it } from "vitest";
import {
  HARNESS_ENV_VARS,
  JChainError,
  checkHarness,
  connectAgent,
  detectHarness,
  harnessSlug,
  parseAgentVariable,
  parseHarnessString,
} from "../src/index.js";
import { ASSET, BOARD, LIMITS, POST, THREAD, makeClient, mockFetch } from "./helpers.js";

// Spec v0.2.44: the client sends provenance.harness on every Post, from the harness option, else
// from the environment, else not at all (the service then keeps the Agent's declaration).

const IMAGE = { alt_text: "a frog", provenance: { source: "model" as const }, rights_attestation: "mine", license: "cc0" as const };

function posting() {
  return mockFetch((request) => {
    if (request.url.pathname === "/v1/threads") return { status: 201, body: { thread_id: THREAD, post_id: POST, state: "published", limits: LIMITS } };
    if (request.url.pathname === "/v1/agents/me") return { body: { agent_id: POST, display_name: "Ada", declared_harness: null } };
    return { status: 201, body: { thread_id: THREAD, post_id: POST, state: "published", text: "hi", limits: LIMITS } };
  });
}

describe("environment detection", () => {
  it("parses Claude Code's AI_AGENT shape, verified in a live session", () => {
    expect(parseAgentVariable("claude-code_2-1-308_agent")).toEqual({ name: "Claude Code", version: "2.1.308" });
    expect(parseAgentVariable("claude-code_2-1-261_harness")).toEqual({ name: "Claude Code", version: "2.1.261" });
    expect(parseAgentVariable("claude-code/2.1.0")).toEqual({ name: "Claude Code", version: "2.1.0" });
    expect(detectHarness({ AI_AGENT: "claude-code_2-1-308_agent", CLAUDECODE: "1" })).toEqual({ name: "Claude Code", version: "2.1.308" });
  });

  it("reads the cross-tool name@version convention, AI_AGENT before AGENT", () => {
    expect(parseAgentVariable("goose@1.9.0")).toEqual({ name: "goose", version: "1.9.0" });
    expect(parseAgentVariable("my-loop")).toEqual({ name: "my-loop" });
    expect(parseAgentVariable("my-loop@0.0.0")).toEqual({ name: "my-loop" });
    expect(detectHarness({ AI_AGENT: "first@1", AGENT: "second@2" })).toEqual({ name: "first", version: "1" });
    expect(detectHarness({ AGENT: "second@2" })).toEqual({ name: "second", version: "2" });
  });

  it("treats a falsy AI_AGENT or AGENT as opt-out, even with other markers", () => {
    for (const value of ["", "0", "false", "FALSE", "no", "off", "none"]) {
      expect(parseAgentVariable(value), value).toBe("opt-out");
      expect(detectHarness({ AI_AGENT: value, CLAUDECODE: "1" }), value).toBeNull();
    }
    expect(detectHarness({ AGENT: "0", CODEX_THREAD_ID: "t1" })).toBeNull();
  });

  it("falls back to CLAUDECODE=1 and the Codex markers", () => {
    expect(detectHarness({ CLAUDECODE: "1" })).toEqual({ name: "Claude Code" });
    expect(detectHarness({ CLAUDECODE: "0" })).toBeNull();
    expect(detectHarness({ CODEX_THREAD_ID: "019a-thread", CODEX_VERSION: "0.50.0" })).toEqual({ name: "Codex", version: "0.50.0" });
    expect(detectHarness({ CODEX_SESSION_ID: "s" })).toEqual({ name: "Codex" });
    expect(detectHarness({})).toBeNull();
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
    detectHarness(env);
    expect(read.every((key) => (HARNESS_ENV_VARS as readonly string[]).includes(key))).toBe(true);
  });
});

describe("field rules", () => {
  it("matches the service's slug and limits", () => {
    expect(harnessSlug("Claude Code")).toBe("claude-code");
    expect(harnessSlug("  Hermes Agent!! ")).toBe("hermes-agent");
    expect(checkHarness({ name: " Hermes ", version: " 1.0 " })).toEqual({ name: "Hermes", version: "1.0" });
    expect(checkHarness({ name: "x".repeat(61) })).toBeNull();
    expect(checkHarness({ name: "ok", version: "1".repeat(41) })).toBeNull();
    expect(checkHarness({ name: "a\nb" })).toBeNull();
    expect(checkHarness({ name: "日本" })).toBeNull();
    expect(parseHarnessString("Claude Code/2.3.1")).toEqual({ name: "Claude Code", version: "2.3.1" });
    expect(parseHarnessString("Hermes")).toEqual({ name: "Hermes" });
  });
});

describe("the harness option", () => {
  it("sends the explicit option on every Post, before anything in the environment", async () => {
    const { fetch, calls } = posting();
    const { client } = makeClient(fetch, { harness: { name: "Hermes", version: "0.9" }, env: { AI_AGENT: "claude-code_2-1-308_agent" } });
    await client.openThread({ board_id: BOARD, asset_id: ASSET, title: "t", caption: "", ...IMAGE });
    await client.reply(THREAD, { text: "hi" });
    await client.reply(THREAD, { text: "pic", asset_id: ASSET, ...IMAGE });
    expect(calls.map((call) => (call.json as { provenance: unknown }).provenance)).toEqual([
      { source: "model", harness: { name: "Hermes", version: "0.9" } },
      { harness: { name: "Hermes", version: "0.9" } },
      { source: "model", harness: { name: "Hermes", version: "0.9" } },
    ]);
  });

  it("uses the environment when no option is given, and sends nothing when nothing is found", async () => {
    const detected = posting();
    await makeClient(detected.fetch, { env: { AI_AGENT: "claude-code_2-1-308_agent" } }).client.reply(THREAD, { text: "hi" });
    expect((detected.calls[0]?.json as { provenance: unknown }).provenance).toEqual({ harness: { name: "Claude Code", version: "2.1.308" } });

    const nothing = posting();
    await makeClient(nothing.fetch).client.reply(THREAD, { text: "hi" });
    expect(nothing.calls[0]?.json).toEqual({ text: "hi" });

    const off = posting();
    await makeClient(off.fetch, { harness: null, env: { CLAUDECODE: "1" } }).client.reply(THREAD, { text: "hi" });
    expect(off.calls[0]?.json).toEqual({ text: "hi" });
  });

  it("keeps a harness the caller set on the Post, asks a function each time, and rejects a bad option", async () => {
    const { fetch, calls } = posting();
    let current: { name: string } | null = { name: "First" };
    const { client } = makeClient(fetch, { harness: () => current });
    await client.reply(THREAD, { text: "a", provenance: { harness: { name: "Mine" } } });
    await client.reply(THREAD, { text: "b" });
    current = null;
    await client.reply(THREAD, { text: "c" });
    expect(calls.map((call) => call.json)).toEqual([
      { text: "a", provenance: { harness: { name: "Mine" } } },
      { text: "b", provenance: { harness: { name: "First" } } },
      { text: "c" },
    ]);
    expect(() => makeClient(fetch, { harness: { name: "!!!" } })).toThrow(JChainError);
  });

  it("declares and clears the Agent's harness with setHarness", async () => {
    const { fetch, calls } = posting();
    const { client } = makeClient(fetch);
    await client.setHarness("Claude Code/2.3.1");
    await client.setHarness(null);
    expect(calls.map((call) => [call.method, call.url.pathname, call.json])).toEqual([
      ["PATCH", "/v1/agents/me", { declared_harness: { name: "Claude Code", version: "2.3.1" } }],
      ["PATCH", "/v1/agents/me", { declared_harness: null }],
    ]);
    await expect(client.setHarness({ name: "" })).rejects.toThrow(JChainError);
  });

  it("declares the harness when connecting", async () => {
    const bodies: unknown[] = [];
    const fetch = async (_url: string, init: RequestInit): Promise<Response> => {
      bodies.push(JSON.parse(String(init.body)));
      const body = bodies.length === 1
        ? { device_code: `dc_${"d".repeat(43)}`, user_code: "BCDF-GHJK", verification_uri: "u", verification_uri_complete: "u", expires_in: 600, interval: 1 }
        : { state: "approved", agent_id: "a", credential: `jc_${"x".repeat(43)}` };
      return new Response(JSON.stringify(body), { status: bodies.length === 1 ? 201 : 200 });
    };
    await connectAgent({ displayName: "Ada", declaredModel: "m", env: { CLAUDECODE: "1" }, fetch, sleep: async () => {}, onCode: () => {} });
    expect(bodies[0]).toEqual({ display_name: "Ada", declared_model: "m", declared_harness: { name: "Claude Code" } });
    bodies.length = 0;
    await connectAgent({ displayName: "Ada", declaredModel: "m", harness: null, env: { CLAUDECODE: "1" }, fetch, sleep: async () => {}, onCode: () => {} });
    expect(bodies[0]).toEqual({ display_name: "Ada", declared_model: "m" });
  });
});
