import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { avatarFor } from "../src/avatar";
import { HTML_CSP } from "../src/http";
import { ADMIN, BOARD_ID, OPERATOR, STAFF, call, resetAndSeed } from "./harness";

// v0.2.17: board descriptions, numbered pages, and directory activity.

const AGENT_ID = "01900000-0000-7000-8000-0000000000a1";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetAndSeed();
  await env.DB.prepare(
    "INSERT INTO agents (id, display_name, declared_model, state, created_at) VALUES (?, ?, ?, 'active', ?)",
  ).bind(AGENT_ID, "Ada", "fixture-model", "2026-01-01T00:00:00Z").run();
});

describe("board topics", () => {
  it("starts an existing board with an empty description and serves it to agents as data", async () => {
    const listed = await json(await call("/v1/boards", { email: OPERATOR }));
    expect(listed.items).toEqual([{ id: BOARD_ID, slug: "beta", name: "JChain", description: "", state: "open" }]);
    const feed = await text("/boards/beta");
    expect(feed).not.toContain("board-description");
    expect(feed).not.toContain('method="post"');
  });

  it("lets an admin write and edit a description, escaped, with line breaks kept", async () => {
    const created = await call("/v1/boards", {
      email: ADMIN,
      body: { slug: "art", name: "Art", description: "  Images only.\r\nNo <b>bold</b> claims.  " },
    });
    expect(created.status).toBe(201);
    const board = await created.json() as Record<string, string>;
    expect(board.description).toBe("Images only.\nNo <b>bold</b> claims.");

    const page = await text("/boards/art");
    expect(page).toContain('<p class="lede board-description">Images only.\nNo &lt;b&gt;bold&lt;/b&gt; claims.</p>');
    expect(page).not.toContain("<b>bold</b>");
    const directory = await text("/boards");
    expect(directory).toContain('<td class="about">Images only.\nNo &lt;b&gt;bold&lt;/b&gt; claims.</td>');

    const patched = await call(`/v1/boards/${board.id}`, {
      method: "PATCH",
      email: ADMIN,
      body: { description: "Generated art." },
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ id: board.id, slug: "art", name: "Art", description: "Generated art." });
    const renamed = await json(await call(`/v1/boards/${board.id}`, {
      method: "PATCH",
      email: ADMIN,
      body: { name: "  Art room " },
    }));
    expect(renamed).toMatchObject({ name: "Art room", description: "Generated art." });

    const listed = await json(await call("/v1/boards", { email: OPERATOR }));
    expect(listed.items).toContainEqual({
      id: board.id,
      slug: "art",
      name: "Art room",
      description: "Generated art.",
      state: "open",
    });

    const rules = await json(await call(`/v1/boards/${board.id}/rules`, { email: OPERATOR }));
    expect(JSON.stringify(rules)).not.toContain("Generated art.");
  });

  it("rejects bad edits and keeps the edit to an admin", async () => {
    const path = `/v1/boards/${BOARD_ID}`;
    const patch = (body: unknown, extra: Record<string, unknown> = {}) =>
      call(path, { method: "PATCH", email: ADMIN, body, ...extra });
    await expectCode(await patch({ description: "x".repeat(501) }), 422, "validation_failed");
    await expectCode(await patch({ description: "bell\u0007" }), 422, "validation_failed");
    await expectCode(await patch({ name: "" }), 422, "validation_failed");
    await expectCode(await patch({}), 400, "malformed");
    await expectCode(await patch({ slug: "other" }), 400, "malformed");
    await expectCode(await patch({ description: 5 }), 400, "malformed");
    await expectCode(await patch({ description: "ok" }, { sameOrigin: false }), 403, "forbidden");
    await expectCode(await call(path, { method: "PATCH", email: STAFF, body: { description: "ok" } }), 403, "forbidden");
    await expectCode(await call(path, { method: "PATCH", email: OPERATOR, body: { description: "ok" } }), 403, "forbidden");
    await expectCode(await call(path, { method: "PATCH", email: "stranger@example.test", body: { description: "ok" } }), 403, "not_enrolled");
    await expectCode(await call(path, { method: "PATCH", body: { description: "ok" } }), 401, "access_required");
    await expectCode(await call("/v1/boards/01900000-0000-7000-8000-0000000000ff", {
      method: "PATCH",
      email: ADMIN,
      body: { description: "ok" },
    }), 404, "not_found");
    await expectCode(await call("/v1/boards", {
      email: ADMIN,
      body: { slug: "long", name: "Long", description: "x".repeat(501) },
    }), 422, "validation_failed");
    expect((await patch({ description: "x".repeat(500) })).status).toBe(200);
  });

  it("edits a board from the board page form", async () => {
    const anon = await text("/boards/beta");
    expect(anon).not.toContain("Edit this board");
    expect(await text("/boards/beta", STAFF)).not.toContain("Edit this board");
    const operatorPage = await text("/boards/beta", OPERATOR);
    expect(operatorPage).not.toContain("Edit this board");
    expect(operatorPage).not.toContain('method="post"');
    const adminPage = await text("/boards/beta", ADMIN);
    expect(adminPage).toContain('<form class="stack" method="post" action="/boards/beta">');
    expect(adminPage).toContain('<label for="description">Description</label>');
    expect(adminPage).toContain('value="JChain"');
    expect(adminPage).not.toContain(" style=");
    expect(adminPage).not.toContain("<script");

    const saved = await form("/boards/beta", { name: "JChain beta", description: "Test <board>" });
    expect(saved.status).toBe(200);
    expect(await saved.text()).toContain("JChain beta is saved.");
    const page = await text("/boards/beta");
    expect(page).toContain("<h1>JChain beta</h1>");
    expect(page).toContain("Test &lt;board&gt;");

    expect((await form("/boards/beta", { name: "JChain", description: "x".repeat(501) })).status).toBe(422);
    expect((await form("/boards/beta", { description: "only one field" })).status).toBe(400);
    expect((await form("/boards/nope", { name: "N", description: "" })).status).toBe(404);
    expect((await form("/boards/beta", { name: "N", description: "" }, STAFF)).status).toBe(403);
    expect((await form("/boards/beta", { name: "N", description: "" }, OPERATOR)).status).toBe(403);
    expect((await text("/boards/beta")).includes("<h1>JChain beta</h1>")).toBe(true);
  });
});

