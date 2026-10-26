import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { avatarFor, fnv1a32 } from "../src/avatar";
import { CAST, type CastMember } from "../src/cast";
import { BOARD_ID, OPERATOR, OPERATOR_ID, call, resetAndSeed } from "./harness";

// AT-89 (Danny, 2026-10-24: "you can do all of these"): each Agent shows one homepage cast
// member as its avatar, picked by rendezvous hashing: the entry with the highest
// FNV-1a(agent id + "\n" + file) wins, ties to the smaller file name.

const ORIGIN = "https://jchain.example.test";
const ADA = "01900000-0000-7000-8000-0000000000a1";
const BEE = "01900000-0000-7000-8000-0000000000b1";
const CY = "01900000-0000-7000-8000-0000000000c1";
const BEE_NAME = `O'Neil <b>&</b> "Q"`;
const THREAD = "01900000-0000-7000-8000-100000000001";
const OPENING = "01900000-0000-7000-8000-200000000001";
const REPLY_BEE = "01900000-0000-7000-8000-200000000002";
const REPLY_CY = "01900000-0000-7000-8000-200000000003";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetAndSeed();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO agents (id, display_name, declared_model, state, operator_id, created_at) VALUES (?, ?, 'fixture-model', ?, ?, ?)",
    ).bind(ADA, "Ada", "active", OPERATOR_ID, "2026-01-01T00:00:00Z"),
    env.DB.prepare(
      "INSERT INTO agents (id, display_name, declared_model, state, operator_id, created_at) VALUES (?, ?, 'fixture-model', ?, ?, ?)",
    ).bind(BEE, BEE_NAME, "active", OPERATOR_ID, "2026-01-02T00:00:00Z"),
    env.DB.prepare(
      "INSERT INTO agents (id, display_name, declared_model, state, operator_id, created_at) VALUES (?, ?, 'fixture-model', ?, ?, ?)",
    ).bind(CY, "Cy", "retired", OPERATOR_ID, "2026-01-03T00:00:00Z"),
    env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)")
      .bind(THREAD, BOARD_ID, "2026-02-01T00:00:00Z"),
    env.DB.prepare(
      "INSERT INTO posts (id, thread_id, author_agent_id, title, caption, state, created_at) VALUES (?, ?, ?, ?, ?, 'published', ?)",
    ).bind(OPENING, THREAD, ADA, "Avatars", "opening", "2026-02-01T00:00:00Z"),
    env.DB.prepare(
      "INSERT INTO posts (id, thread_id, author_agent_id, title, caption, state, created_at) VALUES (?, ?, ?, NULL, ?, 'published', ?)",
    ).bind(REPLY_BEE, THREAD, BEE, "bee reply", "2026-02-02T00:00:00Z"),
    env.DB.prepare(
      "INSERT INTO posts (id, thread_id, author_agent_id, title, caption, state, created_at) VALUES (?, ?, ?, NULL, ?, 'published', ?)",
    ).bind(REPLY_CY, THREAD, CY, "cy reply", "2026-02-03T00:00:00Z"),
  ]);
});

function small(agentId: string): string {
  return `<img class="avatar avatar-sm" src="/brand/cast/${avatarFor(agentId)?.file}" width="24" height="24" alt="" aria-hidden="true" loading="lazy">`;
}

function medium(agentId: string, alt: string): string {
  return `<p class="profile-avatar"><img class="avatar avatar-md" src="/brand/cast/${avatarFor(agentId)?.file}" width="96" height="96" alt="${alt}"></p>`;
}

async function html(path: string, email?: string): Promise<string> {
  const response = await call(path, email === undefined ? {} : { email });
  expect(response.status, path).toBe(200);
  expect(response.headers.get("content-security-policy"), path).toContain("img-src 'self'");
  return response.text();
}

