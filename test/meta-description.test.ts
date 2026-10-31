import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeCursor } from "../src/browse";
import { boardTitle, DESCRIPTIONS, escapeHtml, metaDescription, profileTitle, SITE_TAGLINE, threadTitle } from "../src/html";
import { uuidv7 } from "../src/ids";
import { BOARD_ID, call, resetAndSeed } from "./harness";

// Page-head descriptions: one meta description and a matching og:description per indexable page.

const ELLIPSIS = "\u2026";
const DOT = "\u00b7";
const ADA = "01900000-0000-7000-8000-0000000000d1";
const BOB = "01900000-0000-7000-8000-0000000000d2";
const THREAD_TAIL = "A meme thread on /beta/ at J-Chain, the imageboard where AI agents post memes.";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetAndSeed();
  await env.DB.prepare(
    `INSERT INTO agents (id, display_name, declared_model, state, created_at, handle, harness_name, harness_version)
     VALUES (?, ?, ?, 'active', ?, 'ada', 'Claude Code', '2.1')`,
  ).bind(ADA, "Ada", "claude-sonnet", "2026-01-01T00:00:00Z").run();
});

function descriptions(html: string): string {
  const meta = [...html.matchAll(/<meta name="description" content="([^"]*)">/g)].map((match) => match[1] ?? "");
  const og = [...html.matchAll(/<meta property="og:description" content="([^"]*)">/g)].map((match) => match[1] ?? "");
  expect(meta).toHaveLength(1);
  expect(og).toHaveLength(1);
  expect(meta[0]).toBe(og[0]);
  return meta[0] ?? "";
}

function plain(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'");
}

async function htmlPage(pathname: string, status = 200): Promise<string> {
  const response = await call(pathname);
  expect(response.status).toBe(status);
  return response.text();
}

describe("thread descriptions", () => {
  it("uses the caption, escaped once, for the meta description and og:description", async () => {
    const caption = "Retry #3 & <still> failing";
    const threadId = await thread({ title: "Retry", caption });
    const html = await htmlPage(`/threads/${threadId}`);
    const expected = `${caption} ${DOT} ${THREAD_TAIL}`;
    expect(descriptions(html)).toBe(escapeHtml(expected));
    expect(html).not.toContain("<still>");
    expect(html).not.toContain("&amp;amp;");
  });

  it("falls back to alt text, then the title, and escapes an injected tag", async () => {
    const altId = await thread({ title: "Ignored", caption: "", alt: "A cat" });
    const altHtml = await htmlPage(`/threads/${altId}`);
    expect(plain(descriptions(altHtml)).startsWith(`A cat ${DOT} `)).toBe(true);

    const title = "Plain & <title>";
    const titleId = await thread({ title, caption: "", alt: "  \n" });
    const titleHtml = await htmlPage(`/threads/${titleId}`);
    expect(plain(descriptions(titleHtml)).startsWith(`${title} ${DOT} `)).toBe(true);

    const injected = "Say \"hi\" & 'bye' <ok> \"><script>alert(1)</script>";
    const injectedId = await thread({ title: "Injected", caption: injected });
    const injectedHtml = await htmlPage(`/threads/${injectedId}`);
    expect(descriptions(injectedHtml)).toBe(escapeHtml(`${injected} ${DOT} ${THREAD_TAIL}`));
    expect(injectedHtml).not.toContain("<script");
    expect(injectedHtml).not.toContain("\"><script");
  });

  it("cuts a 400-character caption to 155 code points and does not escape twice", async () => {
    const caption = `&${"x".repeat(399)}`;
    const threadId = await thread({ title: "Long", caption });
    const html = await htmlPage(`/threads/${threadId}`);
    expect(html).not.toContain("&amp;amp;");
    const text = plain(descriptions(html));
    expect(Array.from(text).length).toBeLessThanOrEqual(155);
    expect(text.startsWith("&xxx")).toBe(true);
    expect(text).toContain("at J-Chain, the imageboard where AI agents post memes.");
    expect(text).not.toContain("x".repeat(80));
  });

  it("uses the later-page template when a cursor is set", async () => {
    const threadId = await thread({ title: "Hello thread", caption: "UNIQUE_CAPTION_TOKEN" });
    const cursor = encodeCursor("2020-01-01T00:00:00Z", "01900000-0000-7000-8000-0000000000aa");
    const html = await htmlPage(`/threads/${threadId}?cursor=${cursor}`);
    const text = plain(descriptions(html));
    expect(text.startsWith("More replies to \"Hello thread\" on /beta/")).toBe(true);
    expect(text).not.toContain("UNIQUE_CAPTION_TOKEN");
  });

  it("does not build a description for a quarantined opening post", async () => {
    const threadId = await thread({ title: "Hidden", caption: "should-not-leak", state: "quarantined" });
    const response = await call(`/threads/${threadId}`);
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain(`<meta property="og:description" content="${SITE_TAGLINE}">`);
    expect(html).not.toContain("should-not-leak");
    expect(html).not.toContain('<meta name="description"');
  });
});

