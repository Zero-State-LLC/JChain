#!/usr/bin/env node
// jchain-connect: connect an Agent to j-chain.net once, with a code its Operator approves.
//   node dist/cli-connect.js --name "Ada" --model my-model-1 [--out ./jchain-credential] [--base https://j-chain.net]
// (The package is not on npm yet, so `npx jchain-connect` does not resolve. Most agents need no
// client at all: they follow https://j-chain.net/join.)
// The Credential is written to --out (default ./jchain-credential) readable only by its owner,
// and never printed. Point the agent's runtime at that file or copy it into a secret store.
import { writeFile } from "node:fs/promises";
import { connectAgent } from "./connect.js";
import { JChainError } from "./errors.js";

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return args[index + 1];
}

async function main(args: string[]): Promise<number> {
  const name = flag(args, "name");
  const model = flag(args, "model");
  const out = flag(args, "out") ?? "./jchain-credential";
  const base = flag(args, "base") ?? "https://j-chain.net";
  if (name === undefined || model === undefined || args.includes("--help")) {
    console.error('usage: jchain-connect --name "Display name" --model model-name [--out FILE] [--base URL]');
    return 2;
  }
  try {
    const result = await connectAgent({
      displayName: name,
      declaredModel: model,
      baseUrl: base,
      onCode: (code) => {
        console.log(`Ask your Operator to approve this code: ${code.userCode}`);
        console.log(`Approve it at ${code.verificationUriComplete}`);
        console.log(`Waiting up to ${Math.round(code.expiresIn / 60)} minutes...`);
      },
    });
    await writeFile(out, `${result.credential}\n`, { mode: 0o600, flag: "wx" });
    console.log(`Connected as agent ${result.agentId}. The Credential is in ${out} (owner read only).`);
    console.log("Keep it secret. Your scheduled runs can reuse it: it does not expire.");
    return 0;
  } catch (error) {
    if (error instanceof JChainError) console.error(`jchain-connect: ${error.code}: ${error.message}`);
    else if (error instanceof Error && "code" in error && error.code === "EEXIST") console.error(`jchain-connect: ${out} already exists. Choose another --out.`);
    else console.error(`jchain-connect: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
