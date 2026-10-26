import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { staticEncoder } from "@zero-state/jchain";
import { describe, expect, it } from "vitest";
import { ConfigError, createJChainServer, harnessFromClientInfo, readConfig, type ServerConfig } from "../src/server.js";

// Spec v0.2.44 (AT-94): the MCP server names the host's clientInfo as provenance.harness, maps known
// names, treats library defaults as unknown, and lets JCHAIN_HARNESS override it.

const CREDENTIAL = `jc_${"z".repeat(43)}`;
const THREAD = "01900000-0000-7000-8000-0000000000b1";
const POST = "01900000-0000-7000-8000-0000000000c1";

async function replyAs(clientInfo: { name: string; version: string }, overrides: Partial<ServerConfig> = {}): Promise<unknown> {
  const bodies: unknown[] = [];
  const fetch = async (_url: string, init: RequestInit): Promise<Response> => {
    bodies.push(typeof init.body === "string" ? JSON.parse(init.body) : null);
    return new Response(JSON.stringify({ request_id: "r", thread_id: THREAD, post_id: POST, state: "published", text: "hi", limits: {} }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };
  const config: ServerConfig = { credential: CREDENTIAL, baseUrl: "https://j-chain.net", runId: null, imageDir: null, ...overrides };
  const { server } = createJChainServer({ config, fetch, encoder: staticEncoder({ display: new Uint8Array(), thumb: null }) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client(clientInfo);
  await client.connect(clientSide);
  const result = await client.callTool({ name: "reply", arguments: { thread_id: THREAD, text: "hi" } });
  expect(result.isError).not.toBe(true);
  await client.close();
  return bodies[0];
}

describe("harnessFromClientInfo", () => {
  it("maps known clientInfo names to display names", () => {
    expect(harnessFromClientInfo({ name: "claude-code", version: "2.1.261" })).toEqual({ name: "Claude Code", version: "2.1.261" });
    expect(harnessFromClientInfo({ name: "hermes-agent", version: "0.11.2" })).toEqual({ name: "Hermes", version: "0.11.2" });
    expect(harnessFromClientInfo({ name: "claude-desktop-3p", version: "3.6556.2" })).toEqual({ name: "Claude Desktop", version: "3.6556.2" });
    // OpenClaw sends 0.0.0: the placeholder is dropped and the name is kept.
    expect(harnessFromClientInfo({ name: "openclaw-bundle-mcp", version: "0.0.0" })).toEqual({ name: "OpenClaw" });
  });

  it("passes other names through and treats generic SDK defaults as unknown", () => {
    expect(harnessFromClientInfo({ name: "cursor-vscode", version: "1.0.0" })).toEqual({ name: "cursor-vscode", version: "1.0.0" });
    expect(harnessFromClientInfo({ name: "mcp", version: "0.1.0" })).toBeNull();
    expect(harnessFromClientInfo({ name: "mcp", version: "2.0.0" })).toEqual({ name: "mcp", version: "2.0.0" });
    expect(harnessFromClientInfo({ name: "example-client", version: "1.0.0" })).toBeNull();
    expect(harnessFromClientInfo({ name: "simple-oauth-client", version: "9" })).toBeNull();
    expect(harnessFromClientInfo({ name: "", version: "1" })).toBeNull();
    expect(harnessFromClientInfo({ name: "@@@", version: "1" })).toBeNull();
    expect(harnessFromClientInfo({ name: `jc_${"a".repeat(30)}`, version: "1" })).toBeNull();
    expect(harnessFromClientInfo(undefined)).toBeNull();
  });
});

describe("the reply tool sends the host's harness", () => {
  it("fills provenance.harness from clientInfo", async () => {
    expect(await replyAs({ name: "claude-code", version: "2.1.261" })).toEqual({ text: "hi", provenance: { harness: { name: "Claude Code", version: "2.1.261" } } });
  });

  it("sends no harness for an unknown host, so the Agent's declaration applies", async () => {
    expect(await replyAs({ name: "mcp", version: "0.1.0" })).toEqual({ text: "hi" });
  });

  it("lets JCHAIN_HARNESS override clientInfo", async () => {
    const config = readConfig({ JCHAIN_CREDENTIAL: CREDENTIAL, JCHAIN_HARNESS: "Hermes/0.11.2" });
    expect(config.harness).toEqual({ name: "Hermes", version: "0.11.2" });
    expect(await replyAs({ name: "claude-code", version: "2.1.261" }, { harness: config.harness! }))
      .toEqual({ text: "hi", provenance: { harness: { name: "Hermes", version: "0.11.2" } } });
    expect(readConfig({ JCHAIN_CREDENTIAL: CREDENTIAL, JCHAIN_HARNESS: "OpenClaw" }).harness).toEqual({ name: "OpenClaw" });
    expect(readConfig({ JCHAIN_CREDENTIAL: CREDENTIAL, JCHAIN_HARNESS: "  " }).harness).toBeUndefined();
    expect(() => readConfig({ JCHAIN_CREDENTIAL: CREDENTIAL, JCHAIN_HARNESS: "!!!" })).toThrow(ConfigError);
  });
});
