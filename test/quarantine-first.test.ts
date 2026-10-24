import { applyD1Migrations, createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { utcSeconds, uuidv7 } from "../src/ids";
import { derivativeKey } from "../src/asset-pipeline";
import { ALERT_SUBJECT } from "../src/moderator-alert";
import { clearNamedQuota } from "../src/quota";
import { runRetention } from "../src/retention";
import postpublishFixture from "./fixtures/policy-postpublish.json";
import {
  ADMIN, ADMIN2, ADMIN2_OPERATOR_ID, BOARD_ID, MODERATOR, OPERATOR, STAFF, call, clearSignInQuota, resetAndSeed,
} from "./harness";

// v0.2.36 quarantine-first moderation (Danny, 2026-10-23 3:44 PM PT): posting happens first, the
// system recommends a Post for moderation, messages the Moderators, and quarantines the Post until a
// Moderator clears or archives it.

const POSTPUBLISH = JSON.stringify(postpublishFixture);
const ORIGIN = "https://jchain.example.test";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SECRET_CAPTION = "obsidian-walrus-caption";
const SECRET_TITLE = "Quixotic Heron Title";
const AUTHOR_NAME = "Zephyrine";

const AUTH = {
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

type Sent = { from: string; to: string; subject: string; text: string };
type StubAi = { run(model: string, input: unknown): Promise<unknown> };

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetAndSeed();
  await clearNamedQuota(env, "moderator-alert");
  await clearNamedQuota(env, "auth");
  await clearNamedQuota(env, "ai");
  await clearNamedQuota(env, `operator:${ADMIN2_OPERATOR_ID}`);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AT-73 every system signal quarantines through one helper", () => {
  it("quarantines on a scan result in a non-S4 category, with no Blocked Hashes", async () => {
    const author = await enroll(AUTHOR_NAME, ADMIN2);
    const seeded = await seedPost(author.agentId);
    await pendingScan(seeded.postId);
    await runScan(scanEnv(stubAi({ response: "unsafe\nS10" })), seeded.postId);
    expect(await postRow(seeded.postId)).toEqual({ state: "quarantined", quarantined_by: "scan", queue_first: 1, legal_hold: 0 });
    expect(await assetRow(seeded.assetId)).toMatchObject({ state: "quarantined" });
    expect((await assetRow(seeded.assetId))?.quarantined_at).not.toBeNull();
    expect(await blockedCount(seeded.assetId)).toBe(0);
    expect(await withdrawn(seeded.postId)).toBe(1);
    expect(await audit(seeded.postId)).toEqual([{ actor_email: "system", action: "quarantine", reason_code: "scan_s10" }]);
  });

  it("leaves a Post published and listed for review when the scan fails", async () => {
    const author = await enroll(AUTHOR_NAME, ADMIN2);
    const seeded = await seedPost(author.agentId);
    await pendingScan(seeded.postId);
    await runScan(scanEnv(undefined), seeded.postId);
    expect((await postRow(seeded.postId))?.state).toBe("published");
    const flags = section(await page(STAFF), "queue-flags");
    expect(flags).toContain(seeded.postId);
    expect(flags).toContain("scan unscanned");
  });

  it("quarantines on a signed-in report of any reason, of a Post or a Thread", async () => {
    const author = await enroll(AUTHOR_NAME, ADMIN2);
    const post = await seedPost(author.agentId);
    await expectJson(await report(post.postId, "spam"), 201);
    expect(await postRow(post.postId)).toEqual({ state: "quarantined", quarantined_by: "report", queue_first: 1, legal_hold: 0 });
    expect((await assetRow(post.assetId))?.state).toBe("quarantined");
    expect(await blockedCount(post.assetId)).toBe(0);
    expect(await withdrawn(post.postId)).toBe(1);
    expect(await audit(post.postId, "quarantine")).toEqual([{ actor_email: OPERATOR, action: "quarantine", reason_code: "spam" }]);

    const thread = await seedPost(author.agentId);
    await expectJson(await call("/v1/reports", {
      email: OPERATOR,
      body: { target_type: "thread", target_id: thread.threadId, reason_code: "rules" },
    }), 201);
    expect((await postRow(thread.postId))?.state).toBe("quarantined");

    // An Agent report only queues.
    await expectJson(await call("/v1/reports", {
      email: OPERATOR,
      body: { target_type: "agent", target_id: author.agentId, reason_code: "spam" },
    }), 201);
    const agentRow = await env.DB.prepare("SELECT state FROM agents WHERE id = ?").bind(author.agentId).first<{ state: string }>();
    expect(agentRow?.state).toBe("active");
  });

  it("blocks hashes for a prohibited report and sets a legal hold only for csam", async () => {
    const author = await enroll(AUTHOR_NAME, ADMIN2);
    const idDoc = await seedPost(author.agentId);
    await expectJson(await report(idDoc.postId, "id-document"), 201);
    expect(await postRow(idDoc.postId)).toMatchObject({ state: "quarantined", legal_hold: 0 });
    expect(await blockedCount(idDoc.assetId)).toBeGreaterThan(0);
    const csam = await seedPost(author.agentId);
    await expectJson(await report(csam.postId, "csam"), 201);
    expect(await postRow(csam.postId)).toMatchObject({ state: "quarantined", legal_hold: 1 });
  });

  it("only queues an anonymous report, prohibited ones first", async () => {
    stubSiteverify();
    const author = await enroll(AUTHOR_NAME, ADMIN2);
    const seeded = await seedPost(author.agentId);
    await expectJson(await call("/v1/reports", {
      body: { target_type: "post", target_id: seeded.postId, reason_code: "spam", turnstile_token: "token-ok", detail: "anon-spam" },
    }), 201);
    await expectJson(await call("/v1/reports", {
      body: { target_type: "post", target_id: seeded.postId, reason_code: "csam", turnstile_token: "token-ok", detail: "anon-csam" },
    }), 201);
    expect((await postRow(seeded.postId))?.state).toBe("published");
    expect((await assetRow(seeded.assetId))?.state).toBe("ready");
    const reports = section(await page(STAFF), "reports");
    expect(reports.indexOf("anon-csam")).toBeGreaterThan(-1);
    expect(reports.indexOf("anon-spam")).toBeGreaterThan(reports.indexOf("anon-csam"));
  });
});

