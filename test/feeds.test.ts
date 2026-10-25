import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "../src/ids";
import { EDGE_CACHE_SECONDS, FEED_ENTRIES, SITEMAP_MAX_URLS, SUMMARY_CHARS } from "../src/feeds";
import { BOARD_ID, call, OPERATOR, resetAndSeed } from "./harness";

// Feeds and sitemap (Danny, 2026-10-24, "continue"). AT-90.

const ORIGIN = "https://jchain.example.test";
const AGENT_ID = "01900000-0000-7000-8000-0000000000c1";
const OTHER_AGENT_ID = "01900000-0000-7000-8000-0000000000c2";
const ART_ID = "01900000-0000-7000-8000-0000000000c3";
const OLD_ID = "01900000-0000-7000-8000-0000000000c4";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

// The feeds and the sitemap are kept in the edge cache for EDGE_CACHE_SECONDS. Each test starts
// from an empty cache and empties it again wherever it changes the data under a URL it already read.
const CACHED_PATHS = ["/feed.xml", "/sitemap.xml", "/boards/beta/feed.xml", "/boards/art/feed.xml", "/boards/old/feed.xml", "/boards/nope/feed.xml"];

async function purgeEdge(): Promise<void> {
  for (const path of CACHED_PATHS) await caches.default.delete(new Request(`${ORIGIN}${path}`));
}

beforeEach(async () => {
  await purgeEdge();
  await resetAndSeed();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO agents (id, display_name, declared_model, state, created_at, handle) VALUES (?, ?, ?, 'active', ?, 'ada')",
    ).bind(AGENT_ID, "Ada", "fixture-model", "2026-01-01T00:00:00Z"),
    env.DB.prepare(
      "INSERT INTO agents (id, display_name, declared_model, state, created_at) VALUES (?, ?, ?, 'active', ?)",
    ).bind(OTHER_AGENT_ID, "Bo", "fixture-model", "2026-01-01T00:00:00Z"),
    env.DB.prepare("INSERT INTO boards (id, slug, name) VALUES (?, ?, ?)").bind(ART_ID, "art", "Art"),
    env.DB.prepare("INSERT INTO boards (id, slug, name, state) VALUES (?, ?, ?, 'archived')").bind(OLD_ID, "old", "Old"),
  ]);
});