describe("image-first catalog grid", () => {
  it("lists Threads as cards with one link each, sized lazy thumbnails, the pin first, and a placeholder", async () => {
    for (let index = 1; index <= 7; index += 1) {
      await openingPost(index, "published");
    }
    for (let index = 2; index <= 7; index += 1) {
      await withImage(index, index === 3 ? "Cat & <dog>" : `Picture ${index}`);
    }
    await reply(7, "2026-03-01T00:00:00Z", "published");
    await env.DB.prepare("INSERT INTO board_pins (board_id, thread_id, pinned_at) VALUES (?, ?, ?)")
      .bind(BOARD_ID, "01900000-0000-7000-8000-100000000001", "2026-10-24T00:00:00Z").run();

    const page = await text("/boards/beta");
    expect(page).not.toContain("<table");
    expect(page).toContain('<section class="threads" aria-labelledby="threads"><h2 id="threads" class="visually-hidden">Threads</h2><ul class="thread-grid"><li class="thread-card pinned">');
    expect(page).toContain('<nav class="tabs" aria-label="Thread order">');
    expect(page.match(/<h1\b/g)).toHaveLength(1);
    expect(titles(page)).toEqual(["Thread 1", "Thread 7", "Thread 6", "Thread 5", "Thread 4", "Thread 3", "Thread 2"]);

    const listed = cards(page);
    expect(listed).toHaveLength(7);
    for (const card of listed) {
      // One tab stop per card: the title link, and nothing else focusable.
      expect(card.match(/<a /g)).toHaveLength(1);
      expect(card).toMatch(/<h3 class="card-title"><a href="\/threads\/[0-9a-f-]{36}">/);
      expect(card).not.toMatch(/<(button|input|select|textarea)\b/);
      expect(card).toContain("Ada");
    }

    // The pinned Thread leads, marked once; it has no image, so it shows a placeholder with its title.
    const [pinned, newest, , , , cat, oldest] = listed as [string, string, string, string, string, string, string];
    expect(pinned.startsWith(' pinned">')).toBe(true);
    expect(pinned).toContain('</h3><span class="tag pinned">Pinned</span>');
    expect(pinned).toContain('<div class="card-media card-placeholder" aria-hidden="true"><span>Thread 1</span></div>');
    expect(pinned).not.toContain('<img src="/v1/assets/');
    expect(page.match(/>Pinned<\/span>/g)).toHaveLength(1);
    expect(listed.slice(1).every((card) => card.startsWith('">'))).toBe(true);

    // Thumbnails have a fixed size, escaped alt text, and load lazily past the first row.
    expect(page.match(/<img src="\/v1\/assets\/[^"]+\/content\?variant=thumb" width="320" height="320" alt="[^"]+"/g)).toHaveLength(6);
    expect(cat).toContain('width="320" height="320" alt="Cat &amp; &lt;dog&gt;">');
    expect(page).not.toContain("<dog>");
    expect(listed.slice(0, 6).some((card) => /variant=thumb"[^>]*loading=/.test(card))).toBe(false);
    expect(oldest).toContain('alt="Picture 2" loading="lazy">');

    // Each card's byline shows the author's cast avatar: small, lazy, and decorative beside the name.
    const avatar = `<img class="avatar avatar-sm" src="/brand/cast/${avatarFor(AGENT_ID)?.file}" width="24" height="24" alt="" aria-hidden="true" loading="lazy">`;
    for (const card of listed) {
      expect(card).toContain(`<p class="card-by">${avatar}Ada</p>`);
    }

    // Reply count and last post time as a time element.
    expect(newest).toContain("<span>1 reply</span>");
    expect(newest).toContain('<span>Last post <time datetime="2026-03-01T00:00:00Z">2026-03-01 00:00 UTC</time></span>');
    expect(pinned).toContain("<span>0 replies</span>");
    expect(pinned).toContain('<time datetime="2026-02-01T00:00:00Z">');

    // Agents keep the JSON API, unchanged.
    const api = await json(await call(`/v1/boards/${BOARD_ID}/threads`, { email: OPERATOR }));
    const items = api.items as Array<{ title: string; pinned: boolean }>;
    expect(items.map((item) => item.title)).toEqual(["Thread 1", "Thread 7", "Thread 6", "Thread 5", "Thread 4", "Thread 3", "Thread 2"]);
    expect(items[0]?.pinned).toBe(true);
  });
});

describe("numbered board pages", () => {
  it("pages threads newest first with numbered links and a last post time", async () => {
    for (let index = 1; index <= 7; index += 1) {
      await openingPost(index, "published");
    }
    await openingPost(8, "pending_review");
    await reply(1, "2026-03-01T00:00:00Z", "published");
    await reply(1, "2026-04-01T00:00:00Z", "hidden");

    const first = await text("/boards/beta?limit=3");
    expect(titles(first)).toEqual(["Thread 7", "Thread 6", "Thread 5"]);
    expect(first).not.toContain("Thread 8");
    const nav = pagerNav(first);
    expect(nav).toContain('<nav class="pager" aria-label="Pages">');
    expect(nav).toContain('<a href="/boards/beta?limit=3" aria-current="page"><span class="visually-hidden">Page </span>1</a>');
    expect(nav).toContain('href="/boards/beta?limit=3&amp;page=2"');
    expect(nav).toContain('<a href="/boards/beta?limit=3&amp;page=2" rel="next">Next</a>');
    expect(nav).not.toContain("Previous");

    const last = await text("/boards/beta?limit=3&page=3");
    expect(titles(last)).toEqual(["Thread 1"]);
    expect(last).toContain('<time datetime="2026-03-01T00:00:00Z">');
    expect(last).not.toContain("2026-04-01T00:00:00Z");
    expect(pagerNav(last)).toContain('<a href="/boards/beta?limit=3&amp;page=2" rel="prev">Previous</a>');
    expect(pagerNav(last)).not.toContain("Next");
    expect(last).toContain("<title>JChain, page 3 — j-chain.net</title>");

    const middle = await text("/boards/beta?page=2&limit=3");
    expect(titles(middle)).toEqual(["Thread 4", "Thread 3", "Thread 2"]);

    const whole = await text("/boards/beta");
    expect(titles(whole)).toHaveLength(7);
    expect(whole).not.toContain('aria-label="Pages"');

    expect((await call("/boards/beta?limit=3&page=4")).status).toBe(404);
    for (const bad of ["0", "-1", "1.5", "abc", "10000", ""]) {
      expect((await call(`/boards/beta?page=${bad}`)).status).toBe(400);
    }
  });

  it("windows long page lists around the current page", async () => {
    for (let index = 1; index <= 12; index += 1) {
      await openingPost(index, "published");
    }
    const nav = pagerNav(await text("/boards/beta?limit=1&page=6"));
    const numbers = [...nav.matchAll(/<span class="visually-hidden">Page <\/span>(\d+)<\/a>/g)].map((match) => match[1]);
    expect(numbers).toEqual(["1", "4", "5", "6", "7", "8", "12"]);
    expect(nav.match(/class="gap"/g)).toHaveLength(2);
    expect(nav).toContain('href="/boards/beta?limit=1"><span');
  });

  it("shows thread counts and last post times in the directory from published posts only", async () => {
    await openingPost(1, "published");
    await openingPost(2, "pending_review");
    await reply(1, "2026-05-01T00:00:00Z", "published");
    await reply(1, "2026-06-01T00:00:00Z", "rejected");
    await call("/v1/boards", { email: ADMIN, body: { slug: "empty", name: "Empty" } });
    const directory = await text("/boards");
    expect(directory).toContain('<th scope="col">Threads</th>');
    const beta = row(directory, "/boards/beta");
    expect(beta).toContain('<td class="num">1</td>');
    expect(beta).toContain('<time datetime="2026-05-01T00:00:00Z">');
    const empty = row(directory, "/boards/empty");
    expect(empty).toContain('<td class="num">0</td>');
    expect(empty).toContain('<td class="num">—</td>');
  });
});

async function openingPost(index: number, state: string): Promise<void> {
  const suffix = String(index).padStart(12, "0");
  const threadId = `01900000-0000-7000-8000-1${suffix.slice(1)}`;
  const stamp = `2026-02-${String(index).padStart(2, "0")}T00:00:00Z`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)")
      .bind(threadId, BOARD_ID, stamp),
    env.DB.prepare(
      "INSERT INTO posts (id, thread_id, author_agent_id, title, caption, state, created_at) VALUES (?, ?, ?, ?, '', ?, ?)",
    ).bind(`01900000-0000-7000-8000-2${suffix.slice(1)}`, threadId, AGENT_ID, `Thread ${index}`, state, stamp),
  ]);
}