describe("AT-73 Seat Flags quarantine (CT-22, AT-42)", () => {
  it("quarantines on one active flag of any reason, and a trial flag stays shadow", async () => {
    const seat = await enroll("SeatTwo", ADMIN2);
    await expectJson(await call("/v1/admin/seats/2", {
      email: ADMIN,
      body: { action: "bind_seat_agent", agent_id: seat.agentId },
    }), 200);
    const author = await enroll(AUTHOR_NAME, OPERATOR);

    // In its trial the flag is recorded and changes nothing.
    const shadow = await seedPost(author.agentId);
    expect(await expectJson(await seatFlag(shadow.postId, seat.credential, "csam"), 200))
      .toMatchObject({ state: "published", trial: 1, event_type: "post.flagged_trial" });
    expect(await postRow(shadow.postId)).toEqual({ state: "published", quarantined_by: null, queue_first: 0, legal_hold: 0 });
    expect((await assetRow(shadow.assetId))?.state).toBe("ready");
    expect(await withdrawn(shadow.postId)).toBe(0);

    await env.DB.prepare("UPDATE admin_seats SET seat_state = 'active', seat_trial_count = 10 WHERE seat = 2").run();
    const sent: Sent[] = [];
    const offTopic = await seedPost(author.agentId);
    expect(await expectJson(await seatFlag(offTopic.postId, seat.credential, "off-topic", withMail(sent)), 200))
      .toMatchObject({ state: "quarantined", trial: 0, event_type: "post.flagged" });
    expect(await postRow(offTopic.postId)).toEqual({ state: "quarantined", quarantined_by: "seat_agents", queue_first: 1, legal_hold: 0 });
    expect((await assetRow(offTopic.assetId))?.state).toBe("quarantined");
    expect(await blockedCount(offTopic.assetId)).toBe(0);
    expect(await withdrawn(offTopic.postId)).toBe(1);
    expect(await audit(offTopic.postId)).toEqual([{ actor_email: "seat_agent", action: "quarantine", reason_code: "off-topic" }]);
    // The seat flag messaged every Moderator, naming the source and no Agent.
    expect(sent).toHaveLength(3);
    for (const message of sent) {
      expect(message.text).toContain("Seat Agent flag, reason off-topic");
      expect(message.text).not.toContain(AUTHOR_NAME);
      expect(message.text).not.toContain("SeatTwo");
    }

    const prohibited = await seedPost(author.agentId);
    await expectJson(await seatFlag(prohibited.postId, seat.credential, "id-document"), 200);
    expect(await postRow(prohibited.postId)).toMatchObject({ state: "quarantined", quarantined_by: "seat_agents", legal_hold: 0 });
    expect(await blockedCount(prohibited.assetId)).toBeGreaterThan(0);
  });
});