describe("AT-90 a board's Atom feed", () => {
  it("is well-formed Atom, newest Opening Post first, the pin not special, updated at the bump", async () => {
    const oldest = await thread({ title: "First", caption: "one", stamp: "2026-02-01T00:00:00Z" });
    const middle = await thread({ title: "Second", caption: "two", stamp: "2026-02-02T00:00:00Z" });
    const newest = await thread({ title: "Third", caption: "three", stamp: "2026-02-03T00:00:00Z" });
    // The oldest Thread is pinned and bumped by a Reply: the feed keeps the New order.
    await env.DB.prepare("INSERT INTO board_pins (board_id, thread_id, pinned_at) VALUES (?, ?, ?)")
      .bind(BOARD_ID, oldest.threadId, "2026-02-04T00:00:00Z").run();
    await reply(oldest.threadId, "a bump", "2026-02-05T00:00:00Z");
    // A hidden Reply never bumps.
    await reply(middle.threadId, "hidden bump", "2026-02-06T00:00:00Z", "hidden");

    const response = await call("/boards/beta/feed.xml");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/atom+xml; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    const source = await response.text();
    expect(source.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
    const root = parseXml(source);
    expect(root.name).toBe("feed");
    expect(root.attrs.xmlns).toBe("http://www.w3.org/2005/Atom");
    expect(text(root, "id")).toBe(`${ORIGIN}/boards/beta/feed.xml`);
    expect(text(root, "title")).toBe("/beta/ JChain on j-chain.net");
    expect(text(root, "updated")).toBe("2026-02-05T00:00:00Z");
    const links = children(root, "link").map((link) => [link.attrs.rel, link.attrs.href]);
    expect(links).toEqual([["self", `${ORIGIN}/boards/beta/feed.xml`], ["alternate", `${ORIGIN}/boards/beta`]]);

    const entries = children(root, "entry");
    expect(entries.map((item) => text(item, "title"))).toEqual(["Third", "Second", "First"]);
    const [third, second, first] = entries as [XmlNode, XmlNode, XmlNode];
    expect(text(third, "id")).toBe(`tag:j-chain.net,2026:thread:${newest.threadId}`);
    expect(child(third, "link").attrs).toEqual({ rel: "alternate", type: "text/html", href: `${ORIGIN}/threads/${newest.threadId}` });
    expect(text(third, "published")).toBe("2026-02-03T00:00:00Z");
    expect(text(third, "updated")).toBe("2026-02-03T00:00:00Z");
    expect(text(child(third, "author"), "name")).toBe("Ada (@ada)");
    expect(text(child(third, "author"), "uri")).toBe(`${ORIGIN}/agents/${AGENT_ID}`);
    expect(child(third, "summary").attrs.type).toBe("text");
    expect(text(third, "summary")).toBe("three");
    expect(child(third, "category").attrs.term).toBe("beta");
    expect(text(second, "updated")).toBe("2026-02-02T00:00:00Z");
    expect(text(first, "id")).toBe(`tag:j-chain.net,2026:thread:${oldest.threadId}`);
    expect(text(first, "published")).toBe("2026-02-01T00:00:00Z");
    expect(text(first, "updated")).toBe("2026-02-05T00:00:00Z");
  });

  it("leaves out everything the Visibility Projection hides", async () => {
    await thread({ title: "Visible", caption: "", stamp: "2026-02-01T00:00:00Z" });
    for (const state of ["quarantined", "hidden", "removed", "removal_pending", "pending_review", "rejected", "flagged"]) {
      await thread({ title: `State ${state}`, caption: `caption ${state}`, state, stamp: "2026-02-02T00:00:00Z" });
    }
    await thread({ title: "Owner deleted", caption: "gone", stamp: "2026-02-03T00:00:00Z", author: OTHER_AGENT_ID });
    await env.DB.prepare("UPDATE agents SET deletion_requested_at = ? WHERE id = ?")
      .bind("2026-03-01T00:00:00Z", OTHER_AGENT_ID).run();
    const hiddenOpening = await thread({ title: "Hidden opener", caption: "", state: "hidden", stamp: "2026-02-04T00:00:00Z" });
    await reply(hiddenOpening.threadId, "reply under a hidden opener", "2026-02-05T00:00:00Z");

    for (const path of ["/boards/beta/feed.xml", "/feed.xml"]) {
      const source = await (await call(path)).text();
      const root = parseXml(source);
      expect(children(root, "entry").map((item) => text(item, "title")), path).toEqual(["Visible"]);
      expect(source, path).not.toContain("State ");
      expect(source, path).not.toContain("Owner deleted");
      expect(source, path).not.toContain("hidden opener");
    }

    // Quarantined after it was listed, the Thread leaves the feed; cleared, it comes back.
    const row = await env.DB.prepare("SELECT id FROM posts WHERE title = 'Visible'").first<{ id: string }>();
    await env.DB.prepare("UPDATE posts SET state = 'quarantined' WHERE id = ?").bind(row?.id).run();
    await purgeEdge();
    expect(children(parseXml(await (await call("/boards/beta/feed.xml")).text()), "entry")).toEqual([]);
    await env.DB.prepare("UPDATE posts SET state = 'published' WHERE id = ?").bind(row?.id).run();
    await purgeEdge();
    expect(children(parseXml(await (await call("/boards/beta/feed.xml")).text()), "entry")).toHaveLength(1);
  });

  it("escapes titles, captions, and names, and truncates the summary to plain text", async () => {
    await env.DB.prepare("UPDATE agents SET display_name = ? WHERE id = ?").bind(`Ada <&> "Q"`, AGENT_ID).run();
    const long = `<b>bold</b> & "quoted" 'single' ${"x".repeat(400)}`;
    await thread({ title: `Fish & <chips> "a" 'b'\u0001`, caption: long, stamp: "2026-02-01T00:00:00Z" });
    const source = await (await call("/boards/beta/feed.xml")).text();
    expect(source).toContain("<title type=\"text\">Fish &amp; &lt;chips&gt; &quot;a&quot; &apos;b&apos;</title>");
    expect(source).not.toContain("<chips>");
    expect(source).not.toContain("<b>bold</b>");
    expect(source).not.toContain("\u0001");
    const entry = child(parseXml(source), "entry");
    expect(text(entry, "title")).toBe(`Fish & <chips> "a" 'b'`);
    expect(text(child(entry, "author"), "name")).toBe(`Ada <&> "Q" (@ada)`);
    const summary = text(entry, "summary");
    expect(Array.from(summary)).toHaveLength(SUMMARY_CHARS);
    expect(summary.endsWith("…")).toBe(true);
    expect(summary.startsWith(`<b>bold</b> & "quoted" 'single' xxx`)).toBe(true);
  });

  it("links the display image only while the Asset is served", async () => {
    const shown = await thread({ title: "Picture", caption: "", stamp: "2026-02-01T00:00:00Z", withAsset: true });
    let source = await (await call("/boards/beta/feed.xml")).text();
    const enclosure = (): XmlNode | undefined => children(child(parseXml(source), "entry"), "link")
      .find((link) => link.attrs.rel === "enclosure");
    expect(enclosure()?.attrs).toEqual({
      rel: "enclosure",
      type: "image/webp",
      href: `${ORIGIN}/v1/assets/${shown.assetId}/content?variant=display`,
    });
    const page = await (await call(`/threads/${shown.threadId}`)).text();
    expect(page).toContain(`src="/v1/assets/${shown.assetId}/content?variant=display"`);
    await env.DB.prepare("UPDATE assets SET state = 'quarantined' WHERE id = ?").bind(shown.assetId).run();
    await purgeEdge();
    source = await (await call("/boards/beta/feed.xml")).text();
    expect(enclosure()).toBeUndefined();
  });

  it("is not found for an unknown or archived board, like the board page", async () => {
    const page = await call("/boards/nope", { headers: { accept: "text/html" } });
    expect(page.status).toBe(404);
    const unknown = await call("/boards/nope/feed.xml");
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain("<h1>Not found</h1>");
    await thread({ title: "Archived thread", caption: "", stamp: "2026-02-01T00:00:00Z", boardId: OLD_ID });
    const archived = await call("/boards/old/feed.xml");
    expect(archived.status).toBe(404);
    expect(await (await call("/feed.xml")).text()).not.toContain("Archived thread");
  });
});

describe("AT-90 the all-boards feed", () => {
  it("lists the newest threads across every listed board, capped", async () => {
    const statements: D1PreparedStatement[] = [];
    for (let index = 0; index < FEED_ENTRIES + 2; index += 1) {
      const minute = String(index).padStart(2, "0");
      const threadId = uuidv7();
      const boardId = index % 2 === 0 ? BOARD_ID : ART_ID;
      statements.push(
        env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)")
          .bind(threadId, boardId, `2026-02-01T00:${minute}:00Z`),
        env.DB.prepare(
          "INSERT INTO posts (id, thread_id, author_agent_id, title, caption, state, created_at) VALUES (?, ?, ?, ?, '', 'published', ?)",
        ).bind(uuidv7(), threadId, AGENT_ID, `Thread ${index}`, `2026-02-01T00:${minute}:00Z`),
      );
    }
    await env.DB.batch(statements);
    const response = await call("/feed.xml");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/atom+xml; charset=utf-8");
    const root = parseXml(await response.text());
    expect(text(root, "id")).toBe(`${ORIGIN}/feed.xml`);
    const entries = children(root, "entry");
    expect(entries).toHaveLength(FEED_ENTRIES);
    expect(text(entries[0] as XmlNode, "title")).toBe(`Thread ${FEED_ENTRIES + 1}`);
    expect(text(entries[FEED_ENTRIES - 1] as XmlNode, "title")).toBe("Thread 2");
    expect(new Set(entries.map((item) => child(item, "category").attrs.term))).toEqual(new Set(["beta", "art"]));
  });
});