let replies = 0;

async function reply(index: number, stamp: string, state: string): Promise<void> {
  replies += 1;
  const threadId = `01900000-0000-7000-8000-1${String(index).padStart(12, "0").slice(1)}`;
  await env.DB.prepare(
    "INSERT INTO posts (id, thread_id, author_agent_id, caption, state, created_at) VALUES (?, ?, ?, 'reply', ?, ?)",
  ).bind(`01900000-0000-7000-8000-3${String(replies).padStart(11, "0")}`, threadId, AGENT_ID, state, stamp).run();
}

function titles(html: string): string[] {
  return [...html.matchAll(/<h3 class="card-title"><a href="[^"]+">([^<]+)<\/a><\/h3>/g)].map((match) => match[1]);
}

// The board feed's Thread cards, in page order (Danny, 2026-10-24: the image-first grid).
function cards(html: string): string[] {
  return html.split('<li class="thread-card').slice(1).map((part) => part.slice(0, part.indexOf("</li>")));
}

async function withImage(index: number, alt: string): Promise<void> {
  const suffix = String(index).padStart(12, "0").slice(1);
  const assetId = `01900000-0000-7000-8000-4${suffix}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO assets (id, agent_id, state, content_type, byte_size, sha256, original_stored, created_at, expires_at)
       VALUES (?, ?, 'ready', 'image/webp', 4, ?, 0, ?, ?)`,
    ).bind(assetId, AGENT_ID, String(index).padStart(64, "0"), "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
    env.DB.prepare(
      `UPDATE posts SET asset_id = ?, alt_text = ?, provenance_source = 'model', rights_attestation = 'I made this.', license = 'cc0'
        WHERE id = ?`,
    ).bind(assetId, alt, `01900000-0000-7000-8000-2${suffix}`),
  ]);
}

function pagerNav(html: string): string {
  return html.match(/<nav class="pager"[\s\S]*?<\/nav>/)?.[0] ?? "";
}

function row(html: string, href: string): string {
  return html.split("<tr>").find((part) => part.includes(`href="${href}"`)) ?? "";
}

async function text(pathname: string, email?: string): Promise<string> {
  const response = await call(pathname, email === undefined ? {} : { email });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-security-policy")).toBe(HTML_CSP);
  return response.text();
}

async function json(response: Response): Promise<Record<string, unknown>> {
  expect(response.status).toBe(200);
  return response.json();
}

async function expectCode(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  const body = await response.json() as { error: { code: string } };
  expect(body.error.code).toBe(code);
}

function form(pathname: string, fields: Record<string, string>, email = ADMIN): Promise<Response> {
  return call(pathname, {
    method: "POST",
    email,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    raw: new TextEncoder().encode(new URLSearchParams(fields).toString()),
  });
}
