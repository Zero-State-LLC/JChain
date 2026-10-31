import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalUrl, OG_IMAGE_PATH, withSocialUrls } from "../src/html";
import { uuidv7 } from "../src/ids";
import { BOARD_ID, call, resetAndSeed } from "./harness";

// Canonical links: one clean absolute URL per indexable page, matching og:url.

const ORIGIN = "https://jchain.example.test";
const ADA = "01900000-0000-7000-8000-0000000000d1";
const IMAGE = `<meta property="og:image" content="${OG_IMAGE_PATH}">`;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetAndSeed();
  await env.DB.prepare(
    "INSERT INTO agents (id, display_name, declared_model, state, created_at) VALUES (?, ?, ?, 'active', ?)",
  ).bind(ADA, "Ada", "fixture-model", "2026-01-01T00:00:00Z").run();
});

function expectCanonical(html: string, href: string): void {
  const links = [...html.matchAll(/<link rel="canonical" href="([^"]*)">/g)].map((match) => match[1]);
  const urls = [...html.matchAll(/<meta property="og:url" content="([^"]*)">/g)].map((match) => match[1]);
  expect(links).toHaveLength(1);
  expect(urls).toHaveLength(1);
  expect(links[0]).toBe(urls[0]);
  expect(links[0]).toBe(href.replaceAll("&", "&amp;"));
}

async function htmlPage(pathname: string, status = 200): Promise<string> {
  const response = await call(pathname);
  expect(response.status).toBe(status);
  return response.text();
}

describe("canonical links", () => {
  it("points the homepage at itself and uses the policy origin, not the request host", async () => {
    expectCanonical(await htmlPage("/?utm_source=x"), `${ORIGIN}/`);

    const raw = env.POLICY;
    if (typeof raw !== "string") throw new Error("policy missing");
    const policy = JSON.parse(raw) as { site_origin: string };
    policy.site_origin = "https://j-chain.net";
    const response = await call("/?utm_source=x", { policy: JSON.stringify(policy) });
    expect(response.status).toBe(200);
    expectCanonical(await response.text(), "https://j-chain.net/");
  });

  it("drops tracking params and keeps page, sort, and window when they change the page", async () => {
    await fillBoard(26);
    const threadId = await thread();
    expectCanonical(await htmlPage("/boards/beta?utm_source=x&utm_medium=y&fbclid=z"), `${ORIGIN}/boards/beta`);
    expectCanonical(await htmlPage(`/threads/${threadId}?ref=x`), `${ORIGIN}/threads/${threadId}`);
    expectCanonical(await htmlPage("/boards/beta?page=2"), `${ORIGIN}/boards/beta?page=2`);
    expectCanonical(await htmlPage("/boards/beta?page=1"), `${ORIGIN}/boards/beta`);
    const active = `${ORIGIN}/boards/beta?sort=active&amp;page=2`;
    expectCanonical(await htmlPage("/boards/beta?page=2&sort=active"), active.replaceAll("&amp;", "&"));
    expectCanonical(await htmlPage("/boards/beta?sort=active&page=2"), active.replaceAll("&amp;", "&"));
    expectCanonical(await htmlPage("/boards/beta?sort=new"), `${ORIGIN}/boards/beta`);
    expectCanonical(await htmlPage("/boards/beta?limit=10&page=2"), `${ORIGIN}/boards/beta`);
    expectCanonical(await htmlPage("/leaderboard?window=30d"), `${ORIGIN}/leaderboard?window=30d`);
    expectCanonical(await htmlPage("/leaderboard?window=7d"), `${ORIGIN}/leaderboard`);
    expectCanonical(await htmlPage("/start/agents/grokbot?name=Foo"), `${ORIGIN}/start/agents/grokbot`);

    await env.DB.prepare("UPDATE boards SET state = 'archived' WHERE slug = 'beta'").run();
    expectCanonical(await htmlPage("/boards/beta"), `${ORIGIN}/boards/beta`);
  });

  it("omits a canonical on search and on a not-found page", async () => {
    const search = await call("/search?q=cat");
    expect(search.status).toBe(200);
    const searchHtml = await search.text();
    expect(searchHtml).toContain('<meta name="robots" content="noindex">');
    expect(searchHtml).not.toContain('rel="canonical"');
    expect(search.headers.get("x-robots-tag")).toBe("noindex");

    const missing = await call("/no-such-canonical-page", { headers: { accept: "text/html" } });
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain('rel="canonical"');

    const malformed = await call("/boards/beta?page=02");
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).not.toContain('rel="canonical"');
  });
});

