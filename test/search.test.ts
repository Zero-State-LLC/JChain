import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/credential";
import { utcSeconds, uuidv7 } from "../src/ids";
import { chargeHour, clearNamedQuota } from "../src/quota";
import { runRetention } from "../src/retention";
import {
  SEARCH_PER_ADDRESS_HOUR,
  foldTerm,
  highlight,
  searchTerms,
} from "../src/search";
import { BOARD_ID, MODERATOR, OPERATOR, UUID_V7, call, resetAndSeed } from "./harness";

// Header search over published Posts (Danny, 2026-10-24: "build all"). AT-83 to AT-87.

const AGENT_ID = "01900000-0000-7000-8000-0000000000b1";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetAndSeed();
  await clearSearchQuota();
  await env.DB.prepare(
    "INSERT INTO agents (id, display_name, declared_model, state, created_at, handle) VALUES (?, ?, ?, 'active', ?, 'ada')",
  ).bind(AGENT_ID, "Ada", "fixture-model", "2026-01-01T00:00:00Z").run();
});

describe("AT-83 search finds published Posts by title, caption, and alt text", () => {
  it("matches each text field and links to the Post on its Thread", async () => {
    const titled = await thread({ title: "Wandering Okapi", caption: "", stamp: "2026-02-01T00:00:00Z" });
    const captioned = await thread({ title: "Plain", caption: "a saffron glacier at dusk", stamp: "2026-02-02T00:00:00Z" });
    const described = await thread({
      title: "Picture",
      caption: "",
      alt: "a cobalt heron on one leg",
      withAsset: true,
      stamp: "2026-02-03T00:00:00Z",
    });

    const byTitle = await search("okapi");
    expect(results(byTitle)).toEqual(["Wandering Okapi"]);
    expect(byTitle).toContain(`href="/threads/${titled.threadId}#post-${titled.postId}"`);
    expect(byTitle).toContain("Wandering <mark>Okapi</mark>");
    expect(byTitle).toContain('<a href="/boards/beta">/beta/</a>');
    expect(byTitle).toContain('Ada <span class="handle">@ada</span>');
    expect(byTitle).toContain('<time datetime="2026-02-01T00:00:00Z">');

    const byCaption = await search("saffron");
    expect(results(byCaption)).toEqual(["Plain"]);
    expect(byCaption).toContain("a <mark>saffron</mark> glacier at dusk");
    expect(byCaption).toContain(`#post-${captioned.postId}`);

    const byAlt = await search("Heron");
    expect(results(byAlt)).toEqual(["Picture"]);
    expect(byAlt).toContain(`<img class="search-thumb" src="/v1/assets/${described.assetId}/content?variant=thumb" alt="a cobalt heron on one leg">`);

    // Every term is required, in any field, and ASCII case does not matter. A term matches
    // inside a word.
    expect(results(await search("SAFFRON dusk"))).toEqual(["Plain"]);
    expect(results(await search("saffron okapi"))).toEqual([]);
    expect(results(await search("okapi heron"))).toEqual([]);
    expect(results(await search("glac"))).toEqual(["Plain"]);
    await thread({ title: "Café crème", caption: "", stamp: "2026-02-04T00:00:00Z" });
    expect(results(await search("café"))).toEqual(["Café crème"]);

    // The thread page carries the anchor.
    const threadPage = await (await call(`/threads/${titled.threadId}`)).text();
    expect(threadPage).toContain(`id="post-${titled.postId}"`);
  });

  it("names a Reply by its Thread and lands on the page that holds it", async () => {
    const opening = await thread({ title: "Long thread", caption: "", stamp: "2026-02-01T00:00:00Z" });
    const replies: string[] = [];
    for (let index = 1; index <= 30; index += 1) {
      const minute = String(index).padStart(2, "0");
      replies.push(await reply(opening.threadId, `reply number ${index}${index === 2 ? " zeppelin" : ""}${index === 28 ? " walrus" : ""}`, `2026-02-01T00:${minute}:00Z`));
    }
    const early = await search("zeppelin");
    expect(results(early)).toEqual(["Reply in Long thread"]);
    expect(early).toContain(`href="/threads/${opening.threadId}#post-${replies[1]}"`);

    const late = await search("walrus");
    expect(results(late)).toEqual(["Reply in Long thread"]);
    const href = (late.match(/<h2><a href="([^"]+)">Reply in Long thread<\/a><\/h2>/)?.[1] ?? "").replaceAll("&amp;", "&");
    expect(href).toMatch(new RegExp(`^/threads/${opening.threadId}\\?cursor=[A-Za-z0-9_-]+#post-${replies[27]}$`));
    const landed = await call(href.split("#")[0] ?? "");
    expect(landed.status).toBe(200);
    const landedHtml = await landed.text();
    expect(landedHtml).toContain(`id="post-${replies[27]}"`);
    expect(landedHtml.indexOf(`id="post-${replies[27]}"`)).toBeLessThan(landedHtml.indexOf("reply number 29"));
  });
});

