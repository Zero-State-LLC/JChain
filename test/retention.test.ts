import { applyD1Migrations, createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { derivativeKey, originalKey } from "../src/asset-pipeline";
import { uuidv7 } from "../src/ids";
import { REDACTED_EMAIL, RETENTION_BATCH, runRetention } from "../src/retention";
import { MODERATOR, OPERATOR, OPERATOR_ID, resetAndSeed } from "./harness";

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

async function seedAsset(state: string, createdAt: string, expiresAt: string, keys: string[] = []): Promise<string> {
  const id = uuidv7();
  await env.DB.prepare(
    `INSERT INTO assets (id, agent_id, state, content_type, byte_size, sha256, reason_code, original_stored, created_at, expires_at)
     VALUES (?, ?, ?, 'image/webp', 4, ?, ?, ?, ?, ?)`,
  ).bind(
    id, agentId, state, SHA,
    state === "rejected" ? "invalid_image" : null,
    keys.includes("original") ? 1 : 0,
    createdAt, expiresAt,
  ).run();
  for (const key of keys) {
    const name = key === "original" ? originalKey(id) : derivativeKey(id, key as "display" | "thumb");
    await env.MEDIA.put(name, new Uint8Array([1, 2, 3, 4]));
  }
  return id;
}

async function quarantineAction(assetId: string, createdAt: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO moderation_actions (id, actor_email, target_type, target_id, action, reason_code, private_note, event_id, created_at)
     VALUES (?, ?, 'asset', ?, 'quarantine_asset', 'rules', 'note', NULL, ?)`,
  ).bind(uuidv7(), MODERATOR, assetId, createdAt).run();
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
    expect(again).toEqual({ ran: true, audit_redacted: 0, reports_redacted: 0, assets_deleted: 0 });
  });

  it("deletes quarantined bytes 7 days after the quarantine action", async () => {
    const expired = await seedAsset("quarantined", at(-30 * DAY), at(-29 * DAY), ["display", "thumb"]);
    await quarantineAction(expired, at(-8 * DAY));
    const recent = await seedAsset("quarantined", at(-30 * DAY), at(-29 * DAY), ["display", "thumb"]);
    await quarantineAction(recent, at(-2 * DAY));
    const ready = await seedAsset("ready", at(-300 * DAY), at(-299 * DAY), ["display", "thumb"]);

    await runScheduled();

    expect(await assetState(expired)).toBe("deleted");
    expect(await stored(expired)).toBe(0);
    expect(await assetState(recent)).toBe("quarantined");
    expect(await stored(recent)).toBe(2);
    expect(await assetState(ready)).toBe("ready");
    expect(await stored(ready)).toBe(2);
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
    expect(await runRetention(noPolicy, NOW)).toEqual({ ran: false, audit_redacted: 0, reports_redacted: 0, assets_deleted: 0 });
    expect(await assetState(abandoned)).toBe("reserved");
    expect(await stored(abandoned)).toBe(1);
  });
});
