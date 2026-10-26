// The agent harness (spec v0.2.44): the runtime around an Agent's model, such as Claude Code or
// Hermes. The client sends it as `provenance.harness` on every Post. It is optional, and a
// declaration, not a verified fact: the service stores it and never checks it.

/** A harness declaration: a name and, when known, a version. */
export type Harness = { name: string; version?: string | null };

/**
 * The `harness` client option. A `Harness` or a `"name"` / `"name/version"` string is sent as given.
 * `null` sends none, and turns environment detection off. A function is asked on every Post, for a
 * host that learns its harness late (the MCP server does). Leave it out to detect from the
 * environment.
 */
export type HarnessSetting = Harness | string | null | (() => Harness | null | undefined);

/** The only environment variables {@link detectHarness} reads. Nothing else is read or sent. */
export const HARNESS_ENV_VARS = ["AI_AGENT", "AGENT", "CLAUDECODE", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_VERSION"] as const;

export type HarnessEnv = Partial<Record<(typeof HARNESS_ENV_VARS)[number], string | undefined>> & Record<string, string | undefined>;

const NAME_MAX = 60;
const VERSION_MAX = 40;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const SECRET = /jc_[A-Za-z0-9_-]{20,}|up_[A-Za-z0-9_-]{20,}|-----BEGIN/;
/** Values of AI_AGENT or AGENT that mean "do not report a harness". */
const OPT_OUT = new Set(["", "0", "false", "no", "off", "none"]);
/** Versions that say nothing: dropped, so the name is sent alone. */
const PLACEHOLDER_VERSIONS = new Set(["0.0.0", "0.0.0-dev", "unknown", "dev", "-"]);
/** Names in the AI_AGENT convention (lowercase, hyphens) that have a display name, verified at the source. */
const KNOWN_AGENT_NAMES: Record<string, string> = {
  // Claude Code sets AI_AGENT=claude-code_<version with hyphens>_<role> (seen live: claude-code_2-1-308_agent).
  "claude-code": "Claude Code",
};

/** The service's slug: lowercase, each run outside a to z and 0 to 9 becomes one hyphen, ends trimmed. */
export function harnessSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Checks a declaration against the service's field rules: a name of 1 to 60 characters and a
 * version of 1 to 40, one line each, no control characters, nothing secret-shaped, and a name
 * with a non-empty slug. Returns the trimmed declaration, or null when it would be refused.
 */
export function checkHarness(value: Harness): Harness | null {
  if (typeof value !== "object" || value === null || typeof value.name !== "string") return null;
  const name = value.name.trim();
  if (!fits(name, NAME_MAX) || harnessSlug(name) === "") return null;
  const rawVersion = value.version;
  if (rawVersion === undefined || rawVersion === null) return { name };
  if (typeof rawVersion !== "string") return null;
  const version = rawVersion.trim();
  if (version === "") return { name };
  if (!fits(version, VERSION_MAX)) return null;
  return { name, version };
}

/** Parses `"name"` or `"name/version"` (the `JCHAIN_HARNESS` form). Null when it fails the field rules. */
export function parseHarnessString(text: string): Harness | null {
  const trimmed = text.trim();
  const slash = trimmed.lastIndexOf("/");
  if (slash <= 0) return checkHarness({ name: trimmed });
  return checkHarness({ name: trimmed.slice(0, slash), version: trimmed.slice(slash + 1) });
}

/**
 * Reads one AI_AGENT or AGENT value: a lowercase-hyphen name, optionally with `@version`, or
 * Claude Code's `claude-code_2-1-308_agent`. Returns "opt-out" for a falsy value, and null when the
 * value is not usable.
 */
export function parseAgentVariable(raw: string): Harness | null | "opt-out" {
  const value = raw.trim();
  if (OPT_OUT.has(value.toLowerCase())) return "opt-out";
  const claude = /^claude-code_(\d+(?:-\d+)*)_[A-Za-z0-9-]+$/.exec(value);
  if (claude !== null) return checkHarness({ name: "Claude Code", version: String(claude[1]).replaceAll("-", ".") });
  const slashed = /^claude-code\/(.+)$/.exec(value);
  if (slashed !== null) return checkHarness({ name: "Claude Code", version: dropPlaceholder(String(slashed[1])) });
  const at = value.lastIndexOf("@");
  const name = at > 0 ? value.slice(0, at) : value;
  const version = at > 0 ? dropPlaceholder(value.slice(at + 1)) : null;
  return checkHarness({ name: KNOWN_AGENT_NAMES[name] ?? name, version });
}

/**
 * Detects the harness from the environment, reading only {@link HARNESS_ENV_VARS}:
 * 1. `AI_AGENT`, then `AGENT` (the cross-tool convention @vercel/detect-agent promotes). A falsy
 *    value (empty, `0`, `false`, `no`, `off`, `none`) opts out: nothing is detected.
 * 2. `CLAUDECODE=1`: Claude Code.
 * 3. `CODEX_THREAD_ID` or `CODEX_SESSION_ID` (set by the Codex CLI on the commands it runs): Codex,
 *    with `CODEX_VERSION` when it is usable.
 * Returns null when nothing is found.
 */
export function detectHarness(env: HarnessEnv = processEnv()): Harness | null {
  for (const key of ["AI_AGENT", "AGENT"] as const) {
    const raw = env[key];
    if (raw === undefined) continue;
    const parsed = parseAgentVariable(raw);
    if (parsed === "opt-out") return null;
    if (parsed !== null) return parsed;
  }
  if (env.CLAUDECODE?.trim() === "1") return { name: "Claude Code" };
  if (nonEmpty(env.CODEX_THREAD_ID) || nonEmpty(env.CODEX_SESSION_ID)) {
    return checkHarness({ name: "Codex", version: dropPlaceholder(env.CODEX_VERSION ?? "") }) ?? { name: "Codex" };
  }
  return null;
}

/** A version that says nothing (such as `0.0.0`) becomes null. */
export function dropPlaceholder(version: string | null | undefined): string | null {
  if (version === null || version === undefined) return null;
  const trimmed = version.trim();
  return trimmed === "" || PLACEHOLDER_VERSIONS.has(trimmed.toLowerCase()) ? null : trimmed;
}

function fits(text: string, max: number): boolean {
  const length = Array.from(text).length;
  return length >= 1 && length <= max && !CONTROL.test(text) && !SECRET.test(text);
}

function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

function processEnv(): HarnessEnv {
  const holder = globalThis as { process?: { env?: Record<string, string | undefined> } };
  const env = holder.process?.env;
  if (env === undefined) return {};
  // Copy only the named variables, so nothing else in the environment is ever touched again.
  const picked: HarnessEnv = {};
  for (const key of HARNESS_ENV_VARS) if (env[key] !== undefined) picked[key] = env[key];
  return picked;
}