describe("AT-84 search lists only what every anonymous reader may see", () => {
  it("leaves out every Post the Visibility Projection hides", async () => {
    await thread({ title: "Visible lynx", caption: "", stamp: "2026-02-01T00:00:00Z" });
    for (const state of ["quarantined", "hidden", "removed", "removal_pending", "pending_review", "rejected", "flagged"]) {
      await thread({ title: `Lynx ${state}`, caption: "", state, stamp: "2026-02-02T00:00:00Z" });
    }
    // A published Reply under a hidden, and under a quarantined, Opening Post.
    const hiddenOpening = await thread({ title: "Hidden opener", caption: "", state: "hidden", stamp: "2026-02-03T00:00:00Z" });
    await reply(hiddenOpening.threadId, "lynx under a hidden opener", "2026-02-03T01:00:00Z");
    const quarantinedOpening = await thread({ title: "Quarantined opener", caption: "", state: "quarantined", stamp: "2026-02-04T00:00:00Z" });
    await reply(quarantinedOpening.threadId, "lynx under a quarantined opener", "2026-02-04T01:00:00Z");
    // A Reply in any state but published, under a visible Opening Post.
    const visible = await thread({ title: "Open thread", caption: "", stamp: "2026-02-05T00:00:00Z" });
    await reply(visible.threadId, "quarantined lynx reply", "2026-02-05T01:00:00Z", "quarantined");
    await reply(visible.threadId, "hidden lynx reply", "2026-02-05T02:00:00Z", "hidden");

    const page = await search("lynx");
    expect(results(page)).toEqual(["Visible lynx"]);
    expect(page).not.toContain("hidden opener");
    expect(page).not.toContain("quarantined opener");

    // Once quarantined, the Post leaves the results; once cleared, it comes back.
    const row = await env.DB.prepare("SELECT id FROM posts WHERE title = 'Visible lynx'").first<{ id: string }>();
    await env.DB.prepare("UPDATE posts SET state = 'quarantined' WHERE id = ?").bind(row?.id).run();
    expect(results(await search("lynx"))).toEqual([]);
    await env.DB.prepare("UPDATE posts SET state = 'published' WHERE id = ?").bind(row?.id).run();
    expect(results(await search("lynx"))).toEqual(["Visible lynx"]);
  });

  it("leaves out an Agent's Posts from the moment its owner deletion is requested", async () => {
    await thread({ title: "Marked ibex", caption: "", stamp: "2026-02-01T00:00:00Z" });
    expect(results(await search("ibex"))).toEqual(["Marked ibex"]);
    await env.DB.prepare("UPDATE agents SET deletion_requested_at = ? WHERE id = ?").bind(utcSeconds(), AGENT_ID).run();
    expect(results(await search("ibex"))).toEqual([]);
  });

  it("keeps the database exportable: no migration creates a virtual table", () => {
    const migrations = env.TEST_MIGRATIONS;
    expect(migrations.length).toBeGreaterThan(0);
    for (const migration of migrations) {
      const sql = migration.queries.join("\n");
      expect(
        /CREATE\s+VIRTUAL\s+TABLE/i.test(sql),
        `${migration.name} creates a virtual table. D1 cannot export a database that holds one (developers.cloudflare.com/d1/best-practices/import-export-data), and the restore rehearsal (#81, NFR-04) depends on export. Put a full-text index in a separate D1 database instead.`,
      ).toBe(false);
    }
  });
});

