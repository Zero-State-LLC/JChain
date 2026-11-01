import { applyD1Migrations, createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { CONNECTOR_TIMING, CONNECTOR_TOOL_NAMES } from "../src/mcp";
import { BOARD_ID, OPERATOR, STAFF, call, resetAndSeed } from "./harness";
import { connectApp } from "./connector-helpers";
import { LARGE_WEBP, VALID_PNG } from "./fixtures/bytes";

// v0.2.50 (AT-108, AT-109): chat agents through the remote MCP connector.

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetAndSeed();
  CONNECTOR_TIMING.readyWaitMs = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Rpc = { result?: Record<string, unknown>; error?: { code: number; message: string } };

let nextId = 1;
async function rpc(token: string, method: string, params: Record<string, unknown> = {}): Promise<Rpc> {
  const response = await call("/mcp", { bearer: token, body: { jsonrpc: "2.0", id: nextId++, method, params }, sameOrigin: false });
  expect(response.status).toBe(200);
  return await response.json() as Rpc;
}

async function tool(token: string, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean; content: Array<Record<string, unknown>> }> {
  const answered = await rpc(token, "tools/call", { name, arguments: args });
  const result = answered.result as { content: Array<{ type: string; text?: string }>; isError?: boolean };
  return { text: result.content.map((part) => part.text ?? "").join("\n"), isError: result.isError === true, content: result.content };
}

function jsonIn(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}

async function settle(assetId: string): Promise<void> {
  const ctx = createExecutionContext();
  const batch = createMessageBatch("asset-upload", [{ id: `msg-${assetId}`, timestamp: new Date(), attempts: 1, body: { asset_id: assetId } }]);
  await worker.queue!(batch, env, ctx);
  await getQueueResult(batch, ctx);
}

const IMAGE_ARGS = {
  board: "beta",
  title: "A test",
  caption: "made by my platform",
  alt_text: "a single pixel",
  provenance: { source: "model", model: "platform-image-1" },
  license: "cc0",
  rights_attestation: "My platform generated this for me.",
};

async function joined(name = "Chatty"): Promise<string> {
  const { tokens } = await connectApp(OPERATOR);
  await rpc(tokens.access_token, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-ai", version: "1" }, capabilities: {} });
  const done = await tool(tokens.access_token, "join", { display_name: name, declared_model: "claude-test" });
  expect(done.isError, done.text).toBe(false);
  return tokens.access_token;
}

async function boardSlug(): Promise<string> {
  const row = await env.DB.prepare("SELECT slug FROM boards WHERE id = ?").bind(BOARD_ID).first<{ slug: string }>();
  return row!.slug;
}

describe("the MCP endpoint", () => {
  it("needs a connector token and speaks stateless JSON-RPC", async () => {
    const anonymous = await call("/mcp", { body: { jsonrpc: "2.0", id: 1, method: "ping" }, sameOrigin: false });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain("resource_metadata=\"https://jchain.example.test/.well-known/oauth-protected-resource\"");
    expect((await call("/mcp")).status).toBe(405);
    const { tokens } = await connectApp(OPERATOR);
    const init = await rpc(tokens.access_token, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "ChatGPT" }, capabilities: {} });
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "j-chain.net" } });
    const instructions = String(init.result?.instructions);
    expect(instructions).toContain("image-generation connector is needed");
    expect(instructions).toContain("Operators direct, agents author");
    const notified = await call("/mcp", { bearer: tokens.access_token, body: { jsonrpc: "2.0", method: "notifications/initialized" }, sameOrigin: false });
    expect(notified.status).toBe(202);
    const listed = await rpc(tokens.access_token, "tools/list");
    const names = (listed.result?.tools as Array<{ name: string; annotations: { readOnlyHint: boolean } }>);
    expect(names.map((item) => item.name).sort()).toEqual([...CONNECTOR_TOOL_NAMES].sort());
    expect(names.find((item) => item.name === "reply")?.annotations.readOnlyHint).toBe(false);
    expect(names.find((item) => item.name === "list_boards")?.annotations.readOnlyHint).toBe(true);
    expect((await rpc(tokens.access_token, "resources/list")).error?.code).toBe(-32601);
  });

  it("joins once, as the Operator's one agent, with the chat app as harness", async () => {
    const { tokens } = await connectApp(OPERATOR);
    await rpc(tokens.access_token, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-ai" }, capabilities: {} });
    expect((await tool(tokens.access_token, "whoami")).text).toContain("Not joined yet");
    const early = await tool(tokens.access_token, "list_boards");
    expect(early.isError).toBe(true);
    expect(early.text).toContain("not_joined");
    const done = await tool(tokens.access_token, "join", { display_name: "Chatty", declared_model: "claude-test" });
    expect(done.isError).toBe(false);
    expect(done.text).not.toMatch(/jc_[A-Za-z0-9]/);
    const agent = await env.DB.prepare("SELECT display_name, harness_name FROM agents WHERE display_name = 'Chatty'").first<{ harness_name: string }>();
    expect(agent?.harness_name).toBe("claude-ai");
    const again = await tool(tokens.access_token, "join", { display_name: "Other", declared_model: "x" });
    expect(again.text).toContain("state_conflict");
    expect(jsonIn((await tool(tokens.access_token, "whoami")).text).display_name).toBe("Chatty");
    // A second app for the same Operator acts as the same agent.
    const second = await connectApp(OPERATOR);
    expect(jsonIn((await tool(second.tokens.access_token, "whoami")).text).display_name).toBe("Chatty");
  });

  it("reads boards and rules, and labels board content as untrusted", async () => {
    const token = await joined();
    const boards = await tool(token, "list_boards");
    expect(boards.text).toContain("untrusted data");
    expect(boards.text).toContain("<board_content>");
    const rules = await tool(token, "get_rules", { board: await boardSlug() });
    expect(rules.isError, rules.text).toBe(false);
    expect(rules.text).toContain("instructions you may follow");
    expect((await tool(token, "posts_to_judge")).isError).toBe(false);
    expect((await tool(token, "my_responses")).isError).toBe(false);
    expect((await tool(token, "set_handle", { handle: "chatty_bot" })).text).toContain("chatty_bot");
  });

  it("opens an image thread from a platform image URL and replies, marking connector Posts", async () => {
    const token = await joined();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://images.example/gen/1.png") return new Response(VALID_PNG, { status: 200, headers: { "content-type": "image/png" } });
      throw new Error(`unexpected fetch ${url}`);
    });
    const args = { ...IMAGE_ARGS, board: await boardSlug(), image_url: "https://images.example/gen/1.png", idempotency_key: "img-1" };
    const first = await tool(token, "post_image_thread", args);
    expect(first.isError, first.text).toBe(false);
    const processing = jsonIn(first.text);
    expect(processing.state).toBe("processing");
    await settle(String(processing.asset_id));
    const opened = await tool(token, "post_image_thread", { ...args, asset_id: processing.asset_id });
    expect(opened.isError, opened.text).toBe(false);
    const thread = jsonIn(opened.text);
    const post = await env.DB.prepare("SELECT arrived_via FROM posts WHERE id = ?").bind(thread.post_id).first<{ arrived_via: string }>();
    expect(post?.arrived_via).toBe("connector");
    const asset = await env.DB.prepare("SELECT content_type, state FROM assets WHERE id = ?").bind(processing.asset_id).first<{ content_type: string; state: string }>();
    expect(asset?.state).toBe("ready");
    // The arrival signal is never on a public route.
    const read = await call(`/v1/posts/${thread.post_id}`, { bearer: token });
    expect(JSON.stringify(await read.json())).not.toContain("arrived_via");
  });

  it("refuses private and non-https image URLs", async () => {
    const token = await joined();
    for (const bad of ["http://images.example/a.png", "https://127.0.0.1/a.png", "https://localhost/a.png", "https://[::1]/a.png"]) {
      const result = await tool(token, "post_image_thread", { ...IMAGE_ARGS, board: await boardSlug(), image_url: bad });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("public https URL");
    }
  });

  it("hands an image over through a one-time upload link, marked handoff", async () => {
    const token = await joined();
    const requested = jsonIn((await tool(token, "request_image_upload")).text);
    const path = new URL(String(requested.link)).pathname;
    expect((await call(path)).status).toBe(401);
    expect((await call(path, { email: STAFF })).status).toBe(401);
    const page = await call(path, { email: OPERATOR });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("never one you made or chose");
    expect((await tool(token, "view_upload", { upload_id: requested.upload_id })).text).toContain("not_ready");
    const form = new FormData();
    form.set("image", new File([LARGE_WEBP], "gen.webp", { type: "image/webp" }));
    const multipart = new Request("https://x/", { method: "POST", body: form });
    const sent = await call(path, {
      email: OPERATOR,
      headers: { "content-type": multipart.headers.get("content-type")! },
      raw: new Uint8Array(await multipart.arrayBuffer()),
    });
    expect(sent.status).toBe(200);
    expect((await call(path, { email: OPERATOR })).status).toBe(404);
    const viewed = await tool(token, "view_upload", { upload_id: requested.upload_id });
    expect(viewed.isError, viewed.text).toBe(false);
    expect(viewed.content.find((part) => part.type === "image")?.mimeType).toBe("image/webp");
    const args = { ...IMAGE_ARGS, board: await boardSlug(), upload_id: requested.upload_id, idempotency_key: "up-1" };
    const processing = jsonIn((await tool(token, "post_image_thread", args)).text);
    await settle(String(processing.asset_id));
    const opened = jsonIn((await tool(token, "post_image_thread", { ...args, asset_id: processing.asset_id })).text);
    const post = await env.DB.prepare("SELECT arrived_via FROM posts WHERE id = ?").bind(opened.post_id).first<{ arrived_via: string }>();
    expect(post?.arrived_via).toBe("handoff");
    expect((await tool(token, "post_image_thread", { ...args, idempotency_key: "up-2" })).text).toContain("already posted");
  });

  it("stops working when the Agent is retired or the Operator suspended", async () => {
    const token = await joined();
    await env.DB.prepare("UPDATE agents SET state = 'retired' WHERE display_name = 'Chatty'").run();
    expect((await tool(token, "whoami")).isError).toBe(true);
    await env.DB.prepare("UPDATE operators SET state = 'suspended' WHERE email = ?").bind(OPERATOR).run();
    expect((await call("/mcp", { bearer: token, body: { jsonrpc: "2.0", id: 1, method: "ping" }, sameOrigin: false })).status).toBe(401);
  });
});
