import { applyD1Migrations, createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { utcSeconds, uuidv7 } from "../src/ids";
import { ALERT_SUBJECT } from "../src/moderator-alert";
import { clearNamedQuota } from "../src/quota";
import { runRetention } from "../src/retention";
import postpublishFixture from "./fixtures/policy-postpublish.json";
import { ADMIN, ADMIN2, ADMIN2_OPERATOR_ID, BOARD_ID, MODERATOR, OPERATOR, STAFF, call, resetAndSeed } from "./harness";

// v0.2.36 quarantine-first moderation (Danny, 2026-10-23 3:44 PM PT): posting happens first, the
// system recommends a Post for moderation, messages the Moderators, and quarantines the Post until a
// Moderator clears or archives it.

const POSTPUBLISH = JSON.stringify(postpublishFixture);
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

describe("every system signal quarantines through one helper", () => {
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

describe("Seat Flags quarantine (CT-22, AT-42)", () => {
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

describe("Clear and Archive", () => {
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
    const sharing = await seedPost(author.agentId);
    await env.DB.prepare("UPDATE posts SET asset_id = ? WHERE id = ?").bind(held.assetId, sharing.postId).run();
    await expectJson(await report(held.postId, "csam"), 201);
    await expectJson(await report(sharing.postId, "spam"), 201);
    expect(await postRow(sharing.postId)).toMatchObject({ state: "quarantined", legal_hold: 0 });

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

  it("closes a Post's open reports when a Moderator hides it", async () => {
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

describe("dismiss_report", () => {
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

describe("appeals of automatic quarantines", () => {
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

describe("Moderator email", () => {
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

    // The daily run sends the same alert when Posts wait and none was sent in the last 24 hours.
    await runRetention(mailEnv, Date.now());
    expect(sent).toHaveLength(3);
    await clearNamedQuota(env, "moderator-alert");
    await runRetention(mailEnv, Date.now());
    expect(sent).toHaveLength(6);
    expect(sent.at(-1)?.text).toContain("2 quarantined Posts are waiting");
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

function withMail(sent: Sent[], mailer = true): Env {
  const policy = JSON.stringify({ ...JSON.parse(env.POLICY as string), auth: AUTH });
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
