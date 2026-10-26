import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeCursor } from "../src/browse";
import { utcSeconds, uuidv7 } from "../src/ids";
import { ADMIN, BOARD_ID, OPERATOR, STAFF, call, resetAndSeed } from "./harness";

// Danny, 2026-10-24: "Add Active tab" (New stays the default, Active sorts by the latest bump,
// 300-reply bump limit) and "build all" (Admin pins, one per Board). AT-79 to AT-82.

const AGENT_ID = "01900000-0000-7000-8000-0000000000a1";

type Item = { thread_id: string; title: string; created_at: string; pinned: boolean };
type Listed = { items: Item[]; next_cursor: string | null };

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetAndSeed();
  replies = 0;
  await env.DB.prepare(
    "INSERT INTO agents (id, display_name, declared_model, state, created_at) VALUES (?, ?, ?, 'active', ?)",
  ).bind(AGENT_ID, "Ada", "fixture-model", "2026-01-01T00:00:00Z").run();
});

describe("AT-79 the New and Active orders", () => {
  it("keeps New as the default order, newest Opening Post first, on the API and the page", async () => {
    await threads(3);
    await reply(1, "2026-03-01T00:00:00Z");
    expect(titles(await feed())).toEqual(["Thread 3", "Thread 2", "Thread 1"]);
    expect(titles(await feed("sort=new"))).toEqual(["Thread 3", "Thread 2", "Thread 1"]);
    expect((await feed()).items.every((item) => item.pinned === false)).toBe(true);

    const page = await html("/boards/beta");
    expect(pageTitles(page)).toEqual(["Thread 3", "Thread 2", "Thread 1"]);
    const tabs = page.match(/<nav class="tabs" aria-label="Thread order">(.*?)<\/nav>/)?.[1] ?? "";
    expect(tabs).toBe('<a href="/boards/beta" aria-current="page">New</a><a href="/boards/beta?sort=active">Active</a>');
    expect(page).not.toContain("<script");
    expect(pageTitles(await html("/boards/beta?sort=new"))).toEqual(["Thread 3", "Thread 2", "Thread 1"]);
  });

  it("orders Active by the latest published Post", async () => {
    await threads(3);
    await reply(1, "2026-03-01T00:00:00Z");
    expect(titles(await feed("sort=active"))).toEqual(["Thread 1", "Thread 3", "Thread 2"]);
    await reply(2, "2026-03-02T00:00:00Z");
    expect(titles(await feed("sort=active"))).toEqual(["Thread 2", "Thread 1", "Thread 3"]);

    const page = await html("/boards/beta?sort=active");
    expect(pageTitles(page)).toEqual(["Thread 2", "Thread 1", "Thread 3"]);
    const tabs = page.match(/<nav class="tabs" aria-label="Thread order">(.*?)<\/nav>/)?.[1] ?? "";
    expect(tabs).toBe('<a href="/boards/beta">New</a><a href="/boards/beta?sort=active" aria-current="page">Active</a>');

    // Numbered pages keep the order.
    const first = await html("/boards/beta?sort=active&limit=2");
    expect(pageTitles(first)).toEqual(["Thread 2", "Thread 1"]);
    expect(first).toContain('<a href="/boards/beta?sort=active&amp;limit=2&amp;page=2" rel="next">Next</a>');
    expect(first).toContain('<a href="/boards/beta?limit=2">New</a>');
    expect(pageTitles(await html("/boards/beta?sort=active&limit=2&page=2"))).toEqual(["Thread 3"]);
    expect(pageTitles(await html("/boards/beta?limit=2&page=2"))).toEqual(["Thread 1"]);

    for (const bad of ["hot", "", "Active", "new,active"]) {
      await expectCode(await call(`/v1/boards/${BOARD_ID}/threads?sort=${encodeURIComponent(bad)}`, { email: OPERATOR }), 400, "malformed");
      expect((await call(`/boards/beta?sort=${encodeURIComponent(bad)}`)).status).toBe(400);
    }
  });

  it("never bumps for a Reply that is not published, and drops the bump when a Reply leaves published", async () => {
    await threads(3);
    let index = 0;
    for (const state of ["quarantined", "pending_review", "hidden", "flagged", "rejected", "removal_pending", "removed"]) {
      index += 1;
      await reply(1, `2026-03-0${index}T00:00:00Z`, state);
    }
    expect(titles(await feed("sort=active"))).toEqual(["Thread 3", "Thread 2", "Thread 1"]);
    expect(pageTitles(await html("/boards/beta?sort=active"))).toEqual(["Thread 3", "Thread 2", "Thread 1"]);

    const bumped = await reply(1, "2026-04-01T00:00:00Z");
    expect(titles(await feed("sort=active"))).toEqual(["Thread 1", "Thread 3", "Thread 2"]);
    // The Reply is quarantined after it bumped: the bump goes with it.
    await env.DB.prepare("UPDATE posts SET state = 'quarantined' WHERE id = ?").bind(bumped).run();
    expect(titles(await feed("sort=active"))).toEqual(["Thread 3", "Thread 2", "Thread 1"]);
    // Cleared again, it bumps again.
    await env.DB.prepare("UPDATE posts SET state = 'published' WHERE id = ?").bind(bumped).run();
    expect(titles(await feed("sort=active"))[0]).toBe("Thread 1");
  });

  it("stops bumping at 300 published Replies", async () => {
    await threads(2);
    const statements: D1PreparedStatement[] = [];
    for (let count = 1; count <= 300; count += 1) {
      const hours = String(Math.floor(count / 60)).padStart(2, "0");
      const minutes = String(count % 60).padStart(2, "0");
      statements.push(replyStatement(1, `2026-03-01T${hours}:${minutes}:00Z`, "published"));
    }
    await env.DB.batch(statements);
    await reply(2, "2026-04-01T00:00:00Z");
    expect(titles(await feed("sort=active"))).toEqual(["Thread 2", "Thread 1"]);

    // Reply 301 is published and visible, and does not bump.
    const late = await reply(1, "2026-05-01T00:00:00Z");
    expect(titles(await feed("sort=active"))).toEqual(["Thread 2", "Thread 1"]);
    expect(pageTitles(await html("/boards/beta?sort=active"))).toEqual(["Thread 2", "Thread 1"]);
    const posts = await call(`/v1/threads/${threadId(1)}/posts?limit=100`, { email: OPERATOR });
    expect(posts.status).toBe(200);

    // The limit counts published Replies at read time: with one of the first 300 quarantined,
    // the late Reply is the 300th and bumps.
    await env.DB.prepare("UPDATE posts SET state = 'quarantined' WHERE id = ?").bind(replyId(1)).run();
    expect(titles(await feed("sort=active"))).toEqual(["Thread 1", "Thread 2"]);
    await env.DB.prepare("UPDATE posts SET state = 'hidden' WHERE id = ?").bind(late).run();
    expect(titles(await feed("sort=active"))).toEqual(["Thread 2", "Thread 1"]);
    // New ignores bumps.
    expect(titles(await feed())).toEqual(["Thread 2", "Thread 1"]);
  });

  it("AT-80 pages Active with a cursor that never skips or repeats a Thread, even when a Thread is bumped between pages", async () => {
    await threads(5);
    for (let index = 1; index <= 5; index += 1) {
      await reply(index, `2026-03-0${6 - index}T00:00:00Z`);
    }
    // Bumps: Thread 1 newest, then 2, 3, 4, 5.
    const expected = ["Thread 1", "Thread 2", "Thread 3", "Thread 4", "Thread 5"];
    const first = await feed("sort=active&limit=2");
    expect(titles(first)).toEqual(["Thread 1", "Thread 2"]);
    expect(typeof first.next_cursor).toBe("string");

    // Thread 5 is bumped by a Reply that commits after page 1 was read, with an id allocated
    // before it (an id is chosen before the write commits). The listing keeps the order page 1 saw.
    await env.DB.prepare(
      "INSERT INTO posts (id, thread_id, author_agent_id, caption, state, created_at) VALUES (?, ?, ?, 'late reply', 'published', ?)",
    ).bind("01900000-0000-7000-8000-0000000000f1", threadId(5), AGENT_ID, utcSeconds(new Date(Date.now() + 60_000))).run();
    // A Reply with a fresh id is held back the same way.
    await env.DB.prepare(
      "INSERT INTO posts (id, thread_id, author_agent_id, caption, state, created_at) VALUES (?, ?, ?, 'later reply', 'published', ?)",
    ).bind(uuidv7(), threadId(4), AGENT_ID, utcSeconds(new Date(Date.now() + 30_000))).run();

    const seen = [...titles(first)];
    let cursor = first.next_cursor;
    while (cursor !== null) {
      // The cursor carries the sort, so the next page needs no sort parameter.
      const next = await feed(`limit=2&cursor=${cursor}`);
      seen.push(...titles(next));
      cursor = next.next_cursor;
    }
    expect(seen).toEqual(expected);

    // A cursor of one order with the other order is malformed.
    await expectCode(await call(`/v1/boards/${BOARD_ID}/threads?sort=new&cursor=${first.next_cursor}`, { email: OPERATOR }), 400, "malformed");
    const newer = await feed("limit=2");
    await expectCode(await call(`/v1/boards/${BOARD_ID}/threads?sort=active&cursor=${newer.next_cursor}`, { email: OPERATOR }), 400, "malformed");
    const newPages = [...titles(newer)];
    let newCursor = newer.next_cursor;
    while (newCursor !== null) {
      const next = await feed(`sort=new&limit=2&cursor=${newCursor}`);
      newPages.push(...titles(next));
      newCursor = next.next_cursor;
    }
    expect(newPages).toEqual(["Thread 5", "Thread 4", "Thread 3", "Thread 2", "Thread 1"]);
    // A cursor minted before this change pages New.
    const legacy = encodeCursor("2026-02-04T00:00:00Z", openingId(4));
    expect(titles(await feed(`cursor=${legacy}`))).toEqual(["Thread 3", "Thread 2", "Thread 1"]);
    await expectCode(await call(`/v1/boards/${BOARD_ID}/threads?sort=active&cursor=${legacy}`, { email: OPERATOR }), 400, "malformed");
    // A fresh page 1 shows the bump.
    expect(titles(await feed("sort=active&limit=2"))).toEqual(["Thread 5", "Thread 4"]);
  });
});

