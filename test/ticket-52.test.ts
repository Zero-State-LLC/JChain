import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import postpublishFixture from "./fixtures/policy-postpublish.json";
import {
  ADMIN2,
  BOARD_ID,
  INSTRUCTIONS,
  MODERATOR,
  OPERATOR,
  call,
  clearConnectQuota,
  resetAndSeed,
} from "./harness";
import { uuidv7 } from "../src/ids";
import { POSTPUBLISH_INSTRUCTIONS } from "../src/rules-copy";

// Ticket 52 (spec v0.2.44): the agent harness in Provenance. AT-91 to AT-94, plus the Board Rules
// provenance object (CT-12) and the onboarding copy.

const POSTPUBLISH = JSON.stringify(postpublishFixture);
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const THREAD_ID = "01900000-0000-7000-8000-00000000c0a1";
const OPENING_ID = "01900000-0000-7000-8000-00000000c0a2";
const SECRET = `jc_${"a".repeat(30)}`;

type Json = Record<string, unknown>;
type Agent = { agentId: string; credential: string };

function form(fields: Record<string, string>): Uint8Array {
  return new TextEncoder().encode(new URLSearchParams(fields).toString());
}

async function json(response: Response, status: number): Promise<Json> {
  expect(response.status, await response.clone().text()).toBe(status);
  return response.json() as Promise<Json>;
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

async function enroll(name: string, extra: Json = {}, model = "claude-opus-5-5"): Promise<Agent> {
  const body = await json(await call("/v1/agents", { email: OPERATOR, body: { display_name: name, declared_model: model, ...extra } }), 201);
  return { agentId: String(body.agent_id), credential: String(body.credential) };
}

async function agentCount(): Promise<number> {
  return Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM agents").first<{ n: number }>())?.n ?? 0);
}

async function seedAsset(agentId: string): Promise<string> {
  const id = uuidv7();
  await env.DB.prepare(
    `INSERT INTO assets (id, agent_id, state, content_type, byte_size, sha256, original_stored, created_at, expires_at)
     VALUES (?, ?, 'ready', 'image/webp', 4, ?, 0, '2026-10-25T00:00:00Z', '2026-10-26T00:00:00Z')`,
  ).bind(id, agentId, id.replaceAll("-", "").padEnd(64, "e")).run();
  return id;
}

// A published Opening Post with no harness columns set, as before migration 0031.
async function seedThread(author: Agent): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', '2026-10-25T00:00:00Z')").bind(THREAD_ID, BOARD_ID),
    env.DB.prepare(
      `INSERT INTO posts (id, thread_id, author_agent_id, asset_id, title, caption, alt_text, provenance_source, provenance_model,
         rights_attestation, license, remix_of_post_id, state, created_at)
       VALUES (?, ?, ?, NULL, 'Seed', '', NULL, NULL, NULL, NULL, NULL, NULL, 'published', '2026-10-25T00:00:00Z')`,
    ).bind(OPENING_ID, THREAD_ID, author.agentId),
  ]);
}

async function reply(agent: Agent, body: Json, userAgent?: string, status = 201): Promise<Response> {
  const headers: Record<string, string> = { "idempotency-key": crypto.randomUUID() };
  if (userAgent !== undefined) headers["user-agent"] = userAgent;
  const response = await call(`/v1/threads/${THREAD_ID}/posts`, { bearer: agent.credential, headers, body, policy: POSTPUBLISH });
  expect(response.status, await response.clone().text()).toBe(status);
  return response;
}

async function replyId(agent: Agent, body: Json, userAgent?: string): Promise<string> {
  return String((await (await reply(agent, body, userAgent)).json() as Json).post_id);
}

async function snapshot(postId: string): Promise<{ harness_name: string | null; harness_version: string | null; harness_origin: string }> {
  return (await env.DB.prepare("SELECT harness_name, harness_version, harness_origin FROM posts WHERE id = ?").bind(postId)
    .first<{ harness_name: string | null; harness_version: string | null; harness_origin: string }>())!;
}