async function agentJson(path: string, options: { email?: string; bearer?: string }): Promise<Record<string, unknown>> {
  const response = await call(path, options);
  const body = await response.json() as Record<string, unknown>;
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body;
}

describe("AT-89 cast avatars", () => {
  it("picks by rendezvous hashing with 32-bit FNV-1a", () => {
    // Published FNV-1a test vectors.
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
    expect(CAST).toHaveLength(49);
    // With this cast the pick is fixed. The winner is the entry with the highest score for this id.
    const scores = CAST.map((member) => fnv1a32(`${ADA}\n${member.file}`));
    expect(CAST[scores.indexOf(Math.max(...scores))]?.file).toBe("wojak-consoomer.webp");
    expect(avatarFor(ADA)?.file).toBe("wojak-consoomer.webp");
    expect(avatarFor(BEE)?.file).toBe("wojak-wholesome.webp");
    // The pick depends on the set of files, not their order, and is the same on every call.
    expect(avatarFor(ADA, [...CAST].reverse())?.file).toBe("wojak-consoomer.webp");
    expect(avatarFor(ADA)).toBe(avatarFor(ADA));
    expect(avatarFor(ADA, [])).toBeNull();
  });

  it("moves only a small share of Agents when a cast member is added or removed", () => {
    const ids = Array.from({ length: 1000 }, (_, index) => `01900000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`);
    const before = new Map(ids.map((id) => [id, avatarFor(id, CAST)?.file]));
    expect(new Set(before.values()).size).toBe(CAST.length);

    // Append one member: at most about 1 in 10 Agents move, and every one that moves gets it.
    const added: CastMember[] = [...CAST, { ...(CAST[1] as CastMember), file: "wojak-appended-test.webp", name: "Appended" }];
    const moved = ids.filter((id) => avatarFor(id, added)?.file !== before.get(id));
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.length).toBeLessThanOrEqual(100);
    for (const id of moved) expect(avatarFor(id, added)?.file).toBe("wojak-appended-test.webp");

    // Remove one member: exactly the Agents that had it move, and nobody else.
    const gone = CAST[5] as CastMember;
    const removed = CAST.filter((member) => member.file !== gone.file);
    const holders = ids.filter((id) => before.get(id) === gone.file);
    expect(holders.length).toBeGreaterThan(0);
    for (const id of ids) {
      const after = avatarFor(id, removed)?.file;
      if (before.get(id) === gone.file) expect(after).not.toBe(gone.file);
      else expect(after).toBe(before.get(id));
    }
  });

  it("shows the same avatar for an Agent on every page and in the API", async () => {
    const chosen = "wojak-consoomer.webp";
    const profile = await html(`/agents/${ADA}`);
    expect(profile).toContain(medium(ADA, "Ada&#39;s avatar: Consoomer"));
    // Medium, above the fold, loaded eagerly; it stands alone, so its alt text names both.
    expect(profile.indexOf('class="profile-avatar"')).toBeLessThan(profile.indexOf("<h1>Ada</h1>"));

    const thread = await html(`/threads/${THREAD}`);
    const opening = thread.slice(thread.indexOf(`id="post-${OPENING}"`), thread.indexOf("</p>", thread.indexOf(`id="post-${OPENING}"`)));
    expect(opening).toContain(`${small(ADA)}<a href="/agents/${ADA}">Ada</a>`);

    const board = await html("/boards/beta");
    expect(board).toContain(`<p class="card-by">${small(ADA)}Ada</p>`);

    const operator = await html("/operator", OPERATOR);
    expect(operator).toContain(`<td class="title"><img class="avatar avatar-sm" src="/brand/cast/${chosen}" width="24" height="24" alt="" aria-hidden="true"><a href="/agents/${ADA}">Ada</a>`);

    // The same pick on a second render: nothing random.
    expect(await html(`/agents/${ADA}`)).toContain(`src="/brand/cast/${chosen}"`);

    const api = await agentJson(`/v1/agents/${ADA}`, { email: OPERATOR });
    expect(api.avatar_url).toBe(`${ORIGIN}/brand/cast/${chosen}`);

    const art = await call(`/brand/cast/${chosen}`);
    expect(art.status).toBe(200);
    expect(art.headers.get("content-type")).toContain("image/webp");
    await art.arrayBuffer();
  });

  it("returns avatar_url on agents/me, matching the pick for the caller's id", async () => {
    const enrolled = await call("/v1/agents", {
      email: OPERATOR,
      body: { display_name: "Dee", declared_model: "fixture-model" },
    });
    const body = await enrolled.json() as { agent_id: string; credential: string };
    expect(enrolled.status, JSON.stringify(body)).toBe(201);
    const expected = `${ORIGIN}/brand/cast/${avatarFor(body.agent_id)?.file}`;
    const me = await agentJson("/v1/agents/me", { bearer: body.credential });
    expect(me).toMatchObject({ agent_id: body.agent_id, display_name: "Dee", avatar_url: expected });
    expect(String(me.avatar_url).startsWith("https://")).toBe(true);
    const claimed = await call("/v1/agents/me", { method: "PATCH", bearer: body.credential, body: { handle: "dee_bot" } });
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({ handle: "dee_bot", avatar_url: expected });
    const profile = await agentJson(`/v1/agents/${body.agent_id}`, { email: OPERATOR });
    expect(profile.avatar_url).toBe(expected);
  });

  it("gives two different Agents different avatars, and escapes the alt text", async () => {
    expect(avatarFor(ADA)?.file).not.toBe(avatarFor(BEE)?.file);
    const thread = await html(`/threads/${THREAD}`);
    expect(thread).toContain(small(ADA));
    expect(thread).toContain(small(BEE));
    const bee = await html(`/agents/${BEE}`);
    expect(bee).toContain(medium(BEE, "O&#39;Neil &lt;b&gt;&amp;&lt;/b&gt; &quot;Q&quot;&#39;s avatar: Wholesome"));
    expect(bee).not.toContain(BEE_NAME);
    expect(bee).not.toContain("wojak-consoomer.webp");
  });

  it("keeps the avatar for suspended and retired Agents", async () => {
    await env.DB.prepare("UPDATE agents SET state = 'suspended', suspended_by = 'moderator' WHERE id = ?").bind(BEE).run();
    const suspended = await html(`/agents/${BEE}`);
    expect(suspended).toContain(medium(BEE, "O&#39;Neil &lt;b&gt;&amp;&lt;/b&gt; &quot;Q&quot;&#39;s avatar: Wholesome"));
    // A retired Agent has no profile page, as before; its Posts and its Operator's list keep the avatar.
    const retired = await call(`/agents/${CY}`);
    expect(retired.status).toBe(404);
    await retired.text();
    const thread = await html(`/threads/${THREAD}`);
    expect(thread).toContain(`${small(CY)}<a href="/agents/${CY}">Cy</a>`);
    const operator = await html("/operator", OPERATOR);
    expect(operator).toContain(`<td class="title"><img class="avatar avatar-sm" src="/brand/cast/${avatarFor(CY)?.file}" width="24" height="24" alt="" aria-hidden="true">Cy</td>`);
  });

  it("links the v10 stylesheet with the avatar frame on every page that shows an avatar", async () => {
    for (const path of [`/agents/${ADA}`, `/threads/${THREAD}`, "/boards/beta"]) {
      const page = await html(path);
      expect(page, path).toContain('<link rel="stylesheet" href="/brand/board-v10.css">');
      expect(page, path).not.toContain("board-v8.css");
    }
    const css = await call("/brand/board-v10.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("cache-control")).toContain("max-age=31536000");
    const text = await css.text();
    expect(text).toContain(".avatar {");
    expect(text).toContain("object-fit: cover;");
    expect(text).toContain("border: 1px solid var(--color-muted);");
    expect(text).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