describe("board, profile, and static descriptions", () => {
  it("describes a board from its description, its name, and the page suffix", async () => {
    const empty = await htmlPage("/boards/beta");
    expect(descriptions(empty)).toBe(
      "Image memes posted by AI agents on /beta/ (JChain) at J-Chain, the imageboard for AI agents.",
    );

    await env.DB.prepare("UPDATE boards SET description = ? WHERE slug = 'beta'")
      .bind("Meme lab.\nSecond line & <tags>.")
      .run();
    const filled = await htmlPage("/boards/beta");
    const filledText = plain(descriptions(filled));
    expect(filledText).toContain("Meme lab. Second line & <tags>.");
    expect(filledText).toContain("/beta/");
    expect(filled).not.toContain("&amp;amp;");
    expect(filled).not.toContain("<tags>");

    await fillBoard(26);
    const paged = await htmlPage("/boards/beta?page=2");
    expect(plain(descriptions(paged)).endsWith(" Page 2.")).toBe(true);

    await env.DB.prepare("UPDATE boards SET description = ? WHERE slug = 'beta'")
      .bind("word ".repeat(100))
      .run();
    const long = await htmlPage("/boards/beta?page=2");
    expect(long).not.toContain("&amp;amp;");
    const longText = plain(descriptions(long));
    expect(longText.endsWith(" Page 2.")).toBe(true);
    const body = longText.slice(0, -" Page 2.".length);
    expect(Array.from(body).length).toBeLessThanOrEqual(155);
    expect(body.endsWith(ELLIPSIS)).toBe(true);
  });

  it("describes a profile from the agent and the visible post count", async () => {
    const threadId = await thread({ title: "One", caption: "visible" });
    await reply(threadId, "also visible", "published");
    await reply(threadId, "not counted", "hidden");
    const html = await htmlPage(`/agents/${ADA}`);
    const text = plain(descriptions(html));
    expect(html).toContain("<title>Ada (@ada) | J-Chain</title>");
    expect(text).toContain("Ada is an AI agent on J-Chain.");
    expect(text).not.toContain("(@ada)");
    expect(text).toContain("says it runs on claude-sonnet via Claude Code 2.1");
    expect(text).toContain("2 published posts.");
    expect(text).not.toContain("3 published");

    await env.DB.prepare(
      "INSERT INTO agents (id, display_name, declared_model, state, created_at) VALUES (?, ?, ?, 'active', ?)",
    ).bind(BOB, "Bob \"><script>", "declared-model", "2026-01-02T00:00:00Z").run();
    const empty = await htmlPage(`/agents/${BOB}`);
    const emptyText = plain(descriptions(empty));
    expect(emptyText).toContain("Bob \"><script>");
    expect(empty).toContain("<title>Bob &quot;&gt;&lt;script&gt; | J-Chain</title>");
    expect(emptyText).toContain("says it runs on declared-model.");
    expect(emptyText).toContain("No published posts yet.");
    expect(emptyText).not.toContain(" via ");
    expect(emptyText).not.toContain("(@");
    expect(emptyText).not.toContain("0 published");
    expect(empty).not.toContain("<script");
    await env.DB.prepare("UPDATE agents SET declared_model = '' WHERE id = ?").bind(BOB).run();
    const undeclared = plain(descriptions(await htmlPage(`/agents/${BOB}`)));
    expect(undeclared).toContain("It hasn't declared a model.");
    expect(undeclared).not.toContain("says it runs on");
  });

  it("gives each static page its own description, distinct from the tagline", async () => {
    const pages: Array<[string, string]> = [
      ["/boards", "Every board on J-Chain"],
      ["/trending", "ranked by agent votes and age"],
      ["/start", "How J-Chain works for readers, Operators and agents"],
      ["/start/agents/grokbot", "Set up Grok bot to post on J-Chain"],
      ["/rules", "what is not allowed"],
      ["/terms", "J-Chain Terms of service (draft pending counsel review)."],
      ["/privacy", "J-Chain Privacy policy (draft pending counsel review)."],
      ["/acceptable-use", "J-Chain Acceptable use policy (draft pending counsel review)."],
    ];
    const seen = new Set<string>();
    for (const [path, fragment] of pages) {
      const text = plain(descriptions(await htmlPage(path)));
      expect(text).toContain(fragment);
      expect(text).not.toBe(SITE_TAGLINE);
      expect(seen.has(text)).toBe(false);
      seen.add(text);
    }
  });
});

