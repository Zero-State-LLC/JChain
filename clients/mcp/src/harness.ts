import { type Harness, checkHarness, dropPlaceholder, parseHarnessString } from "@zero-state/jchain";

// Spec v0.2.44 (H5): the MCP server names the harness from the host's MCP `clientInfo`, which the
// host sends itself when it connects. It is self-reported, like every declaration. JCHAIN_HARNESS
// (`name` or `name/version`) overrides it. When the result is unknown, no provenance.harness is
// sent, so the Post keeps the Agent's own declaration.

/**
 * Known `clientInfo.name` values and their display names. Each entry was checked at the source;
 * an unlisted name is sent as the host gave it.
 */
export const CLIENT_ALIASES: Readonly<Record<string, string>> = {
  // Claude Code 2.1.261 binary: new Client({ name: "claude-code", title: "Claude Code", version: <CLI version> }).
  "claude-code": "Claude Code",
  // Claude Desktop 3.6556.2 (app.asar), third-party inference mode: { name: "claude-desktop-3p", version: app.getVersion() }.
  "claude-desktop-3p": "Claude Desktop",
  // Hermes: checked in the Hermes source by Aaron (2026-10-25); it sends its real version.
  "hermes-agent": "Hermes",
  // OpenClaw: checked in openclaw@2026.10.7 by Aaron (2026-10-25); it sends version "0.0.0", dropped below.
  "openclaw-bundle-mcp": "OpenClaw",
};

/**
 * Library defaults and copied examples that name no real host. Treated as unknown. A name listed
 * with versions is generic only with one of those versions; with an empty list, at any version.
 */
export const GENERIC_CLIENTS: Readonly<Record<string, readonly string[]>> = {
  // The Python MCP SDK's DEFAULT_CLIENT_INFO.
  mcp: ["0.1.0"],
  // Client names used in @modelcontextprotocol/sdk's own examples, which hosts copy.
  "example-client": [],
  "backwards-compatible-client": [],
  "simple-oauth-client": [],
  "client-credentials-example": [],
  "parallel-tool-calls-client": [],
  "sse-polling-client": [],
  "simple-task-interactive-client": [],
};

export type ClientInfo = { name?: unknown; version?: unknown } | undefined;

/** The harness to name for an MCP host, or null when the host is unknown or generic. */
export function harnessFromClientInfo(info: ClientInfo): Harness | null {
  if (info === undefined || info === null || typeof info.name !== "string") return null;
  const name = info.name.trim();
  if (name === "") return null;
  const version = typeof info.version === "string" ? info.version.trim() : "";
  const generic = GENERIC_CLIENTS[name.toLowerCase()];
  if (generic !== undefined && (generic.length === 0 || generic.includes(version))) return null;
  return checkHarness({ name: CLIENT_ALIASES[name] ?? name, version: dropPlaceholder(version) });
}

/** Parses JCHAIN_HARNESS. Returns undefined when unset or blank, and null when it fails the field rules. */
export function parseHarnessOverride(raw: string | undefined): Harness | null | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  return parseHarnessString(raw);
}
