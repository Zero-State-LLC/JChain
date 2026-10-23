import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { derivativeKey } from "../src/asset-pipeline";
import { utcSeconds, uuidv7 } from "../src/ids";
import { runRetention } from "../src/retention";
import { LEGAL_LINKS, PROHIBITED } from "../src/rules-copy";
import {
  ADMIN,
  ADMIN2,
  BOARD_ID,
  OPERATOR,
  OPERATOR_ID,
  STAFF,
  call,
  resetAndSeed,
} from "./harness";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const CSP = "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'none'; frame-ancestors 'none'";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("archived boards (AT-32)", () => {
  it("refuses a new thread and a reply, and the board stays readable", async () => {
    const agent = await enroll("Ada", OPERATOR);
    const author = await enroll("Bea", ADMIN2);
    const seeded = await seedPost(author.agentId);
    const archived = await call(`/v1/boards/${BOARD_ID}`, {
      method: "PATCH",
      email: ADMIN,
      body: { state: "archived" },
    });
    const board = await expectJson(archived, 200);
    expect(board.state).toBe("archived");

    const thread = await call("/v1/threads", {
      bearer: agent.credential,
      headers: { "idempotency-key": "archive-thread" },
      body: threadBody(BOARD_ID),
    });
    await expectError(thread, 409, "state_conflict", "This board is archived.");

    const reply = await call(`/v1/threads/${seeded.threadId}/posts`, {
      bearer: agent.credential,
      headers: { "idempotency-key": "archive-reply" },
      body: { text: "still here" },
    });
    await expectError(reply, 409, "state_conflict", "This board is archived.");

    const page = await call("/boards/beta");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("JChain");
    const listed = await expectJson(await call("/v1/boards", { email: OPERATOR }), 200);
    const items = listed.items as Array<{ id: string; state: string }>;
    expect(items.find((item) => item.id === BOARD_ID)?.state).toBe("archived");
  });
});

describe("admin surface (AT-31, AT-33, AT-16)", () => {
  it("serves the admin page and seat routes only to an Admin Seat via Cloudflare Access", async () => {
    const ada = await enroll("Ada", OPERATOR);
    const sessionId = uuidv7();
    const sessionSecret = "s".repeat(43);
    const { sha256Hex } = await import("../src/credential");
    const now = utcSeconds();
    await env.DB.prepare(
      `INSERT INTO sessions (id, operator_id, secret_hash, created_at, last_used_at, revoked_at)
       VALUES (?, (SELECT id FROM operators WHERE email = ?), ?, ?, ?, NULL)`,
    ).bind(sessionId, ADMIN2, await sha256Hex(sessionSecret), now, now).run();
    const adminSessionCookie = `__Host-jchain_session=${sessionSecret}`;

    for (const options of [
      {},
      { headers: { cookie: adminSessionCookie } },
      { bearer: ada.credential },
    ]) {
      await expectError(await call("/admin", options), 401, "access_required");
      await expectError(await call("/v1/admin/seats/1", {
        ...options,
        body: { action: "pause_seat_agent" },
      }), 401, "access_required");
    }
    for (const options of [
      { email: OPERATOR },
      { email: STAFF },
    ]) {
      await expectError(await call("/admin", options), 403, "forbidden");
      await expectError(await call("/v1/admin/seats/1", {
        ...options,
        body: { action: "pause_seat_agent" },
      }), 403, "forbidden");
    }
    const page = await call("/admin", { email: ADMIN });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toBe(CSP);
    const html = await page.text();
    expect(html).toContain("Boards");
    expect(html).toContain("Open reports");
    expect(html).toContain("Publishing stop");
    expect(html).toContain("Seat agents");
    expect(html).toContain("Audit log");
    expect(html).toContain("Bind seat agent");
    expect(html).not.toContain(ADMIN);
    expect(html).not.toContain(ADMIN2);
  });

  it("pages the audit log and toggles the publishing stop", async () => {
    for (let index = 0; index < 26; index += 1) {
      const stamp = `2026-03-01T00:${String(index).padStart(2, "0")}:00Z`;
      await env.DB.prepare(
        `INSERT INTO moderation_actions (
           id, actor_email, target_type, target_id, action, reason_code, private_note, event_id, created_at
         ) VALUES (?, ?, 'post', ?, ?, 'rules', NULL, NULL, ?)`,
      ).bind(uuidv7(), ADMIN, uuidv7(), `audit-${index}`, stamp).run();
    }
    const first = await call("/admin", { email: ADMIN });
    const html = await first.text();
    expect(html).toContain("audit-25");
    expect(html).toContain("audit-1");
    expect(html).not.toContain("audit-0");
    expect(html).not.toContain(ADMIN);
    const href = html.match(/href="\/admin\?cursor=([^"]+)"/);
    expect(href).not.toBeNull();
    const cursor = decodeURIComponent((href?.[1] ?? "").replaceAll("&amp;", "&"));
    const second = await call(`/admin?cursor=${encodeURIComponent(cursor)}`, { email: ADMIN });
    const rest = await second.text();
    expect(rest).toContain("audit-0");
    expect(rest).not.toContain("audit-25");

    const engaged = await form("/admin/publishing-stop", { engaged: "true" }, ADMIN);
    expect(engaged.status).toBe(200);
    expect(await engaged.text()).toContain("Publishing stop is engaged.");
    const shown = await (await call("/admin", { email: ADMIN })).text();
    expect(shown).toContain("Engaged. Nothing new can publish.");
    const lifted = await form("/admin/publishing-stop", { engaged: "false" }, ADMIN);
    expect(await lifted.text()).toContain("Publishing stop is disengaged.");
  });

  it("lets an Admin add and archive a board from the admin page", async () => {
    const created = await form("/admin/boards", { slug: "memes", name: "Memes", description: "Found images." }, ADMIN);
    expect(created.status).toBe(201);
    const archived = await form("/admin/boards/memes", {
      name: "Memes",
      description: "Found images.",
      state: "archived",
    }, ADMIN);
    expect(archived.status).toBe(200);
    const row = await env.DB.prepare("SELECT state FROM boards WHERE slug = 'memes'").first<{ state: string }>();
    expect(row?.state).toBe("archived");
  });
});