describe("canonicalUrl", () => {
  const id = "01900000-0000-7000-8000-0000000000aa";

  it("keeps only the allowlisted params, in a fixed order", () => {
    const cases: Array<[string, string, string | null]> = [
      ["/", "?utm_source=x", `${ORIGIN}/`],
      ["/boards", "?page=2", `${ORIGIN}/boards`],
      ["/start", "?x=1", `${ORIGIN}/start`],
      ["/rules", "?x=1", `${ORIGIN}/rules`],
      ["/terms", "", `${ORIGIN}/terms`],
      ["/privacy", "?x=1", `${ORIGIN}/privacy`],
      ["/acceptable-use", "?x=1", `${ORIGIN}/acceptable-use`],
      ["/boards/beta", "?utm_source=x&fbclid=z", `${ORIGIN}/boards/beta`],
      ["/boards/beta", "?page=2", `${ORIGIN}/boards/beta?page=2`],
      ["/boards/beta", "?page=1", `${ORIGIN}/boards/beta`],
      ["/boards/beta", "?page=2&sort=active", `${ORIGIN}/boards/beta?sort=active&page=2`],
      ["/boards/beta", "?sort=active&page=2", `${ORIGIN}/boards/beta?sort=active&page=2`],
      ["/boards/beta", "?sort=new", `${ORIGIN}/boards/beta`],
      ["/boards/beta", "?limit=10&page=2", `${ORIGIN}/boards/beta`],
      ["/boards/beta", "?limit=25&page=2", `${ORIGIN}/boards/beta?page=2`],
      ["/boards/beta", "?page=02", `${ORIGIN}/boards/beta`],
      ["/boards/beta", "?sort=active&limit=10&page=3", `${ORIGIN}/boards/beta?sort=active`],
      ["/trending", "?page=2", `${ORIGIN}/trending?page=2`],
      ["/trending", "?limit=10&page=3", `${ORIGIN}/trending`],
      ["/leaderboard", "?window=30d", `${ORIGIN}/leaderboard?window=30d`],
      ["/leaderboard", "?window=all&ref=x", `${ORIGIN}/leaderboard?window=all`],
      ["/leaderboard", "?window=7d", `${ORIGIN}/leaderboard`],
      [`/threads/${id}`, "?ref=x", `${ORIGIN}/threads/${id}`],
      [`/threads/${id}`, "?cursor=abc&limit=25", `${ORIGIN}/threads/${id}?cursor=abc`],
      [`/threads/${id}`, "?cursor=abc&limit=10", `${ORIGIN}/threads/${id}`],
      ["/threads/not-a-uuid", "", null],
      [`/agents/${id}`, "?cursor=abc", `${ORIGIN}/agents/${id}?cursor=abc`],
      ["/agents/ada", "", null],
      ["/start/agents/grokbot", "?name=Foo", `${ORIGIN}/start/agents/grokbot`],
      ["/start/agents/grokbot.md", "", null],
      ["/start/agents/nope", "", null],
      ["/search", "?q=cat", null],
      ["/moderation", "", null],
      ["/reports", "", null],
      ["/operator", "", null],
      ["/signin", "", null],
      ["/admin", "", null],
    ];
    for (const [path, search, expected] of cases) {
      expect(canonicalUrl(ORIGIN, path, search)).toBe(expected);
    }
    expect(canonicalUrl(`${ORIGIN}/`, "/", "?utm=1")).toBe(`${ORIGIN}/`);
  });

  it("escapes an ampersand in the canonical href", () => {
    const html = withSocialUrls(IMAGE, ORIGIN, "/boards/beta", "?page=2&sort=active", 200);
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/boards/beta?sort=active&amp;page=2">`);
    expect(html).toContain(`<meta property="og:url" content="${ORIGIN}/boards/beta?sort=active&amp;page=2">`);
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
    expect(html.match(/property="og:image"/g)).toHaveLength(1);

    const hidden = withSocialUrls(`<meta name="robots" content="noindex">${IMAGE}`, ORIGIN, "/search", "?q=cat", 200);
    expect(hidden).not.toContain("canonical");
    expect(hidden).toContain(`<meta property="og:url" content="${ORIGIN}/search">`);

    const missing = withSocialUrls(IMAGE, ORIGIN, "/missing", "", 404);
    expect(missing).not.toContain("canonical");
    expect(missing).toContain(`<meta property="og:url" content="${ORIGIN}/missing">`);
  });
});

async function thread(): Promise<string> {
  const threadId = uuidv7();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)")
      .bind(threadId, BOARD_ID, "2026-02-01T00:00:00Z"),
    env.DB.prepare(
      "INSERT INTO posts (id, thread_id, author_agent_id, title, caption, state, created_at) VALUES (?, ?, ?, ?, '', 'published', ?)",
    ).bind(uuidv7(), threadId, ADA, "Hello", "2026-02-01T00:00:00Z"),
  ]);
  return threadId;
}

async function fillBoard(count: number): Promise<void> {
  const statements = [];
  for (let index = 0; index < count; index += 1) {
    const threadId = uuidv7();
    const stamp = `2026-03-${String((index % 28) + 1).padStart(2, "0")}T00:00:${String(index).padStart(2, "0")}Z`;
    statements.push(
      env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)")
        .bind(threadId, BOARD_ID, stamp),
      env.DB.prepare(
        "INSERT INTO posts (id, thread_id, author_agent_id, title, caption, state, created_at) VALUES (?, ?, ?, ?, '', 'published', ?)",
      ).bind(uuidv7(), threadId, ADA, `Thread ${index}`, stamp),
    );
  }
  await env.DB.batch(statements);
}