describe("regressions", () => {
  it("keeps the search description and noindex, and the not-found tagline", async () => {
    const search = await call("/search");
    expect(search.status).toBe(200);
    const searchHtml = await search.text();
    expect(descriptions(searchHtml)).toBe("Search published Posts on j-chain.net.");
    expect(searchHtml).toContain('<meta name="robots" content="noindex">');
    expect(search.headers.get("x-robots-tag")).toBe("noindex");

    const missing = await call("/no-such-meta-page", { headers: { accept: "text/html" } });
    expect(missing.status).toBe(404);
    const missingHtml = await missing.text();
    expect(missingHtml).toContain(`<meta property="og:description" content="${SITE_TAGLINE}">`);
    expect(missingHtml).not.toContain('<meta name="description"');
  });
});

describe("titles", () => {
  it("keeps a short thread title and cuts a long one to 60 code points", () => {
    expect(threadTitle("Hello")).toBe("Hello | J-Chain");
    const cut = threadTitle("a".repeat(80));
    expect(cut).toBe(`${"a".repeat(49)}${ELLIPSIS} | J-Chain`);
    expect(Array.from(cut).length).toBe(60);
  });

  it("falls back when a board title would pass 60 code points", () => {
    expect(boardTitle("JChain", "beta")).toBe("JChain: AI agent memes on /beta/ | J-Chain");
    expect(boardTitle("JChain", "beta", 3)).toBe("JChain, page 3: AI agent memes on /beta/ | J-Chain");
    const named = "N".repeat(40);
    expect(boardTitle(named, "beta")).toBe(`${named} | J-Chain`);
    expect(boardTitle(named, "beta", 2)).toBe(`${named}, page 2 | J-Chain`);
    expect(boardTitle("N".repeat(55), "beta", 2)).toBe("/beta/, page 2 | J-Chain");
  });

  it("keeps the J-Chain clause when a thread snippet is long", () => {
    const text = DESCRIPTIONS.thread("x".repeat(400), "a".repeat(20));
    expect(text).toContain("at J-Chain");
    expect(Array.from(text).length).toBeLessThanOrEqual(155);
  });

  it("drops the handle when the profile title would pass 60 code points", () => {
    expect(profileTitle("Ada", "ada")).toBe("Ada (@ada) | J-Chain");
    expect(profileTitle("Ada", null)).toBe("Ada | J-Chain");
    const name = "N".repeat(50);
    expect(profileTitle(name, "ada")).toBe(`${name} | J-Chain`);
  });
});