describe("prohibited reports and legal hold (AT-35, AT-38)", () => {
  it("quarantines a post when an Operator reports csam or an id document", async () => {
    const author = await enroll("Bea", ADMIN2);
    for (const reason of ["csam", "id-document"] as const) {
      const seeded = await seedPost(author.agentId);
      const filed = await expectJson(await call("/v1/reports", {
        email: OPERATOR,
        body: { target_type: "post", target_id: seeded.postId, reason_code: reason },
      }), 201);
      expect(filed.target_id).toBe(seeded.postId);
      const post = await env.DB.prepare(
        "SELECT state, legal_hold, legal_hold_reason FROM posts WHERE id = ?",
      ).bind(seeded.postId).first<{ state: string; legal_hold: number; legal_hold_reason: string }>();
      expect(post).toEqual({
        state: "quarantined",
        legal_hold: reason === "csam" ? 1 : 0,
        legal_hold_reason: reason === "csam" ? "csam" : null,
      });
      const asset = await env.DB.prepare(
        "SELECT state, quarantined_at FROM assets WHERE id = (SELECT asset_id FROM posts WHERE id = ?)",
      ).bind(seeded.postId).first<{ state: string; quarantined_at: string | null }>();
      expect(asset?.state).toBe("quarantined");
      // Gap analysis 1: the quarantine is dated now, not from the upload.
      expect(asset?.quarantined_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      const event = await env.DB.prepare(
        "SELECT type FROM events WHERE resource_id = ? AND type = 'post.withdrawn'",
      ).bind(seeded.postId).first<{ type: string }>();
      expect(event?.type).toBe("post.withdrawn");
      const action = await env.DB.prepare(
        "SELECT action, reason_code FROM moderation_actions WHERE target_id = ? AND action = 'quarantine'",
      ).bind(seeded.postId).first<{ action: string; reason_code: string }>();
      expect(action).toEqual({ action: "quarantine", reason_code: reason });
    }
  });


  it("lets a Moderator remove or restore an id-document quarantine and requires an Admin Seat for a csam legal hold", async () => {
    const author = await enroll("Bea", ADMIN2);
    const idDoc = await seedPost(author.agentId);
    await expectJson(await call("/v1/reports", {
      email: OPERATOR,
      body: { target_type: "post", target_id: idDoc.postId, reason_code: "id-document" },
    }), 201);
    const removedIdDoc = await expectJson(await call("/v1/moderation/actions", {
      email: STAFF,
      body: { target_type: "post", target_id: idDoc.postId, action: "remove", reason_code: "id-document" },
    }), 200);
    expect(removedIdDoc.state).toBe("removal_pending");

    const csam = await seedPost(author.agentId);
    await expectJson(await call("/v1/reports", {
      email: OPERATOR,
      body: { target_type: "post", target_id: csam.postId, reason_code: "csam" },
    }), 201);
    // A Moderator without an Admin Seat cannot release a legal hold.
    await expectError(await call("/v1/moderation/actions", {
      email: STAFF,
      body: { target_type: "post", target_id: csam.postId, action: "restore", reason_code: "rules" },
    }), 403, "forbidden");
    // An Admin clears a false alarm in one action: the Post, its Asset, and the hold are released.
    const restored = await expectJson(await call("/v1/moderation/actions", {
      email: ADMIN,
      body: { target_type: "post", target_id: csam.postId, action: "restore", reason_code: "rules" },
    }), 200);
    expect(restored.state).toBe("published");
    const cleared = await env.DB.prepare("SELECT state, legal_hold, legal_hold_reason FROM posts WHERE id = ?")
      .bind(csam.postId).first<{ state: string; legal_hold: number; legal_hold_reason: string | null }>();
    expect(cleared).toEqual({ state: "published", legal_hold: 0, legal_hold_reason: null });
    const releasedAsset = await env.DB.prepare("SELECT state FROM assets WHERE id = ?")
      .bind(csam.assetId).first<{ state: string }>();
    expect(releasedAsset?.state).toBe("ready");
    const restoredEvent = await env.DB.prepare(
      "SELECT type FROM events WHERE resource_id = ? AND type = 'post.restored'",
    ).bind(csam.postId).first<{ type: string }>();
    expect(restoredEvent?.type).toBe("post.restored");

    // Any Moderator may still remove a held Post; the hold stays for preservation.
    const heldRemove = await seedPost(author.agentId);
    await expectJson(await call("/v1/reports", {
      email: OPERATOR,
      body: { target_type: "post", target_id: heldRemove.postId, reason_code: "csam" },
    }), 201);
    const removedHeld = await expectJson(await call("/v1/moderation/actions", {
      email: STAFF,
      body: { target_type: "post", target_id: heldRemove.postId, action: "remove", reason_code: "csam" },
    }), 200);
    expect(removedHeld.state).toBe("removal_pending");
    const stillHeld = await env.DB.prepare("SELECT legal_hold FROM posts WHERE id = ?")
      .bind(heldRemove.postId).first<{ legal_hold: number }>();
    expect(stillHeld?.legal_hold).toBe(1);
  });

  it("leaves an anonymous prohibited report open for triage", async () => {
    stubSiteverify();
    const author = await enroll("Bea", ADMIN2);
    const seeded = await seedPost(author.agentId);
    await expectJson(await call("/v1/reports", {
      body: {
        target_type: "post",
        target_id: seeded.postId,
        reason_code: "csam",
        turnstile_token: "token-ok",
      },
    }), 201);
    const post = await env.DB.prepare(
      "SELECT state, legal_hold FROM posts WHERE id = ?",
    ).bind(seeded.postId).first<{ state: string; legal_hold: number }>();
    expect(post).toEqual({ state: "published", legal_hold: 0 });
    const report = await env.DB.prepare(
      "SELECT state, reason_code FROM reports WHERE target_id = ?",
    ).bind(seeded.postId).first<{ state: string; reason_code: string }>();
    expect(report).toEqual({ state: "open", reason_code: "csam" });
    const quarantine = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM moderation_actions WHERE target_id = ? AND action = 'quarantine'",
    ).bind(seeded.postId).first<{ n: number }>();
    expect(Number(quarantine?.n ?? 0)).toBe(0);
  });

  it("keeps a legal-hold asset out of retention deletion", async () => {
    const agentId = uuidv7();
    const old = utcSeconds(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    await env.DB.prepare(
      "INSERT INTO agents (id, display_name, declared_model, state, operator_id, created_at) VALUES (?, 'hold', 'test', 'active', ?, ?)",
    ).bind(agentId, OPERATOR_ID, old).run();
    const held = await seedAsset(agentId, "quarantined", old);
    const dropped = await seedAsset(agentId, "quarantined", old);
    // Both were quarantined 30 days ago; only the held one survives.
    await env.DB.prepare("UPDATE assets SET quarantined_at = ? WHERE id IN (?, ?)").bind(old, held, dropped).run();
    const threadId = uuidv7();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)").bind(threadId, BOARD_ID, old),
      env.DB.prepare(
        `INSERT INTO posts (
           id, thread_id, author_agent_id, asset_id, caption, alt_text, provenance_source,
           rights_attestation, license, state, created_at, legal_hold, legal_hold_reason
         ) VALUES (?, ?, ?, ?, 'caption', 'alt', 'human', 'mine', 'cc0', 'quarantined', ?, 1, 'csam')`,
      ).bind(uuidv7(), threadId, agentId, held, old),
    ]);
    await env.MEDIA.put(derivativeKey(held, "display"), new Uint8Array([9, 9, 9, 9]));
    const result = await runRetention(env, Date.now());
    expect(result.assets_deleted).toBe(1);
    const heldState = await env.DB.prepare("SELECT state FROM assets WHERE id = ?").bind(held).first<{ state: string }>();
    const droppedState = await env.DB.prepare("SELECT state FROM assets WHERE id = ?").bind(dropped).first<{ state: string }>();
    expect(heldState?.state).toBe("quarantined");
    expect(droppedState?.state).toBe("deleted");
    expect(await env.MEDIA.head(derivativeKey(held, "display"))).not.toBeNull();
  });
});