async function patchMe(agent: Agent, body: unknown): Promise<Response> {
  return call("/v1/agents/me", { method: "PATCH", bearer: agent.credential, body });
}

async function threadItems(agent: Agent): Promise<Json[]> {
  const body = await json(await call(`/v1/threads/${THREAD_ID}/posts`, { bearer: agent.credential }), 200);
  return body.items as Json[];
}

function itemFor(items: Json[], postId: string): Json {
  const found = items.find((item) => item.post_id === postId);
  expect(found, postId).toBeDefined();
  return found!;
}

function articleFor(html: string, postId: string): string {
  const start = html.lastIndexOf("<article", html.indexOf(`id="post-${postId}"`));
  return html.slice(start, html.indexOf("</article>", start));
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetAndSeed();
  await env.DB.prepare("DELETE FROM agent_connections").run();
  await clearConnectQuota();
});

describe("AT-91 an Agent declares a harness", () => {
  it("accepts an optional declared_harness on CT-01 and returns it with the derived slug", async () => {
    const ada = await enroll("Ada", { declared_harness: { name: "Claude Code", version: "2.3.1" } });
    const expected = { name: "Claude Code", version: "2.3.1", slug: "claude-code" };
    expect((await json(await call(`/v1/agents/${ada.agentId}`, { bearer: ada.credential }), 200)).declared_harness).toEqual(expected);
    expect((await json(await call("/v1/agents/me", { bearer: ada.credential }), 200)).declared_harness).toEqual(expected);

    const bo = await enroll("Bo", { declared_harness: { name: "  Hermes Agent!! " } });
    expect((await json(await call(`/v1/agents/${bo.agentId}`, { bearer: bo.credential }), 200)).declared_harness)
      .toEqual({ name: "  Hermes Agent!! ", version: null, slug: "hermes-agent" });

    const cy = await enroll("Cy");
    expect((await json(await call(`/v1/agents/${cy.agentId}`, { bearer: cy.credential }), 200)).declared_harness).toBeNull();
    expect((await json(await call("/v1/agents/me", { bearer: cy.credential }), 200)).declared_harness).toBeNull();
  });

  it("rejects bad declarations on CT-01 and creates nothing", async () => {
    const cases: Array<[unknown, number, string]> = [
      [{ name: "x".repeat(61) }, 422, "validation_failed"],
      [{ name: "" }, 422, "validation_failed"],
      [{ name: "Claude Code", version: "1".repeat(41) }, 422, "validation_failed"],
      [{ name: "Claude Code", version: "" }, 422, "validation_failed"],
      [{ name: "Claude\nCode" }, 422, "validation_failed"],
      [{ name: "Claude Code", version: "2.3\t1" }, 422, "validation_failed"],
      [{ name: "Bad\u0085Name" }, 422, "validation_failed"],
      [{ name: SECRET }, 422, "secret_in_caption"],
      [{ name: "Claude Code", version: "-----BEGIN" }, 422, "secret_in_caption"],
      [{ name: "---" }, 422, "validation_failed"],
      [{ name: "日本語" }, 422, "validation_failed"],
      [{ name: 5 }, 400, "malformed"],
      [{ name: "Claude Code", extra: true }, 400, "malformed"],
      ["Claude Code", 400, "malformed"],
    ];
    for (const [declared, status, code] of cases) {
      const response = await call("/v1/agents", { email: OPERATOR, body: { display_name: "Ada", declared_model: "m", declared_harness: declared } });
      expect(response.status, JSON.stringify(declared)).toBe(status);
      expect(await errorCode(response), JSON.stringify(declared)).toBe(code);
    }
    expect(await agentCount()).toBe(0);
    // An explicit null is the same as leaving it out.
    const none = await enroll("Ada", { declared_harness: null });
    expect((await json(await call("/v1/agents/me", { bearer: none.credential }), 200)).declared_harness).toBeNull();
  });

  it("takes the harness on the Enroll an agent form", async () => {
    const bad = await call("/operator/agents", {
      email: OPERATOR,
      raw: form({ display_name: "Ada", declared_model: "m", harness_name: "!!!" }),
      headers: FORM,
    });
    expect(bad.status).toBe(422);
    expect(await agentCount()).toBe(0);
    const page = await (await call("/operator", { email: OPERATOR })).text();
    expect(page).toContain('name="harness_name"');
    expect(page).toContain('name="harness_version"');

    const created = await call("/operator/agents", {
      email: OPERATOR,
      raw: form({ display_name: "Ada", declared_model: "m", harness_name: " Hermes ", harness_version: " 0.9.1 " }),
      headers: FORM,
    });
    expect(created.status).toBe(201);
    const row = await env.DB.prepare("SELECT harness_name, harness_version FROM agents WHERE display_name = 'Ada'")
      .first<{ harness_name: string; harness_version: string }>();
    expect(row).toEqual({ harness_name: "Hermes", harness_version: "0.9.1" });

    // Blank harness fields mean no declaration.
    await call("/operator/agents", { email: OPERATOR, raw: form({ display_name: "Bo", declared_model: "m", harness_name: "", harness_version: "" }), headers: FORM });
    const bo = await env.DB.prepare("SELECT harness_name, harness_version FROM agents WHERE display_name = 'Bo'").first();
    expect(bo).toEqual({ harness_name: null, harness_version: null });
  });

  it("carries the harness through CT-28 connect", async () => {
    const refused = await call("/v1/connect", { body: { display_name: "Ada", declared_model: "m", declared_harness: { name: "x".repeat(61) } } });
    expect(refused.status).toBe(422);
    const started = await json(await call("/v1/connect", {
      body: { display_name: "Ada", declared_model: "m", declared_harness: { name: "OpenClaw", version: "2026.10.7" } },
    }), 201);
    const confirm = await (await call(`/operator/connect?code=${String(started.user_code)}`, { email: OPERATOR })).text();
    expect(confirm).toContain("OpenClaw 2026.10.7");
    const approved = await call("/operator/connect", { email: OPERATOR, raw: form({ code: String(started.user_code), decision: "approve" }), headers: FORM });
    expect(approved.status).toBe(200);
    const claimed = await json(await call("/v1/connect/token", { body: { device_code: started.device_code } }), 200);
    expect(claimed.state).toBe("approved");
    const me = await json(await call("/v1/agents/me", { bearer: String(claimed.credential) }), 200);
    expect(me.declared_harness).toEqual({ name: "OpenClaw", version: "2026.10.7", slug: "openclaw" });
  });

  it("sets, changes, and clears the harness with PATCH /v1/agents/me", async () => {
    const ada = await enroll("Ada");
    const set = await json(await patchMe(ada, { declared_harness: { name: "Claude Code", version: "2.3.1" } }), 200);
    expect(set.declared_harness).toEqual({ name: "Claude Code", version: "2.3.1", slug: "claude-code" });
    expect(set.agent_id).toBe(ada.agentId);

    const changed = await json(await patchMe(ada, { declared_harness: { name: "Hermes" } }), 200);
    expect(changed.declared_harness).toEqual({ name: "Hermes", version: null, slug: "hermes" });

    const bad = await patchMe(ada, { declared_harness: { name: "Bad\u0000" } });
    expect(bad.status).toBe(422);
    expect((await json(await call("/v1/agents/me", { bearer: ada.credential }), 200)).declared_harness)
      .toEqual({ name: "Hermes", version: null, slug: "hermes" });

    const both = await json(await patchMe(ada, { handle: "ada_bot", declared_harness: { name: "Claude Code", version: "2.4.0" } }), 200);
    expect(both.handle).toBe("ada_bot");
    expect(both.declared_harness).toEqual({ name: "Claude Code", version: "2.4.0", slug: "claude-code" });

    const cleared = await json(await patchMe(ada, { declared_harness: null }), 200);
    expect(cleared.declared_harness).toBeNull();
    expect((await json(await call(`/v1/agents/${ada.agentId}`, { bearer: ada.credential }), 200)).declared_harness).toBeNull();

    expect((await patchMe(ada, {})).status).toBe(400);
    expect((await patchMe(ada, { declared_model: "x" })).status).toBe(400);
  });

  it("lets the Operator set, change, and clear it on Your agents", async () => {
    const ada = await enroll("Ada");
    let page = await (await call("/operator", { email: OPERATOR })).text();
    expect(page).toContain("harness not declared");
    expect(page).toContain(`action="/operator/agents/${ada.agentId}/harness"`);

    const path = `/operator/agents/${ada.agentId}/harness`;
    expect((await call(path, { email: OPERATOR, raw: form({ harness_name: "Claude Code", harness_version: "2.3.1" }), headers: FORM })).status).toBe(200);
    page = await (await call("/operator", { email: OPERATOR })).text();
    expect(page).toContain("claude-opus-5-5 via Claude Code 2.3.1");

    expect((await call(path, { email: OPERATOR, raw: form({ harness_name: "Hermes", harness_version: "" }), headers: FORM })).status).toBe(200);
    expect((await json(await call("/v1/agents/me", { bearer: ada.credential }), 200)).declared_harness).toEqual({ name: "Hermes", version: null, slug: "hermes" });

    expect((await call(path, { email: OPERATOR, raw: form({ harness_name: "a\u0007b" }), headers: FORM })).status).toBe(422);
    expect((await call(path, { email: OPERATOR, raw: form({ harness_name: "", harness_version: "" }), headers: FORM })).status).toBe(200);
    expect((await json(await call("/v1/agents/me", { bearer: ada.credential }), 200)).declared_harness).toBeNull();

    // Another Operator's Agent is not found on this form.
    expect((await call(path, { email: ADMIN2, raw: form({ harness_name: "Mine" }), headers: FORM })).status).toBe(404);
    expect((await call(path, { email: OPERATOR, raw: form({ harness_name: "Hermes" }), headers: FORM, sameOrigin: false })).status).toBe(403);
  });
});

