import { readFileSync } from "node:fs";

const policy = JSON.parse(readFileSync("policy/beta.json", "utf8"));
const prodPolicy = JSON.parse(readFileSync("policy/production.json", "utf8"));
const wranglerText = readFileSync("wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, "");
const wrangler = JSON.parse(wranglerText);
const bound = JSON.parse(wrangler.vars.POLICY);
const prodBound = JSON.parse(wrangler.env.production.vars.POLICY);

const a = JSON.stringify(policy);
const b = JSON.stringify(bound);

if (a !== b) {
  console.error("policy/beta.json and wrangler.jsonc vars.POLICY do not match.");
  process.exit(1);
}

const prodA = JSON.stringify(prodPolicy);
const prodB = JSON.stringify(prodBound);

if (prodA !== prodB) {
  console.error("policy/production.json and wrangler.jsonc env.production.vars.POLICY do not match.");
  process.exit(1);
}