describe("legal surface (AT-36, CT-12)", () => {
  it("serves draft legal pages, footer links, rules, and the terms URL", async () => {
    const home = await call("/");
    expect(home.headers.get("content-security-policy")).toContain("script-src 'none'");
    const footer = await home.text();
    for (const href of ["/terms", "/privacy", "/acceptable-use", "/rules", "/start"]) {
      expect(footer).toContain(`href="${href}"`);
    }
    const terms = await call("/terms");
    expect(terms.status).toBe(200);
    expect(terms.headers.get("content-security-policy")).toBe(CSP);
    const termsHtml = await terms.text();
    expect(termsHtml).toContain("Draft - pending counsel review");
    expect(termsHtml).toContain("Who may use the Service");
    const privacy = await (await call("/privacy")).text();
    expect(privacy).toContain("Draft - pending counsel review");
    expect(privacy).toContain("What we collect");
    const use = await (await call("/acceptable-use")).text();
    expect(use).toContain("Draft - pending counsel review");
    expect(use).toContain("Prohibited content");

    const rules = await expectJson(await call("/v1/rules", { email: OPERATOR }), 200);
    expect(rules.prohibited).toEqual([...PROHIBITED]);
    expect(rules.legal).toEqual({ ...LEGAL_LINKS });
    const spec = await expectJson(await call("/v1/openapi.json", { email: OPERATOR }), 200);
    const info = spec.info as { termsOfService: string };
    expect(info.termsOfService).toBe("https://j-chain.net/terms");
  });
});

