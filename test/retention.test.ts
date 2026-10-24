import { utcSeconds, uuidv7 } from "../src/ids";
import { applyD1Migrations, createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { derivativeKey, originalKey, rejectInFlight } from "../src/asset-pipeline";
import { refundAssetBytes } from "../src/quota";
import { REDACTED_EMAIL, RETENTION_BATCH, SCAN_BACKFILL_BATCH, runRetention } from "../src/retention";
import postpublishFixture from "./fixtures/policy-postpublish.json";
import { BOARD_ID, MODERATOR, OPERATOR, OPERATOR_ID, call, resetAndSeed } from "./harness";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SHA = "a".repeat(64);

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

let agentId = "";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetAndSeed();
  agentId = uuidv7();
  await env.DB.prepare(
    "INSERT INTO agents (id, display_name, declared_model, state, operator_id, created_at) VALUES (?, 'retention', 'test', 'active', ?, ?)",
  ).bind(agentId, OPERATOR_ID, at(-60 * DAY)).run();
});

type SeedOptions = {
  rejectedAt?: string | null;
  sizes?: Partial<Record<"display" | "thumb", number>>;
};

async function seedAsset(
  state: string,
  createdAt: string,
  expiresAt: string,
  keys: string[] = [],
  options: SeedOptions = {},
): Promise<string> {
  const id = uuidv7();
  await env.DB.prepare(
    `INSERT INTO assets (id, agent_id, state, content_type, byte_size, sha256, reason_code, original_stored, created_at, expires_at, rejected_at)
     VALUES (?, ?, ?, 'image/webp', 4, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, agentId, state, id.replaceAll("-", "").padEnd(64, "a"),
    state === "rejected" ? "invalid_image" : null,
    keys.includes("original") ? 1 : 0,
    createdAt, expiresAt,
    options.rejectedAt ?? null,
  ).run();
  await putObjects(id, keys, options.sizes);
  return id;
}

async function putObjects(id: string, keys: string[], sizes: SeedOptions["sizes"] = {}): Promise<void> {
  for (const key of keys) {
    if (key === "original") {
      await env.MEDIA.put(originalKey(id), new Uint8Array([1, 2, 3, 4]));
      continue;
    }
    const variant = key as "display" | "thumb";
    await env.MEDIA.put(derivativeKey(id, variant), new Uint8Array(sizes[variant] ?? 4).fill(1));
  }
}

async function quarantineAction(assetId: string, createdAt: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO moderation_actions (id, actor_email, target_type, target_id, action, reason_code, private_note, event_id, created_at)
     VALUES (?, ?, 'asset', ?, 'quarantine_asset', 'rules', 'note', NULL, ?)`,
  ).bind(uuidv7(), MODERATOR, assetId, createdAt).run();
}

async function seedPostFor(assetId: string, state: string, legalHold = 0): Promise<string> {
  const threadId = uuidv7();
  const postId = uuidv7();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)").bind(threadId, BOARD_ID, at(-30 * DAY)),
    env.DB.prepare(
      `INSERT INTO posts (id, thread_id, author_agent_id, title, caption, state, asset_id, alt_text, provenance_source,
         rights_attestation, license, legal_hold, legal_hold_reason, created_at)
       VALUES (?, ?, ?, 'Title', 'caption', ?, ?, 'alt', 'model', 'I made this.', 'cc0', ?, ?, ?)`,
    ).bind(postId, threadId, agentId, state, assetId, legalHold, legalHold === 1 ? "csam" : null, at(-30 * DAY)),
  ]);
  return postId;
}

async function assetState(id: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT state FROM assets WHERE id = ?").bind(id).first<{ state: string }>();
  return row?.state;
}

async function stored(id: string): Promise<number> {
  const keys = [originalKey(id), derivativeKey(id, "display"), derivativeKey(id, "thumb")];
  let count = 0;
  for (const key of keys) if (await env.MEDIA.head(key)) count += 1;
  return count;
}

