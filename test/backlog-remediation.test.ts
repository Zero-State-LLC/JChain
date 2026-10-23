import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { derivativeKey } from "../src/asset-pipeline";
import { utcSeconds, uuidv7 } from "../src/ids";
import { runRetention } from "../src/retention";
import { LEGAL_LINKS } from "../src/rules-copy";
import postpublishFixture from "./fixtures/policy-postpublish.json";
import {
  ADMIN,
  ADMIN2,
  BOARD_ID,
  OPERATOR,
  OPERATOR_ID,
  STAFF,
  call,
  clearSignInQuota,
  resetAndSeed,
} from "./harness";

const POSTPUBLISH = JSON.stringify(postpublishFixture);
type SentMail = { from: string; to: string; subject: string; text: string };

// The Worker env with an `auth` block and a stubbed send-email binding (as in ticket 36).
function signInEnv(sent: SentMail[]): Env {
  const auth = {
    signup_open: false,
    link_minutes: 15,
    session_days: 30,
    idle_days: 7,
    sessions_per_operator: 10,
    links_per_email_hour: 3,
    emails_per_day: 300,
    signups_per_day: 50,
    mail_from: "signin@jchain.example.test",
  };
  const policy = JSON.stringify({ ...JSON.parse(env.POLICY as string), auth });
  const binding = { send: async (message: SentMail) => { sent.push(message); return { messageId: "test" }; } };
  return new Proxy(env, {
    get(target, property) {
      if (property === "POLICY") return policy;
      if (property === "EMAIL") return binding;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Env;
}

async function signIn(bindings: Env, sent: SentMail[], email: string): Promise<string> {
  const headers = { "content-type": "application/x-www-form-urlencoded", origin: "https://jchain.example.test" };
  await call("/signin", { method: "POST", raw: new TextEncoder().encode(new URLSearchParams({ email }).toString()), headers, env: bindings });
  const token = sent.at(-1)?.text.match(/https:\/\/[^\s]+\/signin\/(sl_[A-Za-z0-9_-]{43})/)?.[1];
  expect(token).toBeDefined();
  const done = await call(`/signin/${token!}`, { method: "POST", headers: { origin: "https://jchain.example.test" }, env: bindings });
  expect(done.status).toBe(303);
  const secret = (done.headers.get("set-cookie") ?? "").match(/__Host-jc_session=(ss_[A-Za-z0-9_-]{43})/)?.[1];
  expect(secret).toBeDefined();
  return `__Host-jc_session=${secret!}`;
}

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

    // CT-06, CT-20: the state change is audited with a reason code; `rules` when none is given.
    await expectJson(await call(`/v1/boards/${BOARD_ID}`, {
      method: "PATCH",
      email: ADMIN,
      body: { state: "open", reason_code: "spam" },
    }), 200);
    await expectError(await call(`/v1/boards/${BOARD_ID}`, {
      method: "PATCH",
      email: ADMIN,
      body: { state: "archived", reason_code: "not-a-reason" },
    }), 422, "validation_failed");
    await expectError(await call(`/v1/boards/${BOARD_ID}`, {
      method: "PATCH",
      email: ADMIN,
      body: { name: "JChain", reason_code: "spam" },
    }), 400, "malformed");
    const audit = await env.DB.prepare(
      "SELECT action, reason_code FROM moderation_actions WHERE target_type = 'board' AND target_id = ? ORDER BY created_at, rowid",
    ).bind(BOARD_ID).all<{ action: string; reason_code: string }>();
    expect(audit.results.map((row) => [row.action, row.reason_code])).toEqual([
      ["archive_board", "rules"],
      ["unarchive_board", "spam"],
    ]);
  });
});

