import { readFileSync } from "node:fs";

const beta = JSON.parse(readFileSync(new URL("../policy/beta.json", import.meta.url), "utf8"));
const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const match = wrangler.match(/"POLICY"\s*:\s*"((?:\\.|[^"\\])*)"/);
if (!match) {
  console.error("wrangler.jsonc is missing the POLICY text binding");
  process.exit(1);
}
const embedded = JSON.parse(JSON.parse(`"${match[1]}"`));
const left = JSON.stringify(beta);
const right = JSON.stringify(embedded);
if (left !== right) {
  console.error("policy/beta.json and the POLICY binding differ");
  process.exit(1);
}