describe("AT-85 erased text can no longer match", () => {
  it("owner deletion", async () => {
    const ada = await enroll("Erin");
    const post = await thread({
      title: "Nebulous tapir",
      caption: "quixotic marmoset caption",
      alt: "vermilion pangolin",
      withAsset: true,
      author: ada.agentId,
      stamp: utcSeconds(new Date(Date.now() - 60_000)),
    });
    await reply(post.threadId, "jubilant axolotl reply", utcSeconds(new Date(Date.now() - 30_000)), "published", ada.agentId);
    for (const word of ["tapir", "marmoset", "pangolin", "axolotl"]) expect(await stored(word), word).toBe(1);

    const deleted = await call("/v1/deletion-requests", { email: OPERATOR, body: { agent_id: ada.agentId } });
    expect(deleted.status).toBe(200);
    expect(await postState(post.postId)).toBe("removed");
    for (const word of ["tapir", "marmoset", "pangolin", "axolotl"]) {
      expect(await stored(word), word).toBe(0);
      expect(results(await search(word))).toEqual([]);
    }
  });

  it("a Moderator removal, finished by the daily run", async () => {
    const post = await thread({ title: "Gossamer narwhal", caption: "brindled quokka", stamp: "2026-02-01T00:00:00Z" });
    const removed = await call("/v1/moderation/actions", {
      email: MODERATOR,
      body: { target_type: "post", target_id: post.postId, action: "remove", reason_code: "other" },
    });
    expect(removed.status).toBe(200);
    expect(await postState(post.postId)).toBe("removal_pending");
    // Off every read path at once.
    expect(results(await search("narwhal"))).toEqual([]);

    await runRetention(env, Date.now());
    expect(await postState(post.postId)).toBe("removed");
    expect(await stored("narwhal")).toBe(0);
    expect(await stored("quokka")).toBe(0);
  });

  it("the retention scrub of a Post removed before the tombstone", async () => {
    const post = await thread({ title: "Antique wombat", caption: "russet bilby", state: "removed", stamp: "2026-02-01T00:00:00Z" });
    expect(await stored("wombat")).toBe(1);
    await runRetention(env, Date.now());
    const row = await env.DB.prepare("SELECT title, caption FROM posts WHERE id = ?").bind(post.postId).first<{ title: string; caption: string }>();
    expect(row).toEqual({ title: "", caption: "" });
    expect(await stored("wombat")).toBe(0);
    expect(await stored("bilby")).toBe(0);
  });
});

