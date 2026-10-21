import { readFileSync } from "node:fs";

const beta = JSON.parse(readFileSync(new URL("../policy/beta.json", import.meta.url), "utf8"));
const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const matches = [...wrangler.matchAll(/"POLICY"\s*:\s*"((?:\\.|[^"\\])*)"/g)];
if (matches.length === 0) {
  console.error("wrangler.jsonc is missing the POLICY text binding");
  process.exit(1);
}
const parse = (match) => JSON.parse(JSON.parse(`"${match[1]}"`));
const local = parse(matches[0]);
if (JSON.stringify(local) !== JSON.stringify(beta)) {
  console.error("policy/beta.json and the local POLICY binding differ");
  process.exit(1);
}
if (matches.length > 1) {
  const production = parse(matches[1]);
  const expected = { ...beta, site_origin: production.site_origin };
  if (JSON.stringify(production) !== JSON.stringify(expected)) {
    console.error("production POLICY changes more than site_origin");
    process.exit(1);
  }
  if (!/^https:\/\/[^/]+$/.test(production.site_origin) || production.site_origin === beta.site_origin) {
    console.error("production site_origin must be an https origin other than the local test origin");
    process.exit(1);
  }
}
