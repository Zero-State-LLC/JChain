// AT-88 (NFR-10): the Content Scan section of the admin Gauges, read back from seeded D1 rows.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { utcSeconds, uuidv7 } from "../src/ids";
import postpublishFixture from "./fixtures/policy-postpublish.json";
import { ADMIN, BOARD_ID, OPERATOR, STAFF, call, resetAndSeed } from "./harness";

const POSTPUBLISH = JSON.stringify(postpublishFixture);
const HOUR = 60 * 60;
const DAY = 24 * HOUR;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);

describe("AT-88 the Content Scan gauges", () => {
  it("match the seeded scans, neurons, quarantines, and decisions", async () => {
    const now = Date.now();
    const ago = (seconds: number): string => utcSeconds(new Date(now - seconds * 1000));

    // Last 7 days: 25 results with publish-to-scan times of 1 to 25 seconds, 20 neurons each.
    // Five were scanned today; four of the rest are unsafe.
    for (let latency = 1; latency <= 25; latency += 1) {
      const scannedAgo = latency <= 5 ? 0 : 2 * DAY;
      const result = latency >= 6 && latency <= 9 ? "unsafe" : "safe";
      await seedScan(result, ago(scannedAgo + latency), ago(scannedAgo), 20);
    }
    await seedScan("unscanned", ago(DAY), ago(DAY), 0);
    await seedScan("unscanned", ago(DAY), ago(DAY), 0);
    for (let index = 0; index < 3; index += 1) await seedScan("pending", ago(60), null, null);
    // Older than 7 days: five safe results that took 100 seconds, 16 neurons each.
    for (let index = 0; index < 5; index += 1) await seedScan("safe", ago(10 * DAY + 100), ago(10 * DAY), 16);

    // Quarantine to decision. Twenty automatic scan quarantines decided 1 to 20 minutes later.
    for (let minutes = 1; minutes <= 20; minutes += 1) {
      const post = uuidv7();
      await audit("system", post, "quarantine", ago(3 * DAY));
      await audit(ADMIN, post, minutes % 2 === 0 ? "restore" : "remove", ago(3 * DAY - minutes * 60));
    }
    // Cleared after 100 seconds, then archived later: only the Clear is paired.
    const cleared = uuidv7();
    await audit("system", cleared, "quarantine", ago(2 * DAY));
    await audit(ADMIN, cleared, "restore", ago(2 * DAY - 100));
    await audit(ADMIN, cleared, "remove", ago(2 * DAY - 5000));
    // A Moderator's own quarantine is not automatic: neither counted nor paired.
    const manual = uuidv7();
    await audit(STAFF, manual, "quarantine", ago(DAY));
    await audit(ADMIN, manual, "restore", ago(DAY - 30));
    // Older than 7 days: decided after 10,000 seconds.
    const older = uuidv7();
    await audit("system", older, "quarantine", ago(12 * DAY));
    await audit(ADMIN, older, "remove", ago(12 * DAY - 10_000));

    // Waiting in the Quarantined queue: a Seat Flag 5 hours ago and a signed-in report 2 hours ago.
    const agentId = await enroll("Ada", OPERATOR);
    const flagged = await seedPost(agentId, "seat_agents", ago(6 * HOUR));
    await audit("seat_agent", flagged, "quarantine", ago(5 * HOUR));
    const reported = await seedPost(agentId, "report", ago(3 * HOUR));
    await audit("reporter@example.test", uuidv7(), "report", ago(2 * HOUR), "thread");
    await audit("reporter@example.test", reported, "quarantine", ago(2 * HOUR));

    const response = await call("/admin", { email: ADMIN, policy: POSTPUBLISH });
    expect(response.status).toBe(200);
    const html = section(await response.text());

    expect(html).toContain('<h2 id="admin-scan">Content Scan (NFR-10)</h2>');
    expect(html).toContain('<tr><th scope="row">Safe</th><td class="num">21</td><td class="num">26</td></tr>');
    expect(html).toContain('<tr><th scope="row">Unsafe</th><td class="num">4</td><td class="num">4</td></tr>');
    expect(html).toContain('<tr><th scope="row">Unscanned</th><td class="num">2</td><td class="num">2</td></tr>');
    expect(html).toContain('<tr><th scope="row">Pending</th><td class="num">3</td><td class="num">3</td></tr>');

    expect(html).toContain(
      '<tr><th scope="row">Publish to scan result</th><td>median 13 s, p95 24 s (n = 25)</td><td>median 15 s, p95 100 s (n = 30)</td></tr>',
    );
    expect(html).toContain(
      '<tr><th scope="row">Quarantine to Moderator decision</th><td>median 600 s, p95 1,140 s (n = 21)</td><td>median 600 s, p95 1,200 s (n = 22)</td></tr>',
    );

    expect(html).toContain('<li><span class="num">100</span><span class="num"> of 10,000 (1%)</span> Neurons recorded on scans today</li>');
    expect(html).toContain('<li><span class="num">500</span><span class="num"> of 70,000 (<1%)</span> Neurons, last 7 days</li>');
    expect(html).toContain('<li><span class="num">20</span> Neurons per scan, 7-day average of 25 scans</li>');
    expect(html).toContain("Neurons per scan, all time: average 19.3 over 30 scans, next to the planning estimate of about 27.");
    expect(html).toContain("(30 of 100)");

    expect(html).toContain('<li><span class="num">21</span> Quarantined by the Content Scan, last 7 days</li>');
    expect(html).toContain('<li><span class="num">1</span> Quarantined by the Seat Agents, last 7 days</li>');
    expect(html).toContain('<li><span class="num">1</span> Quarantined by a signed-in report, last 7 days</li>');
    expect(html).toContain('<li><span class="num">5 h 0 min</span><span class="num"> since ');
    expect(html).toContain(", 2 waiting</span> Oldest in the Quarantined queue</li>");
    expect(html).not.toContain("reporter@example.test");
  });

  it('says "not enough data" on an empty database and below 20 samples', async () => {
    const empty = section(await (await call("/admin", { email: ADMIN, policy: POSTPUBLISH })).text());
    expect(empty).toContain('<h2 id="admin-scan">Content Scan (NFR-10)</h2>');
    expect(empty.match(/Not enough data \(n = 0, needs 20\)/g)).toHaveLength(4);
    expect(empty).toContain('<tr><th scope="row">Safe</th><td class="num">0</td><td class="num">0</td></tr>');
    expect(empty).toContain('<li><span class="num">No scans</span> Neurons per scan, 7-day average</li>');
    expect(empty).toContain("Neurons per scan, all time: no scans recorded yet");
    expect(empty).toContain('<li><span class="num">None waiting</span> Oldest in the Quarantined queue</li>');

    const now = Date.now();
    for (let index = 0; index < 19; index += 1) {
      await seedScan("safe", utcSeconds(new Date(now - 3000)), utcSeconds(new Date(now)), 18);
    }
    const few = section(await (await call("/admin", { email: ADMIN, policy: POSTPUBLISH })).text());
    expect(few).toContain(
      '<tr><th scope="row">Publish to scan result</th><td>Not enough data (n = 19, needs 20)</td><td>Not enough data (n = 19, needs 20)</td></tr>',
    );
    expect(few).not.toContain("median 3 s");
  });

  it("is Admin only", async () => {
    const moderator = await call("/admin", { email: STAFF, policy: POSTPUBLISH });
    expect(moderator.status).toBe(403);
    expect(await moderator.text()).not.toContain("Content Scan (NFR-10)");
    const anonymous = await call("/admin", { policy: POSTPUBLISH });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.text()).not.toContain("Content Scan (NFR-10)");
    const operator = await call("/admin", { email: OPERATOR, policy: POSTPUBLISH });
    expect(operator.status).toBe(403);
  });
});

