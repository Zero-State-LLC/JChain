import { applyD1Migrations, createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { VALID_WEBP } from "./fixtures/bytes";
import { BOARD_ID, MODERATOR, OPERATOR, call, clearConnectQuota, resetAndSeed } from "./harness";

// Ticket 52 (v0.2.44): the agent harness in Provenance.

const FORM = { "content-type": "application/x-www-form-urlencoded" };
const THREAD_ID = "01900000-0000-7000-8000-00000000b0b1";
const OPENING_ID = "01900000-0000-7000-8000-00000000b0b2";
const CLAUDE_CODE = { name: "Claude Code", version: "2.3.1" };

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetAndSeed();
  await env.DB.prepare("DELETE FROM agent_connections").run();
  await clearConnectQuota();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("AT-91 an Agent declares a harness", () => {
  it("takes an optional declared_harness at enrollment and returns it with a derived slug", async () => {
    const declared = await enroll("Ada", CLAUDE_CODE);
    const profile = await expectSuccess(await call(`/v1/agents/${declared.agentId}`, { bearer: declared.credential }));
    expect(profile.declared_harness).toEqual({ name: "Claude Code", version: "2.3.1", slug: "claude-code" });
    const me = await expectSuccess(await call("/v1/agents/me", { bearer: declared.credential }));
    expect(me.declared_harness).toEqual({ name: "Claude Code", version: "2.3.1", slug: "claude-code" });

    const nameOnly = await enroll("Bea", { name: "Hermes" });
    expect((await expectSuccess(await call(`/v1/agents/${nameOnly.agentId}`, { bearer: nameOnly.credential }))).declared_harness)
      .toEqual({ name: "Hermes", version: null, slug: "hermes" });

    const bare = await enroll("Cy");
    expect((await expectSuccess(await call(`/v1/agents/${bare.agentId}`, { bearer: bare.credential }))).declared_harness).toBeNull();
    expect((await expectSuccess(await call("/v1/agents/me", { bearer: bare.credential }))).declared_harness).toBeNull();
  });

  it("rejects an over-long name or version, control characters, a secret-shaped value, and an empty slug", async () => {
    const invalid = [
      { name: "x".repeat(61) },
      { name: "Hermes", version: "1".repeat(41) },
      { name: "Claude\nCode" },
      { name: "Hermes", version: "1\u00070" },
      { name: `jc_${"a".repeat(24)}` },
      { name: "!!! ---" },
      { name: "" },
    ];
    for (const harness of invalid) {
      await expectError(await enrollResponse("Ada", harness), 422, "validation_failed");
    }
    for (const harness of ["Claude Code", { version: "1.0" }, { name: 7 }, { name: "Hermes", extra: true }]) {
      await expectError(await enrollResponse("Ada", harness), 400, "malformed");
    }
    expect(await agentRows()).toBe(0);
  });

  it("sets, changes, and clears the harness with PATCH /v1/agents/me, one field at a time", async () => {
    const agent = await enroll("Ada");
    const set = await expectSuccess(await patchMe(agent.credential, { declared_harness: CLAUDE_CODE }));
    expect(set.declared_harness).toEqual({ name: "Claude Code", version: "2.3.1", slug: "claude-code" });
    const changed = await expectSuccess(await patchMe(agent.credential, { declared_harness: { name: "OpenClaw" } }));
    expect(changed.declared_harness).toEqual({ name: "OpenClaw", version: null, slug: "openclaw" });
    const cleared = await expectSuccess(await patchMe(agent.credential, { declared_harness: null }));
    expect(cleared.declared_harness).toBeNull();
    expect((await expectSuccess(await call(`/v1/agents/${agent.agentId}`, { bearer: agent.credential }))).declared_harness).toBeNull();
    await expectError(await patchMe(agent.credential, { declared_harness: { name: "x".repeat(61) } }), 422, "validation_failed");
    await expectError(await patchMe(agent.credential, { handle: "ada_one", declared_harness: null }), 400, "malformed");
  });

  it("takes the harness on the Enroll an agent form, and an Operator changes it on Your agents", async () => {
    const enrolled = await call("/operator/agents", {
      email: OPERATOR,
      raw: form({ display_name: "Ada", declared_model: "fixture-model", harness_name: "Claude Code", harness_version: "2.3.1" }),
      headers: FORM,
    });
    expect(enrolled.status, await enrolled.clone().text()).toBe(201);
    const agentId = (await env.DB.prepare("SELECT id FROM agents WHERE display_name = 'Ada'").first<{ id: string }>())!.id;
    expect(await harnessOf(agentId)).toEqual({ harness_name: "Claude Code", harness_version: "2.3.1" });

    const page = await (await call("/operator", { email: OPERATOR })).text();
    expect(page).toContain("via Claude Code 2.3.1");
    expect(page).toContain(`action="/operator/agents/${agentId}/harness"`);

    const changed = await call(`/operator/agents/${agentId}/harness`, {
      email: OPERATOR,
      raw: form({ harness_name: "Hermes", harness_version: "" }),
      headers: FORM,
    });
    expect(changed.status, await changed.clone().text()).toBe(200);
    expect(await harnessOf(agentId)).toEqual({ harness_name: "Hermes", harness_version: null });

    const cleared = await call(`/operator/agents/${agentId}/harness`, { email: OPERATOR, raw: form({ harness_name: "" }), headers: FORM });
    expect(cleared.status).toBe(200);
    expect(await harnessOf(agentId)).toEqual({ harness_name: null, harness_version: null });
    expect(await (await call("/operator", { email: OPERATOR })).text()).toContain("harness not declared");

    const refused = await call(`/operator/agents/${agentId}/harness`, {
      email: OPERATOR,
      raw: form({ harness_name: "x".repeat(61) }),
      headers: FORM,
    });
    expect(refused.status).toBe(422);
  });

  it("carries the harness through the CT-28 connect flow into the new Agent", async () => {
    const started = await expectSuccess(await call("/v1/connect", {
      body: { display_name: "Ada", declared_model: "my-model-1", declared_harness: { name: "Hermes", version: "0.9" } },
    }), 201);
    await expectError(await call("/v1/connect", {
      body: { display_name: "Bea", declared_model: "m", declared_harness: { name: "\u0000" } },
    }), 422, "validation_failed");
    const approved = await call("/operator/connect", {
      email: OPERATOR,
      raw: form({ code: String(started.user_code), decision: "approve" }),
      headers: FORM,
    });
    expect(approved.status, await approved.clone().text()).toBe(200);
    await env.DB.prepare("UPDATE agent_connections SET last_poll_at = '2000-01-01T00:00:00Z'").run();
    const claimed = await expectSuccess(await call("/v1/connect/token", { body: { device_code: started.device_code } }));
    expect(claimed.state).toBe("approved");
    const me = await expectSuccess(await call("/v1/agents/me", { bearer: String(claimed.credential) }));
    expect(me.declared_harness).toEqual({ name: "Hermes", version: "0.9", slug: "hermes" });
  });
});

describe("AT-92 each Post keeps its own harness", () => {
  it("stores origin post, agent, or none, and later Agent changes leave earlier Posts alone", async () => {
    const declared = await enroll("Ada", CLAUDE_CODE);
    const assetId = await readyAsset(declared.credential);
    const named = await expectSuccess(await openThread(declared.credential, threadBody(assetId, {
      provenance: { source: "model", model: "gpt-image-2", harness: { name: "Hermes", version: "0.9" } },
    })), 201);
    expect((named.provenance as Record<string, unknown>).harness)
      .toEqual({ name: "Hermes", version: "0.9", slug: "hermes", origin: "post" });

    await seedThread(declared.agentId);
    const copied = await reply(declared.credential, { text: "copied" });
    const bare = await enroll("Bea");
    const none = await reply(bare.credential, { text: "nothing declared" });
    const textOnly = await reply(bare.credential, { text: "named here", provenance: { harness: { name: "OpenClaw" } } });

    expect(await stored(String(named.post_id))).toEqual({ harness_name: "Hermes", harness_version: "0.9", harness_origin: "post" });
    expect(await stored(copied)).toEqual({ harness_name: "Claude Code", harness_version: "2.3.1", harness_origin: "agent" });
    expect(await stored(none)).toEqual({ harness_name: null, harness_version: null, harness_origin: "none" });
    expect(await stored(textOnly)).toEqual({ harness_name: "OpenClaw", harness_version: null, harness_origin: "post" });

    await patchMe(declared.credential, { declared_harness: { name: "Codex" } });
    expect(await stored(copied)).toEqual({ harness_name: "Claude Code", harness_version: "2.3.1", harness_origin: "agent" });

    await env.DB.prepare("UPDATE posts SET state = 'published'").run();
    const listed = await expectSuccess(await call(`/v1/threads/${THREAD_ID}/posts`, { bearer: bare.credential }));
    const byCaption = new Map((listed.items as Array<Record<string, unknown>>).map((item) => [item.caption, item.provenance]));
    expect(byCaption.get("copied")).toEqual({ harness: { name: "Claude Code", version: "2.3.1", slug: "claude-code", origin: "agent" } });
    expect(byCaption.get("nothing declared")).toBeNull();
    expect(byCaption.get("named here")).toEqual({ harness: { name: "OpenClaw", version: null, slug: "openclaw", origin: "post" } });

    const opening = await expectSuccess(await call(`/v1/threads/${String(named.thread_id)}/posts`, { bearer: bare.credential }));
    expect((opening.items as Array<Record<string, unknown>>)[0]?.provenance).toEqual({
      source: "model",
      model: "gpt-image-2",
      harness: { name: "Hermes", version: "0.9", slug: "hermes", origin: "post" },
    });

    const exported = await expectSuccess(await call(`/v1/exports/${String((await expectSuccess(await call("/v1/exports", {
      method: "POST",
      email: MODERATOR,
      body: { board_id: BOARD_ID, purpose: "archive" },
    }), 201)).export_id)}`, { email: MODERATOR }));
    const exportedHarness = new Map((exported.posts as Array<Record<string, unknown>>).map((post) => [
      post.caption,
      (post.provenance as Record<string, unknown> | null)?.harness ?? null,
    ]));
    expect(exportedHarness.get("copied")).toEqual({ name: "Claude Code", version: "2.3.1", slug: "claude-code", origin: "agent" });
    expect(exportedHarness.get("nothing declared")).toBeNull();
  });

  it("rejects an invalid Post harness and image fields on a text-only Reply", async () => {
    const agent = await enroll("Ada");
    await seedThread(agent.agentId);
    await expectError(await replyResponse(agent.credential, {
      text: "bad",
      provenance: { harness: { name: "x".repeat(61) } },
    }), 422, "validation_failed");
    await expectError(await replyResponse(agent.credential, {
      text: "bad",
      provenance: { source: "model", harness: { name: "Hermes" } },
    }), 400, "malformed");
    await expectError(await replyResponse(agent.credential, { text: "bad", provenance: {} }), 400, "malformed");
  });
});

describe("AT-93 people see model via harness", () => {
  it("shows the Agent's harness on the profile and each Post's own snapshot on the Thread bylines", async () => {
    const agent = await enroll("Ada", CLAUDE_CODE);
    await seedThread(agent.agentId);
    const first = await reply(agent.credential, { text: "first" });
    await patchMe(agent.credential, { declared_harness: { name: "Hermes", version: "0.9" } });
    const second = await reply(agent.credential, { text: "second" });
    await env.DB.prepare("UPDATE posts SET state = 'published'").run();

    const profile = await (await call(`/agents/${agent.agentId}`)).text();
    expect(profile).toContain("Runs on: <code>fixture-model</code> via <code>Hermes 0.9</code>");

    const thread = await (await call(`/threads/${THREAD_ID}`)).text();
    expect(bylineOf(thread, first)).toContain("<code>fixture-model</code> via <code>Claude Code 2.3.1</code>");
    expect(bylineOf(thread, second)).toContain("<code>fixture-model</code> via <code>Hermes 0.9</code>");

    const plain = await enroll("Bea");
    const plainProfile = await (await call(`/agents/${plain.agentId}`)).text();
    expect(plainProfile).toContain("Runs on: <code>fixture-model</code></p>");
    expect(plainProfile).not.toContain(" via <code>");

    const board = await (await call("/boards/beta")).text();
    expect(board).not.toContain(" via <code>");
  });
});

describe("AT-94 the harness mismatch signal", () => {
  it("shows the share of Posts whose harness disagrees with the client, and never changes a Post's state", async () => {
    const declared = await enroll("Mismatched", CLAUDE_CODE);
    const scripted = await enroll("Scripted", CLAUDE_CODE);
    const undeclared = await enroll("Undeclared");
    await seedThread(declared.agentId);
    const ids: string[] = [];
    for (const text of ["a", "b", "c"]) ids.push(await reply(declared.credential, { text }, "curl/8.7.1"));
    for (const text of ["x", "y", "z"]) await reply(scripted.credential, { text }, "zero-state-jchain-mcp/0.1.0");
    for (const text of ["p", "q", "r"]) await reply(undeclared.credential, { text }, "curl/8.7.1");
    const before = await states(ids);

    const page = await (await call("/moderation", { email: MODERATOR })).text();
    const section = page.slice(page.indexOf('id="authorship-signals"'));
    const headers = [...section.slice(0, section.indexOf("</thead>")).matchAll(/<th scope="col">([^<]*)<\/th>/g)].map((m) => m[1]);
    const manual = headers.indexOf("Manual client");
    const mismatch = headers.indexOf("Harness mismatch");
    expect(mismatch).toBeGreaterThan(-1);
    expect(cells(rowOf(section, "Mismatched"))[mismatch]).toBe("100%");
    expect(cells(rowOf(section, "Scripted"))[mismatch]).toBe("0%");
    // A manual client with no declared harness is not a mismatch.
    expect(cells(rowOf(section, "Undeclared"))[manual]).toBe("100%");
    expect(cells(rowOf(section, "Undeclared"))[mismatch]).toBe("0%");
    expect(await states(ids)).toEqual(before);
  });
});

function form(fields: Record<string, string>): Uint8Array {
  return new TextEncoder().encode(new URLSearchParams(fields).toString());
}

function enrollResponse(name: string, harness?: unknown): Promise<Response> {
  const body: Record<string, unknown> = { display_name: name, declared_model: "fixture-model" };
  if (harness !== undefined) body.declared_harness = harness;
  return call("/v1/agents", { email: OPERATOR, body });
}

async function enroll(name: string, harness?: unknown): Promise<{ credential: string; agentId: string }> {
  const body = await expectSuccess(await enrollResponse(name, harness), 201);
  return { credential: String(body.credential), agentId: String(body.agent_id) };
}

function patchMe(credential: string, body: Record<string, unknown>): Promise<Response> {
  return call("/v1/agents/me", { method: "PATCH", bearer: credential, body });
}

async function agentRows(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM agents WHERE display_name = 'Ada'").first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function harnessOf(agentId: string): Promise<{ harness_name: string | null; harness_version: string | null }> {
  const row = await env.DB.prepare("SELECT harness_name, harness_version FROM agents WHERE id = ?")
    .bind(agentId).first<{ harness_name: string | null; harness_version: string | null }>();
  return row!;
}

async function stored(postId: string): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare("SELECT harness_name, harness_version, harness_origin FROM posts WHERE id = ?")
    .bind(postId).first<Record<string, unknown>>();
  return row!;
}

