import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

export const POLICY_DOCUMENT = {
  schema_version: 1,
  moderation_mode: "pre_publication",
  content_is_untrusted_data: true,
  prohibited: ["slurs", "harassment", "sexual_content", "real_person_likeness", "private_data"],
} as const;

export type SeedAgent = {
  id: string;
  credentialId: string;
  secret: string;
  displayName: string;
};

export type Seed = {
  operator: { id: string; sessionId: string; secret: string };
  moderator: { id: string; secret: string };
  agents: [SeedAgent, SeedAgent];
  revoked: { id: string; secret: string; agentId: string };
  expired: { id: string; secret: string; agentId: string };
  board: { id: string; slug: string; title: string };
};

const TABLES = [
  "audit_events",
  "credentials",
  "agents",
  "operator_sessions",
  "operators",
  "moderators",
  "boards",
  "policy_config",
] as const;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function newSecret(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const token = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `${prefix}${token}`;
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

async function resetAndSeed(policy: boolean): Promise<Seed> {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch(TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));

  const operatorId = newId("opr");
  const sessionId = newId("oss");
  const operatorSecret = newSecret("jcop_");
  const moderatorId = newId("mod");
  const moderatorSecret = newSecret("jcmd_");
  const agentOneId = newId("agt");
  const agentTwoId = newId("agt");
  const credentialOneId = newId("crd");
  const credentialTwoId = newId("crd");
  const revokedId = newId("crd");
  const expiredId = newId("crd");
  const agentOneSecret = newSecret("jcag_");
  const agentTwoSecret = newSecret("jcag_");
  const revokedSecret = newSecret("jcag_");
  const expiredSecret = newSecret("jcag_");
  const boardId = newId("brd");
  const scopes = JSON.stringify(["read", "post", "react"]);

  const statements = [
    env.DB.prepare(
      "INSERT INTO operators (id, display_name, created_at) VALUES (?, ?, ?)",
    ).bind(operatorId, "Primary Operator", "2026-01-01T00:00:00.000Z"),
    env.DB.prepare(
      "INSERT INTO operator_sessions (id, operator_id, secret_hash, state, created_at, revoked_at) VALUES (?, ?, ?, 'active', ?, NULL)",
    ).bind(sessionId, operatorId, await sha256Hex(operatorSecret), "2026-01-01T00:00:00.000Z"),
    env.DB.prepare(
      "INSERT INTO moderators (id, display_name, secret_hash, state, created_at) VALUES (?, ?, ?, 'active', ?)",
    ).bind(moderatorId, "Moderator", await sha256Hex(moderatorSecret), "2026-01-01T00:00:00.000Z"),
    env.DB.prepare(
      "INSERT INTO agents (id, operator_id, display_name, declared_model, state, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
    ).bind(agentOneId, operatorId, "First Agent", "test-model", "2026-01-02T00:00:00.000Z"),
    env.DB.prepare(
      "INSERT INTO agents (id, operator_id, display_name, declared_model, state, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
    ).bind(agentTwoId, operatorId, "Second Agent", "test-model", "2026-01-03T00:00:00.000Z"),
    env.DB.prepare(
      "INSERT INTO credentials (id, agent_id, secret_hash, scopes, state, created_at, revoked_at) VALUES (?, ?, ?, ?, 'active', ?, NULL)",
    ).bind(credentialOneId, agentOneId, await sha256Hex(agentOneSecret), scopes, "2026-01-02T00:00:00.000Z"),
    env.DB.prepare(
      "INSERT INTO credentials (id, agent_id, secret_hash, scopes, state, created_at, revoked_at) VALUES (?, ?, ?, ?, 'active', ?, NULL)",
    ).bind(credentialTwoId, agentTwoId, await sha256Hex(agentTwoSecret), scopes, "2026-01-03T00:00:00.000Z"),
    env.DB.prepare(
      "INSERT INTO credentials (id, agent_id, secret_hash, scopes, state, created_at, revoked_at) VALUES (?, ?, ?, ?, 'revoked', ?, ?)",
    ).bind(revokedId, agentOneId, await sha256Hex(revokedSecret), scopes, "2026-01-02T00:00:01.000Z", "2026-01-02T00:00:02.000Z"),
    env.DB.prepare(
      "INSERT INTO credentials (id, agent_id, secret_hash, scopes, state, created_at, revoked_at) VALUES (?, ?, ?, ?, 'expired', ?, NULL)",
    ).bind(expiredId, agentTwoId, await sha256Hex(expiredSecret), scopes, "2026-01-03T00:00:01.000Z"),
    env.DB.prepare(
      "INSERT INTO boards (id, slug, title, visibility, created_at) VALUES (?, ?, ?, 'private', ?)",
    ).bind(boardId, "main", "Main", "2026-01-01T00:00:00.000Z"),
  ];

  if (policy) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO policy_config (id, document, updated_at) VALUES ('current', ?, ?)",
      ).bind(JSON.stringify(POLICY_DOCUMENT), "2026-01-01T00:00:00.000Z"),
    );
  }

  await env.DB.batch(statements);

  return {
    operator: { id: operatorId, sessionId, secret: operatorSecret },
    moderator: { id: moderatorId, secret: moderatorSecret },
    agents: [
      { id: agentOneId, credentialId: credentialOneId, secret: agentOneSecret, displayName: "First Agent" },
      { id: agentTwoId, credentialId: credentialTwoId, secret: agentTwoSecret, displayName: "Second Agent" },
    ],
    revoked: { id: revokedId, secret: revokedSecret, agentId: agentOneId },
    expired: { id: expiredId, secret: expiredSecret, agentId: agentTwoId },
    board: { id: boardId, slug: "main", title: "Main" },
  };
}

export function useSeed(): { current: () => Seed } {
  let seed: Seed | undefined;
  beforeEach(async () => {
    seed = await resetAndSeed(true);
  });
  return {
    current() {
      if (!seed) throw new Error("Seed is not ready.");
      return seed;
    },
  };
}

export async function clearPolicy(): Promise<void> {
  await env.DB.prepare("DELETE FROM policy_config").run();
}

export async function replacePolicy(document: string): Promise<void> {
  await env.DB.prepare("UPDATE policy_config SET document = ? WHERE id = 'current'").bind(document).run();
}

export async function insertBoard(title: string, createdAt: string): Promise<{ id: string; slug: string }> {
  const id = newId("brd");
  const slug = `extra-${id.slice(-12)}`;
  await env.DB.prepare(
    "INSERT INTO boards (id, slug, title, visibility, created_at) VALUES (?, ?, ?, 'private', ?)",
  ).bind(id, slug, title, createdAt).run();
  return { id, slug };
}

export async function createOperator(displayName: string): Promise<{ id: string; secret: string }> {
  const id = newId("opr");
  const sessionId = newId("oss");
  const secret = newSecret("jcop_");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO operators (id, display_name, created_at) VALUES (?, ?, ?)").bind(
      id,
      displayName,
      "2026-02-01T00:00:00.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO operator_sessions (id, operator_id, secret_hash, state, created_at, revoked_at) VALUES (?, ?, ?, 'active', ?, NULL)",
    ).bind(sessionId, id, await sha256Hex(secret), "2026-02-01T00:00:00.000Z"),
  ]);
  return { id, secret };
}
