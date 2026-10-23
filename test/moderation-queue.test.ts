import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { derivativeKey } from "../src/asset-pipeline";
import { utcSeconds, uuidv7 } from "../src/ids";
import { ADMIN, ADMIN2, BOARD_ID, OPERATOR, STAFF, call, resetAndSeed } from "./harness";

// Gap analysis 2026-10-23, rows 10 to 19 and the moderation P3s: what reaches /moderation,
// prohibited removals and quarantines, the evidence read, and the reason code aliases.

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("prohibited reports are queued first (gap row 11, AT-35)", () => {
  it("marks a signed-in prohibited report queue_first and lists it first in line", async () => {
    const author = await enroll("Bea", ADMIN2);
    const seeded = await seedPost(author.agentId);
    await expectJson(await call("/v1/reports", {
      email: OPERATOR,
      body: { target_type: "post", target_id: seeded.postId, reason_code: "id-document" },
    }), 201);
    const row = await env.DB.prepare("SELECT state, queue_first FROM posts WHERE id = ?")
      .bind(seeded.postId).first<{ state: string; queue_first: number }>();
    expect(row).toEqual({ state: "quarantined", queue_first: 1 });
    const page = await moderationPage(STAFF);
    const first = section(page, "queue-first");
    expect(first).toContain(seeded.postId);
    expect(first).toContain("(quarantined)");
  });

  it("lists id-document and csam reports, signed-in or anonymous, before older reports", async () => {
    stubSiteverify();
    const author = await enroll("Bea", ADMIN2);
    const target = await seedPost(author.agentId);
    const older = await expectJson(await call("/v1/reports", {
      email: OPERATOR,
      body: { target_type: "agent", target_id: author.agentId, reason_code: "spam", detail: "older-spam" },
    }), 201);
    const anonymous = await expectJson(await call("/v1/reports", {
      body: {
        target_type: "post",
        target_id: target.postId,
        reason_code: "child-sexual-abuse-material",
        detail: "anonymous-csam",
        turnstile_token: "token-ok",
      },
    }), 201);
    await env.DB.batch([
      env.DB.prepare("UPDATE reports SET created_at = '2026-01-01T00:00:00Z' WHERE id = ?").bind(String(older.report_id)),
      env.DB.prepare("UPDATE reports SET created_at = '2026-01-02T00:00:00Z' WHERE id = ?").bind(String(anonymous.report_id)),
    ]);
    // The long name is an accepted alias, stored as the short code.
    const stored = await env.DB.prepare("SELECT reason_code FROM reports WHERE id = ?")
      .bind(String(anonymous.report_id)).first<{ reason_code: string }>();
    expect(stored?.reason_code).toBe("csam");
    // An anonymous report still quarantines nothing.
    const post = await env.DB.prepare("SELECT state FROM posts WHERE id = ?").bind(target.postId).first<{ state: string }>();
    expect(post?.state).toBe("published");

    const reports = section(await moderationPage(STAFF), "reports");
    expect(reports.indexOf("anonymous-csam")).toBeGreaterThan(-1);
    expect(reports.indexOf("older-spam")).toBeGreaterThan(reports.indexOf("anonymous-csam"));
  });
});

