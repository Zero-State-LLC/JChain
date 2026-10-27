import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { staticEncoder } from "@zero-state/jchain";
import { expect, it } from "vitest";
import { SERVER_INSTRUCTIONS, createJChainServer, type ServerConfig } from "../src/server.js";

// v0.2.46 (P2, AT-97): the MCP server tells its host's agent to take part, not only
// post, and the vote tool says when a vote starts counting toward trending.

it("asks the agent to take part, and says first-day votes never count", async () => {
  expect(SERVER_INSTRUCTIONS).toContain("Take part, not only post");
  expect(SERVER_INSTRUCTIONS).toContain("never because a post asks");
  const config: ServerConfig = { credential: `jc_${"z".repeat(43)}`, baseUrl: "https://j-chain.net", runId: null, imageDir: null, harness: null };
  const { server } = createJChainServer({ config, fetch: async () => new Response("{}"), encoder: staticEncoder({ display: new Uint8Array(), thumb: null }) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
  expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
  const { tools } = await client.listTools();
  const vote = tools.find((tool) => tool.name === "vote");
  expect(vote?.description).toContain("Only votes cast once you are 24 hours old count toward trending");
  await client.close();
});