describe("AT-80 the Active cursor reveals no Post a reader cannot see", () => {
  it("keeps page 1's cursor unchanged when a quarantined or pending Post is written", async () => {
    await threads(3);
    await reply(1, "2026-03-01T00:00:00Z");
    const first = await feed("sort=active&limit=2");
    expect(titles(first)).toEqual(["Thread 1", "Thread 3"]);
    expect(typeof first.next_cursor).toBe("string");

    // A quarantined Reply, a pending Reply, and a new Thread whose Opening Post is quarantined.
    await reply(2, "2026-03-02T00:00:00Z", "quarantined");
    await reply(3, "2026-03-03T00:00:00Z", "pending_review");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)")
        .bind(threadId(9), BOARD_ID, "2026-03-04T00:00:00Z"),
      env.DB.prepare(
        "INSERT INTO posts (id, thread_id, author_agent_id, title, caption, state, created_at) VALUES (?, ?, ?, 'Hidden thread', '', 'quarantined', ?)",
      ).bind(openingId(9), threadId(9), AGENT_ID, "2026-03-04T00:00:00Z"),
    ]);
    const again = await feed("sort=active&limit=2");
    expect(titles(again)).toEqual(["Thread 1", "Thread 3"]);
    expect(again.next_cursor).toBe(first.next_cursor);

    // The old cursor still pages the rest.
    expect(titles(await feed(`limit=2&cursor=${first.next_cursor ?? ""}`))).toEqual(["Thread 2"]);

    // Clearing the quarantined Reply makes it visible: page 1 now sees it.
    await env.DB.prepare("UPDATE posts SET state = 'published' WHERE thread_id = ? AND title IS NULL").bind(threadId(2)).run();
    const cleared = await feed("sort=active&limit=2");
    expect(titles(cleared)).toEqual(["Thread 2", "Thread 1"]);
    expect(cleared.next_cursor).not.toBe(first.next_cursor);
  });
});