describe("prohibited reports page ahead of the rest (gap row 11, review 4364659822)", () => {
  async function seedReports(prefix: string, reason: string, count: number, day: string): Promise<void> {
    await env.DB.batch(Array.from({ length: count }, (_, index) => env.DB.prepare(
      `INSERT INTO reports (id, actor_email, target_type, target_id, reason_code, detail, state, created_at)
       VALUES (?, NULL, 'agent', ?, ?, ?, 'open', ?)`,
    ).bind(
      uuidv7(),
      uuidv7(),
      reason,
      `${prefix}-${String(index).padStart(3, "0")}`,
      `2026-01-${day}T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z`,
    )));
  }

  function details(html: string): string[] {
    const reports = section(html, "reports");
    return [...reports.matchAll(/<p>((?:prohibited|other)-\d{3})<\/p>/g)].map((match) => String(match[1]));
  }

  async function walk(start: string): Promise<string[][]> {
    const pages: string[][] = [];
    let href: string | null = start;
    while (href !== null && pages.length < 10) {
      const html = await moderationPage(STAFF, href);
      pages.push(details(html));
      href = nextReportsHref(html);
    }
    return pages;
  }

  it("reaches every report when the prohibited reports span more than one page", async () => {
    // Prohibited reports are newer than the others, and still come first.
    await seedReports("other", "spam", 30, "01");
    await seedReports("prohibited", "csam", 20, "02");
    await env.DB.batch(Array.from({ length: 12 }, (_, index) => env.DB.prepare(
      `INSERT INTO reports (id, actor_email, target_type, target_id, reason_code, detail, state, created_at)
       VALUES (?, NULL, 'agent', ?, 'id-document', ?, 'open', ?)`,
    ).bind(uuidv7(), uuidv7(), `prohibited-${String(20 + index).padStart(3, "0")}`, `2026-01-03T00:00:${String(index).padStart(2, "0")}Z`)));

    const pages = await walk("/moderation?limit=10");
    const prohibited = Array.from({ length: 32 }, (_, index) => `prohibited-${String(index).padStart(3, "0")}`);
    const other = Array.from({ length: 30 }, (_, index) => `other-${String(index).padStart(3, "0")}`);
    expect(pages.flat()).toEqual([...prohibited, ...other]);
    expect(pages.map((page) => page.length)).toEqual([10, 10, 10, 10, 10, 10, 2]);
    // Page 4 holds the last two prohibited reports, then the oldest other reports.
    expect(pages[3]?.slice(0, 3)).toEqual(["prohibited-030", "prohibited-031", "other-000"]);
  });

  it("starts the other reports on the next page when the prohibited reports fill a page exactly", async () => {
    await seedReports("prohibited", "csam", 10, "02");
    await seedReports("other", "rules", 3, "01");
    const pages = await walk("/moderation?limit=10");
    expect(pages).toEqual([
      Array.from({ length: 10 }, (_, index) => `prohibited-${String(index).padStart(3, "0")}`),
      ["other-000", "other-001", "other-002"],
    ]);
  });

  it("shows no next link when only prohibited reports exist and they fit", async () => {
    await seedReports("prohibited", "csam", 10, "02");
    const html = await moderationPage(STAFF, "/moderation?limit=10");
    expect(details(html)).toHaveLength(10);
    expect(nextReportsHref(html)).toBeNull();
  });
});

function nextReportsHref(html: string): string | null {
  const found = html.match(/<nav aria-label="Reports"><a href="([^"]+)">Next reports<\/a><\/nav>/);
  return found?.[1]?.replaceAll("&amp;", "&") ?? null;
}