describe("AT-74 Clear and Archive", () => {
  it("lets any Moderator clear a quarantine: the Post and its Asset return and its reports close", async () => {
    const author = await enroll(AUTHOR_NAME, ADMIN2);
    const seeded = await seedPost(author.agentId);
    await expectJson(await report(seeded.postId, "spam"), 201);

    const quarantined = section(await page(STAFF), "queue-quarantined");
    expect(quarantined).toContain(seeded.postId);
    expect(quarantined).toContain("Quarantined by a signed-in report.");
    expect(quarantined).toContain(">Clear</button>");
    expect(quarantined).toContain(">Archive (remove)</button>");

    // The Publishing Stop still blocks a Clear.
    await expectJson(await call("/v1/admin/publishing-stop", { email: MODERATOR, body: { engaged: true } }), 200);
    await expectError(await moderate(STAFF, "post", seeded.postId, "restore"), 409, "state_conflict");
    await expectJson(await call("/v1/admin/publishing-stop", { email: MODERATOR, body: { engaged: false } }), 200);

    const cleared = await expectJson(await moderate(STAFF, "post", seeded.postId, "restore"), 200);
    expect(cleared.state).toBe("published");
    expect(await postRow(seeded.postId)).toEqual({ state: "published", quarantined_by: null, queue_first: 0, legal_hold: 0 });
    expect(await assetRow(seeded.assetId)).toEqual({ state: "ready", quarantined_at: null });
    expect(await blockedCount(seeded.assetId)).toBe(0);
    const restored = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE resource_id = ? AND type = 'post.restored'")
      .bind(seeded.postId).first<{ n: number }>();
    expect(Number(restored?.n)).toBe(1);
    expect(await reportStates(seeded.postId)).toEqual(["triaged"]);
    expect(section(await page(STAFF), "reports")).not.toContain(seeded.postId);
  });

  it("keeps clearing a quarantine under a legal hold Admin only", async () => {
    const author = await enroll(AUTHOR_NAME, ADMIN2);
    const seeded = await seedPost(author.agentId);
    await expectJson(await report(seeded.postId, "csam"), 201);
    expect(section(await page(STAFF), "queue-quarantined")).toContain("Only an Admin can clear it.");
    await expectError(await moderate(STAFF, "post", seeded.postId, "restore"), 403, "forbidden");
    expect((await postRow(seeded.postId))?.state).toBe("quarantined");
    expect((await expectJson(await moderate(ADMIN, "post", seeded.postId, "restore"), 200)).state).toBe("published");
    expect(await postRow(seeded.postId)).toMatchObject({ state: "published", legal_hold: 0 });
  });

  it("never lets a Clear release an Asset another Post holds under a legal hold (review 4365291514)", async () => {
    const author = await enroll(AUTHOR_NAME, ADMIN2);
    const held = await seedPost(author.agentId);
    const sharing = await sharePost(author.agentId, held.assetId);
    // A csam removal keeps the held Post for preservation and quarantines the image with every
    // published Post on it, under the same hold.
    await expectJson(await moderateWith(STAFF, held.postId, "remove", "csam"), 200);
    expect(await postRow(held.postId)).toMatchObject({ state: "removal_pending", legal_hold: 1 });
    expect(await postRow(sharing.postId)).toMatchObject({ state: "quarantined", legal_hold: 1 });
    expect(await withdrawn(sharing.postId)).toBe(1);

    await expectError(await moderate(STAFF, "post", sharing.postId, "restore"), 403, "forbidden");
    await expectError(await moderate(ADMIN, "post", sharing.postId, "restore"), 409, "state_conflict");
    expect((await postRow(sharing.postId))?.state).toBe("quarantined");
    expect((await assetRow(held.assetId))?.state).toBe("quarantined");
    expect(await blockedCount(held.assetId)).toBeGreaterThan(0);
  });

  it("archives (removes) a quarantine for any Moderator and closes its reports", async () => {
    const author = await enroll(AUTHOR_NAME, ADMIN2);
    const seeded = await seedPost(author.agentId);
    await expectJson(await report(seeded.postId, "harassment"), 201);
    const archived = await expectJson(await moderate(STAFF, "post", seeded.postId, "remove"), 200);
    expect(archived.state).toBe("removal_pending");
    expect(await reportStates(seeded.postId)).toEqual(["triaged"]);
  });

  it("AT-75 closes a Post's open reports when a Moderator hides it", async () => {
    stubSiteverify();
    const author = await enroll(AUTHOR_NAME, ADMIN2);
    const seeded = await seedPost(author.agentId);
    await expectJson(await call("/v1/reports", {
      body: { target_type: "post", target_id: seeded.postId, reason_code: "spam", turnstile_token: "token-ok" },
    }), 201);
    expect(await reportStates(seeded.postId)).toEqual(["open"]);
    await expectJson(await moderate(STAFF, "post", seeded.postId, "hide"), 200);
    expect(await reportStates(seeded.postId)).toEqual(["triaged"]);
  });
});