describe("AT-92 each Post keeps its own harness", () => {
  it("stores origin post, agent, or none, and later edits never rewrite it", async () => {
    const declared = await enroll("Declared", { declared_harness: { name: "Claude Code", version: "2.3.1" } });
    const bare = await enroll("Bare");
    await seedThread(bare);

    const fromAgent = await replyId(declared, { text: "copied from my declaration" });
    const fromPost = await replyId(declared, { text: "named on the post", provenance: { harness: { name: "Hermes", version: "0.9" } } });
    const named = await replyId(declared, { text: "no version", provenance: { harness: { name: "Hermes" } } });
    const none = await replyId(bare, { text: "nothing declared" });
    expect(await snapshot(fromAgent)).toEqual({ harness_name: "Claude Code", harness_version: "2.3.1", harness_origin: "agent" });
    expect(await snapshot(fromPost)).toEqual({ harness_name: "Hermes", harness_version: "0.9", harness_origin: "post" });
    // A Post that names a harness never borrows the Agent's version.
    expect(await snapshot(named)).toEqual({ harness_name: "Hermes", harness_version: null, harness_origin: "post" });
    expect(await snapshot(none)).toEqual({ harness_name: null, harness_version: null, harness_origin: "none" });

    await json(await patchMe(declared, { declared_harness: { name: "OpenClaw" } }), 200);
    await json(await patchMe(bare, { declared_harness: { name: "OpenClaw" } }), 200);
    expect(await snapshot(fromAgent)).toEqual({ harness_name: "Claude Code", harness_version: "2.3.1", harness_origin: "agent" });
    expect(await snapshot(none)).toEqual({ harness_name: null, harness_version: null, harness_origin: "none" });

    const items = await threadItems(bare);
    expect(itemFor(items, fromAgent).provenance).toEqual({ harness: { name: "Claude Code", version: "2.3.1", slug: "claude-code", origin: "agent" } });
    expect(itemFor(items, fromPost).provenance).toEqual({ harness: { name: "Hermes", version: "0.9", slug: "hermes", origin: "post" } });
    expect(itemFor(items, none).provenance).toBeNull();
    // The seeded Opening Post predates the migration: origin none.
    expect(itemFor(items, OPENING_ID).provenance).toBeNull();

    // A Post made after the change copies the new declaration.
    const after = await replyId(bare, { text: "after the change" });
    expect(await snapshot(after)).toEqual({ harness_name: "OpenClaw", harness_version: null, harness_origin: "agent" });
  });

  it("validates provenance.harness on CT-04 and CT-05", async () => {
    const ada = await enroll("Ada");
    await seedThread(ada);
    for (const [harness, code] of [
      [{ name: "x".repeat(61) }, "validation_failed"],
      [{ name: "ok", version: "v\n1" }, "validation_failed"],
      [{ name: SECRET }, "secret_in_caption"],
      [{ name: "@@" }, "validation_failed"],
      [{ name: 1 }, "malformed"],
      ["Hermes", "malformed"],
    ] as Array<[unknown, string]>) {
      const response = await reply(ada, { text: "hi", provenance: { harness } }, undefined, code === "malformed" ? 400 : 422);
      expect(await errorCode(response), JSON.stringify(harness)).toBe(code);
    }
    // A text-only Reply carries no image declarations: only harness is allowed in its provenance.
    expect(await errorCode(await reply(ada, { text: "hi", provenance: { source: "model", harness: { name: "Hermes" } } }, undefined, 400))).toBe("malformed");
    expect(await errorCode(await reply(ada, { text: "hi", provenance: {} }, undefined, 400))).toBe("malformed");

    const assetId = await seedAsset(ada.agentId);
    const badThread = await call("/v1/threads", {
      bearer: ada.credential,
      headers: { "idempotency-key": crypto.randomUUID() },
      policy: POSTPUBLISH,
      body: {
        board_id: BOARD_ID, asset_id: assetId, title: "t", caption: "", alt_text: "a",
        provenance: { source: "model", harness: { name: "a\u001bb" } }, rights_attestation: "mine", license: "cc0",
      },
    });
    expect(badThread.status).toBe(422);
  });

  it("returns provenance.harness on image Posts, Agent posts, and exports, and leaves Events and search alone", async () => {
    const ada = await enroll("Ada", { declared_harness: { name: "Claude Code", version: "2.3.1" } });
    const bo = await enroll("Bo");
    const assetId = await seedAsset(ada.agentId);
    const opened = await json(await call("/v1/threads", {
      bearer: ada.credential,
      headers: { "idempotency-key": crypto.randomUUID() },
      policy: POSTPUBLISH,
      body: {
        board_id: BOARD_ID, asset_id: assetId, title: "Frog", caption: "a frog", alt_text: "a green frog",
        provenance: { source: "model", model: "gpt-image-2", harness: { name: "Hermes Agent", version: "1.2" } },
        rights_attestation: "mine", license: "cc0",
      },
    }), 201);
    const threadId = String(opened.thread_id);
    const postId = String(opened.post_id);
    expect(opened.state).toBe("published");
    const replied = await json(await call(`/v1/threads/${threadId}/posts`, {
      bearer: bo.credential, headers: { "idempotency-key": crypto.randomUUID() }, policy: POSTPUBLISH, body: { text: "nice" },
    }), 201);
    const replyPost = String(replied.post_id);

    const expected = { source: "model", model: "gpt-image-2", harness: { name: "Hermes Agent", version: "1.2", slug: "hermes-agent", origin: "post" } };
    const thread = await json(await call(`/v1/threads/${threadId}/posts`, { bearer: bo.credential }), 200);
    expect(itemFor(thread.items as Json[], postId).provenance).toEqual(expected);
    expect(itemFor(thread.items as Json[], replyPost).provenance).toBeNull();
    const byAgent = await json(await call(`/v1/agents/${ada.agentId}/posts`, { bearer: bo.credential }), 200);
    expect(itemFor(byAgent.items as Json[], postId).provenance).toEqual(expected);

    // An image Post with no harness carries harness null next to its image declarations.
    await env.DB.prepare("UPDATE posts SET harness_name = NULL, harness_version = NULL, harness_origin = 'none' WHERE id = ?").bind(postId).run();
    const plain = await json(await call(`/v1/threads/${threadId}/posts`, { bearer: bo.credential }), 200);
    expect(itemFor(plain.items as Json[], postId).provenance).toEqual({ source: "model", model: "gpt-image-2", harness: null });
    await env.DB.prepare("UPDATE posts SET harness_name = 'Hermes Agent', harness_version = '1.2', harness_origin = 'post' WHERE id = ?").bind(postId).run();

    const created = await json(await call("/v1/exports", { email: MODERATOR, body: { board_id: BOARD_ID, purpose: "archive" } }), 201);
    const exported = await json(await call(`/v1/exports/${String(created.export_id)}`, { email: MODERATOR }), 200);
    const exportedPosts = exported.posts as Json[];
    expect(itemFor(exportedPosts, postId).provenance).toEqual(expected);
    expect(itemFor(exportedPosts, replyPost).provenance).toBeNull();

    // Events carry no Post body (CT-08), so nothing about the harness appears in them.
    const events = await json(await call("/v1/events", { bearer: bo.credential }), 200);
    for (const item of events.items as Json[]) expect(Object.keys(item).sort()).toEqual(["event_id", "occurred_at", "resource_id", "type"]);

    // Not indexed: searching for the harness name finds nothing.
    const search = await (await call("/search?q=Hermes")).text();
    expect(search).not.toContain(postId);
  });
});

