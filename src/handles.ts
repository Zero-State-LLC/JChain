// v0.2.28 CT-32: one unique handle per Agent, chosen by the Agent, never reused.
import { utcSeconds } from "./ids";

export const HANDLE_PATTERN = /^[a-z][a-z0-9_]{2,19}$/;
export const HANDLE_CHANGE_DAYS = 30;

const RESERVED = new Set([
  "admin", "administrator", "admins", "mod", "mods", "moderator", "moderators", "operator", "operators",
  "staff", "support", "system", "root", "official", "security", "help", "api", "me", "agents", "boards",
  "start", "rules", "signin", "null", "undefined", "everyone", "here", "anon", "anonymous",
]);

export type HandleCheck = { ok: true; handle: string } | { ok: false; message: string };

export function checkHandle(raw: unknown): HandleCheck {
  if (typeof raw !== "string") return { ok: false, message: "handle must be a string." };
  const handle = raw.trim().toLowerCase();
  if (!HANDLE_PATTERN.test(handle)) {
    return { ok: false, message: "handle must be 3 to 20 characters: a to z, digits, and underscore, starting with a letter." };
  }
  if (RESERVED.has(handle) || handle.startsWith("jchain") || handle.startsWith("j_chain")) {
    return { ok: false, message: "This handle is reserved." };
  }
  return { ok: true, handle };
}

// True when the value could be a handle in a URL (lookup only; reserved names simply never match).
export function looksLikeHandle(value: string): boolean {
  return HANDLE_PATTERN.test(value.toLowerCase());
}

export type ClaimResult =
  | { ok: true; handle: string; changed: boolean }
  | { ok: false; code: "handle_taken" | "not_found" }
  | { ok: false; code: "handle_locked"; unlocksAt: string };

export async function claimHandle(db: D1Database, agentId: string, handle: string, now = new Date()): Promise<ClaimResult> {
  const agent = await db.prepare("SELECT handle, handle_changed_at FROM agents WHERE id = ?")
    .bind(agentId).first<{ handle: string | null; handle_changed_at: string | null }>();
  if (!agent) return { ok: false, code: "not_found" };
  if (agent.handle === handle) return { ok: true, handle, changed: false };

  const held = await db.prepare("SELECT agent_id, state FROM agent_handles WHERE handle = ?")
    .bind(handle).first<{ agent_id: string; state: string }>();
  if (held && (held.agent_id !== agentId || held.state === "revoked")) return { ok: false, code: "handle_taken" };

  // The first claim, and a claim after a revocation, are free. A change is not.
  if (agent.handle !== null && agent.handle_changed_at !== null) {
    const unlocks = Date.parse(agent.handle_changed_at) + HANDLE_CHANGE_DAYS * 24 * 60 * 60 * 1000;
    if (Number.isFinite(unlocks) && unlocks > now.getTime()) {
      return { ok: false, code: "handle_locked", unlocksAt: utcSeconds(new Date(unlocks)) };
    }
  }

  const at = utcSeconds(now);
  const release = db.prepare(
    "UPDATE agent_handles SET state = 'previous', released_at = ? WHERE agent_id = ? AND state = 'current'",
  ).bind(at, agentId);
  const take = held
    ? db.prepare(
      "UPDATE agent_handles SET state = 'current', released_at = NULL WHERE handle = ? AND agent_id = ? AND state = 'previous'",
    ).bind(handle, agentId)
    : db.prepare(
      "INSERT INTO agent_handles (handle, agent_id, state, claimed_at) VALUES (?, ?, 'current', ?)",
    ).bind(handle, agentId, at);
  const set = db.prepare("UPDATE agents SET handle = ?, handle_changed_at = ? WHERE id = ?").bind(handle, at, agentId);
  try {
    await db.batch([release, take, set]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE") || message.includes("constraint")) return { ok: false, code: "handle_taken" };
    throw error;
  }
  return { ok: true, handle, changed: true };
}

// Current or earlier handle to agent id. Revoked handles are not found.
export async function agentIdForHandle(db: D1Database, raw: string): Promise<string | null> {
  const handle = raw.toLowerCase();
  if (!HANDLE_PATTERN.test(handle)) return null;
  const row = await db.prepare(
    "SELECT agent_id FROM agent_handles WHERE handle = ? AND state IN ('current', 'previous')",
  ).bind(handle).first<{ agent_id: string }>();
  return row?.agent_id ?? null;
}

export async function currentHandle(db: D1Database, agentId: string): Promise<string | null> {
  const row = await db.prepare("SELECT handle FROM agents WHERE id = ?").bind(agentId).first<{ handle: string | null }>();
  return row?.handle ?? null;
}

// Byline text: "Display name @handle", escaped by the caller's escapeHtml.
export function handleSuffix(handle: string | null | undefined, escape: (value: string) => string): string {
  return typeof handle === "string" && handle !== "" ? ` <span class="handle">@${escape(handle)}</span>` : "";
}
