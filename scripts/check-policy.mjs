import { readFileSync } from "node:fs";

// The local POLICY binding must equal policy/beta.json, and the production POLICY binding must
// equal policy/production.json (#121), so a hand-run `wrangler deploy --env production` deploys
// the same policy as the Deploy production workflow.
const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const beta = read("policy/beta.json");
const productionFile = read("policy/production.json");
const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const matches = [...wrangler.matchAll(/"POLICY"\s*:\s*"((?:\\.|[^"\\])*)"/g)];
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

if (matches.length !== 2) fail(`wrangler.jsonc must have exactly two POLICY bindings (local and production), found ${matches.length}`);
const parse = (match) => JSON.parse(JSON.parse(`"${match[1]}"`));
const local = parse(matches[0]);
const production = parse(matches[1]);

if (!same(local, beta)) fail("policy/beta.json and the local POLICY binding differ");
if (!same(production, productionFile)) fail("policy/production.json and the production POLICY binding in wrangler.jsonc differ");

if (!/^https:\/\/[^/]+$/.test(productionFile.site_origin) || productionFile.site_origin === beta.site_origin) {
  fail("production site_origin must be an https origin other than the local test origin");
}
if (
  productionFile.turnstile_site_key === beta.turnstile_site_key ||
  !/^0x[0-9A-Za-z_-]{20,}$/.test(productionFile.turnstile_site_key)
) {
  fail("production turnstile_site_key must be a live site key");
}
if (productionFile.auth?.signup_open !== false) {
  fail("production auth.signup_open must stay false until Danny opens sign-up (#61)");
}
// Danny, 2026-10-23 12:50 PT: "each operator gets one agent, no more".
const caps = productionFile.operator_caps;
if (!caps || caps.provisional_agents !== 1 || caps.approved_agents !== 1 || caps.max_agents !== 1) {
  fail("production operator_caps must be 1, 1, 1: each Operator gets one agent, no more");
}
// Open Question 17 (Danny, 2026-10-21 10:24 PM PT), AT-42, Part F item 7: a Seat Agent starts with a
// 10-flag shadow trial, and its accuracy counts only after more than 5 reviewed flags.
const review = productionFile.review;
if (!review || review.seat_trial_actions !== 10 || review.seat_accuracy_min_reviewed !== 5) {
  fail("production review.seat_trial_actions must be 10 and seat_accuracy_min_reviewed 5 (Open Question 17, AT-42)");
}