describe("AT-73 and AT-74 a shared image is one item", () => {
  it("quarantines every published Post on the image in one batch, with one alert", async () => {
    const sent: Sent[] = [];
    const author = await enroll(AUTHOR_NAME, ADMIN2);
    const first = await seedPost(author.agentId);
    const second = await sharePost(author.agentId, first.assetId);
    const pending = await sharePost(author.agentId, first.assetId, "pending_review");
    await expectJson(await call("/v1/reports", {
      email: OPERATOR,
      env: withMail(sent),
      body: { target_type: "post", target_id: first.postId, reason_code: "spam" },
    }), 201);
    for (const postId of [first.postId, second.postId]) {
      expect(await postRow(postId)).toEqual({ state: "quarantined", quarantined_by: "report", queue_first: 1, legal_hold: 0 });
      expect(await withdrawn(postId)).toBe(1);
      expect(await audit(postId, "quarantine")).toEqual([{ actor_email: OPERATOR, action: "quarantine", reason_code: "spam" }]);
    }
    // A pending Post on the image keeps waiting for its approval; it was never public.
    expect((await postRow(pending.postId))?.state).toBe("pending_review");
    expect(await withdrawn(pending.postId)).toBe(0);
    expect((await assetRow(first.assetId))?.state).toBe("quarantined");
    // No published Post is left on the quarantined image.
    const published = await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE asset_id = ? AND state = 'published'")
      .bind(first.assetId).first<{ n: number }>();
    expect(Number(published?.n)).toBe(0);
    // One alert: one email per Moderator, counting both Posts.
    expect(sent).toHaveLength(3);
    expect(sent[0]?.text).toContain("2 quarantined Posts are waiting");
  });

  it("carries a prohibited reason and a legal hold to every Post on the image", async () => {
    const author = await enroll(AUTHOR_NAME, ADMIN2);
    const first = await seedPost(author.agentId);
    const second = await sharePost(author.agentId, first.assetId);
    await expectJson(await report(first.postId, "csam"), 201);
    expect(await postRow(second.postId)).toEqual({ state: "quarantined", quarantined_by: "report", queue_first: 1, legal_hold: 1 });
    expect(await audit(second.postId, "quarantine")).toEqual([{ actor_email: OPERATOR, action: "quarantine", reason_code: "csam" }]);
    expect(await blockedCount(first.assetId)).toBeGreaterThan(0);
  });

  it("quarantines a sibling through a Seat Flag and a scan as well", async () => {
    const seat = await enroll("SeatTwo", ADMIN2);
    await expectJson(await call("/v1/admin/seats/2", {
      email: ADMIN,
      body: { action: "bind_seat_agent", agent_id: seat.agentId },
    }), 200);
    await env.DB.prepare("UPDATE admin_seats SET seat_state = 'active', seat_trial_count = 10 WHERE seat = 2").run();
    const author = await enroll(AUTHOR_NAME, OPERATOR);
    const flagged = await seedPost(author.agentId);
    const flaggedSibling = await sharePost(author.agentId, flagged.assetId);
    await expectJson(await seatFlag(flagged.postId, seat.credential, "off-topic"), 200);
    expect(await postRow(flaggedSibling.postId)).toMatchObject({ state: "quarantined", quarantined_by: "seat_agents" });
    expect(await audit(flaggedSibling.postId)).toEqual([{ actor_email: "seat_agent", action: "quarantine", reason_code: "off-topic" }]);

    const scanned = await seedPost(author.agentId);
    const scannedSibling = await sharePost(author.agentId, scanned.assetId);
    await pendingScan(scanned.postId);
    await runScan(scanEnv(stubAi({ response: "unsafe\nS10" })), scanned.postId);
    expect(await postRow(scannedSibling.postId)).toMatchObject({ state: "quarantined", quarantined_by: "scan" });
    expect(await audit(scannedSibling.postId)).toEqual([{ actor_email: "system", action: "quarantine", reason_code: "scan_s10" }]);
  });

  it("clears the whole group together and only then releases the image", async () => {
    const author = await enroll(AUTHOR_NAME, ADMIN2);
    const first = await seedPost(author.agentId);
    const second = await sharePost(author.agentId, first.assetId);
    await expectJson(await report(first.postId, "spam"), 201);
    // Clearing the sibling, which the report never named, clears the reported Post too.
    const cleared = await expectJson(await moderate(STAFF, "post", second.postId, "restore"), 200);
    expect(cleared.state).toBe("published");
    for (const postId of [first.postId, second.postId]) {
      expect(await postRow(postId)).toEqual({ state: "published", quarantined_by: null, queue_first: 0, legal_hold: 0 });
      expect(await audit(postId, "restore")).toEqual([{ actor_email: STAFF, action: "restore", reason_code: "other" }]);
      const restored = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE resource_id = ? AND type = 'post.restored'")
        .bind(postId).first<{ n: number }>();
      expect(Number(restored?.n)).toBe(1);
    }
    expect(await reportStates(first.postId)).toEqual(["triaged"]);
    expect(await assetRow(first.assetId)).toEqual({ state: "ready", quarantined_at: null });
  });

  it("refuses a group Clear while a member is prohibited and held, until an Admin clears all of it", async () => {
    const author = await enroll(AUTHOR_NAME, ADMIN2);
    const first = await seedPost(author.agentId);
    const second = await sharePost(author.agentId, first.assetId);
    await expectJson(await report(first.postId, "csam"), 201);
    expect(await postRow(second.postId)).toMatchObject({ state: "quarantined", legal_hold: 1 });
    // A Moderator without a seat clears no Post of the group: the image stays quarantined and its
    // prohibited Blocked Hashes stay.
    await expectError(await moderate(STAFF, "post", second.postId, "restore"), 403, "forbidden");
    await expectError(await moderate(STAFF, "post", first.postId, "restore"), 403, "forbidden");
    expect((await assetRow(first.assetId))?.state).toBe("quarantined");
    expect(await blockedCount(first.assetId)).toBeGreaterThan(0);
    expect((await postRow(first.postId))?.state).toBe("quarantined");
    // An Admin clears the group together.
    await expectJson(await moderate(ADMIN, "post", second.postId, "restore"), 200);
    expect(await postRow(first.postId)).toMatchObject({ state: "published", legal_hold: 0 });
    expect(await postRow(second.postId)).toMatchObject({ state: "published", legal_hold: 0 });
    expect((await assetRow(first.assetId))?.state).toBe("ready");
  });

  it("refuses to clear a Post whose image a Moderator archived on another Post", async () => {
    const author = await enroll(AUTHOR_NAME, ADMIN2);
    const first = await seedPost(author.agentId);
    const second = await sharePost(author.agentId, first.assetId);
    await expectJson(await report(first.postId, "id-document"), 201);
    expect((await postRow(second.postId))?.state).toBe("quarantined");
    await expectJson(await moderateWith(STAFF, first.postId, "remove", "id-document"), 200);
    await expectError(await moderate(ADMIN, "post", second.postId, "restore"), 409, "state_conflict");
    expect((await postRow(second.postId))?.state).toBe("quarantined");
    expect((await assetRow(first.assetId))?.state).toBe("quarantined");
    expect(await blockedCount(first.assetId)).toBeGreaterThan(0);
  });
});

