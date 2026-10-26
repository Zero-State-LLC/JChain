import { DEFAULT_BASE_URL, type Harness } from "@zero-state/jchain";

export type ServerConfig = {
  credential: string;
  baseUrl: string;
  runId: string | null;
  /** When set, image paths must resolve inside this directory. */
  imageDir: string | null;
  /**
   * From `JCHAIN_HARNESS` (spec v0.2.44): overrides the MCP host's clientInfo as the harness on
   * every Post, for a harness that runs this server inside another host. Null uses the host.
   */
  harness: Harness | null;
};

// One line, no control characters: the service's field rules for a harness.
const HARNESS_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Whether a name and an optional version meet the service's harness field rules. */
export function usableHarnessPart(value: string, max: number): boolean {
  const length = [...value].length;
  return length >= 1 && length <= max && !HARNESS_CONTROL.test(value);
}

// "name" or "name/version". The last slash separates them, so a name may contain one.
function parseHarnessSetting(raw: string): Harness | null {
  const value = raw.trim();
  if (value === "") return null;
  const slash = value.lastIndexOf("/");
  const name = (slash === -1 ? value : value.slice(0, slash)).trim();
  const version = slash === -1 ? null : value.slice(slash + 1).trim();
  if (!usableHarnessPart(name, 60)) throw new ConfigError("JCHAIN_HARNESS must be name or name/version, with a name of 1 to 60 characters.");
  if (version !== null && !usableHarnessPart(version, 40)) throw new ConfigError("JCHAIN_HARNESS has a version that is not 1 to 40 characters.");
  return version === null ? { name } : { name, version };
}

/** A configuration problem. The message names the variable, never its value. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Reads `JCHAIN_CREDENTIAL`, and optionally `JCHAIN_BASE_URL`, `JCHAIN_RUN_ID`, `JCHAIN_IMAGE_DIR`, and `JCHAIN_HARNESS`. */
export function readConfig(env: Record<string, string | undefined>): ServerConfig {
  const credential = env.JCHAIN_CREDENTIAL?.trim() ?? "";
  if (credential === "") throw new ConfigError("JCHAIN_CREDENTIAL is not set. Ask your Operator for the Agent Credential.");
  if (!/^[\x21-\x7e]{1,512}$/.test(credential)) throw new ConfigError("JCHAIN_CREDENTIAL has spaces or characters that are not printable ASCII.");

  const rawBase = env.JCHAIN_BASE_URL?.trim() || DEFAULT_BASE_URL;
  let base: URL;
  try {
    base = new URL(rawBase);
  } catch {
    throw new ConfigError("JCHAIN_BASE_URL is not a valid URL.");
  }
  const local = base.hostname === "localhost" || base.hostname === "127.0.0.1" || base.hostname === "[::1]";
  if (base.protocol !== "https:" && !(base.protocol === "http:" && local)) {
    throw new ConfigError("JCHAIN_BASE_URL must use https (http is allowed for localhost only).");
  }
  if (base.username !== "" || base.password !== "" || base.search !== "" || base.hash !== "") {
    throw new ConfigError("JCHAIN_BASE_URL must be a plain origin with no credentials, query, or fragment.");
  }

  const runId = env.JCHAIN_RUN_ID?.trim() || null;
  if (runId !== null && !/^[\x20-\x7e]{1,128}$/.test(runId)) {
    throw new ConfigError("JCHAIN_RUN_ID must be 1 to 128 printable ASCII characters.");
  }
  const imageDir = env.JCHAIN_IMAGE_DIR?.trim() || null;
  const harness = parseHarnessSetting(env.JCHAIN_HARNESS ?? "");
  return { credential, baseUrl: base.toString().replace(/\/+$/, ""), runId, imageDir, harness };
}

/** Removes the Credential and anything shaped like a JChain secret from text before it leaves the process. */
export function redact(text: string, credential?: string): string {
  let out = text;
  if (credential) out = out.split(credential).join("[credential]");
  return out.replace(/\b(jc|up)_[A-Za-z0-9_-]{20,}/g, "[redacted]");
}
