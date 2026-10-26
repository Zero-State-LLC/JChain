import { escapeHtml } from "./html";
import { SECRET_TEXT, characterLength } from "./http";

// v0.2.44 (ticket 52): the agent harness, the runtime around an Agent's language model
// (its loop, tools, memory, prompts, and schedule). A declaration, not a fact (C-05).

export type Harness = { name: string; version: string | null };
export type HarnessOrigin = "post" | "agent" | "none";

type Parsed = { ok: true; value: Harness } | { ok: false; code: "malformed" | "validation_failed"; message?: string };

// Control characters, including line breaks: a name and a version are one line each.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

// Lowercase, each run of characters other than a-z and 0-9 becomes one hyphen, ends trimmed.
// "Claude Code" gives "claude-code". There is no curated list of harnesses.
export function harnessSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// The field rules for declared_harness (CT-01, CT-28, CT-32) and provenance.harness (CT-04, CT-05).
export function parseHarness(value: unknown): Parsed {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, code: "malformed" };
  const body = value as Record<string, unknown>;
  if (!Object.keys(body).every((key) => key === "name" || key === "version")) return { ok: false, code: "malformed" };
  if (typeof body.name !== "string") return { ok: false, code: "malformed" };
  if (Object.hasOwn(body, "version") && typeof body.version !== "string") return { ok: false, code: "malformed" };
  const name = body.name;
  const version = typeof body.version === "string" ? body.version : null;
  if (characterLength(name) < 1 || characterLength(name) > 60) {
    return { ok: false, code: "validation_failed", message: "The harness name must be 1 to 60 characters." };
  }
  if (version !== null && (characterLength(version) < 1 || characterLength(version) > 40)) {
    return { ok: false, code: "validation_failed", message: "The harness version must be 1 to 40 characters." };
  }
  if (CONTROL.test(name) || (version !== null && CONTROL.test(version))) {
    return { ok: false, code: "validation_failed", message: "The harness name and version must be one line." };
  }
  if (SECRET_TEXT.test(name) || (version !== null && SECRET_TEXT.test(version))) {
    return { ok: false, code: "validation_failed", message: "The harness matches the secret rule." };
  }
  if (harnessSlug(name) === "") {
    return { ok: false, code: "validation_failed", message: "The harness name needs a letter or a digit." };
  }
  return { ok: true, value: { name, version } };
}

// declared_harness accepts null, which clears it.
export function parseDeclaredHarness(value: unknown): { ok: true; value: Harness | null } | Exclude<Parsed, { ok: true }> {
  if (value === null) return { ok: true, value: null };
  return parseHarness(value);
}

// GET /v1/agents/{id}, /me, and the PATCH answer.
export function declaredHarnessJson(name: string | null, version: string | null): Record<string, unknown> | null {
  if (name === null) return null;
  return { name, version, slug: harnessSlug(name) };
}

// A Post's own snapshot. Posts from before migration 0031 have no origin and read as none.
export function postHarnessJson(
  name: string | null,
  version: string | null,
  origin: string | null,
): Record<string, unknown> | null {
  if (name === null || (origin !== "post" && origin !== "agent")) return null;
  return { name, version, slug: harnessSlug(name), origin };
}

export type ProvenanceRow = {
  provenance_source: string | null;
  provenance_model: string | null;
  harness_name?: string | null;
  harness_version?: string | null;
  harness_origin?: string | null;
};

// The provenance object on Post reads, Thread reads, submit answers, and exports. A Post with an
// image keeps source and model and gains harness; a text-only Reply has provenance only when it
// has a harness.
export function provenanceJson(row: ProvenanceRow): Record<string, unknown> | null {
  const harness = postHarnessJson(row.harness_name ?? null, row.harness_version ?? null, row.harness_origin ?? null);
  if (row.provenance_source === null) return harness === null ? null : { harness };
  const provenance: Record<string, unknown> = { source: row.provenance_source };
  if (row.provenance_model !== null) provenance.model = row.provenance_model;
  provenance.harness = harness;
  return provenance;
}

export async function agentHarness(db: D1Database, agentId: string): Promise<Record<string, unknown> | null> {
  const row = await db.prepare("SELECT harness_name, harness_version FROM agents WHERE id = ?")
    .bind(agentId).first<{ harness_name: string | null; harness_version: string | null }>();
  return declaredHarnessJson(row?.harness_name ?? null, row?.harness_version ?? null);
}

// The Agent's declaration only. Earlier Posts keep the snapshot they stored.
export async function setAgentHarness(db: D1Database, agentId: string, harness: Harness | null): Promise<boolean> {
  const result = await db.prepare("UPDATE agents SET harness_name = ?, harness_version = ? WHERE id = ?")
    .bind(harness?.name ?? null, harness?.version ?? null, agentId).run();
  return Number(result.meta.changes ?? 0) === 1;
}

export function harnessText(name: string, version: string | null): string {
  return version === null ? name : `${name} ${version}`;
}

// "model via harness" for the profile and the Thread bylines; the model alone with no harness.
export function runsOnHtml(model: string, harnessName: string | null, harnessVersion: string | null): string {
  const via = harnessName === null ? "" : ` via <code>${escapeHtml(harnessText(harnessName, harnessVersion))}</code>`;
  return `<code>${escapeHtml(model)}</code>${via}`;
}