describe("AT-74 a Moderator reviews a quarantined image", () => {
  it("serves the bytes to a Moderator, no-store, and to nobody else", async () => {
    const author = await enroll(AUTHOR_NAME, ADMIN2);
    const other = await enroll("Bystander", OPERATOR);
    const seeded = await seedPost(author.agentId);
    await env.MEDIA.put(derivativeKey(seeded.assetId, "display"), new Uint8Array([5, 5, 5, 5]));
    await expectJson(await report(seeded.postId, "spam"), 201);
    const path = `/v1/assets/${seeded.assetId}/content?variant=display`;
    const moderator = await call(path, { email: STAFF });
    expect(moderator.status).toBe(200);
    expect(moderator.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await moderator.arrayBuffer())).toEqual(new Uint8Array([5, 5, 5, 5]));
    await expectError(await call(path), 404, "not_found");
    await expectError(await call(path, { bearer: other.credential }), 404, "not_found");
    await expectError(await call(path, { bearer: author.credential }), 404, "not_found");
    // The Quarantined section links that image.
    expect(section(await page(STAFF), "queue-quarantined")).toContain(`/v1/assets/${seeded.assetId}/content?variant=thumb`);
  });

  it("keeps legal-hold material Admin only, through the evidence route", async () => {
    const author = await enroll(AUTHOR_NAME, ADMIN2);
    const seeded = await seedPost(author.agentId);
    await env.MEDIA.put(derivativeKey(seeded.assetId, "display"), new Uint8Array([6, 6, 6, 6]));
    await expectJson(await report(seeded.postId, "csam"), 201);
    const path = `/v1/assets/${seeded.assetId}/content?variant=display`;
    await expectError(await call(path, { email: STAFF }), 404, "not_found");
    await expectError(await call(path, { email: ADMIN }), 404, "not_found");
  });
});

describe("AT-73 a Session Operator reports from the browser", () => {
  it("shows the report form to a signed-in Session Operator, and the report quarantines", async () => {
    const sent: Sent[] = [];
    const mailEnv = withMail(sent);
    const author = await enroll(AUTHOR_NAME, ADMIN2);
    const seeded = await seedPost(author.agentId);
    const cookie = await signIn(mailEnv, sent);
    const formPage = await call(`/reports?target_type=post&target_id=${seeded.postId}`, { headers: { cookie }, env: mailEnv });
    expect(formPage.status).toBe(200);
    const formHtml = await formPage.text();
    expect(formHtml).toContain(`action="/reports"`);
    expect(formHtml).not.toContain("Browser reports are for an Operator.");
    // Without a Session the page still refuses.
    expect(await (await call(`/reports?target_type=post&target_id=${seeded.postId}`, { env: mailEnv })).text())
      .toContain("Browser reports are for an Operator.");
    const filed = await call("/reports", {
      method: "POST",
      raw: new TextEncoder().encode(new URLSearchParams({
        target_type: "post", target_id: seeded.postId, reason_code: "spam",
      }).toString()),
      headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      env: mailEnv,
    });
    expect(filed.status).toBe(201);
    expect(await postRow(seeded.postId)).toMatchObject({ state: "quarantined", quarantined_by: "report" });
  });
});

describe("AT-74 the Quarantined section pages", () => {
  it("pages quarantined Posts with quarantined_cursor and a next link", async () => {
    const author = await enroll(AUTHOR_NAME, ADMIN2);
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const seeded = await seedPost(author.agentId);
      // Distinct creation times, so the page order is fixed.
      await env.DB.prepare("UPDATE posts SET created_at = ? WHERE id = ?")
        .bind(`2026-01-0${String(index + 1)}T00:00:00Z`, seeded.postId).run();
      await expectJson(await report(seeded.postId, "spam"), 201);
      ids.push(seeded.postId);
    }
    const first = await (await call("/moderation?limit=2", { email: STAFF })).text();
    const firstSection = section(first, "queue-quarantined");
    expect(firstSection).toContain(ids[0]!);
    expect(firstSection).toContain(ids[1]!);
    expect(firstSection).not.toContain(ids[2]!);
    const link = first.match(/<nav aria-label="Quarantined"><a href="([^"]+)">Next quarantined<\/a><\/nav>/);
    expect(link).not.toBeNull();
    const href = link![1]!.replaceAll("&amp;", "&");
    expect(href).toContain("quarantined_cursor=");
    const second = await (await call(href, { email: STAFF })).text();
    const secondSection = section(second, "queue-quarantined");
    expect(secondSection).toContain(ids[2]!);
    expect(secondSection).not.toContain(ids[0]!);
    expect(second).not.toContain("Next quarantined");
  });
});

describe("AT-75 Archive answers an open appeal", () => {
  it("decides the open appeal as upheld when a Moderator archives the Post", async () => {
    const author = await enroll(AUTHOR_NAME, ADMIN2);
    const scanned = await seedPost(author.agentId);
    await pendingScan(scanned.postId);
    await runScan(scanEnv(stubAi({ response: "unsafe\nS1" })), scanned.postId);
    expect((await appeal(author.credential, scanned.postId, "archive-appeal")).status).toBe(201);
    await expectJson(await moderate(STAFF, "post", scanned.postId, "remove"), 200);
    const row = await env.DB.prepare("SELECT outcome, decided_at, decided_by FROM post_appeals WHERE post_id = ?")
      .bind(scanned.postId).first<{ outcome: string; decided_at: string | null; decided_by: string | null }>();
    expect(row?.outcome).toBe("uphold");
    expect(row?.decided_at).not.toBeNull();
    expect(row?.decided_by).toBe(STAFF);
  });
});

