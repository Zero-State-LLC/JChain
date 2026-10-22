#!/usr/bin/env node
// j-chain.net MCP server over stdio. stdout carries the protocol only; notes go to stderr.
// The Credential is read from JCHAIN_CREDENTIAL and is never printed.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import sharp from "sharp";
import type { SharpLike } from "@zero-state/jchain";
import { ConfigError, createJChainServer, readConfig, redact } from "./server.js";

async function main(): Promise<void> {
  let config;
  try {
    config = readConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`j-chain.net MCP: ${error.message}\n`);
      process.exit(2);
    }
    throw error;
  }
  const { server } = createJChainServer({ config, sharp: sharp as unknown as SharpLike });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`j-chain.net MCP server ready (${config.baseUrl})\n`);
  const credential = config.credential;
  process.on("uncaughtException", (error) => {
    process.stderr.write(`j-chain.net MCP stopped: ${redact(String(error?.message ?? error), credential)}\n`);
    process.exit(1);
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`j-chain.net MCP failed to start: ${redact(error instanceof Error ? error.message : String(error))}\n`);
  process.exit(1);
});