describe("AT-90 the edge cache", () => {
  it("serves a repeat request for the same URL from the edge until the window ends", async () => {
    expect(EDGE_CACHE_SECONDS).toBe(300);
    await thread({ title: "Before", caption: "", stamp: "2026-02-01T00:00:00Z" });
    const firstFeed = await call("/boards/beta/feed.xml");
    const firstSitemap = await call("/sitemap.xml");
    const feedSource = await firstFeed.text();
    const sitemapSource = await firstSitemap.text();
    expect(feedSource).toContain("Before");

    // A new Thread inside the window: the edge copy is served unchanged, with the client's own
    // Cache-Control and a fresh request id.
    const later = await thread({ title: "After", caption: "", stamp: "2026-02-02T00:00:00Z" });
    const secondFeed = await call("/boards/beta/feed.xml");
    expect(secondFeed.status).toBe(200);
    expect(secondFeed.headers.get("content-type")).toBe("application/atom+xml; charset=utf-8");
    expect(secondFeed.headers.get("cache-control")).toBe("public, max-age=300");
    expect(secondFeed.headers.get("x-jchain-client-cache-control")).toBeNull();
    expect(secondFeed.headers.get("x-request-id")).not.toBe(firstFeed.headers.get("x-request-id"));
    expect(await secondFeed.text()).toBe(feedSource);
    // A made-up query string does not skip the cache: the key is the path.
    expect(await (await call("/boards/beta/feed.xml?bust=1")).text()).toBe(feedSource);
    const secondSitemap = await call("/sitemap.xml");
    expect(secondSitemap.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await secondSitemap.text()).toBe(sitemapSource);
    // Another URL is its own entry: the all-boards feed reads D1 and has the new Thread.
    expect(await (await call("/feed.xml")).text()).toContain("After");

    // A missing policy fails closed even while an edge copy exists.
    expect((await call("/boards/beta/feed.xml", { policy: null })).status).not.toBe(200);

    // Once the copy is gone (the window ended), the next request reads D1 again.
    await purgeEdge();
    const fresh = await (await call("/boards/beta/feed.xml")).text();
    expect(fresh).toContain("After");
    expect(await (await call("/sitemap.xml")).text()).toContain(`${ORIGIN}/threads/${later.threadId}`);
  });

  it("never keeps a response that is not a 200", async () => {
    expect((await call("/boards/nope/feed.xml")).status).toBe(404);
    expect(await caches.default.match(new Request(`${ORIGIN}/boards/nope/feed.xml`))).toBeUndefined();
    expect((await call("/feed.xml", { policy: null })).status).not.toBe(200);
    expect(await caches.default.match(new Request(`${ORIGIN}/feed.xml`))).toBeUndefined();
  });

  it("drops a listed thread from the edge copy when a signed-in report quarantines it", async () => {
    const seeded = await thread({ title: "Listed", caption: "still here", stamp: "2026-02-01T00:00:00Z" });
    expect(await (await call("/boards/beta/feed.xml")).text()).toContain("Listed");
    expect(await (await call("/feed.xml")).text()).toContain("Listed");
    expect(await (await call("/sitemap.xml")).text()).toContain(seeded.threadId);

    const filed = await call("/v1/reports", {
      email: OPERATOR,
      body: { target_type: "post", target_id: seeded.postId, reason_code: "spam" },
    });
    expect(filed.status).toBe(201);

    expect(await (await call("/boards/beta/feed.xml")).text()).not.toContain("Listed");
    expect(await (await call("/feed.xml")).text()).not.toContain("Listed");
    expect(await (await call("/sitemap.xml")).text()).not.toContain(seeded.threadId);
  });
});

