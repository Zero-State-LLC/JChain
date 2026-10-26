import type { Harness } from "./types.js";

// Proposed v0.2.45 (H10, awaiting Danny): detect the harness from the environment when no `harness`
// option is given. Precedence: the option, then the environment, then nothing (the service keeps
// the Agent's declaration). Only the variables in HARNESS_ENV_VARS are read; nothing else in the
// environment is read or sent.

/** The only environment variables {@link detectHarness} reads. */
export const HARNESS_ENV_VARS = ["AI_AGENT", "AGENT", "CLAUDECODE", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_VERSION"] as const;

export type HarnessEnv = Record<string, string | undefined>;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const SECRET = /jc_[A-Za-z0-9_-]{20,}|up_[A-Za-z0-9_-]{20,}|-----BEGIN/;
/** Values of AI_AGENT or AGENT that mean "do not report a harness". */
const OPT_OUT = new Set(["", "0", "false", "no", "off", "none"]);
/** Versions that say nothing: dropped, so the name is sent alone. */
const PLACEHOLDER_VERSIONS = new Set(["0.0.0", "0.0.0-dev", "unknown", "dev", "-"]);
/** AI_AGENT names with a display name, verified at the source. */
const KNOWN_AGENT_NAMES: Record<string, string> = {
  // Claude Code sets AI_AGENT=claude-code_<version with hyphens>_<role> (seen live: claude-code_2-1-308_agent).
  "claude-code": "Claude Code",
};

function fits(text: string, max: number): boolean {
  const length = [...text].length;
  return length >= 1 && length <= max && !CONTROL.test(text) && !SECRET.test(text);
}

// The service's field rules, applied quietly: an unusable value is ignored, never thrown.
function usable(name: string, version: string | null): Harness | null {
  const trimmed = name.trim();
  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!fits(trimmed, 60) || slug === "") return null;
  const v = version === null ? "" : version.trim();
  if (v === "" || PLACEHOLDER_VERSIONS.has(v.toLowerCase()) || !fits(v, 40)) return { name: trimmed };
  return { name: trimmed, version: v };
}

/**
 * Reads one AI_AGENT or AGENT value: a lowercase-hyphen name, optionally `@version`, or Claude
 * Code's `claude-code_2-1-308_agent`. Returns "opt-out" for a falsy value and null when unusable.
 */
export function parseAgentVariable(raw: string): Harness | null | "opt-out" {
  const value = raw.trim();
  if (OPT_OUT.has(value.toLowerCase())) return "opt-out";
  const claude = /^claude-code_(\d+(?:-\d+)*)_[A-Za-z0-9-]+$/.exec(value);
  if (claude !== null) return usable("Claude Code", String(claude[1]).replaceAll("-", "."));
  const slashed = /^claude-code\/(.+)$/.exec(value);
  if (slashed !== null) return usable("Claude Code", String(slashed[1]));
  const at = value.lastIndexOf("@");
  const name = at > 0 ? value.slice(0, at) : value;
  return usable(KNOWN_AGENT_NAMES[name] ?? name, at > 0 ? value.slice(at + 1) : null);
}

/**
 * The harness the environment names, or null. In order: `AI_AGENT`, then `AGENT` (the cross-tool
 * convention @vercel/detect-agent promotes; a falsy value opts out of detection altogether), then
 * `CLAUDECODE=1` (Claude Code), then `CODEX_THREAD_ID` or `CODEX_SESSION_ID` (set by the Codex
 * CLI on the commands it runs; `CODEX_VERSION` is the version).
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
  if ((env.CODEX_THREAD_ID?.trim() ?? "") !== "" || (env.CODEX_SESSION_ID?.trim() ?? "") !== "") {
    return usable("Codex", env.CODEX_VERSION ?? null);
  }
  return null;
}

// Copies only the named variables, so nothing else in the environment is touched again.
function processEnv(): HarnessEnv {
  const holder = globalThis as { process?: { env?: Record<string, string | undefined> } };
  const env = holder.process?.env;
  const picked: HarnessEnv = {};
  if (env === undefined) return picked;
  for (const key of HARNESS_ENV_VARS) if (env[key] !== undefined) picked[key] = env[key];
  return picked;
}
