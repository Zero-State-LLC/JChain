import type { Harness } from "@zero-state/jchain";

// Proposed v0.2.45 (H9, awaiting Danny): MCP `clientInfo` names are package ids, not display
// names, and some are library defaults that name no host at all. This turns a host's clientInfo
// into the harness to send, or null when the host is unknown, so the Post keeps the Agent's
// declaration.

/** Known `clientInfo.name` values and their display names, each checked at the source. Others pass through. */
export const HOST_ALIASES: Readonly<Record<string, string>> = {
  // Claude Code 2.1.261 binary: new Client({ name: "claude-code", title: "Claude Code", version: <CLI version> }).
  "claude-code": "Claude Code",
  // Claude Desktop 3.6556.2 (app.asar), third-party inference mode: { name: "claude-desktop-3p", version: app.getVersion() }.
  "claude-desktop-3p": "Claude Desktop",
  // Hermes, checked in the Hermes source by Aaron (2026-10-25): sends its real version.
  "hermes-agent": "Hermes",
  // OpenClaw, checked in openclaw@2026.10.7 by Aaron (2026-10-25): sends version "0.0.0", dropped below.
  "openclaw-bundle-mcp": "OpenClaw",
};

/**
 * Library defaults and copied examples that name no real host, so they are unknown. A name listed
 * with versions is generic only at one of them; with an empty list, at any version.
 */
export const GENERIC_HOSTS: Readonly<Record<string, readonly string[]>> = {
  // The Python MCP SDK's DEFAULT_CLIENT_INFO.
  mcp: ["0.1.0"],
  // Client names in @modelcontextprotocol/sdk's own examples, which hosts copy. The TypeScript SDK has no default.
  "example-client": [],
  "backwards-compatible-client": [],
  "simple-oauth-client": [],
  "client-credentials-example": [],
  "parallel-tool-calls-client": [],
  "sse-polling-client": [],
  "simple-task-interactive-client": [],
};

/** Versions that say nothing. Dropped, so the name is sent alone. */
export const PLACEHOLDER_VERSIONS: ReadonlySet<string> = new Set(["0.0.0", "0.0.0-dev", "unknown", "dev", "-"]);

/**
 * The harness for a host's clientInfo, before the field-rule check: null for a missing or generic
 * name, the display name for a known one, and no version for a placeholder.
 */
export function translateHost(info: { name?: string; version?: string } | undefined): Harness | null {
  const name = info?.name?.trim() ?? "";
  if (name === "") return null;
  const version = info?.version?.trim() ?? "";
  const generic = GENERIC_HOSTS[name.toLowerCase()];
  if (generic !== undefined && (generic.length === 0 || generic.includes(version))) return null;
  const display = HOST_ALIASES[name] ?? name;
  return version === "" || PLACEHOLDER_VERSIONS.has(version.toLowerCase()) ? { name: display } : { name: display, version };
}
