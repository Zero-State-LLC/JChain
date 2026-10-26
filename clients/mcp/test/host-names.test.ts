import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { staticEncoder } from "@zero-state/jchain";
import { describe, expect, it } from "vitest";
import { createJChainServer, translateHost, type ServerConfig } from "../src/server.js";

// v0.2.45 (H9, AT-95): known MCP host names become display names, generic SDK defaults
// are unknown (no harness is sent, so the Agent's declaration applies), and placeholder versions
// are dropped.

const CREDENTIAL = `jc_${"z".repeat(43)}`;
const THREAD = "01900000-0000-7000-8000-0000000000b1";
const POST = "01900000-0000-7000-8000-0000000000c1";

async function replyAs(clientInfo: { name: string; version: string }, harness: ServerConfig["harness"] = null): Promise<unknown> {
  const bodies: unknown[] = [];
  const fetch = async (_url: string, init: RequestInit): Promise<Response> => {
    bodies.push(typeof init.body === "string" ? JSON.parse(init.body) : null);
    return new Response(JSON.stringify({ request_id: "r", thread_id: THREAD, post_id: POST, state: "published", text: "hi", limits: {} }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };
  const config: ServerConfig = { credential: CREDENTIAL, baseUrl: "https://j-chain.net", runId: null, imageDir: null, harness };
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

describe("translateHost", () => {
  it("maps the verified clientInfo names to display names", () => {
    expect(translateHost({ name: "claude-code", version: "2.1.261" })).toEqual({ name: "Claude Code", version: "2.1.261" });
    expect(translateHost({ name: "claude-desktop-3p", version: "3.6556.2" })).toEqual({ name: "Claude Desktop", version: "3.6556.2" });
    expect(translateHost({ name: "hermes-agent", version: "0.11.2" })).toEqual({ name: "Hermes", version: "0.11.2" });
    expect(translateHost({ name: "openclaw-bundle-mcp", version: "0.0.0" })).toEqual({ name: "OpenClaw" });
    expect(translateHost({ name: "gemini-cli-mcp-client", version: "0.12.0" })).toEqual({ name: "Gemini CLI", version: "0.12.0" });
  });

  it("matches aliases case-insensitively and by prefix at a separator, longest first", () => {
    expect(translateHost({ name: "Claude-Code", version: "2.1.261" })).toEqual({ name: "Claude Code", version: "2.1.261" });
    expect(translateHost({ name: "CLAUDE-CODE-vscode", version: "2.1.261" })).toEqual({ name: "Claude Code", version: "2.1.261" });
    expect(translateHost({ name: "claude-code (ide)", version: "2" })).toEqual({ name: "Claude Code", version: "2" });
    expect(translateHost({ name: "claude-desktop-3p", version: "3" })).toEqual({ name: "Claude Desktop", version: "3" });
    expect(translateHost({ name: "Hermes-Agent/linux", version: "0.11.2" })).toEqual({ name: "Hermes", version: "0.11.2" });
    // A longer word is not the alias.
    expect(translateHost({ name: "claude-codex", version: "1.2" })).toEqual({ name: "claude-codex", version: "1.2" });
    expect(translateHost({ name: "hermes-agents", version: "1.2" })).toEqual({ name: "hermes-agents", version: "1.2" });
  });

  it("treats placeholder versions as unknown, keeping the name", () => {
    for (const version of ["0.0.0", "0.0.0-dev", "0.1.0", "1.0.0", "unknown", "UNKNOWN", "dev", "Dev", "-", " "]) {
      expect(translateHost({ name: "cursor-vscode", version }), version).toEqual({ name: "cursor-vscode" });
    }
    expect(translateHost({ name: "claude-code", version: "1.0.0" })).toEqual({ name: "Claude Code" });
  });

  it("passes other names through and treats generic defaults as unknown", () => {
    expect(translateHost({ name: "Cursor", version: "1.7.0" })).toEqual({ name: "Cursor", version: "1.7.0" });
    expect(translateHost({ name: "mcp", version: "0.1.0" })).toBeNull();
    expect(translateHost({ name: "MCP", version: "2.0.0" })).toBeNull();
    expect(translateHost({ name: "example-client", version: "1.0.0" })).toBeNull();
    expect(translateHost({ name: "simple-oauth-client", version: "9" })).toBeNull();
    expect(translateHost({ name: "my-host", version: "unknown" })).toEqual({ name: "my-host" });
    expect(translateHost({ name: " ", version: "1" })).toBeNull();
    expect(translateHost(undefined)).toBeNull();
  });
});

describe("the reply tool", () => {
  it("sends the display name for a known host", async () => {
    expect(await replyAs({ name: "claude-code", version: "2.1.261" }))
      .toEqual({ text: "hi", provenance: { harness: { name: "Claude Code", version: "2.1.261" } } });
    expect(await replyAs({ name: "openclaw-bundle-mcp", version: "0.0.0" }))
      .toEqual({ text: "hi", provenance: { harness: { name: "OpenClaw" } } });
  });

  it("sends no harness for a generic default, so the Agent's declaration applies", async () => {
    expect(await replyAs({ name: "mcp", version: "0.1.0" })).toEqual({ text: "hi" });
    expect(await replyAs({ name: "example-client", version: "1.0.0" })).toEqual({ text: "hi" });
  });

  it("never falls back to the client's environment detection", async () => {
    const saved = process.env.CLAUDECODE;
    process.env.CLAUDECODE = "1";
    try {
      expect(await replyAs({ name: "mcp", version: "0.1.0" })).toEqual({ text: "hi" });
    } finally {
      if (saved === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = saved;
    }
  });

  it("still lets JCHAIN_HARNESS override the host", async () => {
    expect(await replyAs({ name: "mcp", version: "0.1.0" }, { name: "Hermes", version: "0.11.2" }))
      .toEqual({ text: "hi", provenance: { harness: { name: "Hermes", version: "0.11.2" } } });
  });
});