describe("AT-90 feed discovery", () => {
  it("names the feed in the head of the board page and the home page, escaped", async () => {
    await env.DB.prepare("UPDATE boards SET name = ? WHERE id = ?").bind(`Fish & "chips" <b>`, ART_ID).run();
    const board = await (await call("/boards/art")).text();
    const boardHead = board.slice(0, board.indexOf("</head>"));
    expect(boardHead).toContain(
      '<link rel="alternate" type="application/atom+xml" title="/art/ Fish &amp; &quot;chips&quot; &lt;b&gt; on j-chain.net" href="/boards/art/feed.xml">',
    );
    const home = await (await call("/")).text();
    const homeHead = home.slice(0, home.indexOf("</head>"));
    expect(homeHead).toContain('<link rel="alternate" type="application/atom+xml" title="j-chain.net: all boards" href="/feed.xml">');
    const archived = await (await call("/boards/old")).text();
    expect(archived).not.toContain("application/atom+xml");
  });
});

describe("AT-90 the sitemap and robots.txt", () => {
  it("lists the public pages, Threads newest Opening Post first with its time as lastmod, and nothing private", async () => {
    const visible = await thread({ title: "Visible", caption: "", stamp: "2026-02-01T00:00:00Z" });
    await reply(visible.threadId, "bump", "2026-02-02T00:00:00Z");
    const hidden = await thread({ title: "Hidden", caption: "", stamp: "2026-02-03T00:00:00Z", state: "hidden" });
    const deleted = await thread({ title: "Deleted", caption: "", stamp: "2026-02-03T00:00:00Z", author: OTHER_AGENT_ID });
    await env.DB.prepare("UPDATE agents SET deletion_requested_at = ? WHERE id = ?")
      .bind("2026-03-01T00:00:00Z", OTHER_AGENT_ID).run();

    const response = await call("/sitemap.xml");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    const source = await response.text();
    const root = parseXml(source);
    expect(root.name).toBe("urlset");
    expect(root.attrs.xmlns).toBe("http://www.sitemaps.org/schemas/sitemap/0.9");
    const urls = new Map(children(root, "url").map((url) => [text(url, "loc"), url.children.some((node) => node.name === "lastmod") ? text(url, "lastmod") : null]));
    expect([...urls.keys()]).toEqual([
      `${ORIGIN}/`,
      `${ORIGIN}/boards`,
      `${ORIGIN}/boards/art`,
      `${ORIGIN}/boards/beta`,
      `${ORIGIN}/agents/${AGENT_ID}`,
      `${ORIGIN}/threads/${visible.threadId}`,
    ]);
    // A Thread's lastmod is its Opening Post's time, not the bump (the bump is not computed here).
    expect(urls.get(`${ORIGIN}/threads/${visible.threadId}`)).toBe("2026-02-01T00:00:00Z");
    expect(urls.get(`${ORIGIN}/boards/beta`)).toBe("2026-02-02T00:00:00Z");
    expect(urls.get(`${ORIGIN}/agents/${AGENT_ID}`)).toBe("2026-02-02T00:00:00Z");
    expect(urls.size).toBeLessThanOrEqual(SITEMAP_MAX_URLS);
    expect(SITEMAP_MAX_URLS).toBe(50_000);
    for (const absent of [hidden.threadId, deleted.threadId, OTHER_AGENT_ID, "/boards/old", "/search", "/operator", "/admin", "/moderation", "/reports", "/signin", "/v1/"]) {
      expect(source, absent).not.toContain(absent);
    }
  });

  it("keeps the robots rules, adds the admin and search pages, and names the sitemap", async () => {
    for (const policy of [undefined, null]) {
      const response = await call("/robots.txt", policy === null ? { policy: null } : {});
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      const rules = await response.text();
      for (const path of ["/moderation", "/reports", "/operator", "/signin/", "/admin", "/search"]) {
        expect(rules).toContain(`Disallow: ${path}\n`);
      }
      expect(rules).toContain("User-agent: *\n");
      expect(rules).toContain(`\nSitemap: ${ORIGIN}/sitemap.xml\n`);
      expect(rules.indexOf("Disallow: /search")).toBeLessThan(rules.indexOf("Allow: /\n"));
    }
  });
});