describe("csam removal and the evidence read (gap row 12, AT-35, Part D item 5)", () => {
  it("suspends every active Agent of the Operator, quarantines the Asset, and keeps the hold", async () => {
    const ada = await enroll("Ada", OPERATOR);
    const cy = await enroll("Cy", OPERATOR);
    const other = await enroll("Bea", ADMIN2);
    const seeded = await seedPost(ada.agentId);
    const removed = await expectJson(await moderate(STAFF, {
      target_type: "post", target_id: seeded.postId, action: "remove", reason_code: "csam",
    }), 200);
    expect(removed.state).toBe("removal_pending");
    const states = await agentStates([ada.agentId, cy.agentId, other.agentId]);
    expect(states).toEqual({ [ada.agentId]: "suspended", [cy.agentId]: "suspended", [other.agentId]: "active" });
    const audits = await env.DB.prepare(
      "SELECT target_id FROM moderation_actions WHERE action = 'suspend_agent' AND reason_code = 'csam' ORDER BY target_id",
    ).all<{ target_id: string }>();
    expect((audits.results ?? []).map((row) => row.target_id).sort()).toEqual([ada.agentId, cy.agentId].sort());
    const post = await env.DB.prepare("SELECT legal_hold, legal_hold_reason FROM posts WHERE id = ?")
      .bind(seeded.postId).first<{ legal_hold: number; legal_hold_reason: string }>();
    expect(post).toEqual({ legal_hold: 1, legal_hold_reason: "csam" });
    const asset = await env.DB.prepare("SELECT state, quarantined_at FROM assets WHERE id = ?")
      .bind(seeded.assetId).first<{ state: string; quarantined_at: string | null }>();
    expect(asset?.state).toBe("quarantined");
    expect(asset?.quarantined_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    // Nobody reads the bytes through the public route, not even a Moderator.
    await env.MEDIA.put(derivativeKey(seeded.assetId, "display"), new Uint8Array([1, 2, 3, 4]));
    expect((await call(`/v1/assets/${seeded.assetId}/content?variant=display`, { email: ADMIN })).status).toBe(404);
  });

  it("lets only an Admin read held material, and audits every read", async () => {
    const ada = await enroll("Ada", OPERATOR);
    const seeded = await seedPost(ada.agentId);
    const unheld = await seedPost(ada.agentId);
    await expectJson(await moderate(STAFF, {
      target_type: "post", target_id: seeded.postId, action: "remove", reason_code: "csam",
    }), 200);
    await env.MEDIA.put(derivativeKey(seeded.assetId, "display"), new Uint8Array([7, 7, 7, 7]));

    await expectError(await call(`/admin/evidence/${seeded.postId}`), 401, "access_required");
    await expectError(await call(`/admin/evidence/${seeded.postId}`, { email: STAFF }), 403, "forbidden");
    await expectError(await call(`/admin/evidence/${seeded.postId}`, { email: OPERATOR }), 403, "forbidden");
    await expectError(await call(`/admin/evidence/${seeded.postId}/content?variant=display`, { email: STAFF }), 403, "forbidden");
    expect(await evidenceReads(seeded.postId)).toBe(0);

    const record = await expectJson(await call(`/admin/evidence/${seeded.postId}`, { email: ADMIN }), 200);
    expect(record).toMatchObject({
      post_id: seeded.postId,
      author_agent_id: ada.agentId,
      asset_id: seeded.assetId,
      legal_hold: true,
      legal_hold_reason: "csam",
      state: "removal_pending",
    });
    const bytes = await call(`/admin/evidence/${seeded.postId}/content?variant=display`, { email: ADMIN });
    expect(bytes.status).toBe(200);
    expect(bytes.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(new Uint8Array([7, 7, 7, 7]));
    expect(await evidenceReads(seeded.postId)).toBe(2);
    const actor = await env.DB.prepare(
      "SELECT DISTINCT actor_email FROM moderation_actions WHERE target_id = ? AND action LIKE 'evidence_read%'",
    ).bind(seeded.postId).all<{ actor_email: string }>();
    expect((actor.results ?? []).map((row) => row.actor_email)).toEqual([ADMIN]);

    // A Post with no legal hold is not evidence, and a read of it writes nothing.
    await expectError(await call(`/admin/evidence/${unheld.postId}`, { email: ADMIN }), 404, "not_found");
    expect(await evidenceReads(unheld.postId)).toBe(0);
  });
});

describe("the Flags section (gap row 13)", () => {
  it("lists published Posts with an open scan flag or a pending trial Seat Flag, with Hide, Remove, and Dismiss flags", async () => {
    const ada = await enroll("Ada", OPERATOR);
    const scanned = await seedPost(ada.agentId);
    const seat = await seedPost(ada.agentId);
    const dismissed = await seedPost(ada.agentId);
    const stamp = utcSeconds();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO post_scans (post_id, result, hidden, published_at) VALUES (?, 'unsafe', 0, ?)")
        .bind(scanned.postId, stamp),
      env.DB.prepare(
        "INSERT INTO seat_flags (id, seat, agent_id, post_id, reason, trial, outcome, created_at) VALUES (?, 1, ?, ?, 'off-topic', 1, 'pending', ?)",
      ).bind(uuidv7(), ada.agentId, seat.postId, stamp),
      env.DB.prepare(
        "INSERT INTO post_scans (post_id, result, hidden, published_at, dismissed_at) VALUES (?, 'unscanned', 0, ?, ?)",
      ).bind(dismissed.postId, stamp, stamp),
    ]);
    const flags = section(await moderationPage(STAFF), "queue-flags");
    expect(flags).toContain(scanned.postId);
    expect(flags).toContain("scan unsafe");
    expect(flags).toContain(seat.postId);
    expect(flags).toContain("1 seat flag");
    expect(flags).not.toContain(dismissed.postId);
    for (const action of ["hide", "remove", "dismiss_flags"]) {
      expect(flags).toContain(`name="action" value="${action}"`);
    }
    expect(flags).toContain("Dismiss flags");

    await expectJson(await moderate(STAFF, {
      target_type: "post", target_id: scanned.postId, action: "dismiss_flags", reason_code: "other",
    }), 200);
    expect(section(await moderationPage(STAFF), "queue-flags")).not.toContain(scanned.postId);
  });
});