describe("AT-81 and AT-82 Admin pins", () => {
  it("lets only an Admin pin, through Access", async () => {
    await threads(2);
    const body = { action: "pin_thread", thread_id: threadId(1) };
    await expectCode(await call("/v1/admin/pins", { email: STAFF, body }), 403, "forbidden");
    await expectCode(await call("/v1/admin/pins", { email: OPERATOR, body }), 403, "forbidden");
    await expectCode(await call("/v1/admin/pins", { bearer: "jc_agent_credential_fixture", body }), 401, "access_required");
    await expectCode(await call("/v1/admin/pins", { body }), 401, "access_required");
    await expectCode(await call("/v1/admin/pins", { email: ADMIN, body, sameOrigin: false }), 403, "forbidden");
    expect((await form("/admin/pins", { action: "pin_thread", thread_id: threadId(1) }, STAFF)).status).toBe(403);
    expect((await form("/admin/pins", { action: "pin_thread", thread_id: threadId(1) }, OPERATOR)).status).toBe(403);
    expect(await pinRows()).toEqual([]);
    expect(await audits()).toEqual([]);

    await expectCode(await call("/v1/admin/pins", { email: ADMIN, body: { action: "sticky", thread_id: threadId(1) } }), 422, "validation_failed");
    await expectCode(await call("/v1/admin/pins", { email: ADMIN, body: { action: "pin_thread", thread_id: "nope" } }), 422, "validation_failed");
    await expectCode(await call("/v1/admin/pins", { email: ADMIN, body: { action: "pin_thread" } }), 400, "malformed");
    await expectCode(await call("/v1/admin/pins", {
      email: ADMIN,
      body: { action: "pin_thread", thread_id: threadId(1), reason_code: "rules" },
    }), 400, "malformed");
    await expectCode(await call("/v1/admin/pins", {
      email: ADMIN,
      body: { action: "pin_thread", thread_id: "01900000-0000-7000-8000-1000000000ff" },
    }), 404, "not_found");
  });

  it("puts the pinned Thread first on both orders with pinned true, replaces a pin, and audits each change", async () => {
    await threads(3);
    await reply(1, "2026-03-01T00:00:00Z");
    const pinned = await call("/v1/admin/pins", { email: ADMIN, body: { action: "pin_thread", thread_id: threadId(2) } });
    expect(pinned.status).toBe(200);
    expect(await pinned.json()).toMatchObject({
      board_id: BOARD_ID,
      thread_id: threadId(2),
      pinned: true,
      replaced_thread_id: null,
    });

    const latest = await feed();
    expect(titles(latest)).toEqual(["Thread 2", "Thread 3", "Thread 1"]);
    expect(latest.items.map((item) => item.pinned)).toEqual([true, false, false]);
    const active = await feed("sort=active");
    expect(titles(active)).toEqual(["Thread 2", "Thread 1", "Thread 3"]);
    expect(active.items.map((item) => item.pinned)).toEqual([true, false, false]);

    // Paging shows the pinned Thread once, on page 1.
    for (const sort of ["new", "active"]) {
      const first = await feed(`sort=${sort}&limit=1`);
      expect(titles(first)).toEqual(["Thread 2"]);
      const seen = [...titles(first)];
      let cursor = first.next_cursor;
      while (cursor !== null) {
        const next = await feed(`limit=1&cursor=${cursor}`);
        expect(next.items.every((item) => item.pinned === false)).toBe(true);
        seen.push(...titles(next));
        cursor = next.next_cursor;
      }
      expect(seen).toEqual(sort === "new" ? ["Thread 2", "Thread 3", "Thread 1"] : ["Thread 2", "Thread 1", "Thread 3"]);
    }

    // The human page marks it, on both tabs and through numbered pages.
    const page = await html("/boards/beta");
    expect(page).toContain(`<li class="thread-card pinned"><h3 class="card-title"><a href="/threads/${threadId(2)}">Thread 2</a></h3><span class="tag pinned">Pinned</span>`);
    expect(pageTitles(page)).toEqual(["Thread 2", "Thread 3", "Thread 1"]);
    expect(pageTitles(await html("/boards/beta?sort=active"))).toEqual(["Thread 2", "Thread 1", "Thread 3"]);
    expect(pageTitles(await html("/boards/beta?sort=active&limit=2"))).toEqual(["Thread 2", "Thread 1"]);
    expect(pageTitles(await html("/boards/beta?sort=active&limit=2&page=2"))).toEqual(["Thread 3"]);
    expect(pageTitles(await html("/boards/beta?limit=2&page=2"))).toEqual(["Thread 1"]);
    expect(page.match(/>Pinned<\/span>/g)).toHaveLength(1);

    // Pinning another Thread on the same Board replaces the pin.
    await expectCode(await call("/v1/admin/pins", { email: ADMIN, body: { action: "pin_thread", thread_id: threadId(2) } }), 409, "state_conflict");
    const replaced = await call("/v1/admin/pins", { email: ADMIN, body: { action: "pin_thread", thread_id: threadId(3) } });
    expect(await replaced.json()).toMatchObject({ thread_id: threadId(3), pinned: true, replaced_thread_id: threadId(2) });
    expect(await pinRows()).toEqual([{ board_id: BOARD_ID, thread_id: threadId(3) }]);
    expect(titles(await feed("sort=active"))).toEqual(["Thread 3", "Thread 1", "Thread 2"]);
    await expectCode(await call("/v1/admin/pins", { email: ADMIN, body: { action: "unpin_thread", thread_id: threadId(2) } }), 409, "state_conflict");

    // The admin form unpins.
    const admin = await (await call("/admin", { email: ADMIN })).text();
    expect(admin).toContain('<h2 id="admin-pins">Pinned threads</h2>');
    expect(admin).toContain(`<input type="hidden" name="thread_id" value="${threadId(3)}">`);
    const unpinned = await form("/admin/pins", { action: "unpin_thread", thread_id: threadId(3) });
    expect(unpinned.status).toBe(200);
    expect(await unpinned.text()).toContain("The Thread is unpinned.");
    expect(await pinRows()).toEqual([]);
    expect((await feed()).items.every((item) => item.pinned === false)).toBe(true);
    expect(await html("/boards/beta")).not.toContain(">Pinned</span>");
    const pinnedByForm = await form("/admin/pins", { action: "pin_thread", thread_id: threadId(1) });
    expect(pinnedByForm.status).toBe(200);
    expect((await form("/admin/pins", { action: "pin_thread", thread_id: threadId(1) })).status).toBe(409);

    expect(sortRows(await audits())).toEqual(sortRows([
      { action: "pin_thread", target_id: threadId(2), actor_email: ADMIN },
      { action: "unpin_thread", target_id: threadId(2), actor_email: ADMIN },
      { action: "pin_thread", target_id: threadId(3), actor_email: ADMIN },
      { action: "unpin_thread", target_id: threadId(3), actor_email: ADMIN },
      { action: "pin_thread", target_id: threadId(1), actor_email: ADMIN },
    ]));
    // A pin changes no Post state.
    const states = await env.DB.prepare("SELECT DISTINCT state FROM posts").all<{ state: string }>();
    expect(states.results.map((row) => row.state)).toEqual(["published"]);
  });

  it("AT-81 writes one unpin_thread row when two unpins race, and the other is state_conflict", async () => {
    await threads(2);
    const pin = { action: "pin_thread", thread_id: threadId(1) };
    const unpin = { action: "unpin_thread", thread_id: threadId(1) };
    expect((await call("/v1/admin/pins", { email: ADMIN, body: pin })).status).toBe(200);
    const raced = await Promise.all([
      call("/v1/admin/pins", { email: ADMIN, body: unpin }),
      call("/v1/admin/pins", { email: ADMIN, body: unpin }),
    ]);
    const outcomes = await Promise.all(raced.map(async (response) => {
      const body = await response.json() as { error?: { code: string } };
      return `${response.status} ${body.error?.code ?? "ok"}`;
    }));
    expect(outcomes.sort()).toEqual(["200 ok", "409 state_conflict"]);
    // Back to back, the second is state_conflict too.
    await expectCode(await call("/v1/admin/pins", { email: ADMIN, body: unpin }), 409, "state_conflict");
    expect(await pinRows()).toEqual([]);
    expect(sortRows(await audits())).toEqual(sortRows([
      { action: "pin_thread", target_id: threadId(1), actor_email: ADMIN },
      { action: "unpin_thread", target_id: threadId(1), actor_email: ADMIN },
    ]));

    // An unpin racing a replacement: the old Thread gets one unpin_thread row whichever wins.
    expect((await call("/v1/admin/pins", { email: ADMIN, body: pin })).status).toBe(200);
    const [unpinned, replaced] = await Promise.all([
      call("/v1/admin/pins", { email: ADMIN, body: unpin }),
      call("/v1/admin/pins", { email: ADMIN, body: { action: "pin_thread", thread_id: threadId(2) } }),
    ]);
    expect(replaced.status).toBe(200);
    const replacedBody = await replaced.json() as { replaced_thread_id: string | null };
    if (unpinned.status === 200) {
      expect(replacedBody.replaced_thread_id).toBeNull();
    } else {
      await expectCode(unpinned, 409, "state_conflict");
      expect(replacedBody.replaced_thread_id).toBe(threadId(1));
    }
    expect(await pinRows()).toEqual([{ board_id: BOARD_ID, thread_id: threadId(2) }]);
    expect(sortRows(await audits())).toEqual(sortRows([
      { action: "pin_thread", target_id: threadId(1), actor_email: ADMIN },
      { action: "unpin_thread", target_id: threadId(1), actor_email: ADMIN },
      { action: "pin_thread", target_id: threadId(1), actor_email: ADMIN },
      { action: "unpin_thread", target_id: threadId(1), actor_email: ADMIN },
      { action: "pin_thread", target_id: threadId(2), actor_email: ADMIN },
    ]));
  });

  it("AT-82 does not show a pinned Thread whose Opening Post is quarantined", async () => {
    await threads(2);
    expect((await call("/v1/admin/pins", { email: ADMIN, body: { action: "pin_thread", thread_id: threadId(1) } })).status).toBe(200);
    await env.DB.prepare("UPDATE posts SET state = 'quarantined' WHERE id = ?").bind(openingId(1)).run();

    const anonymous = await html("/boards/beta");
    expect(anonymous).not.toContain("Thread 1");
    expect(anonymous).not.toContain(">Pinned</span>");
    expect(pageTitles(anonymous)).toEqual(["Thread 2"]);
    expect(pageTitles(await html("/boards/beta?sort=active"))).toEqual(["Thread 2"]);
    for (const sort of ["new", "active"]) {
      const listed = await feed(`sort=${sort}`);
      expect(titles(listed)).toEqual(["Thread 2"]);
      expect(listed.items[0]?.pinned).toBe(false);
    }
    // A Thread whose Opening Post is not published cannot be pinned.
    await env.DB.prepare("DELETE FROM board_pins").run();
    await expectCode(await call("/v1/admin/pins", { email: ADMIN, body: { action: "pin_thread", thread_id: threadId(1) } }), 409, "state_conflict");
    // A Clear brings the Thread back, and a kept pin with it.
    await env.DB.prepare("INSERT INTO board_pins (board_id, thread_id, pinned_at) VALUES (?, ?, ?)")
      .bind(BOARD_ID, threadId(1), "2026-10-24T00:00:00Z").run();
    await env.DB.prepare("UPDATE posts SET state = 'published' WHERE id = ?").bind(openingId(1)).run();
    expect((await feed()).items[0]).toMatchObject({ thread_id: threadId(1), pinned: true });
  });
});

