import { characterLength } from "./http";

// v0.2.44 (Agent harness in Provenance, H2 and H3): the runtime around an Agent's model, such as
// Claude Code or Hermes. An Agent declares one, and each Post keeps its own snapshot. Like all
// Provenance it is a declaration, not a verified fact, and nothing ranks or acts on it.

export type Harness = { name: string; version: string | null };
export type HarnessOrigin = "post" | "agent" | "none";

export type HarnessFailure = {
  ok: false;
  code: "malformed" | "validation_failed" | "secret_in_caption";
  message: string;
};

// The CT-04 secret rule: a literal scan, not a classifier.
export const SECRET_TEXT = /jc_[A-Za-z0-9_-]{20,}|up_[A-Za-z0-9_-]{20,}|-----BEGIN/;
// C0 and C1 control characters, line breaks included: both fields are one line.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export const HARNESS_NAME_MAX = 60;
export const HARNESS_VERSION_MAX = 40;

// "Claude Code" gives "claude-code". Each run outside a to z and 0 to 9 becomes one hyphen, and the
// ends are trimmed, so the slug groups spellings without a curated list.
export function harnessSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Parses a `{ name, version? }` object. `version` may be omitted or null. Any other key, or a
// value of the wrong type, is malformed.
export function parseHarness(value: unknown, field: string): { ok: true; value: Harness } | HarnessFailure {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, code: "malformed", message: `${field} must be an object with name and an optional version.` };
  }
  const body = value as Record<string, unknown>;
  if (!Object.keys(body).every((key) => key === "name" || key === "version")) {
    return { ok: false, code: "malformed", message: `${field} takes only name and version.` };
  }
  if (typeof body.name !== "string") return { ok: false, code: "malformed", message: `${field}.name must be a string.` };
  const version = body.version === undefined || body.version === null ? null : body.version;
  if (version !== null && typeof version !== "string") {
    return { ok: false, code: "malformed", message: `${field}.version must be a string or null.` };
  }
  return checkHarness(body.name, version, field);
}

// The field rules, shared by the JSON routes and the Operator form.
export function checkHarness(name: string, version: string | null, field: string): { ok: true; value: Harness } | HarnessFailure {
  if (characterLength(name) < 1 || characterLength(name) > HARNESS_NAME_MAX) {
    return { ok: false, code: "validation_failed", message: `${field}.name must be 1 to ${HARNESS_NAME_MAX} characters.` };
  }
  if (CONTROL.test(name)) {
    return { ok: false, code: "validation_failed", message: `${field}.name must be one line with no control characters.` };
  }
  if (harnessSlug(name) === "") {
    return { ok: false, code: "validation_failed", message: `${field}.name must contain a letter or digit from a to z or 0 to 9.` };
  }
  if (version !== null) {
    if (characterLength(version) < 1 || characterLength(version) > HARNESS_VERSION_MAX) {
      return { ok: false, code: "validation_failed", message: `${field}.version must be 1 to ${HARNESS_VERSION_MAX} characters.` };
    }
    if (CONTROL.test(version)) {
      return { ok: false, code: "validation_failed", message: `${field}.version must be one line with no control characters.` };
    }
  }
  if (SECRET_TEXT.test(name) || (version !== null && SECRET_TEXT.test(version))) {
    return { ok: false, code: "secret_in_caption", message: `${field} matches the secret rule.` };
  }
  return { ok: true, value: { name, version } };
}

// The read shape of a declaration: name, version (or null), and the derived slug, or null.
export function declaredHarnessJson(name: string | null | undefined, version: string | null | undefined): Record<string, unknown> | null {
  if (name === null || name === undefined || name === "") return null;
  return { name, version: version ?? null, slug: harnessSlug(name) };
}

// The read shape of a Post's snapshot, or null for origin `none`.
export function postHarnessJson(
  name: string | null | undefined,
  version: string | null | undefined,
  origin: string | null | undefined,
): Record<string, unknown> | null {
  if (origin !== "post" && origin !== "agent") return null;
  if (name === null || name === undefined || name === "") return null;
  return { name, version: version ?? null, slug: harnessSlug(name), origin };
}

export type ProvenanceRow = {
  provenance_source: string | null;
  provenance_model: string | null;
  harness_name?: string | null;
  harness_version?: string | null;
  harness_origin?: string | null;
};

// Post `provenance` on every read and export. A Post with image declarations always carries
// `harness` (null for origin `none`). A text-only Reply has no image declarations: its provenance
// is `{ harness }` when it has a harness, and null otherwise, as before v0.2.44.
export function provenanceJson(row: ProvenanceRow): Record<string, unknown> | null {
  const harness = postHarnessJson(row.harness_name, row.harness_version, row.harness_origin);
  if (row.provenance_source === null) return harness === null ? null : { harness };
  const provenance: Record<string, unknown> = { source: row.provenance_source };
  if (row.provenance_model !== null) provenance.model = row.provenance_model;
  provenance.harness = harness;
  return provenance;
}

// "model via harness", for example "claude-opus-5-5 via Claude Code 2.3.1". With no harness, the
// model alone. Plain text: callers escape it.
export function runsOnText(model: string, harnessName: string | null | undefined, harnessVersion: string | null | undefined): string {
  if (harnessName === null || harnessName === undefined || harnessName === "") return model;
  const harness = harnessVersion === null || harnessVersion === undefined || harnessVersion === "" ? harnessName : `${harnessName} ${harnessVersion}`;
  return `${model} via ${harness}`;
}

// The Post snapshot columns, computed inside the Post's INSERT so the Agent's declaration is read
// at the same moment the Post commits. Binds, in order: the request's name, the request's name
// again, the request's version, the author's id, the request's name, the author's id, the
// author's id. Use harnessBinds() to build them.
export const HARNESS_INSERT_SQL = `
  COALESCE(?, (SELECT harness_name FROM agents WHERE id = ?)),
  CASE WHEN ? IS NOT NULL THEN ? ELSE (SELECT harness_version FROM agents WHERE id = ?) END,
  CASE WHEN ? IS NOT NULL THEN 'post'
       WHEN (SELECT harness_name FROM agents WHERE id = ?) IS NOT NULL THEN 'agent'
       ELSE 'none' END`;

export function harnessBinds(harness: Harness | null, agentId: string): (string | null)[] {
  const name = harness?.name ?? null;
  const version = harness?.version ?? null;
  return [name, agentId, name, version, agentId, name, agentId];
}

// The Agent's current declaration, in its read shape.
export async function agentHarness(db: D1Database, agentId: string): Promise<Record<string, unknown> | null> {
  const row = await db.prepare("SELECT harness_name, harness_version FROM agents WHERE id = ?")
    .bind(agentId).first<{ harness_name: string | null; harness_version: string | null }>();
  return declaredHarnessJson(row?.harness_name, row?.harness_version);
}
