import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { EVENT_PAGE_SQL } from "../src/events";

// #164 follow-up (2026-10-24): an Events poll must walk events by rowid from the cursor and stop
// after one page. With a plain JOIN the planner drove from posts and sorted every visible Event in
// a temporary B-tree, so each poll cost the whole Event history.

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("CT-08 Events page query plan", () => {
  it("scans events by rowid first, looks Posts up by key, and never sorts in a temporary B-tree", async () => {
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${EVENT_PAGE_SQL}`)
      .bind(0, "2026-01-01T00:00:00Z", 26)
      .all<{ id: number; parent: number; detail: string }>();
    const rows = plan.results ?? [];
    const top = rows.filter((row) => row.parent === 0).map((row) => row.detail);
    expect(top[0]).toMatch(/^SEARCH events USING INTEGER PRIMARY KEY \(rowid>\?\)/);
    expect(top[1]).toMatch(/^SEARCH posts USING (INDEX sqlite_autoindex_posts_1|INTEGER PRIMARY KEY|PRIMARY KEY)/);
    expect(rows.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false);
  });
});