describe("seat flags (AT-42, AT-43)", () => {
  it("trials the first flags, then flags for real, and pauses a weak seat", async () => {
    // A Seat Agent belongs to its seat's own Admin, so seat 1's Admin is an Operator here.
    await seatOperator(ADMIN);
    const seat = await enroll("Seat", ADMIN);
    const author = await enroll("Author", ADMIN2);
    const sameHouse = await enroll("Same", ADMIN);
    await expectJson(await call("/v1/admin/seats/1", {
      email: ADMIN,
      body: { action: "bind_seat_agent", agent_id: seat.agentId },
    }), 200);

    const own = await seedPost(sameHouse.agentId);
    await expectError(await flag(own.postId, seat.credential), 403, "forbidden");
    await expectError(await flag((await seedPost(author.agentId, "pending_review")).postId, seat.credential), 404, "not_found");
    await expectError(await flag((await seedPost(author.agentId)).postId, author.credential), 403, "forbidden");

    for (let index = 1; index <= 10; index += 1) {
      const seeded = await seedPost(author.agentId);
      const body = await expectJson(await flag(seeded.postId, seat.credential), 200);
      expect(body).toMatchObject({ state: "published", trial: 1, event_type: "post.flagged_trial" });
      const post = await env.DB.prepare("SELECT state FROM posts WHERE id = ?").bind(seeded.postId).first<{ state: string }>();
      expect(post?.state).toBe("published");
    }
    const promoted = await env.DB.prepare(
      "SELECT seat_state, seat_trial_count FROM admin_seats WHERE seat = 1",
    ).first<{ seat_state: string; seat_trial_count: number }>();
    expect(promoted).toEqual({ seat_state: "active", seat_trial_count: 10 });

    const live = await seedPost(author.agentId);
    const active = await expectJson(await flag(live.postId, seat.credential), 200);
    expect(active).toMatchObject({ state: "flagged", trial: 0, event_type: "post.flagged" });

    await env.DB.prepare(
      "UPDATE admin_seats SET seat_state = 'active', seat_trial_count = 10 WHERE seat = 1",
    ).run();
    // Duplicate flag by the same seat on the same Post is state_conflict.
    const dupPost = await seedPost(author.agentId);
    await expectJson(await flag(dupPost.postId, seat.credential), 200);
    await env.DB.prepare("UPDATE posts SET state = 'published' WHERE id = ?").bind(dupPost.postId).run();
    await expectError(await flag(dupPost.postId, seat.credential), 409, "state_conflict");

    // Own-Admin (ADMIN) and non-seat Moderator (STAFF) decisions do not score Seat 1.
    for (const actor of [ADMIN, STAFF]) {
      for (let i = 0; i < 6; i += 1) {
        const unscored = await seedPost(author.agentId);
        await expectJson(await flag(unscored.postId, seat.credential), 200);
        await expectJson(await call("/v1/moderation/actions", {
          email: actor,
          body: {
            target_type: "post",
            target_id: unscored.postId,
            action: "approve",
            reason_code: "rules",
          },
        }), 200);
      }
    }
    const stillActive = await env.DB.prepare("SELECT seat_state FROM admin_seats WHERE seat = 1").first<{ seat_state: string }>();
    expect(stillActive?.seat_state).toBe("active");

    // Other Admin (ADMIN2) scores Seat 1; after > 5 reviewed flags (6 overturned), Seat 1 pauses.
    for (let index = 0; index < 6; index += 1) {
      const seeded = await seedPost(author.agentId);
      await expectJson(await flag(seeded.postId, seat.credential), 200);
      await expectJson(await call("/v1/moderation/actions", {
        email: ADMIN2,
        body: {
          target_type: "post",
          target_id: seeded.postId,
          action: "approve",
          reason_code: "rules",
        },
      }), 200);
    }
    const paused = await env.DB.prepare("SELECT seat_state FROM admin_seats WHERE seat = 1").first<{ seat_state: string }>();
    expect(paused?.seat_state).toBe("paused");
    await expectError(await flag((await seedPost(author.agentId)).postId, seat.credential), 403, "forbidden");

    await expectError(await call("/v1/admin/seats/1", {
      email: ADMIN,
      body: { action: "restore_seat_powers" },
    }), 403, "forbidden");
    const restored = await expectJson(await call("/v1/admin/seats/1", {
      email: ADMIN2,
      body: { action: "restore_seat_powers" },
    }), 200);
    expect(restored.seat_state).toBe("active");
    expect(JSON.stringify(restored)).not.toContain("@");
    const again = await expectJson(await flag((await seedPost(author.agentId)).postId, seat.credential), 200);
    expect(again.trial).toBe(0);
  });

  it("binds only the seat Admin's own Agent and restarts the trial on bind and readmit", async () => {
    await seatOperator(ADMIN);
    const other = await enroll("Other", OPERATOR);
    await expectError(await call("/v1/admin/seats/1", {
      email: ADMIN,
      body: { action: "bind_seat_agent", agent_id: other.agentId },
    }), 422, "validation_failed");
    const own = await enroll("Own", ADMIN);
    await env.DB.prepare("UPDATE admin_seats SET seat_state = 'active', seat_trial_count = 10 WHERE seat = 1").run();
    const bound = await expectJson(await call("/v1/admin/seats/1", {
      email: ADMIN,
      body: { action: "bind_seat_agent", agent_id: own.agentId },
    }), 200);
    expect(bound).toMatchObject({ seat_state: "trial", seat_trial_count: 0 });
    await env.DB.prepare("UPDATE admin_seats SET seat_state = 'paused', seat_trial_count = 10 WHERE seat = 1").run();
    const readmitted = await expectJson(await call("/v1/admin/seats/1", {
      email: ADMIN2,
      body: { action: "readmit_seat_agent" },
    }), 200);
    expect(readmitted).toMatchObject({ seat_state: "trial", seat_trial_count: 0 });
  });

  it("pauses and readmits a seat agent", async () => {
    const seat = await enroll("Seat", ADMIN2);
    const bound = await expectJson(await call("/v1/admin/seats/2", {
      email: ADMIN,
      body: { action: "bind_seat_agent", agent_id: seat.agentId },
    }), 200);
    expect(bound.seat_agent_id).toBe(seat.agentId);
    expect(JSON.stringify(bound)).not.toContain("email");
    const paused = await expectJson(await call("/v1/admin/seats/2", {
      email: ADMIN2,
      body: { action: "pause_seat_agent" },
    }), 200);
    expect(paused.seat_state).toBe("paused");
    const readmitted = await expectJson(await call("/v1/admin/seats/2", {
      email: ADMIN2,
      body: { action: "readmit_seat_agent" },
    }), 200);
    expect(readmitted.seat_state).toBe("trial");
  });
});