describe("metaDescription", () => {
  it("collapses whitespace and newlines and drops other control characters", () => {
    expect(metaDescription("  hello\r\n\nworld\tthere  ")).toBe("hello world there");
    expect(metaDescription("a\u0000b\u0007c\u001fd")).toBe("abcd");
    expect(metaDescription("a & b")).toBe("a & b");
  });

  it("keeps 155 code points and cuts 156 without splitting an emoji", () => {
    expect(metaDescription("a".repeat(155))).toBe("a".repeat(155));
    expect(metaDescription("a".repeat(156))).toBe(`${"a".repeat(154)}${ELLIPSIS}`);
    expect(Array.from(metaDescription("a".repeat(156))).length).toBe(155);

    const emoji = "\u{1F600}";
    const atCut = `${"a".repeat(153)}${emoji}bc`;
    expect(metaDescription(atCut)).toBe(`${"a".repeat(153)}${emoji}${ELLIPSIS}`);
    const pastCut = `${"a".repeat(154)}${emoji}b`;
    const cut = metaDescription(pastCut);
    expect(cut).toBe(`${"a".repeat(154)}${ELLIPSIS}`);
    expect(cut.includes("\uD83D")).toBe(false);
    expect(hasLoneSurrogate(cut)).toBe(false);
    expect(hasLoneSurrogate(metaDescription(atCut))).toBe(false);
  });

  it("backs off to a space in the last 25 code points and trims trailing punctuation", () => {
    const spaced = Array.from({ length: 200 }, () => "b");
    spaced[140] = " ";
    expect(metaDescription(spaced.join(""))).toBe(`${"b".repeat(140)}${ELLIPSIS}`);

    const punctuated = Array.from({ length: 200 }, () => "c");
    punctuated[138] = ".";
    punctuated[139] = ",";
    punctuated[140] = " ";
    expect(metaDescription(punctuated.join(""))).toBe(`${"c".repeat(138)}${ELLIPSIS}`);
  });
});

async function thread(options: {
  title: string;
  caption: string;
  alt?: string | null;
  state?: string;
  stamp?: string;
  author?: string;
}): Promise<string> {
  const threadId = uuidv7();
  const postId = uuidv7();
  const stamp = options.stamp ?? "2026-02-01T00:00:00Z";
  await env.DB.batch([
    env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)")
      .bind(threadId, BOARD_ID, stamp),
    env.DB.prepare(
      `INSERT INTO posts (id, thread_id, author_agent_id, title, caption, alt_text, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(postId, threadId, options.author ?? ADA, options.title, options.caption, options.alt ?? null, options.state ?? "published", stamp),
  ]);
  return threadId;
}

async function reply(threadId: string, caption: string, state: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO posts (id, thread_id, author_agent_id, title, caption, state, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)",
  ).bind(uuidv7(), threadId, ADA, caption, state, "2026-02-02T00:00:00Z").run();
}

async function fillBoard(count: number): Promise<void> {
  const statements = [];
  for (let index = 0; index < count; index += 1) {
    const threadId = uuidv7();
    const postId = uuidv7();
    const stamp = `2026-03-${String((index % 28) + 1).padStart(2, "0")}T00:00:${String(index).padStart(2, "0")}Z`;
    statements.push(
      env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)")
        .bind(threadId, BOARD_ID, stamp),
      env.DB.prepare(
        "INSERT INTO posts (id, thread_id, author_agent_id, title, caption, state, created_at) VALUES (?, ?, ?, ?, '', 'published', ?)",
      ).bind(postId, threadId, ADA, `Thread ${index}`, stamp),
    );
  }
  await env.DB.batch(statements);
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) return true;
  }
  return false;
}
