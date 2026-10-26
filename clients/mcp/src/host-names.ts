import type { Harness } from "@zero-state/jchain";

// v0.2.45 (H9): MCP `clientInfo` names are package ids, not display
// names, and some are library defaults that name no host at all. This turns a host's clientInfo
// into the harness to send, or null when the host is unknown, so the Post keeps the Agent's
// declaration.

/**
 * Known `clientInfo.name` values and their display names, each checked at the source. A name
 * matches case-insensitively, exactly or as a prefix followed by a separator (so a host that adds
 * a suffix such as `claude-code-vscode` still matches); the longest alias wins. Others pass through.
 */
export const HOST_ALIASES: Readonly<Record<string, string>> = {
  // Claude Code 2.1.261 binary: new Client({ name: "claude-code", title: "Claude Code", version: <CLI version> }).
  "claude-code": "Claude Code",
  // Claude Desktop 3.6556.2 (app.asar), third-party inference mode: { name: "claude-desktop-3p", version: app.getVersion() }.
  "claude-desktop-3p": "Claude Desktop",
  // Hermes, checked in the Hermes source by Aaron (2026-10-25): sends its real version.
  "hermes-agent": "Hermes",
  // OpenClaw, checked in openclaw@2026.10.7 by Aaron (2026-10-25): sends version "0.0.0", dropped below.
  "openclaw-bundle-mcp": "OpenClaw",
  // Gemini CLI, google-gemini/gemini-cli packages/core/src/tools/mcp-client.ts: new Client({ name: "gemini-cli-mcp-client", ... }).
  "gemini-cli-mcp-client": "Gemini CLI",
};

/**
 * Library defaults and copied examples that name no real host, so they are unknown. A name listed
 * with versions is generic only at one of them; with an empty list, at any version.
 */
export const GENERIC_HOSTS: Readonly<Record<string, readonly string[]>> = {
  // The Python MCP SDK's DEFAULT_CLIENT_INFO is mcp 0.1.0; the bare name says nothing at any version.
  mcp: [],
  // Client names in @modelcontextprotocol/sdk's own examples, which hosts copy. The TypeScript SDK has no default.
  "example-client": [],
  "backwards-compatible-client": [],
  "simple-oauth-client": [],
  "client-credentials-example": [],
  "parallel-tool-calls-client": [],
  "sse-polling-client": [],
  "simple-task-interactive-client": [],
};

/**
 * Versions that say nothing, compared case-insensitively. Dropped, so the name is sent alone.
 * 0.1.0 and 1.0.0 are SDK and example defaults that hosts leave unchanged (Cursor sends 1.0.0).
 */
export const PLACEHOLDER_VERSIONS: ReadonlySet<string> = new Set(["0.0.0", "0.0.0-dev", "0.1.0", "1.0.0", "unknown", "dev", "-"]);

const ALIAS_KEYS = Object.keys(HOST_ALIASES).sort((a, b) => b.length - a.length);

/** The display name for a clientInfo name, or the name itself when no alias matches. */
export function aliasFor(name: string): string {
  const lower = name.toLowerCase();
  const key = ALIAS_KEYS.find((alias) => lower === alias || (lower.startsWith(alias) && !/[a-z0-9]/.test(lower.charAt(alias.length))));
  return key === undefined ? name : (HOST_ALIASES[key] ?? name);
}

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
  const display = aliasFor(name);
  return version === "" || PLACEHOLDER_VERSIONS.has(version.toLowerCase()) ? { name: display } : { name: display, version };
}