describe("AT-75 dismiss_report", () => {
  it("dismisses one report on its own, audited, and lists only open reports", async () => {
    const author = await enroll(AUTHOR_NAME, ADMIN2);
    const filed = await expectJson(await call("/v1/reports", {
      email: OPERATOR,
      body: { target_type: "agent", target_id: author.agentId, reason_code: "spam", detail: "dismiss-me" },
    }), 201);
    const reportId = String(filed.report_id);
    const before = section(await page(STAFF), "reports");
    expect(before).toContain("dismiss-me");
    expect(before).toContain(`name="target_type" value="report"`);
    expect(before).toContain(`name="target_id" value="${reportId}"`);
    expect(before).toContain(">Dismiss</button>");

    const done = await expectJson(await moderate(STAFF, "report", reportId, "dismiss_report"), 200);
    expect(done).toMatchObject({ report_id: reportId, state: "triaged" });
    const row = await env.DB.prepare("SELECT state FROM reports WHERE id = ?").bind(reportId).first<{ state: string }>();
    expect(row?.state).toBe("triaged");
    const audited = await env.DB.prepare(
      "SELECT actor_email, target_type, action FROM moderation_actions WHERE target_id = ? AND action = 'dismiss_report'",
    ).bind(reportId).all<{ actor_email: string; target_type: string; action: string }>();
    expect(audited.results).toEqual([{ actor_email: STAFF, target_type: "report", action: "dismiss_report" }]);
    expect((await env.DB.prepare("SELECT state FROM agents WHERE id = ?").bind(author.agentId).first<{ state: string }>())?.state).toBe("active");
    expect(section(await page(STAFF), "reports")).not.toContain("dismiss-me");
    await expectError(await moderate(STAFF, "report", reportId, "dismiss_report"), 409, "state_conflict");
    await expectError(await moderate(STAFF, "report", uuidv7(), "dismiss_report"), 404, "not_found");
    await expectError(await call("/v1/moderation/actions", {
      email: OPERATOR,
      body: { target_type: "report", target_id: reportId, action: "dismiss_report", reason_code: "other" },
    }), 403, "forbidden");
  });
});

describe("AT-75 appeals of automatic quarantines", () => {
  it("lets the author appeal a scan quarantine once, and refuses an appeal of a report quarantine", async () => {
    const author = await enroll(AUTHOR_NAME, ADMIN2);
    const scanned = await seedPost(author.agentId);
    await pendingScan(scanned.postId);
    await runScan(scanEnv(stubAi({ response: "unsafe\nS1" })), scanned.postId);
    const review = await expectJson(await call(`/v1/posts/${scanned.postId}/review`, { bearer: author.credential, policy: POSTPUBLISH }), 200);
    expect(review).toMatchObject({ state: "quarantined", review_state: "quarantined", quarantined_by: "scan", appeal: null });
    expect(typeof review.appealable_until).toBe("string");
    const first = await appeal(author.credential, scanned.postId, "scan-appeal");
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ appeal: { state: "open", hidden_by: "scan" } });
    await expectError(await appeal(author.credential, scanned.postId, "scan-appeal-2"), 409, "state_conflict");
    const appeals = section(await page(STAFF), "queue-appeals");
    expect(appeals).toContain(scanned.postId);
    expect(appeals).toContain("a quarantine by the content scan");
    // A Clear answers the appeal and returns the image in one action.
    await expectJson(await moderate(STAFF, "post", scanned.postId, "restore"), 200);
    expect(await assetRow(scanned.assetId)).toEqual({ state: "ready", quarantined_at: null });
    const answered = await env.DB.prepare("SELECT outcome FROM post_appeals WHERE post_id = ?").bind(scanned.postId).first<{ outcome: string }>();
    expect(answered?.outcome).toBe("restore");

    const reported = await seedPost(author.agentId);
    await expectJson(await report(reported.postId, "spam"), 201);
    const reportReview = await expectJson(await call(`/v1/posts/${reported.postId}/review`, { bearer: author.credential, policy: POSTPUBLISH }), 200);
    expect(reportReview).toMatchObject({ quarantined_by: "report", appealable_until: null });
    await expectError(await appeal(author.credential, reported.postId, "report-appeal"), 409, "state_conflict");
  });
});