type ThreadOptions = {
  title: string;
  caption: string;
  stamp: string;
  state?: string;
  withAsset?: boolean;
  author?: string;
  boardId?: string;
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
    env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)")
      .bind(threadId, options.boardId ?? BOARD_ID, options.stamp),
    assetId === null
      ? env.DB.prepare(
        "INSERT INTO posts (id, thread_id, author_agent_id, title, caption, alt_text, state, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
      ).bind(postId, threadId, author, options.title, options.caption, options.state ?? "published", options.stamp)
      : env.DB.prepare(
        `INSERT INTO posts (
           id, thread_id, author_agent_id, asset_id, title, caption, alt_text,
           provenance_source, provenance_model, rights_attestation, license, state, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'an image', 'model', 'fixture-model', 'I made this.', 'cc0', ?, ?)`,
      ).bind(postId, threadId, author, assetId, options.title, options.caption, options.state ?? "published", options.stamp),
  );
  await env.DB.batch(statements);
  return { threadId, postId, assetId };
}

async function reply(threadId: string, caption: string, stamp: string, state = "published"): Promise<string> {
  const postId = uuidv7();
  await env.DB.prepare(
    "INSERT INTO posts (id, thread_id, author_agent_id, title, caption, state, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)",
  ).bind(postId, threadId, AGENT_ID, caption, state, stamp).run();
  return postId;
}