describe("approve and restore keep the asset-ready guard (gap rows 16 and 17)", () => {
  it("refuses to approve a flagged Post whose Asset is quarantined", async () => {
    const ada = await enroll("Ada", OPERATOR);
    const held = await seedPost(ada.agentId, "flagged");
    await env.DB.prepare("UPDATE assets SET state = 'quarantined', quarantined_at = ? WHERE id = ?")
      .bind(utcSeconds(), held.assetId).run();
    await expectError(await moderate(STAFF, {
      target_type: "post", target_id: held.postId, action: "approve", reason_code: "rules",
    }), 409, "state_conflict");
    const fine = await seedPost(ada.agentId, "flagged");
    expect((await expectJson(await moderate(STAFF, {
      target_type: "post", target_id: fine.postId, action: "approve", reason_code: "rules",
    }), 200)).state).toBe("published");
  });

  it("removes the Blocked Hashes when an Admin restores a quarantined Post", async () => {
    const ada = await enroll("Ada", OPERATOR);
    const seeded = await seedPost(ada.agentId);
    await expectJson(await moderate(STAFF, {
      target_type: "post", target_id: seeded.postId, action: "quarantine", reason_code: "id-document",
    }), 200);
    expect(await blockedFor(seeded.assetId)).toBeGreaterThan(0);
    const restored = await expectJson(await moderate(ADMIN, {
      target_type: "post", target_id: seeded.postId, action: "restore", reason_code: "other",
    }), 200);
    expect(restored.state).toBe("published");
    expect(await blockedFor(seeded.assetId)).toBe(0);
    const asset = await env.DB.prepare("SELECT state, quarantined_at FROM assets WHERE id = ?")
      .bind(seeded.assetId).first<{ state: string; quarantined_at: string | null }>();
    expect(asset).toEqual({ state: "ready", quarantined_at: null });
  });
});

describe("a prohibited Post quarantine quarantines and blocks the Asset (gap row 18)", () => {
  it("quarantines the Asset and blocks its hashes for id-document, from published or hidden", async () => {
    const ada = await enroll("Ada", OPERATOR);
    const published = await seedPost(ada.agentId);
    await expectJson(await moderate(STAFF, {
      target_type: "post", target_id: published.postId, action: "quarantine", reason_code: "id-document",
    }), 200);
    const asset = await env.DB.prepare("SELECT state, quarantined_at FROM assets WHERE id = ?")
      .bind(published.assetId).first<{ state: string; quarantined_at: string | null }>();
    expect(asset?.state).toBe("quarantined");
    expect(asset?.quarantined_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const prohibited = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM blocked_hashes WHERE asset_id = ? AND prohibited = 1",
    ).bind(published.assetId).first<{ n: number }>();
    expect(Number(prohibited?.n ?? 0)).toBeGreaterThan(0);

    const hidden = await seedPost(ada.agentId, "hidden");
    const done = await expectJson(await moderate(STAFF, {
      target_type: "post", target_id: hidden.postId, action: "quarantine", reason_code: "csam",
    }), 200);
    expect(done.state).toBe("quarantined");
    const heldAsset = await env.DB.prepare("SELECT state FROM assets WHERE id = ?").bind(hidden.assetId).first<{ state: string }>();
    expect(heldAsset?.state).toBe("quarantined");
    expect(await blockedFor(hidden.assetId)).toBeGreaterThan(0);
  });

  it("leaves the Asset ready and unblocked for a quarantine with a non-prohibited reason", async () => {
    const ada = await enroll("Ada", OPERATOR);
    const seeded = await seedPost(ada.agentId);
    await expectJson(await moderate(STAFF, {
      target_type: "post", target_id: seeded.postId, action: "quarantine", reason_code: "rules",
    }), 200);
    const asset = await env.DB.prepare("SELECT state FROM assets WHERE id = ?").bind(seeded.assetId).first<{ state: string }>();
    expect(asset?.state).toBe("ready");
    expect(await blockedFor(seeded.assetId)).toBe(0);
  });
});