async function states(ids: string[]): Promise<string[]> {
  const rows = await Promise.all(ids.map((id) => env.DB.prepare("SELECT state FROM posts WHERE id = ?").bind(id).first<{ state: string }>()));
  return rows.map((row) => row?.state ?? "");
}

async function seedThread(authorId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', '2026-10-25T00:00:00Z')").bind(THREAD_ID, BOARD_ID),
    env.DB.prepare(
      `INSERT INTO posts (id, thread_id, author_agent_id, asset_id, title, caption, alt_text, provenance_source, provenance_model,
         rights_attestation, license, remix_of_post_id, state, created_at)
       VALUES (?, ?, ?, NULL, 'Seed', '', NULL, NULL, NULL, NULL, NULL, NULL, 'published', '2026-10-25T00:00:00Z')`,
    ).bind(OPENING_ID, THREAD_ID, authorId),
  ]);
}

function replyResponse(credential: string, body: Record<string, unknown>, userAgent?: string): Promise<Response> {
  const headers: Record<string, string> = { "idempotency-key": crypto.randomUUID() };
  if (userAgent !== undefined) headers["user-agent"] = userAgent;
  return call(`/v1/threads/${THREAD_ID}/posts`, { bearer: credential, headers, body });
}

async function reply(credential: string, body: Record<string, unknown>, userAgent?: string): Promise<string> {
  return String((await expectSuccess(await replyResponse(credential, body, userAgent), 201)).post_id);
}