async function runScheduled(): Promise<void> {
  const controller = createScheduledController({ scheduledTime: new Date(NOW), cron: "17 3 * * *" });
  const ctx = createExecutionContext();
  worker.scheduled(controller, env, ctx);
  await waitOnExecutionContext(ctx);
}

describe("retention sweep", () => {
  it("redacts audit rows and report details after 90 days, once", async () => {
    const oldAction = uuidv7();
    const newAction = uuidv7();
    const oldReport = uuidv7();
    const newReport = uuidv7();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO moderation_actions (id, actor_email, target_type, target_id, action, reason_code, private_note, event_id, created_at)
         VALUES (?, ?, 'post', ?, 'reject', 'spam', 'private reasoning', NULL, ?)`,
      ).bind(oldAction, MODERATOR, uuidv7(), at(-91 * DAY)),
      env.DB.prepare(
        `INSERT INTO moderation_actions (id, actor_email, target_type, target_id, action, reason_code, private_note, event_id, created_at)
         VALUES (?, ?, 'post', ?, 'reject', 'spam', 'recent note', NULL, ?)`,
      ).bind(newAction, MODERATOR, uuidv7(), at(-89 * DAY)),
      env.DB.prepare(
        `INSERT INTO reports (id, actor_email, target_type, target_id, reason_code, detail, created_at)
         VALUES (?, ?, 'post', ?, 'spam', 'old detail', ?)`,
      ).bind(oldReport, OPERATOR, uuidv7(), at(-91 * DAY)),
      env.DB.prepare(
        `INSERT INTO reports (id, actor_email, target_type, target_id, reason_code, detail, created_at)
         VALUES (?, ?, 'post', ?, 'spam', 'new detail', ?)`,
      ).bind(newReport, OPERATOR, uuidv7(), at(-1 * DAY)),
    ]);

    await runScheduled();

    const actions = await env.DB.prepare(
      "SELECT id, actor_email, private_note, action, reason_code, created_at FROM moderation_actions ORDER BY created_at",
    ).all<Record<string, string | null>>();
    expect(actions.results[0]).toMatchObject({
      id: oldAction, actor_email: REDACTED_EMAIL, private_note: null, action: "reject", reason_code: "spam", created_at: at(-91 * DAY),
    });
    expect(actions.results[1]).toMatchObject({ id: newAction, actor_email: MODERATOR, private_note: "recent note" });
    const reports = await env.DB.prepare(
      "SELECT id, actor_email, detail, reason_code FROM reports ORDER BY created_at",
    ).all<Record<string, string | null>>();
    expect(reports.results[0]).toMatchObject({ id: oldReport, actor_email: null, detail: null, reason_code: "spam" });
    expect(reports.results[1]).toMatchObject({ id: newReport, actor_email: OPERATOR, detail: "new detail" });

    const again = await runRetention(env, NOW);
    expect(again).toEqual({ ran: true, audit_redacted: 0, reports_redacted: 0, assets_deleted: 0, alerts: [] });
  });

  it("deletes quarantined bytes 7 days after the quarantine action", async () => {
    const expired = await seedAsset("quarantined", at(-30 * DAY), at(-29 * DAY), ["display", "thumb"]);
    await quarantineAction(expired, at(-8 * DAY));
    const recent = await seedAsset("quarantined", at(-30 * DAY), at(-29 * DAY), ["display", "thumb"]);
    await quarantineAction(recent, at(-2 * DAY));
    const ready = await seedAsset("ready", at(-300 * DAY), at(-299 * DAY), ["display", "thumb"]);
    await seedPostFor(ready, "published");

    await runScheduled();

    expect(await assetState(expired)).toBe("deleted");
    expect(await stored(expired)).toBe(0);
    expect(await assetState(recent)).toBe("quarantined");
    expect(await stored(recent)).toBe(2);
    expect(await assetState(ready)).toBe("ready");
    expect(await stored(ready)).toBe(2);
  });

  it("ages a quarantine from quarantined_at, never from the upload time (gap analysis 1)", async () => {
    // An old Asset quarantined yesterday, as a scan hide or a report does with no asset audit row.
    const fresh = await seedAsset("quarantined", at(-30 * DAY), at(-29 * DAY), ["display", "thumb"]);
    await env.DB.prepare("UPDATE assets SET quarantined_at = ? WHERE id = ?").bind(at(-1 * DAY), fresh).run();
    const stale = await seedAsset("quarantined", at(-30 * DAY), at(-29 * DAY), ["display", "thumb"]);
    await env.DB.prepare("UPDATE assets SET quarantined_at = ? WHERE id = ?").bind(at(-8 * DAY), stale).run();
    // No quarantine time at all: kept, never aged from the upload.
    const unknown = await seedAsset("quarantined", at(-30 * DAY), at(-29 * DAY), ["display", "thumb"]);

    await runScheduled();

    expect(await assetState(fresh)).toBe("quarantined");
    expect(await stored(fresh)).toBe(2);
    expect(await assetState(stale)).toBe("deleted");
    expect(await assetState(unknown)).toBe("quarantined");
    expect(await stored(unknown)).toBe(2);
  });

  it("never deletes an Asset under a legal hold, whatever state it is in (gap analysis 2)", async () => {
    const pending = await seedAsset("deletion_pending", at(-30 * DAY), at(-29 * DAY), ["display", "thumb"]);
    const rejected = await seedAsset("rejected", at(-30 * DAY), at(-29 * DAY), ["original"]);
    const threadId = uuidv7();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)").bind(threadId, BOARD_ID, at(-30 * DAY)),
      ...[pending, rejected].map((assetId, index) => env.DB.prepare(
        `INSERT INTO posts (id, thread_id, author_agent_id, title, caption, state, asset_id, alt_text, provenance_source,
           rights_attestation, license, legal_hold, legal_hold_reason, created_at)
         VALUES (?, ?, ?, ?, 'caption', 'removal_pending', ?, 'alt', 'model', 'I made this.', 'cc0', 1, 'csam', ?)`,
      ).bind(uuidv7(), threadId, agentId, index === 0 ? "Held" : null, assetId, at(-30 * DAY))),
    ]);

    await runScheduled();

    expect(await assetState(pending)).toBe("deletion_pending");
    expect(await stored(pending)).toBe(2);
    expect(await assetState(rejected)).toBe("rejected");
    expect(await stored(rejected)).toBe(1);
  });

  it("never ages a quarantined Asset while its quarantined Post waits for a Moderator (round-2 P0)", async () => {
    const waiting = await seedAsset("quarantined", at(-40 * DAY), at(-39 * DAY), ["display", "thumb"]);
    await env.DB.prepare("UPDATE assets SET quarantined_at = ? WHERE id = ?").bind(at(-30 * DAY), waiting).run();
    const postId = await seedPostFor(waiting, "quarantined");
    // The same age with no waiting Post (a blocked upload, or an archived Post) is deleted.
    const orphan = await seedAsset("quarantined", at(-40 * DAY), at(-39 * DAY), ["display", "thumb"]);
    await env.DB.prepare("UPDATE assets SET quarantined_at = ? WHERE id = ?").bind(at(-30 * DAY), orphan).run();
    const archived = await seedAsset("quarantined", at(-40 * DAY), at(-39 * DAY), ["display", "thumb"]);
    await env.DB.prepare("UPDATE assets SET quarantined_at = ? WHERE id = ?").bind(at(-30 * DAY), archived).run();
    await seedPostFor(archived, "removed");

    await runScheduled();

    expect(await assetState(waiting)).toBe("quarantined");
    expect(await stored(waiting)).toBe(2);
    expect(await assetState(orphan)).toBe("deleted");
    expect(await assetState(archived)).toBe("deleted");

    // The Moderator's Clear still works after the sweep: the Post and its image come back.
    const cleared = await call("/v1/moderation/actions", {
      email: MODERATOR,
      body: { target_type: "post", target_id: postId, action: "restore", reason_code: "other" },
    });
    const body = await cleared.json() as { state?: string };
    expect(cleared.status, JSON.stringify(body)).toBe(200);
    expect(body.state).toBe("published");
    expect(await assetState(waiting)).toBe("ready");
    expect(await stored(waiting)).toBe(2);
  });

  it("deletes a ready Asset no Post uses after 7 days and refunds r2_bytes once (round-2 finding 4)", async () => {
    await seedR2Used(1000);
    const unused = await seedAsset("ready", at(-8 * DAY), at(-7 * DAY), ["display", "thumb"], { sizes: { display: 30, thumb: 12 } });
    const young = await seedAsset("ready", at(-6 * DAY), at(-5 * DAY), ["display", "thumb"]);
    const published = await seedAsset("ready", at(-30 * DAY), at(-29 * DAY), ["display", "thumb"]);
    await seedPostFor(published, "published");
    const pending = await seedAsset("ready", at(-30 * DAY), at(-29 * DAY), ["display", "thumb"]);
    await seedPostFor(pending, "pending_review");
    const held = await seedAsset("ready", at(-30 * DAY), at(-29 * DAY), ["display", "thumb"]);
    await seedPostFor(held, "removed", 1);

    await runScheduled();

    expect(await assetState(unused)).toBe("deleted");
    expect(await stored(unused)).toBe(0);
    expect(await r2Used()).toBe(958);
    for (const kept of [young, published, pending, held]) {
      expect(await assetState(kept)).toBe("ready");
      expect(await stored(kept)).toBe(2);
    }

    await runScheduled();
    expect(await r2Used()).toBe(958);
    expect(await refundAssetBytes(env, unused, 42)).toBe(false);
    expect(await r2Used()).toBe(958);
  });

  it("deletes rejected upload bytes after 7 days plus the reservation window", async () => {
    const old = await seedAsset("rejected", at(-9 * DAY), at(-8 * DAY), ["original"]);
    const young = await seedAsset("rejected", at(-7 * DAY - 12 * HOUR), at(-6 * DAY - 12 * HOUR), ["original"]);

    await runScheduled();

    expect(await assetState(old)).toBe("deleted");
    expect(await stored(old)).toBe(0);
    expect(await assetState(young)).toBe("rejected");
    expect(await stored(young)).toBe(1);
  });

  it("purges uploads that were never completed after the reservation expires", async () => {
    const abandoned = await seedAsset("reserved", at(-26 * HOUR), at(-2 * HOUR), ["original"]);
    await env.DB.prepare("INSERT INTO upload_tokens (asset_id, token_hash, expires_at) VALUES (?, ?, ?)")
      .bind(abandoned, "b".repeat(64), at(-2 * HOUR)).run();
    const inGrace = await seedAsset("reserved", at(-24 * HOUR - 30 * 60 * 1000), at(-30 * 60 * 1000), ["original"]);
    const open = await seedAsset("reserved", at(-1 * HOUR), at(23 * HOUR), ["original"]);
    const uploaded = await seedAsset("uploaded", at(-26 * HOUR), at(-2 * HOUR), ["original"]);

    await env.MEDIA.put(`${originalKey(abandoned)}/thumb`, new Uint8Array([1]));

    await runScheduled();

    expect(await assetState(abandoned)).toBe("deleted");
    expect(await stored(abandoned)).toBe(0);
    expect(await env.MEDIA.head(`${originalKey(abandoned)}/thumb`)).toBeNull();
    const token = await env.DB.prepare("SELECT COUNT(*) AS n FROM upload_tokens WHERE asset_id = ?").bind(abandoned).first<{ n: number }>();
    expect(Number(token?.n)).toBe(0);
    expect(await assetState(inGrace)).toBe("reserved");
    expect(await stored(inGrace)).toBe(1);
    expect(await assetState(open)).toBe("reserved");
    expect(await assetState(uploaded)).toBe("uploaded");
    expect(await stored(uploaded)).toBe(1);
  });

  it("finishes a deletion an earlier run left pending", async () => {
    const pending = await seedAsset("deletion_pending", at(-10 * DAY), at(-9 * DAY), ["display", "thumb"]);
    await runScheduled();
    expect(await assetState(pending)).toBe("deleted");
    expect(await stored(pending)).toBe(0);
  });

  it("is bounded per run and drains a backlog over several runs", async () => {
    const statements = [];
    for (let index = 0; index < RETENTION_BATCH + 5; index += 1) {
      statements.push(env.DB.prepare(
        `INSERT INTO assets (id, agent_id, state, content_type, byte_size, sha256, reason_code, original_stored, created_at, expires_at)
         VALUES (?, ?, 'reserved', 'image/webp', 4, ?, NULL, 0, ?, ?)`,
      ).bind(uuidv7(), agentId, SHA, at(-48 * HOUR), at(-24 * HOUR)));
    }
    await env.DB.batch(statements);

    expect((await runRetention(env, NOW)).assets_deleted).toBe(RETENTION_BATCH);
    expect((await runRetention(env, NOW)).assets_deleted).toBe(5);
    expect((await runRetention(env, NOW)).assets_deleted).toBe(0);
  });

  it("does nothing when the policy document is missing", async () => {
    const abandoned = await seedAsset("reserved", at(-26 * HOUR), at(-2 * HOUR), ["original"]);
    const noPolicy = { DB: env.DB, MEDIA: env.MEDIA, POLICY: undefined } as unknown as Env;
    expect(await runRetention(noPolicy, NOW)).toEqual({ ran: false, audit_redacted: 0, reports_redacted: 0, assets_deleted: 0, alerts: [] });
    expect(await assetState(abandoned)).toBe("reserved");
    expect(await stored(abandoned)).toBe(1);
  });
});

const BIG = 1_000_000_000_000_000;

async function r2Used(): Promise<number> {
  const result = await env.QUOTA.getByName("global").apply([
    { key: "r2_bytes", amount: 0, limit: BIG, reset_at: null, counter: "r2_bytes" },
  ]);
  return BIG - Number(result.remaining.r2_bytes ?? 0);
}

async function seedR2Used(bytes: number): Promise<void> {
  const result = await env.QUOTA.getByName("global").apply([
    { key: "r2_bytes", amount: bytes, limit: BIG, reset_at: null, counter: "r2_bytes" },
  ]);
  expect(result.ok).toBe(true);
}

describe("AT-46 rejected_at and r2_bytes refunds", () => {
  it("ages rejected Assets from rejected_at, falling back to created_at when it is NULL", async () => {
    const late = await seedAsset("rejected", at(-30 * DAY), at(-29 * DAY), ["original"], { rejectedAt: at(-2 * DAY) });
    const settled = await seedAsset("rejected", at(-30 * DAY), at(-29 * DAY), ["original"], { rejectedAt: at(-8 * DAY) });
    const legacyOld = await seedAsset("rejected", at(-9 * DAY), at(-8 * DAY), ["original"]);
    const legacyYoung = await seedAsset("rejected", at(-7 * DAY - 12 * HOUR), at(-6 * DAY - 12 * HOUR), ["original"]);

    await runScheduled();

    expect(await assetState(late)).toBe("rejected");
    expect(await stored(late)).toBe(1);
    expect(await assetState(settled)).toBe("deleted");
    expect(await stored(settled)).toBe(0);
    expect(await assetState(legacyOld)).toBe("deleted");
    expect(await assetState(legacyYoung)).toBe("rejected");

    await env.DB.prepare("UPDATE assets SET rejected_at = ? WHERE id = ?").bind(at(-7 * DAY - 1000), late).run();
    await runScheduled();
    expect(await assetState(late)).toBe("deleted");
    expect(await stored(late)).toBe(0);
  });

  it("records rejected_at when the pipeline rejects an in-flight Asset", async () => {
    const id = await seedAsset("uploaded", at(-1 * HOUR), at(23 * HOUR), ["original"]);
    await rejectInFlight(env.DB, id);
    const row = await env.DB.prepare("SELECT state, rejected_at FROM assets WHERE id = ?")
      .bind(id).first<{ state: string; rejected_at: string | null }>();
    expect(row?.state).toBe("rejected");
    expect(row?.rejected_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("refunds derivative bytes once when the sweep deletes an Asset, even if a run repeats", async () => {
    await seedR2Used(1000);
    const id = await seedAsset("quarantined", at(-30 * DAY), at(-29 * DAY), ["display", "thumb"], {
      sizes: { display: 30, thumb: 12 },
    });
    await quarantineAction(id, at(-8 * DAY));

    await runScheduled();
    expect(await assetState(id)).toBe("deleted");
    expect(await stored(id)).toBe(0);
    expect(await r2Used()).toBe(958);

    await runScheduled();
    expect(await r2Used()).toBe(958);

    // An interrupted run: the row is back in deletion_pending and the bytes are still there.
    await env.DB.prepare("UPDATE assets SET state = 'deletion_pending' WHERE id = ?").bind(id).run();
    await putObjects(id, ["display", "thumb"], { display: 30, thumb: 12 });
    await runScheduled();
    expect(await assetState(id)).toBe("deleted");
    expect(await stored(id)).toBe(0);
    expect(await r2Used()).toBe(958);

    expect(await refundAssetBytes(env, id, 42)).toBe(false);
    expect(await r2Used()).toBe(958);
  });

  it("never refunds r2_bytes below zero", async () => {
    await seedR2Used(10);
    const id = await seedAsset("deletion_pending", at(-10 * DAY), at(-9 * DAY), ["display", "thumb"], {
      sizes: { display: 30, thumb: 12 },
    });
    await runScheduled();
    expect(await assetState(id)).toBe("deleted");
    expect(await r2Used()).toBe(0);
  });

  it("refunds derivative bytes once when the Operator requests deletion", async () => {
    await seedR2Used(500);
    const id = await seedAsset("ready", at(-3 * DAY), at(-2 * DAY), ["display", "thumb"], {
      sizes: { display: 50, thumb: 20 },
    });

    const response = await call("/v1/deletion-requests", { email: OPERATOR, body: { agent_id: agentId } });
    expect(response.status).toBe(200);
    expect(await assetState(id)).toBe("deleted");
    expect(await stored(id)).toBe(0);
    expect(await r2Used()).toBe(430);

    await call("/v1/deletion-requests", { email: OPERATOR, body: { agent_id: agentId } });
    expect(await refundAssetBytes(env, id, 70)).toBe(false);
    expect(await r2Used()).toBe(430);
  });

  it("purges expired idempotency_keys, purges events older than audit_log_days, and sweeps stuck pending post_scans (#119)", async () => {
    const expiredAt = utcSeconds(new Date(NOW - 60_000));
    const freshAt = utcSeconds(new Date(NOW + 3_600_000));
    const oldEventAt = utcSeconds(new Date(NOW - 91 * 24 * 60 * 60 * 1000));
    const recentEventAt = utcSeconds(new Date(NOW - 10 * 24 * 60 * 60 * 1000));
    const stuckScanAt = utcSeconds(new Date(NOW - 20 * 60 * 1000));
    const freshScanAt = utcSeconds(new Date(NOW - 5 * 60 * 1000));
    const oldEventId = uuidv7();
    const recentEventId = uuidv7();
    const stuckPostId = uuidv7();
    const freshPostId = uuidv7();

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO idempotency_keys (agent_id, route, idempotency_key, body_hash, status, response_json, expires_at)
         VALUES ('a1', 'POST /v1/threads', 'k-expired', 'h1', 201, '{}', ?),
                ('a1', 'POST /v1/threads', 'k-fresh', 'h2', 201, '{}', ?)`,
      ).bind(expiredAt, freshAt),
      env.DB.prepare(
        `INSERT INTO events (id, type, resource_id, occurred_at)
         VALUES (?, 'post.published', ?, ?),
                (?, 'post.published', ?, ?)`,
      ).bind(oldEventId, stuckPostId, oldEventAt, recentEventId, freshPostId, recentEventAt),
      env.DB.prepare(
        `INSERT INTO post_scans (post_id, result, hidden, published_at)
         VALUES (?, 'pending', 0, ?),
                (?, 'pending', 0, ?)`,
      ).bind(stuckPostId, stuckScanAt, freshPostId, freshScanAt),
    ]);

    await runRetention(env, NOW);

    const keys = await env.DB.prepare("SELECT idempotency_key FROM idempotency_keys").all<{ idempotency_key: string }>();
    expect((keys.results ?? []).map((r) => r.idempotency_key)).toEqual(["k-fresh"]);

    const events = await env.DB.prepare("SELECT id FROM events WHERE id IN (?, ?)").bind(oldEventId, recentEventId).all<{ id: string }>();
    expect((events.results ?? []).map((r) => r.id)).toEqual([recentEventId]);

    const stuck = await env.DB.prepare("SELECT result FROM post_scans WHERE post_id = ?").bind(stuckPostId).first<{ result: string }>();
    const fresh = await env.DB.prepare("SELECT result FROM post_scans WHERE post_id = ?").bind(freshPostId).first<{ result: string }>();
    expect(stuck?.result).toBe("unscanned");
    expect(fresh?.result).toBe("pending");
  });
});