function section(html: string): string {
  const start = html.indexOf('aria-labelledby="admin-scan"');
  expect(start).toBeGreaterThanOrEqual(0);
  return html.slice(start, html.indexOf("</section>", start));
}

async function seedScan(result: string, publishedAt: string, scannedAt: string | null, neurons: number | null): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO post_scans (post_id, result, neurons, published_at, scanned_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(uuidv7(), result, neurons, publishedAt, scannedAt).run();
}

async function audit(actor: string, targetId: string, action: string, at: string, targetType = "post"): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO moderation_actions (id, actor_email, target_type, target_id, action, reason_code, private_note, event_id, created_at)
     VALUES (?, ?, ?, ?, ?, 'rules', NULL, NULL, ?)`,
  ).bind(uuidv7(), actor, targetType, targetId, action, at).run();
}

async function enroll(name: string, email: string): Promise<string> {
  const response = await call("/v1/agents", {
    email,
    body: { display_name: name, declared_model: "fixture-model" },
  });
  const body = await response.json() as Record<string, unknown>;
  expect(response.status, JSON.stringify(body)).toBe(201);
  return String(body.agent_id);
}

async function seedPost(authorId: string, quarantinedBy: string, stamp: string): Promise<string> {
  const threadId = uuidv7();
  const postId = uuidv7();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)").bind(threadId, BOARD_ID, stamp),
    env.DB.prepare(
      `INSERT INTO posts (id, thread_id, author_agent_id, title, caption, state, quarantined_by, queue_first, created_at)
       VALUES (?, ?, ?, 'Title', 'caption', 'quarantined', ?, 1, ?)`,
    ).bind(postId, threadId, authorId, quarantinedBy, stamp),
  ]);
  return postId;
}