describe("AT-86 the query is bounded and user input is never a wildcard", () => {
  it("splits terms on whitespace, at most 5, and folds only ASCII case", () => {
    expect(searchTerms("okapi  heron\tokapi")).toEqual(["okapi", "heron"]);
    expect(searchTerms("a b c d e f g")).toEqual(["a", "b", "c", "d", "e"]);
    expect(foldTerm("OKAPI")).toBe("okapi");
    expect(foldTerm("100%_\\\"'")).toBe("100%_\\\"'");
    expect(foldTerm("CAFÉ")).toBe("cafÉ");
  });

  it("accepts a term longer than a D1 LIKE pattern may be (50 bytes)", async () => {
    const word = "pneumonoultramicroscopicsilicovolcanoconiosis".repeat(2);
    await thread({ title: "Long word", caption: `a ${word} b`, stamp: "2026-02-01T00:00:00Z" });
    expect(results(await search(word))).toEqual(["Long word"]);
    expect(results(await search(`${word}%_`))).toEqual([]);
  });

  it("matches %, _, \\, and quotes literally", async () => {
    await thread({ title: "Percent", caption: "100% sure", stamp: "2026-02-01T00:00:00Z" });
    await thread({ title: "Thousand", caption: "1000 sure", stamp: "2026-02-02T00:00:00Z" });
    await thread({ title: "Underscore", caption: "snake a_b case", stamp: "2026-02-03T00:00:00Z" });
    await thread({ title: "Letter", caption: "snake axb case", stamp: "2026-02-04T00:00:00Z" });
    await thread({ title: "Backslash", caption: "path back\\slash here", stamp: "2026-02-05T00:00:00Z" });
    await thread({ title: "Quoted", caption: 'they say "hi" often', stamp: "2026-02-06T00:00:00Z" });
    await thread({ title: "Unquoted", caption: "they say hi often", stamp: "2026-02-07T00:00:00Z" });

    expect(results(await search("0%"))).toEqual(["Percent"]);
    expect(results(await search("%%"))).toEqual([]);
    expect(results(await search("a_b"))).toEqual(["Underscore"]);
    expect(results(await search("__"))).toEqual([]);
    expect(results(await search("back\\slash"))).toEqual(["Backslash"]);
    expect(results(await search("\\\\"))).toEqual([]);
    expect(results(await search('"hi"'))).toEqual(["Quoted"]);
    expect(results(await search("'hi'"))).toEqual([]);
    expect(results(await search("say hi"))).toEqual(["Unquoted", "Quoted"]);
    // A sixth term is ignored.
    expect(results(await search("say hi often they the zzyzx"))).toEqual(["Unquoted", "Quoted"]);
    for (const input of ['""', "%_", "\\%", "' OR 1=1 --", "NEAR(", "*okapi*", "[a-z]"]) {
      const response = await call(`/search?q=${encodeURIComponent(input)}`);
      expect(response.status, input).toBe(200);
      expect(results(await response.text()), input).toEqual([]);
    }
  });

  it("takes 2 to 100 characters after trimming", async () => {
    await thread({ title: "ok go", caption: "", stamp: "2026-02-01T00:00:00Z" });
    for (const input of ['"', "*", "-", "a", "  b  ", "x".repeat(101)]) {
      const response = await call(`/search?q=${encodeURIComponent(input)}`);
      expect(response.status, input).toBe(400);
      expect(await response.text(), input).toContain("A search is 2 to 100 characters.");
    }
    expect(results(await search("  ok  "))).toEqual(["ok go"]);
    expect((await call(`/search?q=${"y".repeat(100)}`)).status).toBe(200);

    const empty = await call("/search");
    expect(empty.status).toBe(200);
    expect(await empty.text()).toContain("Type at least 2 characters");
    expect((await call("/search?q=%20%20")).status).toBe(200);
    expect((await call("/search?q=okapi&page=0")).status).toBe(400);
    expect((await call("/search?q=okapi&page=abc")).status).toBe(400);
  });

  it("rate-limits searches per address", async () => {
    const address = "198.51.100.7";
    for (let index = 0; index < SEARCH_PER_ADDRESS_HOUR; index += 1) {
      await chargeHour(env, `search:${await sha256Hex(address)}`, SEARCH_PER_ADDRESS_HOUR);
    }
    const limited = await call("/search?q=okapi", { headers: { "cf-connecting-ip": address } });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited.text()).toContain("Too many searches");
    // Another address, and a page with no query, are not limited.
    expect((await call("/search?q=okapi", { headers: { "cf-connecting-ip": "198.51.100.8" } })).status).toBe(200);
    expect((await call("/search", { headers: { "cf-connecting-ip": address } })).status).toBe(200);
    await clearNamedQuota(env, `search:${await sha256Hex(address)}`);
    await clearNamedQuota(env, `search:${await sha256Hex("198.51.100.8")}`);
  });
});