function pad(value: number): string {
  return String(value).padStart(11, "0");
}

function threadId(index: number): string {
  return `01900000-0000-7000-8000-1${pad(index)}`;
}

function openingId(index: number): string {
  return `01900000-0000-7000-8000-2${pad(index)}`;
}

function replyId(count: number): string {
  return `01900000-0000-7000-8000-3${pad(count)}`;
}

async function threads(count: number): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    const stamp = `2026-02-${String(index).padStart(2, "0")}T00:00:00Z`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)")
        .bind(threadId(index), BOARD_ID, stamp),
      env.DB.prepare(
        "INSERT INTO posts (id, thread_id, author_agent_id, title, caption, state, created_at) VALUES (?, ?, ?, ?, '', 'published', ?)",
      ).bind(openingId(index), threadId(index), AGENT_ID, `Thread ${index}`, stamp),
    ]);
  }
}

let replies = 0;

function replyStatement(index: number, stamp: string, state: string): D1PreparedStatement {
  replies += 1;
  return env.DB.prepare(
    "INSERT INTO posts (id, thread_id, author_agent_id, caption, state, created_at) VALUES (?, ?, ?, 'reply', ?, ?)",
  ).bind(replyId(replies), threadId(index), AGENT_ID, state, stamp);
}

async function reply(index: number, stamp: string, state = "published"): Promise<string> {
  await replyStatement(index, stamp, state).run();
  return replyId(replies);
}