function threadBody(assetId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    board_id: BOARD_ID,
    asset_id: assetId,
    title: "Harness thread",
    caption: "opening caption",
    alt_text: "A square",
    provenance: { source: "model", model: "fixture-model" },
    rights_attestation: "I made this.",
    license: "cc0",
    ...extra,
  };
}

function openThread(credential: string, body: Record<string, unknown>): Promise<Response> {
  return call("/v1/threads", { bearer: credential, headers: { "idempotency-key": crypto.randomUUID() }, body });
}

function bylineOf(page: string, postId: string): string {
  const start = page.indexOf(`id="post-${postId}"`);
  return page.slice(start, page.indexOf("</p>", start));
}

function rowOf(section: string, name: string): string {
  const start = section.lastIndexOf("<tr>", section.indexOf(`>${name}</a>`));
  return section.slice(start, section.indexOf("</tr>", start));
}

// The text of each cell in a table row, with tags removed, so cells[i] lines up with headers[i].
function cells(row: string): string[] {
  return [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => (m[1] ?? "").replace(/<[^>]+>/g, "").trim());
}

async function readyAsset(credential: string): Promise<string> {
  const sha256 = await sha256HexBytes(VALID_WEBP);
  const reserved = await expectSuccess(await call("/v1/uploads", {
    bearer: credential,
    headers: { "idempotency-key": crypto.randomUUID() },
    body: { content_type: "image/webp", byte_size: VALID_WEBP.byteLength, sha256 },
  }), 201);
  const assetId = String(reserved.asset_id);
  await expectSuccess(await call(`/v1/uploads/${assetId}/content`, {
    method: "PUT",
    raw: VALID_WEBP,
    headers: { "idempotency-key": crypto.randomUUID(), "upload-token": String(reserved.upload_token) },
  }));
  await expectSuccess(await call(`/v1/uploads/${assetId}/complete`, {
    method: "POST",
    bearer: credential,
    headers: { "idempotency-key": crypto.randomUUID() },
  }), 202);
  const ctx = createExecutionContext();
  const batch = createMessageBatch("asset-upload", [{ id: `msg-${assetId}`, timestamp: new Date(), attempts: 1, body: { asset_id: assetId } }]);
  if (!worker.queue) throw new Error("queue handler missing");
  await worker.queue(batch, env, ctx);
  await getQueueResult(batch, ctx);
  return assetId;
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function expectError(response: Response, status: number, code: string): Promise<void> {
  const body = await response.json() as { error?: { code?: string } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(body.error?.code).toBe(code);
}

async function expectSuccess(response: Response, status = 200): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body;
}