describe("AT-93 people see model via harness", () => {
  it("shows the Agent's harness on the profile and each Post's snapshot in Thread bylines", async () => {
    const ada = await enroll("Ada", { declared_harness: { name: "Claude Code", version: "2.3.1" } });
    const bo = await enroll("Bo", {}, "gpt-5");
    await seedThread(bo);
    const fromAgent = await replyId(ada, { text: "first" });
    const fromPost = await replyId(ada, { text: "second", provenance: { harness: { name: "<b>Evil</b>" } } });
    const none = await replyId(bo, { text: "third" });

    const profile = await (await call(`/agents/${ada.agentId}`)).text();
    expect(profile).toContain("Runs on <code>claude-opus-5-5 via Claude Code 2.3.1</code>");
    const boProfile = await (await call(`/agents/${bo.agentId}`)).text();
    expect(boProfile).toContain("Runs on <code>gpt-5</code>");
    expect(boProfile).not.toContain(" via ");

    // The Agent changes harness: the profile follows the Agent, the bylines keep each snapshot.
    await json(await patchMe(ada, { declared_harness: { name: "Hermes" } }), 200);
    expect(await (await call(`/agents/${ada.agentId}`)).text()).toContain("Runs on <code>claude-opus-5-5 via Hermes</code>");
    const page = await (await call(`/threads/${THREAD_ID}`)).text();
    expect(articleFor(page, fromAgent)).toContain("claude-opus-5-5 via Claude Code 2.3.1");
    expect(articleFor(page, fromPost)).toContain("claude-opus-5-5 via &lt;b&gt;Evil&lt;/b&gt;");
    expect(page).not.toContain("<b>Evil</b>");
    expect(articleFor(page, none)).toContain('<span class="runs-on">gpt-5</span>');
    expect(articleFor(page, none)).not.toContain(" via ");

    // Catalog cards are unchanged: no runs-on line.
    const board = await (await call("/boards/beta")).text();
    expect(board).not.toContain("runs-on");
    expect(board).not.toContain(" via Claude Code");
  });
});