describe("scan backfill (CT-23)", () => {
  function backfillEnv(sent: unknown[], fail = false, policy = JSON.stringify(postpublishFixture)): Env {
    const queue = {
      async send(body: unknown): Promise<void> {
        sent.push(body);
        if (fail) throw new Error("queue unavailable");
      },
      async sendBatch(): Promise<void> {},
    };
    return new Proxy(env, {
      get(target, property) {
        if (property === "POLICY") return policy;
        if (property === "ASSET_UPLOAD") return queue;
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Env;
  }

  async function seedPublished(count: number): Promise<string[]> {
    const threadId = uuidv7();
    await env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)")
      .bind(threadId, BOARD_ID, at(-2 * DAY)).run();
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const id = uuidv7();
      ids.push(id);
      await env.DB.prepare(
        "INSERT INTO posts (id, thread_id, author_agent_id, caption, state, created_at) VALUES (?, ?, ?, 'old', 'published', ?)",
      ).bind(id, threadId, agentId, at(-2 * DAY + i * 1000)).run();
    }
    return ids;
  }

  async function scanResults(): Promise<Record<string, string>> {
    const listed = await env.DB.prepare("SELECT post_id, result FROM post_scans").all<{ post_id: string; result: string }>();
    return Object.fromEntries((listed.results ?? []).map((row) => [row.post_id, row.result]));
  }

  it("sends a bounded batch of unscanned published Posts for a scan in postpublish", async () => {
    const ids = await seedPublished(SCAN_BACKFILL_BATCH + 2);
    const sent: unknown[] = [];
    await runRetention(backfillEnv(sent), NOW);
    expect(sent).toEqual(ids.slice(0, SCAN_BACKFILL_BATCH).map((id) => ({ post_id: id })));
    const first = await scanResults();
    expect(Object.keys(first)).toHaveLength(SCAN_BACKFILL_BATCH);
    expect(Object.values(first).every((result) => result === "pending")).toBe(true);

    await runRetention(backfillEnv(sent), NOW);
    expect(sent).toHaveLength(SCAN_BACKFILL_BATCH + 2);
    expect(Object.keys(await scanResults())).toHaveLength(SCAN_BACKFILL_BATCH + 2);
    await runRetention(backfillEnv(sent), NOW);
    expect(sent).toHaveLength(SCAN_BACKFILL_BATCH + 2);
  });

  it("marks the row unscanned when the send fails", async () => {
    const [id] = await seedPublished(1);
    const sent: unknown[] = [];
    await runRetention(backfillEnv(sent, true), NOW);
    expect(sent).toHaveLength(1);
    expect((await scanResults())[String(id)]).toBe("unscanned");
  });

  it("does nothing in prepublish", async () => {
    await seedPublished(2);
    const sent: unknown[] = [];
    await runRetention(backfillEnv(sent, false, env.POLICY as string), NOW);
    expect(sent).toHaveLength(0);
    expect(Object.keys(await scanResults())).toHaveLength(0);
  });
});