describe("AT-87 the search page and the header form", () => {
  it("pages 25 at a time, title matches first and newest first", async () => {
    const statements: D1PreparedStatement[] = [];
    for (let index = 1; index <= 30; index += 1) {
      const threadId = uuidv7();
      const stamp = `2026-03-01T00:${String(index).padStart(2, "0")}:00Z`;
      statements.push(
        env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)").bind(threadId, BOARD_ID, stamp),
        env.DB.prepare(
          "INSERT INTO posts (id, thread_id, author_agent_id, title, caption, state, created_at) VALUES (?, ?, ?, ?, 'gecko', 'published', ?)",
        ).bind(uuidv7(), threadId, AGENT_ID, `Gecko ${index}`, stamp),
      );
    }
    await env.DB.batch(statements);
    // The newest Post of all matches only in its caption, so it ranks after every title match.
    await thread({ title: "Lizard", caption: "a gecko again", stamp: "2026-04-01T00:00:00Z" });

    const first = await search("gecko");
    const firstTitles = results(first);
    expect(firstTitles).toHaveLength(25);
    expect(firstTitles.slice(0, 3)).toEqual(["Gecko 30", "Gecko 29", "Gecko 28"]);
    expect(firstTitles[24]).toBe("Gecko 6");
    expect(first).toContain("31 Posts match.");
    expect(first).toContain('<a href="/search?q=gecko&amp;page=2" rel="next">Next</a>');
    expect(first).toContain('<a href="/search?q=gecko" aria-current="page"><span class="visually-hidden">Page </span>1</a>');

    const second = await search("gecko", 2);
    expect(results(second)).toEqual(["Gecko 5", "Gecko 4", "Gecko 3", "Gecko 2", "Gecko 1", "Lizard"]);
    expect(second).toContain("a <mark>gecko</mark> again");
    expect(second).toContain('<a href="/search?q=gecko" rel="prev">Previous</a>');
    expect(second).toContain("<title>Search: gecko, page 2 | j-chain.net</title>");
    expect((await call("/search?q=gecko&page=3")).status).toBe(404);
    expect((await call("/search?q=nothingmatches&page=2")).status).toBe(404);
  });

  it("ranks a page's rows before reading their Thread place, so page 2 keeps the order and the links", async () => {
    const burrow = await thread({ title: "Burrow", caption: "", stamp: "2026-05-01T00:00:00Z" });
    const replies: string[] = [];
    for (let index = 1; index <= 30; index += 1) {
      replies.push(await reply(burrow.threadId, `quokka ${index}`, `2026-05-01T00:${String(index).padStart(2, "0")}:00Z`));
    }
    // A hidden match never takes a slot.
    await reply(burrow.threadId, "quokka hidden", "2026-05-01T01:00:00Z", "quarantined");
    // Two older title matches rank before every caption match.
    const quokkaA = await thread({ title: "Quokka A", caption: "", stamp: "2026-04-01T00:00:00Z" });
    const quokkaB = await thread({ title: "Quokka B", caption: "", stamp: "2026-04-02T00:00:00Z" });
    const anchors = (html: string): string[] =>
      [...html.matchAll(/<h2><a href="[^"]*#post-([^"]+)">/g)].map((match) => match[1] ?? "");

    const first = await search("quokka");
    expect(first).toContain("32 Posts match.");
    // Title matches, then Replies 30 down to 8.
    expect(anchors(first)).toEqual([quokkaB.postId, quokkaA.postId, ...replies.slice(7).reverse()]);
    // Reply 26 is past the Thread's first page: its link starts at the page holding it.
    const href = (first.match(new RegExp(`<h2><a href="([^"]+#post-${replies[25]})">`))?.[1] ?? "").replaceAll("&amp;", "&");
    expect(href).toMatch(new RegExp(`^/threads/${burrow.threadId}\\?cursor=[A-Za-z0-9_-]+#post-${replies[25]}$`));
    const landed = await (await call(href.split("#")[0] ?? "")).text();
    expect(landed.indexOf(`id="post-${replies[25]}"`)).toBeGreaterThan(-1);
    expect(landed).not.toContain(`id="post-${replies[24]}"`);

    const second = await search("quokka", 2);
    // Replies 7 down to 1, each on the Thread's first page.
    expect(anchors(second)).toEqual(replies.slice(0, 7).reverse());
    for (const postId of replies.slice(0, 7)) {
      expect(second).toContain(`href="/threads/${burrow.threadId}#post-${postId}"`);
    }
    expect(results(second)).toEqual(Array.from({ length: 7 }, () => "Reply in Burrow"));
    expect((await call("/search?q=quokka&page=3")).status).toBe(404);
  });

  it("escapes Post text and the query, and marks matches", async () => {
    await thread({
      title: "<b>Bold</b> & \"quoted\"",
      caption: "<script>alert(1)</script> iguana & <img src=x onerror=alert(2)>",
      stamp: "2026-02-01T00:00:00Z",
    });
    const response = await call(`/search?q=${encodeURIComponent("IGUANA <img")}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>Bold");
    expect(html).toContain("&lt;b&gt;Bold&lt;/b&gt; &amp; &quot;quoted&quot;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; <mark>iguana</mark> &amp; <mark>&lt;img</mark> src=x onerror=alert(2)&gt;");
    expect(html).toContain("<title>Search: IGUANA &lt;img | j-chain.net</title>");
    expect(html).toContain('<meta property="og:title" content="Search: IGUANA &lt;img | j-chain.net">');
    expect(html).toContain('value="IGUANA &lt;img"');
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(response.headers.get("x-robots-tag")).toBe("noindex");

    // The highlighter escapes everything, marks case-insensitively, merges overlaps, and
    // windows long text around the first match.
    expect(highlight("a B <c>", ["b"])).toBe("a <mark>B</mark> &lt;c&gt;");
    expect(highlight("abcd", ["abc", "bcd"])).toBe("<mark>abcd</mark>");
    expect(highlight("x.y", ["."])).toBe("x<mark>.</mark>y");
    expect(highlight("<a&b>", ["&"])).toBe("&lt;a<mark>&amp;</mark>b&gt;");
    const long = `${"word ".repeat(60)}target ${"tail ".repeat(60)}`;
    const windowed = highlight(long, ["target"]);
    expect(windowed.startsWith("…")).toBe(true);
    expect(windowed.endsWith("…")).toBe(true);
    expect(windowed).toContain("<mark>target</mark>");
  });

  it("shows the empty and no-match states", async () => {
    const empty = await (await call("/search")).text();
    expect(empty).toContain("<title>Search | j-chain.net</title>");
    expect(empty).toContain('<p class="empty">Type at least 2 characters');
    const none = await search("zzyzx");
    expect(none).toContain("No published Post matches <q>zzyzx</q>.");
    expect(none).toContain("<title>Search: zzyzx | j-chain.net</title>");
    expect(none).not.toContain('class="search-results"');
  });

  it("puts a labelled GET search form in the header of every human page", async () => {
    const opening = await thread({ title: "Header check", caption: "", stamp: "2026-02-01T00:00:00Z" });
    const pages: Array<[string, number]> = [
      ["/", 200],
      ["/boards", 200],
      ["/boards/beta", 200],
      ["/trending", 200],
      ["/start", 200],
      ["/signin", 200],
      ["/reports", 200],
      [`/threads/${opening.threadId}`, 200],
      [`/agents/${AGENT_ID}`, 200],
      ["/search", 200],
      ["/search?q=header", 200],
      ["/threads/01900000-0000-7000-8000-00000000ffff", 404],
    ];
    for (const [path, status] of pages) {
      const response = await call(path);
      expect(response.status, path).toBe(status);
      expect(response.headers.get("content-security-policy"), path).toContain("script-src 'none'");
      const html = await response.text();
      const header = html.slice(html.indexOf('<header class="site">'), html.indexOf("</header>"));
      expect(header, path).toContain('<form class="site-search" method="get" action="/search" role="search">');
      expect(header, path).toContain('<label class="visually-hidden" for="site-search-q">Search posts</label>');
      expect(header, path).toMatch(/<input id="site-search-q" type="search" name="q" maxlength="100"/);
      expect(header, path).toContain('<button type="submit">Search</button>');
      expect(html, path).toContain('href="/brand/board-v10.css"');
      expect(html, path).not.toContain("<script");
    }
  });
});

type ThreadOptions = {
  title: string;
  caption: string;
  stamp: string;
  alt?: string;
  state?: string;
  withAsset?: boolean;
  author?: string;
};

async function thread(options: ThreadOptions): Promise<{ threadId: string; postId: string; assetId: string | null }> {
  const threadId = uuidv7();
  const postId = uuidv7();
  const author = options.author ?? AGENT_ID;
  const assetId = options.withAsset === true ? uuidv7() : null;
  const statements: D1PreparedStatement[] = [];
  if (assetId !== null) {
    statements.push(env.DB.prepare(
      `INSERT INTO assets (id, agent_id, state, content_type, byte_size, sha256, original_stored, created_at, expires_at)
       VALUES (?, ?, 'ready', 'image/webp', 4, ?, 0, ?, ?)`,
    ).bind(assetId, author, assetId.replaceAll("-", "").padEnd(64, "d"), options.stamp, options.stamp));
  }
  statements.push(
    env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)").bind(threadId, BOARD_ID, options.stamp),
    assetId === null
      ? env.DB.prepare(
        "INSERT INTO posts (id, thread_id, author_agent_id, title, caption, alt_text, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(postId, threadId, author, options.title, options.caption, options.alt ?? null, options.state ?? "published", options.stamp)
      : env.DB.prepare(
        `INSERT INTO posts (
           id, thread_id, author_agent_id, asset_id, title, caption, alt_text,
           provenance_source, provenance_model, rights_attestation, license, state, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'model', 'fixture-model', 'I made this.', 'cc0', ?, ?)`,
      ).bind(postId, threadId, author, assetId, options.title, options.caption, options.alt ?? "", options.state ?? "published", options.stamp),
  );
  await env.DB.batch(statements);
  return { threadId, postId, assetId };
}

async function reply(threadId: string, caption: string, stamp: string, state = "published", author = AGENT_ID): Promise<string> {
  const postId = uuidv7();
  await env.DB.prepare(
    "INSERT INTO posts (id, thread_id, author_agent_id, title, caption, state, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)",
  ).bind(postId, threadId, author, caption, state, stamp).run();
  return postId;
}

async function enroll(name: string): Promise<{ agentId: string; credential: string }> {
  const response = await call("/v1/agents", {
    email: OPERATOR,
    body: { display_name: name, declared_model: "fixture-model" },
  });
  const body = await response.json() as { agent_id: string; credential: string; request_id: string };
  expect(response.status, JSON.stringify(body)).toBe(201);
  expect(body.request_id).toMatch(UUID_V7);
  return { agentId: body.agent_id, credential: body.credential };
}

async function search(query: string, pageNumber = 1): Promise<string> {
  const suffix = pageNumber === 1 ? "" : `&page=${pageNumber}`;
  const response = await call(`/search?q=${encodeURIComponent(query)}${suffix}`);
  expect(response.status, query).toBe(200);
  expect(response.headers.get("content-security-policy")).toContain("script-src 'none'");
  return response.text();
}

function results(html: string): string[] {
  return [...html.matchAll(/<li class="search-result">.*?<h2><a href="[^"]+">(.*?)<\/a><\/h2>/g)].map((match) => match[1] ?? "");
}

// Post rows whose text holds the word, whatever their state: the stored text itself, not the page.
async function stored(word: string): Promise<number> {
  const pattern = `%${word}%`;
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM posts WHERE title LIKE ? OR caption LIKE ? OR alt_text LIKE ?",
  ).bind(pattern, pattern, pattern).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function postState(postId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT state FROM posts WHERE id = ?").bind(postId).first<{ state: string }>();
  return row?.state ?? null;
}

async function clearSearchQuota(): Promise<void> {
  await clearNamedQuota(env, `search:${await sha256Hex("unknown")}`);
  await clearNamedQuota(env, "search");
}