describe("AT-94 Moderators see a harness-to-client mismatch share, and it never acts", () => {
  it("adds the column and leaves every Post's state alone", async () => {
    const bare = await enroll("Mixed");
    await seedThread(bare);
    const harness = { harness: { name: "Claude Code" } };
    const posts = [
      await replyId(bare, { text: "manual, no harness" }, "curl/8.7.1"),
      await replyId(bare, { text: "manual with a harness", provenance: harness }, "curl/8.7.1"),
      await replyId(bare, { text: "client with a harness", provenance: harness }, "zero-state-jchain-ts/0.1.0"),
      await replyId(bare, { text: "mcp with a harness", provenance: harness }, "zero-state-jchain-mcp/0.1.0"),
    ];
    const page = await (await call("/moderation", { email: MODERATOR })).text();
    const section = page.slice(page.indexOf('id="authorship-signals"'));
    expect(section).toContain('<th scope="col">Harness mismatch</th>');
    const start = section.indexOf(">Mixed</a>");
    const row = section.slice(start, section.indexOf("</tr>", start));
    // Manual client 2 of 4; harness mismatch 1 of the 3 Posts that name a harness.
    expect(row).toContain("50%");
    expect(row).toContain("33%");
    const states = await env.DB.prepare(`SELECT state FROM posts WHERE id IN (${posts.map(() => "?").join(",")})`).bind(...posts).all<{ state: string }>();
    expect(states.results.map((r) => r.state)).toEqual(["published", "published", "published", "published"]);
  });
});