describe("reason code aliases (gap row 19, CT-09)", () => {
  it("accepts the long names on a moderation action and stores the short code", async () => {
    const ada = await enroll("Ada", OPERATOR);
    const seeded = await seedPost(ada.agentId);
    await expectJson(await moderate(STAFF, {
      target_type: "post", target_id: seeded.postId, action: "remove", reason_code: "identification-document",
    }), 200);
    const audit = await env.DB.prepare(
      "SELECT reason_code FROM moderation_actions WHERE target_id = ? AND action = 'remove'",
    ).bind(seeded.postId).first<{ reason_code: string }>();
    expect(audit?.reason_code).toBe("id-document");
    const prohibited = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM blocked_hashes WHERE asset_id = ? AND prohibited = 1",
    ).bind(seeded.assetId).first<{ n: number }>();
    expect(Number(prohibited?.n ?? 0)).toBeGreaterThan(0);
    // An id-document removal suspends nobody on its own.
    expect(await agentStates([ada.agentId])).toEqual({ [ada.agentId]: "active" });
    await expectError(await moderate(STAFF, {
      target_type: "post", target_id: seeded.postId, action: "remove", reason_code: "not-a-code",
    }), 422, "validation_failed");
  });
});

describe("owner deletion keeps a legal-hold removal (moderation P3)", () => {
  it("does not finish a removal_pending Post under legal hold", async () => {
    const ada = await enroll("Ada", OPERATOR);
    const held = await seedPost(ada.agentId, "removal_pending");
    const plain = await seedPost(ada.agentId, "removal_pending");
    await env.DB.prepare("UPDATE posts SET legal_hold = 1, legal_hold_reason = 'csam' WHERE id = ?").bind(held.postId).run();
    const response = await call("/v1/deletion-requests", { email: OPERATOR, body: { agent_id: ada.agentId } });
    expect(response.status).toBeLessThan(300);
    const states = await env.DB.prepare("SELECT id, state FROM posts WHERE id IN (?, ?)")
      .bind(held.postId, plain.postId).all<{ id: string; state: string }>();
    const byId = Object.fromEntries((states.results ?? []).map((row) => [row.id, row.state]));
    expect(byId[held.postId]).toBe("removal_pending");
    expect(byId[plain.postId]).toBe("removed");
  });
});

async function moderationPage(email: string, path = "/moderation"): Promise<string> {
  const response = await call(path, { email });
  expect(response.status).toBe(200);
  return response.text();
}

// The section whose heading has this id, up to the next section.
function section(html: string, id: string): string {
  const start = html.indexOf(`id="${id}"`);
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf("</section>", start);
  return html.slice(start, end === -1 ? undefined : end);
}

function moderate(email: string, body: Record<string, unknown>): Promise<Response> {
  return call("/v1/moderation/actions", { email, body });
}

async function blockedFor(assetId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM blocked_hashes WHERE asset_id = ?")
    .bind(assetId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function evidenceReads(postId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM moderation_actions WHERE target_id = ? AND action LIKE 'evidence_read%'",
  ).bind(postId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function agentStates(ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    const row = await env.DB.prepare("SELECT state FROM agents WHERE id = ?").bind(id).first<{ state: string }>();
    out[id] = row?.state ?? "missing";
  }
  return out;
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
): Promise<{ threadId: string; postId: string; assetId: string }> {
  const stamp = utcSeconds();
  const threadId = uuidv7();
  const postId = uuidv7();
  const assetId = uuidv7();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO assets (
         id, agent_id, state, content_type, byte_size, sha256, original_stored, created_at, expires_at
       ) VALUES (?, ?, 'ready', 'image/webp', 4, ?, 0, ?, ?)`,
    ).bind(assetId, authorId, assetId.replaceAll("-", "").padEnd(64, "e"), stamp, stamp),
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

function stubSiteverify(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url !== SITEVERIFY) return Promise.reject(new Error(`unexpected fetch ${url}`));
    const body = new URLSearchParams(String(init?.body ?? ""));
    const success = body.get("secret") === "turnstile-secret-test" && body.get("response") === "token-ok";
    return Promise.resolve(Response.json({ success }));
  });
}