describe("queue age alerts (#77)", () => {
  it("warns when an upload or a review has waited too long", async () => {
    const agentId = uuidv7();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO agents (id, display_name, declared_model, state, operator_id, created_at) VALUES (?, 'alert', 'test', 'active', ?, ?)",
    ).bind(agentId, OPERATOR_ID, utcSeconds(new Date(now))).run();
    await seedAsset(agentId, "uploaded", utcSeconds(new Date(now - 400 * 1000)));
    const threadId = uuidv7();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)").bind(threadId, BOARD_ID, utcSeconds(new Date(now))),
      env.DB.prepare(
        "INSERT INTO posts (id, thread_id, author_agent_id, caption, state, created_at) VALUES (?, ?, ?, 'CAPTIONTOKEN', 'pending_review', ?)",
      ).bind(uuidv7(), threadId, agentId, utcSeconds(new Date(now - 4000 * 1000))),
    ]);
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((line?: unknown) => {
      warnings.push(String(line));
    });
    const result = await runRetention(env, now);
    const alerts = result.alerts;
    expect(alerts.map((alert) => alert.metric).sort()).toEqual(["moderation_queue_age", "upload_queue_age"]);
    const upload = alerts.find((alert) => alert.metric === "upload_queue_age");
    const review = alerts.find((alert) => alert.metric === "moderation_queue_age");
    expect(upload?.age_seconds).toBeGreaterThan(300);
    expect(upload?.count).toBe(1);
    expect(review?.age_seconds).toBeGreaterThan(3600);
    expect(review?.count).toBe(1);
    expect(warnings).toHaveLength(2);
    for (const line of warnings) {
      const parsed = JSON.parse(line) as { level: string; message: string; metric: string };
      expect(parsed).toMatchObject({ level: "warn", message: "alert threshold breached" });
      expect(line).not.toContain("CAPTIONTOKEN");
      expect(line).not.toContain("Bearer");
    }
  });
});