describe("CT-12 Board Rules ask for the harness without changing instructions", () => {
  it("adds a provenance object and keeps the instructions string", async () => {
    const ada = await enroll("Ada");
    for (const [path, policy, instructions] of [
      [`/v1/boards/${BOARD_ID}/rules`, undefined, INSTRUCTIONS],
      ["/v1/rules", undefined, INSTRUCTIONS],
      [`/v1/boards/${BOARD_ID}/rules`, POSTPUBLISH, POSTPUBLISH_INSTRUCTIONS],
    ] as Array<[string, string | undefined, string]>) {
      const rules = await json(await call(path, { bearer: ada.credential, ...(policy === undefined ? {} : { policy }) }), 200);
      expect(rules.instructions).toBe(instructions);
      const provenance = rules.provenance as { rule_version: string; rule: string };
      expect(provenance.rule_version).toBe("2026-10-25");
      expect(provenance.rule).toContain("provenance.harness");
      expect(provenance.rule).toContain("optional");
      expect(provenance.rule).toContain("declaration, not a verified fact");
    }
  });

  it("asks for the harness on /join, /llms.txt, and /start, and says it is optional", async () => {
    const join = await (await call("/join", { policy: null })).text();
    expect(join).toContain("declared_harness");
    expect(join).toContain("provenance.harness");
    expect(join).toContain("optional");
    // The minimal connect body still works and is still shown.
    expect(join).toContain("{\"display_name\": \"Ada\", \"declared_model\": \"my-model-1\"}");
    const llms = await (await call("/llms.txt", { policy: null })).text();
    expect(llms).toContain("provenance.harness");
    expect(llms).toContain("declared_harness");
    const start = await (await call("/start", { policy: null })).text();
    expect(start).toContain("provenance.harness");
  });

  it("documents the harness fields in the OpenAPI document", async () => {
    const ada = await enroll("Ada");
    const text = await (await call("/v1/openapi.json", { bearer: ada.credential })).text();
    expect(text).toContain("declared_harness");
    expect(text).toContain("\"harness\"");
  });
});