describe("AT-76 Moderator email", () => {
  it("emails every Moderator once per window, with the link and no content", async () => {
    const sent: Sent[] = [];
    const mailEnv = withMail(sent);
    const author = await enroll(AUTHOR_NAME, ADMIN2);
    const first = await seedPost(author.agentId);
    const second = await seedPost(author.agentId);
    await expectJson(await call("/v1/reports", {
      email: OPERATOR,
      env: mailEnv,
      body: { target_type: "post", target_id: first.postId, reason_code: "spam", detail: "reporter-detail-text" },
    }), 201);
    expect(sent.map((message) => message.to).sort()).toEqual([ADMIN2, MODERATOR, STAFF].sort());
    for (const message of sent) {
      expect(message.from).toBe(AUTH.mail_from);
      expect(message.subject).toBe(ALERT_SUBJECT);
      expect(message.text).toContain("https://jchain.example.test/moderation");
      expect(message.text).toContain("1 quarantined Post is waiting");
      expect(message.text).toContain("signed-in report, reason spam");
      expect(message.text).toContain("This email includes no content");
      for (const secret of [SECRET_CAPTION, SECRET_TITLE, AUTHOR_NAME, OPERATOR, "reporter-detail-text", first.postId, first.assetId]) {
        expect(message.text).not.toContain(secret);
        expect(message.subject).not.toContain(secret);
      }
    }
    // A burst inside the window sends nothing more.
    await expectJson(await call("/v1/reports", {
      email: OPERATOR,
      env: mailEnv,
      body: { target_type: "post", target_id: second.postId, reason_code: "rules" },
    }), 201);
    expect(sent).toHaveLength(3);
    // Every alert email counted toward the sign-in daily window.
    const counted = await env.QUOTA.getByName("auth").peek([`emails:${utcSeconds().slice(0, 10)}`]);
    expect(Object.values(counted)).toEqual([3]);

  });

  it("AT-76 sends the daily repeat on its own key, once per 24 hours, even right after a 15-minute alert", async () => {
    const sent: Sent[] = [];
    const mailEnv = withMail(sent);
    const author = await enroll(AUTHOR_NAME, ADMIN2);
    const first = await seedPost(author.agentId);
    const second = await seedPost(author.agentId);
    await expectJson(await call("/v1/reports", {
      email: OPERATOR,
      env: mailEnv,
      body: { target_type: "post", target_id: first.postId, reason_code: "spam" },
    }), 201);
    await expectJson(await call("/v1/reports", {
      email: OPERATOR,
      env: mailEnv,
      body: { target_type: "post", target_id: second.postId, reason_code: "rules" },
    }), 201);
    expect(sent).toHaveLength(3);
    // Round-2 P3-1: a 15-minute alert went out a moment ago, and the daily run still sends.
    const start = Date.now();
    await runRetention(mailEnv, start);
    expect(sent).toHaveLength(6);
    expect(sent.at(-1)?.text).toContain("2 quarantined Posts are waiting");
    // A second run the same day sends nothing.
    await runRetention(mailEnv, start + 60 * 60 * 1000);
    expect(sent).toHaveLength(6);
    // 24 hours later it sends again, with no Durable Object cleared.
    await runRetention(mailEnv, start + 24 * 60 * 60 * 1000);
    expect(sent).toHaveLength(9);
    // With nothing waiting, the daily run sends nothing.
    await expectJson(await moderate(STAFF, "post", first.postId, "restore"), 200);
    await expectJson(await moderate(STAFF, "post", second.postId, "restore"), 200);
    await runRetention(mailEnv, start + 48 * 60 * 60 * 1000);
    expect(sent).toHaveLength(9);
  });

  it("AT-76 stops at auth.emails_per_day and still quarantines", async () => {
    const sent: Sent[] = [];
    const mailEnv = withMail(sent, true, { emails_per_day: 1 });
    const author = await enroll(AUTHOR_NAME, ADMIN2);
    const seeded = await seedPost(author.agentId);
    await expectJson(await call("/v1/reports", {
      email: OPERATOR,
      env: mailEnv,
      body: { target_type: "post", target_id: seeded.postId, reason_code: "spam" },
    }), 201);
    // Three Moderators, one email allowed today: one is sent and the rest are skipped.
    expect(sent).toHaveLength(1);
    expect((await postRow(seeded.postId))?.state).toBe("quarantined");
    const counted = await env.QUOTA.getByName("auth").peek([`emails:${utcSeconds().slice(0, 10)}`]);
    expect(Object.values(counted)).toEqual([1]);
    // The daily run is capped by the same window.
    await runRetention(mailEnv, Date.now());
    expect(sent).toHaveLength(1);
  });

  it("sends nothing without the EMAIL binding, and still quarantines", async () => {
    const sent: Sent[] = [];
    const author = await enroll(AUTHOR_NAME, ADMIN2);
    const seeded = await seedPost(author.agentId);
    await expectJson(await call("/v1/reports", {
      email: OPERATOR,
      env: withMail(sent, false),
      body: { target_type: "post", target_id: seeded.postId, reason_code: "spam" },
    }), 201);
    expect(sent).toHaveLength(0);
    expect((await postRow(seeded.postId))?.state).toBe("quarantined");
  });
});

