import { DEFAULT_BASE_URL } from "@zero-state/jchain";

export type ServerConfig = {
  credential: string;
  baseUrl: string;
  runId: string | null;
  /** When set, image paths must resolve inside this directory. */
  imageDir: string | null;
};

/** A configuration problem. The message names the variable, never its value. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Reads `JCHAIN_CREDENTIAL`, and optionally `JCHAIN_BASE_URL`, `JCHAIN_RUN_ID`, and `JCHAIN_IMAGE_DIR`. */
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
  return { credential, baseUrl: base.toString().replace(/\/+$/, ""), runId, imageDir };
}

/** Removes the Credential and anything shaped like a JChain secret from text before it leaves the process. */
export function redact(text: string, credential?: string): string {
  let out = text;
  if (credential) out = out.split(credential).join("[credential]");
  return out.replace(/\b(jc|up)_[A-Za-z0-9_-]{20,}/g, "[redacted]");
}
