// Ticket 42 (CT-20 Policy): the effective policy and which bindings exist. Never a secret value.
import { escapeHtml } from "./html";
import type { Policy } from "./policy";

type Need = "required" | "postpublish" | "sign-in" | "optional";

type BindingRow = { name: string; what: string; need: Need; present: boolean; needed: boolean };

const BINDINGS: Array<{ name: string; what: string; need: Need; kind: "object" | "text" | "ai" }> = [
  { name: "DB", what: "D1 database", need: "required", kind: "object" },
  { name: "MEDIA", what: "R2 bucket for images", need: "required", kind: "object" },
  { name: "QUOTA", what: "Durable Objects for quotas and counters", need: "required", kind: "object" },
  { name: "PUBLISHING_STOP", what: "Durable Object for the Publishing Stop", need: "required", kind: "object" },
  { name: "ASSET_UPLOAD", what: "Queue for image checks and the Content Scan", need: "required", kind: "object" },
  { name: "ASSETS", what: "Static brand files", need: "required", kind: "object" },
  { name: "TURNSTILE_SECRET", what: "Secret for Observer reports", need: "required", kind: "text" },
  { name: "AI", what: "Workers AI for the Content Scan", need: "postpublish", kind: "ai" },
  { name: "EMAIL", what: "Email Sending for sign-in links", need: "sign-in", kind: "object" },
  { name: "CF_ANALYTICS_TOKEN", what: "Secret for the Cloudflare gauges", need: "optional", kind: "text" },
  { name: "CF_ACCOUNT_ID", what: "Account id for the Cloudflare gauges", need: "optional", kind: "text" },
  { name: "D1_DATABASE_ID", what: "Database id for the Cloudflare gauges", need: "optional", kind: "text" },
  { name: "MEDIA_ORIGIN", what: "Zone-cached image origin for the CSAM Scanning Tool", need: "optional", kind: "text" },
  { name: "MEDIA_ORIGIN_KEY", what: "Secret header value the image origin's WAF rule requires", need: "optional", kind: "text" },
  { name: "BUILD_SHA", what: "Deployed commit, shown on /version", need: "optional", kind: "text" },
];

export function bindingRows(env: Record<string, unknown>, policy: Policy): BindingRow[] {
  return BINDINGS.map((binding) => {
    const value = env[binding.name];
    const present = binding.kind === "text"
      ? typeof value === "string" && value !== ""
      : binding.kind === "ai"
        ? typeof value === "object" && value !== null && typeof (value as { run?: unknown }).run === "function"
        : typeof value === "object" && value !== null;
    const needed = binding.need === "required"
      || (binding.need === "postpublish" && policy.moderation_mode === "postpublish")
      || (binding.need === "sign-in" && policy.auth !== undefined);
    return { name: binding.name, what: binding.what, need: binding.need, present, needed };
  });
}

const NEED_TEXT: Record<Need, string> = {
  required: "Always",
  postpublish: "In postpublish mode",
  "sign-in": "With email sign-in",
  optional: "Optional",
};

export function policySection(env: Record<string, unknown>, policy: Policy): string {
  const rows = bindingRows(env, policy);
  const missing = rows.filter((row) => row.needed && !row.present);
  const alert = missing.length === 0
    ? `<p>Every binding the policy relies on is present.</p>`
    : `<p><span class="flag">Missing</span> ${missing.map((row) => `<code>${escapeHtml(row.name)}</code>`).join(", ")}. The policy relies on ${missing.length === 1 ? "it" : "them"}.</p>`;
  const table = rows.map((row) => {
    const state = row.present
      ? "Present"
      : row.needed ? `<span class="flag">Missing, needed</span>` : "Not set";
    return `<tr><td><code>${escapeHtml(row.name)}</code></td><td>${escapeHtml(row.what)}</td><td>${NEED_TEXT[row.need]}</td><td>${state}</td></tr>`;
  }).join("");
  const document = JSON.stringify(policy, null, 2);
  return [
    `<section aria-labelledby="admin-policy"><h2 id="admin-policy">Policy and bindings</h2>`,
    `<p>Moderation mode <code>${escapeHtml(policy.moderation_mode)}</code>. Sign-up ${policy.auth?.signup_open === false || policy.auth === undefined ? "closed" : "open"}. Values of secrets are never shown.</p>`,
    alert,
    `<div class="scroll" tabindex="0" role="region" aria-label="Bindings table"><table><thead><tr><th scope="col">Binding</th><th scope="col">For</th><th scope="col">Needed</th><th scope="col">State</th></tr></thead><tbody>${table}</tbody></table></div>`,
    `<details><summary>Effective policy document</summary><pre>${escapeHtml(document)}</pre></details>`,
    "</section>",
  ].join("");
}