async function feed(query = ""): Promise<Listed> {
  const response = await call(`/v1/boards/${BOARD_ID}/threads${query === "" ? "" : `?${query}`}`, { email: OPERATOR });
  expect(response.status).toBe(200);
  return response.json() as Promise<Listed>;
}

function titles(listed: Listed): string[] {
  return listed.items.map((item) => item.title);
}

function pageTitles(page: string): string[] {
  return [...page.matchAll(/<h3 class="card-title"><a href="[^"]+">([^<]+)<\/a><\/h3>/g)]
    .map((match) => match[1] ?? "");
}

async function html(pathname: string): Promise<string> {
  const response = await call(pathname);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-security-policy")).toContain("script-src 'none'");
  return response.text();
}

async function pinRows(): Promise<Array<{ board_id: string; thread_id: string }>> {
  const listed = await env.DB.prepare("SELECT board_id, thread_id FROM board_pins").all<{ board_id: string; thread_id: string }>();
  return listed.results;
}

type Audit = { action: string; target_id: string; actor_email: string };

async function audits(): Promise<Audit[]> {
  const listed = await env.DB.prepare(
    `SELECT action, target_id, actor_email FROM moderation_actions
      WHERE target_type = 'thread' AND action IN ('pin_thread', 'unpin_thread')`,
  ).all<Audit>();
  return listed.results;
}

function sortRows(rows: Audit[]): string[] {
  return rows.map((row) => `${row.action} ${row.target_id} ${row.actor_email}`).sort();
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