// A small, strict XML reader: one root, matched tags, quoted attributes, only the five named
// entities and character references, and no markup in text. It throws on anything else.
type XmlNode = { name: string; attrs: Record<string, string>; children: XmlNode[]; text: string };

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(raw: string): string {
  let out = "";
  let index = 0;
  while (index < raw.length) {
    const char = raw[index] as string;
    if (char !== "&") {
      out += char;
      index += 1;
      continue;
    }
    const end = raw.indexOf(";", index);
    if (end === -1) throw new Error(`bare & at ${index}`);
    const name = raw.slice(index + 1, end);
    if (name in NAMED_ENTITIES) {
      out += NAMED_ENTITIES[name];
    } else if (name.startsWith("#x") && name.length > 2 && [...name.slice(2)].every((digit) => "0123456789abcdefABCDEF".includes(digit))) {
      out += String.fromCodePoint(parseInt(name.slice(2), 16));
    } else if (name.startsWith("#") && name.length > 1 && [...name.slice(1)].every((digit) => "0123456789".includes(digit))) {
      out += String.fromCodePoint(parseInt(name.slice(1), 10));
    } else {
      throw new Error(`unknown entity &${name};`);
    }
    index = end + 1;
  }
  return out;
}

function isNameChar(char: string | undefined): boolean {
  if (char === undefined || char === "") return false;
  const lower = char.toLowerCase();
  return (lower >= "a" && lower <= "z") || (char >= "0" && char <= "9") || ":-_.".includes(char);
}

function isSpace(char: string | undefined): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r";
}

function parseXml(source: string): XmlNode {
  const document: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [document];
  let index = 0;
  const readName = (): string => {
    const start = index;
    while (isNameChar(source[index])) index += 1;
    if (index === start) throw new Error(`expected a name at ${start}`);
    return source.slice(start, index);
  };
  while (index < source.length) {
    if (source[index] !== "<") {
      const next = source.indexOf("<", index);
      const end = next === -1 ? source.length : next;
      const raw = source.slice(index, end);
      const top = stack[stack.length - 1] as XmlNode;
      if (top === document) {
        if (raw.trim() !== "") throw new Error("text outside the root element");
      } else {
        top.text += decodeEntities(raw);
      }
      index = end;
      continue;
    }
    if (source.startsWith("<?", index)) {
      if (index !== 0) throw new Error("the XML declaration must come first");
      const end = source.indexOf("?>", index);
      if (end === -1) throw new Error("unclosed declaration");
      index = end + 2;
      continue;
    }
    if (source.startsWith("<!", index)) throw new Error("unexpected markup declaration");
    if (source.startsWith("</", index)) {
      index += 2;
      const name = readName();
      while (isSpace(source[index])) index += 1;
      if (source[index] !== ">") throw new Error(`bad end tag ${name}`);
      index += 1;
      const open = stack.pop();
      if (open === undefined || open === document || open.name !== name) throw new Error(`mismatched </${name}>`);
      continue;
    }
    index += 1;
    const node: XmlNode = { name: readName(), attrs: {}, children: [], text: "" };
    const parent = stack[stack.length - 1] as XmlNode;
    if (parent === document && document.children.length > 0) throw new Error("more than one root element");
    parent.children.push(node);
    for (;;) {
      const hadSpace = isSpace(source[index]);
      while (isSpace(source[index])) index += 1;
      if (source.startsWith("/>", index)) {
        index += 2;
        break;
      }
      if (source[index] === ">") {
        index += 1;
        stack.push(node);
        break;
      }
      if (!hadSpace) throw new Error(`expected space before an attribute in <${node.name}>`);
      const attr = readName();
      if (attr in node.attrs) throw new Error(`duplicate attribute ${attr}`);
      if (source[index] !== "=") throw new Error(`expected = after ${attr}`);
      index += 1;
      const quote = source[index];
      if (quote !== '"' && quote !== "'") throw new Error(`unquoted attribute ${attr}`);
      const close = source.indexOf(quote, index + 1);
      if (close === -1) throw new Error(`unclosed attribute ${attr}`);
      const raw = source.slice(index + 1, close);
      if (raw.includes("<")) throw new Error(`< in attribute ${attr}`);
      node.attrs[attr] = decodeEntities(raw);
      index = close + 1;
    }
  }
  if (stack.length !== 1) throw new Error(`unclosed <${(stack[stack.length - 1] as XmlNode).name}>`);
  const root = document.children[0];
  if (root === undefined) throw new Error("no root element");
  return root;
}

function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((item) => item.name === name);
}

function child(node: XmlNode, name: string): XmlNode {
  const found = children(node, name)[0];
  if (found === undefined) throw new Error(`no <${name}> in <${node.name}>`);
  return found;
}

function text(node: XmlNode, name: string): string {
  return child(node, name).text;
}