describe("admin surface (AT-31, AT-33, AT-16)", () => {
  it("serves the admin page and seat routes only to an Admin Seat via Cloudflare Access", async () => {
    const ada = await enroll("Ada", OPERATOR);
    // AT-31: a real Session, signed in by email as the seat-2 Admin (an Operator too),
    // with email sign-in on. The Session works on /operator and nowhere on the admin surface.
    const sent: SentMail[] = [];
    const bindings = signInEnv(sent);
    await env.DB.batch([env.DB.prepare("DELETE FROM sessions"), env.DB.prepare("DELETE FROM signin_links")]);
    await clearSignInQuota(ADMIN2);
    const adminSessionCookie = await signIn(bindings, sent, ADMIN2);
    expect((await call("/operator", { headers: { cookie: adminSessionCookie }, env: bindings })).status).toBe(200);

    for (const options of [
      {},
      { headers: { cookie: adminSessionCookie, origin: "https://jchain.example.test" }, env: bindings },
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
    // AT-38: the exact CT-12 descriptions.
    expect(rules.prohibited).toEqual([
      {
        code: "id-document",
        description: "Images or text of a government or personal identity document, such as a passport, driver's licence, national ID card, or social security card, real or forged.",
      },
      {
        code: "csam",
        description: "Any sexual depiction of a minor, including drawn, edited, or AI-generated images.",
      },
    ]);
    expect(rules.legal).toEqual({ ...LEGAL_LINKS });
    const spec = await expectJson(await call("/v1/openapi.json", { email: OPERATOR }), 200);
    const info = spec.info as { termsOfService: string; title: string; license: { name: string } };
    expect(info.termsOfService).toBe("https://j-chain.net/terms");
    // Part E: the document's title and license.
    expect(info.title).toBe("j-chain.net API");
    expect(info.license.name).toBe("Zero State Proprietary License");
    type Schema = { properties: Record<string, { enum?: string[] }> };
    type Operation = { requestBody: { content: { "application/json": { schema: Schema } } } };
    const paths = spec.paths as Record<string, Record<string, Operation>>;
    const moderation = paths["/v1/moderation/actions"]?.post?.requestBody.content["application/json"].schema.properties ?? {};
    expect(moderation.target_type?.enum).toEqual(["post", "thread", "agent", "asset", "operator"]);
    for (const action of [
      "approve_operator", "suspend_operator", "resume_operator", "remove_operator", "set_agent_cap", "change_email",
      "uphold", "dismiss_flags", "restore_asset", "revoke_handle", "quarantine",
    ]) {
      expect(moderation.action?.enum, action).toContain(action);
    }
    expect(moderation.reason_code?.enum).toContain("id-document");
    expect(moderation.reason_code?.enum).toContain("csam");
    expect(Object.keys(moderation)).toEqual(expect.arrayContaining(["value", "email"]));
    const reports = paths["/v1/reports"]?.post?.requestBody.content["application/json"].schema.properties ?? {};
    expect(reports.reason_code?.enum).toEqual(expect.arrayContaining(["id-document", "csam"]));
    const editBoard = paths["/v1/boards/{id}"]?.patch?.requestBody.content["application/json"].schema.properties ?? {};
    expect(editBoard.state?.enum).toEqual(["open", "archived"]);
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

    // Trial flags are shadow whatever the reason: the Post stays published and its image ready.
    const trialReasons = ["off-topic", "id-document", "csam"] as const;
    for (let index = 1; index <= 10; index += 1) {
      const seeded = await seedPost(author.agentId);
      const body = await expectJson(await flag(seeded.postId, seat.credential, trialReasons[index % 3]), 200);
      expect(body).toMatchObject({ state: "published", trial: 1, event_type: "post.flagged_trial" });
      const post = await env.DB.prepare(
        "SELECT posts.state AS state, posts.queue_first AS queue_first, assets.state AS asset_state FROM posts JOIN assets ON assets.id = posts.asset_id WHERE posts.id = ?",
      ).bind(seeded.postId).first<{ state: string; queue_first: number; asset_state: string }>();
      expect(post).toEqual({ state: "published", queue_first: 0, asset_state: "ready" });
      const withdrawn = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM events WHERE resource_id = ? AND type = 'post.withdrawn'",
      ).bind(seeded.postId).first<{ n: number }>();
      expect(Number(withdrawn?.n)).toBe(0);
    }
    const promoted = await env.DB.prepare(
      "SELECT seat_state, seat_trial_count FROM admin_seats WHERE seat = 1",
    ).first<{ seat_state: string; seat_trial_count: number }>();
    expect(promoted).toEqual({ seat_state: "active", seat_trial_count: 10 });

    // AT-42: one active off-topic flag only queues the Post; it stays published.
    const live = await seedPost(author.agentId);
    const active = await expectJson(await flag(live.postId, seat.credential), 200);
    expect(active).toMatchObject({ state: "published", trial: 0, event_type: "post.flagged" });

    await env.DB.prepare(
      "UPDATE admin_seats SET seat_state = 'active', seat_trial_count = 10 WHERE seat = 1",
    ).run();
    // Duplicate flag by the same seat on the same Post is state_conflict.
    const dupPost = await seedPost(author.agentId);
    await expectJson(await flag(dupPost.postId, seat.credential), 200);
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
            action: "dismiss_flags",
            reason_code: "rules",
          },
        }), 200);
      }
    }
    const stillActive = await env.DB.prepare("SELECT seat_state FROM admin_seats WHERE seat = 1").first<{ seat_state: string }>();
    expect(stillActive?.seat_state).toBe("active");
    // The accuracy gauge counts the same flags CT-22 does, so none of those twelve.
    expect(await (await call("/admin", { email: ADMIN })).text()).toMatch(
      /Seat 1<\/span> active, agent <code>[^<]+<\/code>\. Accuracy Not enough reviewed \(0\)/,
    );

    // Other Admin (ADMIN2) scores Seat 1; after > 5 reviewed flags (6 overturned), Seat 1 pauses.
    for (let index = 0; index < 6; index += 1) {
      const seeded = await seedPost(author.agentId);
      await expectJson(await flag(seeded.postId, seat.credential), 200);
      await expectJson(await call("/v1/moderation/actions", {
        email: ADMIN2,
        body: {
          target_type: "post",
          target_id: seeded.postId,
          action: "dismiss_flags",
          reason_code: "rules",
        },
      }), 200);
    }
    expect(await (await call("/admin", { email: ADMIN })).text()).toMatch(
      /Seat 1<\/span> paused, agent <code>[^<]+<\/code>\. Accuracy 0% of 6 reviewed/,
    );
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

  it("hides a Post and quarantines its image at once on one prohibited flag, in one batch (AT-42, C-12b)", async () => {
    await seatOperator(ADMIN);
    const seat = await enroll("Seat", ADMIN);
    const author = await enroll("Author", OPERATOR);
    await bindActive(1, seat.agentId);

    for (const reason of ["id-document", "csam"] as const) {
      const seeded = await seedPost(author.agentId);
      const body = await expectJson(await flag(seeded.postId, seat.credential, reason), 200);
      expect(body).toMatchObject({ post_id: seeded.postId, state: "hidden", trial: 0 });
      const post = await env.DB.prepare(
        "SELECT state, hidden_by, queue_first, legal_hold FROM posts WHERE id = ?",
      ).bind(seeded.postId).first<{ state: string; hidden_by: string; queue_first: number; legal_hold: number }>();
      // A Seat Flag places no legal hold; a Moderator decides that (Part D item 5).
      expect(post).toEqual({ state: "hidden", hidden_by: "seat_agents", queue_first: 1, legal_hold: 0 });
      const asset = await env.DB.prepare("SELECT state, quarantined_at FROM assets WHERE id = ?")
        .bind(seeded.assetId).first<{ state: string; quarantined_at: string | null }>();
      expect(asset?.state).toBe("quarantined");
      expect(asset?.quarantined_at).not.toBeNull();
      const blocked = await env.DB.prepare("SELECT prohibited FROM blocked_hashes WHERE asset_id = ?")
        .bind(seeded.assetId).all<{ prohibited: number }>();
      expect(blocked.results).toEqual([{ prohibited: 1 }]);
      const withdrawn = await env.DB.prepare(
        "SELECT id FROM events WHERE resource_id = ? AND type = 'post.withdrawn'",
      ).bind(seeded.postId).all<{ id: string }>();
      expect(withdrawn.results).toHaveLength(1);
      const audit = await env.DB.prepare(
        "SELECT actor_email, action, reason_code, event_id FROM moderation_actions WHERE target_id = ?",
      ).bind(seeded.postId).all<{ actor_email: string; action: string; reason_code: string; event_id: string }>();
      expect(audit.results).toEqual([
        { actor_email: "seat_agent", action: "hide", reason_code: reason, event_id: withdrawn.results?.[0]?.id },
      ]);
      const queue = await (await call("/moderation", { email: STAFF })).text();
      const firstLine = queue.slice(queue.indexOf('id="queue-first"'), queue.indexOf('id="reports"'));
      expect(firstLine).toContain(seeded.postId);
      expect(firstLine).toContain("seat hide");
      expect(firstLine).toContain("image quarantined");
      expect(firstLine).toContain(`name="target_id" value="${seeded.assetId}"`);
      // The Flagged section offers the Admin-only image restore, since a Post restore needs a ready image.
      const flaggedSection = queue.slice(queue.indexOf('id="queue-flagged"'), queue.indexOf('id="queue-quarantined"'));
      expect(flaggedSection).toContain(seeded.postId);
      expect(flaggedSection).toContain(`name="target_id" value="${seeded.assetId}"`);
      expect(flaggedSection).toContain('name="action" value="restore_asset"');
      expect(flaggedSection).toContain("Restore image (Admin)");
    }

    // A false positive is reversible from /moderation without an appeal: image first, then the Post.
    const falsePositive = await seedPost(author.agentId);
    await expectJson(await flag(falsePositive.postId, seat.credential, "id-document"), 200);
    await expectError(await call("/v1/moderation/actions", {
      email: ADMIN2,
      body: { target_type: "post", target_id: falsePositive.postId, action: "restore", reason_code: "other" },
    }), 409, "state_conflict");
    await expectJson(await call("/v1/moderation/actions", {
      email: ADMIN2,
      body: { target_type: "asset", target_id: falsePositive.assetId, action: "restore_asset", reason_code: "other" },
    }), 200);
    const restored = await expectJson(await call("/v1/moderation/actions", {
      email: ADMIN2,
      body: { target_type: "post", target_id: falsePositive.postId, action: "restore", reason_code: "other" },
    }), 200);
    expect(restored.state).toBe("published");
    const settled = await env.DB.prepare("SELECT outcome FROM seat_flags WHERE post_id = ?")
      .bind(falsePositive.postId).first<{ outcome: string }>();
    expect(settled?.outcome).toBe("overturned");
  });

  it("only queues a Post on one off-topic flag, and hides it when the other seat agrees (AT-42)", async () => {
    await seatOperator(ADMIN);
    const one = await enroll("SeatOne", ADMIN);
    const two = await enroll("SeatTwo", ADMIN2);
    const author = await enroll("Author", OPERATOR);
    await bindActive(1, one.agentId);
    await bindActive(2, two.agentId);
    const seeded = await seedPost(author.agentId);

    const first = await expectJson(await flag(seeded.postId, two.credential), 200);
    expect(first).toMatchObject({ state: "published", trial: 0, event_type: "post.flagged" });
    const queued = await env.DB.prepare("SELECT state, hidden_by, queue_first FROM posts WHERE id = ?")
      .bind(seeded.postId).first<{ state: string; hidden_by: string | null; queue_first: number }>();
    expect(queued).toEqual({ state: "published", hidden_by: null, queue_first: 1 });
    const queue = await (await call("/moderation", { email: STAFF })).text();
    const firstLine = queue.slice(queue.indexOf('id="queue-first"'), queue.indexOf('id="reports"'));
    expect(firstLine).toContain(seeded.postId);
    expect(firstLine).toContain("seat flag");
    // The Flags section lists the same queued Post for Hide, Remove, or Dismiss flags.
    const flagsSection = queue.slice(queue.indexOf('id="queue-flags"'), queue.indexOf('id="queue-flagged"'));
    expect(flagsSection).toContain(seeded.postId);
    expect(flagsSection).toContain("1 seat flag");
    const quiet = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM events WHERE resource_id = ? AND type = 'post.withdrawn') AS withdrawn,
              (SELECT COUNT(*) FROM moderation_actions WHERE target_id = ?) AS audits`,
    ).bind(seeded.postId, seeded.postId).first<{ withdrawn: number; audits: number }>();
    expect({ withdrawn: Number(quiet?.withdrawn), audits: Number(quiet?.audits) }).toEqual({ withdrawn: 0, audits: 0 });

    const second = await expectJson(await flag(seeded.postId, one.credential), 200);
    expect(second).toMatchObject({ state: "hidden", trial: 0 });
    const hidden = await env.DB.prepare(
      "SELECT posts.state AS state, posts.hidden_by AS hidden_by, posts.queue_first AS queue_first, assets.state AS asset_state FROM posts JOIN assets ON assets.id = posts.asset_id WHERE posts.id = ?",
    ).bind(seeded.postId).first<{ state: string; hidden_by: string; queue_first: number; asset_state: string }>();
    // An off-topic hide quarantines nothing and blocks no hash.
    expect(hidden).toEqual({ state: "hidden", hidden_by: "seat_agents", queue_first: 1, asset_state: "ready" });
    const blocked = await env.DB.prepare("SELECT COUNT(*) AS n FROM blocked_hashes").first<{ n: number }>();
    expect(Number(blocked?.n)).toBe(0);
    const audit = await env.DB.prepare("SELECT actor_email, action FROM moderation_actions WHERE target_id = ?")
      .bind(seeded.postId).all<{ actor_email: string; action: string }>();
    expect(audit.results).toEqual([{ actor_email: "seat_agent", action: "hide" }]);
    const withdrawn = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE resource_id = ? AND type = 'post.withdrawn'",
    ).bind(seeded.postId).first<{ n: number }>();
    expect(Number(withdrawn?.n)).toBe(1);
    const afterHide = await (await call("/moderation", { email: STAFF })).text();
    const flaggedSection = afterHide.slice(afterHide.indexOf('id="queue-flagged"'), afterHide.indexOf('id="queue-quarantined"'));
    expect(flaggedSection).toContain(seeded.postId);
    expect(afterHide.slice(afterHide.indexOf('id="queue-flags"'), afterHide.indexOf('id="queue-flagged"'))).not.toContain(seeded.postId);

    // The author appeals the seat hide (v0.2.29); a restore answers it and overturns both flags.
    const review = await expectJson(await call(`/v1/posts/${seeded.postId}/review`, { bearer: author.credential, policy: POSTPUBLISH }), 200);
    expect(review).toMatchObject({ state: "hidden", review_state: "hidden", hidden_by: "seat_agents" });
    expect(typeof review.appealable_until).toBe("string");
    const appealed = await call(`/v1/posts/${seeded.postId}/appeal`, {
      bearer: author.credential,
      headers: { "idempotency-key": "seat-hide-appeal" },
      body: {},
      policy: POSTPUBLISH,
    });
    expect(appealed.status).toBe(201);
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      logged.push(String(line));
    });
    await expectJson(await call("/v1/moderation/actions", {
      email: STAFF,
      body: { target_type: "post", target_id: seeded.postId, action: "restore", reason_code: "rules" },
    }), 200);
    vi.restoreAllMocks();
    // NFR-10: the decision on a seat hide logs its hide-to-decision time.
    const decided = logged.filter((line) => line.includes('"hide decided"')).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(decided).toEqual([expect.objectContaining({ post_id: seeded.postId, action: "restore", hidden_by: "seat_agents" })]);
    const flags = await env.DB.prepare("SELECT outcome FROM seat_flags WHERE post_id = ? ORDER BY seat")
      .bind(seeded.postId).all<{ outcome: string }>();
    expect(flags.results).toEqual([{ outcome: "overturned" }, { outcome: "overturned" }]);
    const answered = await env.DB.prepare("SELECT outcome FROM post_appeals WHERE post_id = ?")
      .bind(seeded.postId).first<{ outcome: string }>();
    expect(answered?.outcome).toBe("restore");
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

describe("export size guard (platform constraints)", () => {
  it("refuses an in-request export of a Board above 5,000 Posts and writes nothing", async () => {
    const author = await enroll("Ada", OPERATOR);
    const { threadId } = await seedPost(author.agentId);
    const exportCall = () => call("/v1/exports", { email: ADMIN, body: { board_id: BOARD_ID, purpose: "archive" } });
    expect((await exportCall()).status).toBe(201);
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
       INSERT INTO posts (id, thread_id, author_agent_id, caption, state, created_at)
       SELECT printf('01900000-0000-7000-8000-%012d', i), ?, ?, 'reply', 'published', ? FROM n`,
    ).bind(threadId, author.agentId, utcSeconds()).run();
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM exports").first<{ n: number }>();
    await expectError(await exportCall(), 409, "state_conflict");
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM exports").first<{ n: number }>();
    expect(Number(after?.n)).toBe(Number(before?.n));
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

function flag(
  postId: string,
  credential: string,
  reason: "off-topic" | "id-document" | "csam" = "off-topic",
): Promise<Response> {
  return call(`/v1/posts/${postId}/flag`, {
    method: "PUT",
    bearer: credential,
    body: { reason },
  });
}

// Bind a seat's Agent through the admin route, then end its trial so its flags act.
async function bindActive(seat: 1 | 2, agentId: string): Promise<void> {
  await expectJson(await call(`/v1/admin/seats/${seat}`, {
    email: seat === 1 ? ADMIN2 : ADMIN,
    body: { action: "bind_seat_agent", agent_id: agentId },
  }), 200);
  await env.DB.prepare("UPDATE admin_seats SET seat_state = 'active', seat_trial_count = 10 WHERE seat = ?").bind(seat).run();
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