function withMail(sent: Sent[], mailer = true, auth: Partial<typeof AUTH> = {}): Env {
  const policy = JSON.stringify({ ...JSON.parse(env.POLICY as string), auth: { ...AUTH, ...auth } });
  const binding = { send: async (message: Sent) => { sent.push(message); return { messageId: "test" }; } };
  return new Proxy(env, {
    get(target, property) {
      if (property === "POLICY") return policy;
      if (property === "EMAIL") return mailer ? binding : undefined;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Env;
}

function scanEnv(ai: StubAi | undefined): Env {
  return new Proxy(env, {
    get(target, property) {
      if (property === "POLICY") return POSTPUBLISH;
      if (property === "AI") return ai;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Env;
}

function stubAi(output: unknown): StubAi {
  return { run: async () => output };
}

async function pendingScan(postId: string): Promise<void> {
  await env.DB.prepare("INSERT INTO post_scans (post_id, result, hidden, published_at) VALUES (?, 'pending', 0, ?)")
    .bind(postId, utcSeconds()).run();
}

async function runScan(target: Env, postId: string): Promise<void> {
  const ctx = createExecutionContext();
  const batch = createMessageBatch("asset-upload", [{ id: `scan-${crypto.randomUUID()}`, timestamp: new Date(), attempts: 1, body: { post_id: postId } }]);
  if (!worker.queue) throw new Error("queue handler missing");
  await worker.queue(batch, target, ctx);
  await getQueueResult(batch, ctx);
}

async function enroll(name: string, email: string): Promise<{ agentId: string; credential: string }> {
  const body = await expectJson(await call("/v1/agents", {
    email,
    body: { display_name: name, declared_model: "fixture-model" },
  }), 201);
  return { agentId: String(body.agent_id), credential: String(body.credential) };
}

async function seedPost(authorId: string): Promise<{ threadId: string; postId: string; assetId: string }> {
  const threadId = uuidv7();
  const postId = uuidv7();
  const assetId = uuidv7();
  const stamp = utcSeconds();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO assets (id, agent_id, state, content_type, byte_size, sha256, original_stored, created_at, expires_at)
       VALUES (?, ?, 'ready', 'image/webp', 4, ?, 0, ?, ?)`,
    ).bind(assetId, authorId, assetId.replaceAll("-", "").padEnd(64, "d"), stamp, stamp),
    env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)").bind(threadId, BOARD_ID, stamp),
    env.DB.prepare(
      `INSERT INTO posts (
         id, thread_id, author_agent_id, asset_id, title, caption, alt_text,
         provenance_source, rights_attestation, license, state, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'alt', 'human', 'mine', 'cc0', 'published', ?)`,
    ).bind(postId, threadId, authorId, assetId, SECRET_TITLE, SECRET_CAPTION, stamp),
  ]);
  return { threadId, postId, assetId };
}

// A second Post of the same Agent on an existing Asset, as upload dedup produces.
async function sharePost(authorId: string, assetId: string, state = "published"): Promise<{ threadId: string; postId: string }> {
  const threadId = uuidv7();
  const postId = uuidv7();
  const stamp = utcSeconds();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)").bind(threadId, BOARD_ID, stamp),
    env.DB.prepare(
      `INSERT INTO posts (
         id, thread_id, author_agent_id, asset_id, title, caption, alt_text,
         provenance_source, rights_attestation, license, state, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'alt', 'human', 'mine', 'cc0', ?, ?)`,
    ).bind(postId, threadId, authorId, assetId, SECRET_TITLE, SECRET_CAPTION, state, stamp),
  ]);
  return { threadId, postId };
}

function moderateWith(email: string, postId: string, action: string, reason: string): Promise<Response> {
  return call("/v1/moderation/actions", {
    email,
    body: { target_type: "post", target_id: postId, action, reason_code: reason },
  });
}

async function signIn(bindings: Env, sent: Sent[], email = OPERATOR): Promise<string> {
  await env.DB.batch([env.DB.prepare("DELETE FROM sessions"), env.DB.prepare("DELETE FROM signin_links")]);
  await clearSignInQuota(email);
  await call("/signin", {
    method: "POST",
    raw: new TextEncoder().encode(new URLSearchParams({ email }).toString()),
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
    env: bindings,
  });
  const found = sent.at(-1)?.text.match(/https:\/\/[^\s]+\/signin\/(sl_[A-Za-z0-9_-]{43})/);
  expect(found).not.toBeNull();
  sent.length = 0;
  const done = await call(`/signin/${found![1]!}`, { method: "POST", headers: { origin: ORIGIN }, env: bindings });
  expect(done.status).toBe(303);
  const cookie = (done.headers.get("set-cookie") ?? "").match(/__Host-jc_session=(ss_[A-Za-z0-9_-]{43})/);
  expect(cookie).not.toBeNull();
  return `__Host-jc_session=${cookie![1]!}`;
}

function seatFlag(postId: string, credential: string, reason: string, target?: Env): Promise<Response> {
  return call(`/v1/posts/${postId}/flag`, {
    method: "PUT",
    bearer: credential,
    body: { reason },
    ...(target === undefined ? {} : { env: target }),
  });
}

function report(postId: string, reason: string): Promise<Response> {
  return call("/v1/reports", { email: OPERATOR, body: { target_type: "post", target_id: postId, reason_code: reason } });
}

function moderate(email: string, targetType: string, targetId: string, action: string): Promise<Response> {
  return call("/v1/moderation/actions", {
    email,
    body: { target_type: targetType, target_id: targetId, action, reason_code: "other" },
  });
}

function appeal(credential: string, postId: string, key: string): Promise<Response> {
  return call(`/v1/posts/${postId}/appeal`, {
    bearer: credential,
    headers: { "idempotency-key": key },
    body: {},
    policy: POSTPUBLISH,
  });
}

async function postRow(postId: string) {
  return env.DB.prepare("SELECT state, quarantined_by, queue_first, legal_hold FROM posts WHERE id = ?")
    .bind(postId).first<{ state: string; quarantined_by: string | null; queue_first: number; legal_hold: number }>();
}

async function assetRow(assetId: string) {
  return env.DB.prepare("SELECT state, quarantined_at FROM assets WHERE id = ?")
    .bind(assetId).first<{ state: string; quarantined_at: string | null }>();
}

async function blockedCount(assetId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM blocked_hashes WHERE asset_id = ?").bind(assetId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function withdrawn(postId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE resource_id = ? AND type = 'post.withdrawn'")
    .bind(postId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function audit(postId: string, action?: string) {
  const listed = await env.DB.prepare(
    `SELECT actor_email, action, reason_code FROM moderation_actions
      WHERE target_id = ?${action === undefined ? "" : " AND action = ?"} ORDER BY created_at, id`,
  ).bind(...(action === undefined ? [postId] : [postId, action])).all<{ actor_email: string; action: string; reason_code: string }>();
  return listed.results ?? [];
}

async function reportStates(postId: string): Promise<string[]> {
  const listed = await env.DB.prepare("SELECT state FROM reports WHERE target_id = ? ORDER BY created_at, id")
    .bind(postId).all<{ state: string }>();
  return (listed.results ?? []).map((row) => row.state);
}

async function page(email: string): Promise<string> {
  const response = await call("/moderation", { email });
  expect(response.status).toBe(200);
  return response.text();
}

function section(html: string, id: string): string {
  const start = html.indexOf(`id="${id}"`);
  if (start === -1) return "";
  const end = html.indexOf("</section>", start);
  return html.slice(start, end === -1 ? undefined : end);
}

function stubSiteverify(): void {
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === SITEVERIFY) {
      return new Response(JSON.stringify({ success: true }), { headers: { "content-type": "application/json" } });
    }
    return realFetch(input, init);
  });
}

async function expectJson(response: Response, status: number): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body;
}

async function expectError(response: Response, status: number, code: string): Promise<void> {
  const body = await response.json() as { error: { code: string } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(body.error.code).toBe(code);
}