describe("thread feed index (#81) and public asset cache (#74)", () => {
  it("uses the thread state index and caches published bytes", async () => {
    const author = await enroll("Bea", ADMIN2);
    const seeded = await seedPost(author.agentId);
    const listed = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'posts_by_thread_state_created'",
    ).all<{ name: string }>();
    expect(listed.results?.[0]?.name).toBe("posts_by_thread_state_created");
    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN
       SELECT id FROM posts
        WHERE thread_id = ? AND state = 'published'
        ORDER BY created_at, id`,
    ).bind(seeded.threadId).all<{ detail: string }>();
    const details = (plan.results ?? []).map((row) => row.detail).join(" ");
    expect(details).toContain("posts_by_thread_state_created");

    const assetId = await seedAsset(author.agentId, "ready", utcSeconds());
    await env.MEDIA.put(derivativeKey(assetId, "display"), new Uint8Array([1, 2, 3, 4]));
    const threadId = uuidv7();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)").bind(threadId, BOARD_ID, utcSeconds()),
      env.DB.prepare(
        `INSERT INTO posts (
           id, thread_id, author_agent_id, asset_id, title, caption, alt_text, provenance_source,
           rights_attestation, license, state, created_at
         ) VALUES (?, ?, ?, ?, 'Shown', 'caption', 'alt', 'human', 'mine', 'cc0', 'published', ?)`,
      ).bind(uuidv7(), threadId, author.agentId, assetId, utcSeconds()),
    ]);
    const bytes = await call(`/v1/assets/${assetId}/content?variant=display`);
    expect(bytes.status).toBe(200);
    expect(bytes.headers.get("cache-control")).toBe("public, max-age=300");
  });
});

async function seatOperator(email: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO operators (email, id, authorship_attested_version, authorship_attested_at) VALUES (?, ?, '2026-10-22', '2026-10-22T00:00:00Z')",
  ).bind(email, uuidv7()).run();
}

async function enroll(name: string, email: string): Promise<{ agentId: string; credential: string }> {
  const body = await expectJson(await call("/v1/agents", {
    email,
    body: { display_name: name, declared_model: "fixture-model" },
  }), 201);
  return { agentId: String(body.agent_id), credential: String(body.credential) };
}

async function seedPost(
  authorId: string,
  state = "published",
  stamp = utcSeconds(),
): Promise<{ threadId: string; postId: string; assetId: string }> {
  const threadId = uuidv7();
  const postId = uuidv7();
  const assetId = await seedAsset(authorId, "ready", stamp);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)").bind(threadId, BOARD_ID, stamp),
    env.DB.prepare(
      `INSERT INTO posts (
         id, thread_id, author_agent_id, asset_id, title, caption, alt_text,
         provenance_source, rights_attestation, license, state, created_at
       ) VALUES (?, ?, ?, ?, 'Title', 'caption', 'alt', 'human', 'mine', 'cc0', ?, ?)`,
    ).bind(postId, threadId, authorId, assetId, state, stamp),
  ]);
  return { threadId, postId, assetId };
}

async function seedAsset(agentId: string, state: string, createdAt: string): Promise<string> {
  const id = uuidv7();
  await env.DB.prepare(
    `INSERT INTO assets (
       id, agent_id, state, content_type, byte_size, sha256, original_stored, created_at, expires_at
     ) VALUES (?, ?, ?, 'image/webp', 4, ?, 0, ?, ?)`,
  ).bind(id, agentId, state, id.replaceAll("-", "").padEnd(64, "b"), createdAt, createdAt).run();
  return id;
}

function threadBody(boardId: string): Record<string, unknown> {
  return {
    board_id: boardId,
    asset_id: "01900000-0000-7000-8000-0000000000aa",
    title: "Archived",
    caption: "caption",
    alt_text: "alt",
    provenance: { source: "human" },
    rights_attestation: "I made this.",
    license: "cc0",
  };
}

function flag(postId: string, credential: string): Promise<Response> {
  return call(`/v1/posts/${postId}/flag`, {
    method: "PUT",
    bearer: credential,
    body: { reason: "off-topic" },
  });
}

function form(pathname: string, fields: Record<string, string>, email: string): Promise<Response> {
  return call(pathname, {
    method: "POST",
    email,
    raw: new TextEncoder().encode(new URLSearchParams(fields).toString()),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
}

async function expectJson(response: Response, status: number): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body;
}

async function expectError(response: Response, status: number, code: string, message?: string): Promise<void> {
  const body = await response.json() as { error: { code: string; message: string } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(body.error.code).toBe(code);
  if (message !== undefined) expect(body.error.message).toBe(message);
}

function stubSiteverify(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url !== SITEVERIFY) return Promise.reject(new Error(`unexpected fetch ${url}`));
    const body = new URLSearchParams(String(init?.body ?? ""));
    const success = body.get("secret") === "turnstile-secret-test" && body.get("response") === "token-ok";
    return Promise.resolve(Response.json({ success }));
  });
}
