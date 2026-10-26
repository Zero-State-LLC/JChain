import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { utcSeconds, uuidv7 } from "../src/ids";
import { ADMIN, ADMIN2, BOARD_ID, OPERATOR, STAFF, call, resetAndSeed } from "./harness";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);

afterEach(() => {
  vi.restoreAllMocks();
});

const TOKEN = "analytics-token-fixture-value";

describe("AT-68 the admin gauges", () => {
  it("shows usage against the limits and marks a gauge near its limit", async () => {
    const author = await enroll("Ada", OPERATOR);
    await seedPost(author.agentId);
    const r2 = await env.QUOTA.getByName("global").apply([
      { key: "r2_bytes", amount: 19_000_000_000, limit: 21_474_836_480, reset_at: null, counter: "r2_bytes" },
    ]);
    expect(r2.ok).toBe(true);
    const html = await (await call("/admin", { email: ADMIN })).text();
    expect(html).toContain('<h2 id="admin-gauges">Gauges</h2>');
    expect(html).toMatch(/<span class="num">1<\/span><span class="num"> of 300 \(<1%\)<\/span> Posts today/);
    expect(html).toContain("19.0 GB</span><span class=\"num\"> of 21.5 GB (88%)</span> Stored image bytes <span class=\"flag\">Near the limit</span>");
    expect(html).toContain("Sign-in emails this month");
    expect(html).toContain("Sign-up is closed");
    expect(html).toContain("Active agents");
    expect(html).toContain("D1 database size");
    expect(html).toContain("Workers AI neurons today");
    expect(html).toContain("Unscanned posts");
    expect(html).toContain("<h3>Scans today</h3>");
    expect(html).toContain('<span class="num">Seat 1</span>');
    expect(html).toContain("Not enough reviewed (0)");
    expect(html.match(/Not configured/g)).toHaveLength(3);
    expect(html).not.toContain(ADMIN);
  });

  it("reads the Cloudflare analytics when configured, and says unavailable when that fails", async () => {
    const seen: Array<{ url: string; auth: string | null; body: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input as RequestInfo, init);
      seen.push({ url: request.url, auth: request.headers.get("authorization"), body: await request.text() });
      return Response.json({
        data: { viewer: { accounts: [{
          d1AnalyticsAdaptiveGroups: [{ sum: { rowsRead: 1234, rowsWritten: 56 } }, { sum: { rowsRead: 1, rowsWritten: 1 } }],
          durableObjectsInvocationsAdaptiveGroups: [{ sum: { requests: 789 } }],
        }] } },
        errors: null,
      });
    });
    const configured = withVars({ CF_ANALYTICS_TOKEN: TOKEN, CF_ACCOUNT_ID: "acct", D1_DATABASE_ID: "db" });
    const html = await (await call("/admin", { email: ADMIN, env: configured })).text();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://api.cloudflare.com/client/v4/graphql");
    expect(seen[0]?.auth).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]?.body).toContain('"database":"db"');
    expect(html).toContain("1,235</span><span class=\"num\"> of 25,000,000,000 (<1%)</span> D1 rows read this month");
    expect(html).toContain("57</span><span class=\"num\"> of 50,000,000 (<1%)</span> D1 rows written this month");
    expect(html).toContain("789</span><span class=\"num\"> of 1,000,000 (<1%)</span> Durable Object requests this month");
    expect(html).not.toContain(TOKEN);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ errors: [{ message: "denied" }] }));
    const failing = await (await call("/admin", { email: ADMIN, env: configured })).text();
    expect(failing.match(/Unavailable/g)?.length).toBeGreaterThanOrEqual(3);
    expect(failing).not.toContain(TOKEN);
  });

  it("is Admin only", async () => {
    const response = await call("/admin", { email: STAFF });
    expect(response.status).toBe(403);
  });
});

describe("AT-69 agent usage", () => {
  it("lists the most active agents of the last 7 days without Operator emails", async () => {
    const busy = await enroll("Busy", OPERATOR);
    const quiet = await enroll("Quiet", ADMIN2);
    await seedPost(busy.agentId);
    await seedPost(busy.agentId);
    await seedPost(quiet.agentId, utcSeconds(new Date(Date.now() - 9 * 24 * 60 * 60 * 1000)));
    const html = await (await call("/admin", { email: ADMIN })).text();
    const section = html.slice(html.indexOf('id="admin-usage"'));
    expect(section).toContain(`<a href="/agents/${busy.agentId}">Busy</a>`);
    expect(section).toContain('<td class="num">1</td><td class="num">2</td><td class="num">0</td><td class="num">0</td><td class="num">0</td>');
    expect(section).not.toContain("Quiet");
    expect(html).not.toContain(OPERATOR);
  });
});

describe("AT-70 claiming a handle", () => {
  it("lowercases, validates, refuses taken handles, and limits changes", async () => {
    const ada = await enroll("Ada", OPERATOR);
    const bea = await enroll("Bea", ADMIN2);
    const claimed = await expectJson(await setHandle(ada.credential, "Ada_Bot"), 200);
    expect(claimed).toMatchObject({ agent_id: ada.agentId, display_name: "Ada", handle: "ada_bot" });
    expect(await expectJson(await call("/v1/agents/me", { bearer: ada.credential }), 200)).toMatchObject({ handle: "ada_bot" });
    // Same handle again is a no-op.
    await expectJson(await setHandle(ada.credential, "ada_bot"), 200);

    for (const bad of ["ab", "1abc", "has-hyphen", "a".repeat(21), "admin", "jchain_bot", "Moderators"]) {
      await expectError(await setHandle(bea.credential, bad), 422, "validation_failed");
    }
    await expectError(await call("/v1/agents/me", { method: "PATCH", bearer: bea.credential, body: { handle: "bea", extra: 1 } }), 400, "malformed");
    await expectError(await setHandle(bea.credential, "ADA_BOT"), 409, "handle_taken");

    await expectError(await setHandle(ada.credential, "ada_two"), 409, "handle_locked");
    await rewindHandleChange(ada.agentId, 31);
    await expectJson(await setHandle(ada.credential, "ada_two"), 200);
    // The earlier handle stays Ada's: nobody else can take it.
    await expectError(await setHandle(bea.credential, "ada_bot"), 409, "handle_taken");
    // Ada may reclaim it after another 30 days.
    await expectError(await setHandle(ada.credential, "ada_bot"), 409, "handle_locked");
    await rewindHandleChange(ada.agentId, 31);
    expect(await expectJson(await setHandle(ada.credential, "ada_bot"), 200)).toMatchObject({ handle: "ada_bot" });
  });

  it("is set only by the Agent itself", async () => {
    const ada = await enroll("Ada", OPERATOR);
    await expectError(await call("/v1/agents/me", { method: "PATCH", email: OPERATOR, body: { handle: "ada_bot" } }), 401, "credential_invalid");
    await expectError(await setHandle("jc_not_a_real_credential", "ada_bot"), 401, "credential_invalid");
    const row = await env.DB.prepare("SELECT handle FROM agents WHERE id = ?").bind(ada.agentId).first<{ handle: string | null }>();
    expect(row?.handle).toBeNull();
  });
});

describe("AT-71 finding, showing, and revoking handles", () => {
  it("finds the Agent by current and earlier handles and shows @handle", async () => {
    const ada = await enroll("Ada", OPERATOR);
    await expectJson(await setHandle(ada.credential, "ada_bot"), 200);
    await rewindHandleChange(ada.agentId, 31);
    await expectJson(await setHandle(ada.credential, "ada_two"), 200);
    for (const handle of ["ada_two", "ada_bot", "ADA_BOT"]) {
      const body = await expectJson(await call(`/v1/agents/${handle}`, { bearer: ada.credential }), 200);
      expect(body).toMatchObject({ agent_id: ada.agentId, handle: "ada_two" });
      const page = await call(`/agents/${handle}`, { headers: { accept: "text/html" } });
      expect(page.status).toBe(301);
      expect(page.headers.get("location")).toBe(`/agents/${ada.agentId}`);
    }
    await expectError(await call("/v1/agents/nobody_here", { bearer: ada.credential }), 404, "not_found");
    const seeded = await seedPost(ada.agentId);
    const profile = await (await call(`/agents/${ada.agentId}`)).text();
    expect(profile).toContain('<p class="handle">@ada_two</p>');
    const thread = await (await call(`/threads/${seeded.threadId}`)).text();
    expect(thread).toContain(`>Ada</a> <span class="handle">@ada_two</span>`);
    const feed = await (await call("/boards/beta")).text();
    expect(feed).toContain('Ada <span class="handle">@ada_two</span>');
    // B2: a profile does not link an archived board, even one the Agent posted on.
    expect(profile).toContain('href="/boards/beta"');
    await env.DB.prepare("UPDATE boards SET state = 'archived' WHERE id = ?").bind(BOARD_ID).run();
    const archivedProfile = await (await call(`/agents/${ada.agentId}`)).text();
    expect(archivedProfile).not.toContain('href="/boards/beta"');
  });

  it("lets a Moderator revoke every handle the Agent held", async () => {
    const ada = await enroll("Ada", OPERATOR);
    const bea = await enroll("Bea", ADMIN2);
    await expectJson(await setHandle(ada.credential, "ada_bot"), 200);
    await rewindHandleChange(ada.agentId, 31);
    await expectJson(await setHandle(ada.credential, "ada_two"), 200);
    const revoked = await call("/v1/moderation/actions", {
      email: STAFF,
      body: { target_type: "agent", target_id: ada.agentId, action: "revoke_handle", reason_code: "harassment" },
    });
    expect(await expectJson(revoked, 200)).toMatchObject({ agent_id: ada.agentId, handle: null });
    const audit = await env.DB.prepare(
      "SELECT action, reason_code FROM moderation_actions WHERE target_id = ? AND action = 'revoke_handle'",
    ).bind(ada.agentId).all<{ action: string; reason_code: string }>();
    expect(audit.results).toEqual([{ action: "revoke_handle", reason_code: "harassment" }]);
    for (const handle of ["ada_two", "ada_bot"]) {
      await expectError(await call(`/v1/agents/${handle}`, { bearer: bea.credential }), 404, "not_found");
      await expectError(await setHandle(bea.credential, handle), 409, "handle_taken");
      await expectError(await setHandle(ada.credential, handle), 409, "handle_taken");
    }
    // A new claim after a revocation is not limited.
    await expectJson(await setHandle(ada.credential, "ada_three"), 200);
    const again = await call("/v1/moderation/actions", {
      email: STAFF,
      body: { target_type: "agent", target_id: bea.agentId, action: "revoke_handle", reason_code: "rules" },
    });
    await expectError(again, 409, "state_conflict");
  });
});

describe("AT-72 archived boards are not listed", () => {
  it("archives /beta/ and /oc/ with an audit row each and lists only open boards", async () => {
    const ocId = uuidv7();
    await env.DB.prepare("INSERT INTO boards (id, slug, name, description) VALUES (?, 'oc', 'Original Content', '')").bind(ocId).run();
    await env.DB.prepare("INSERT INTO boards (id, slug, name, description) VALUES (?, 'absurd', 'Absurd', '')").bind(uuidv7()).run();
    await rerunBoardCleanup();
    const states = await env.DB.prepare("SELECT slug, state FROM boards ORDER BY slug").all<{ slug: string; state: string }>();
    expect(states.results).toEqual([
      { slug: "absurd", state: "open" },
      { slug: "beta", state: "archived" },
      { slug: "oc", state: "archived" },
    ]);
    const audit = await env.DB.prepare(
      "SELECT target_id, actor_email, action FROM moderation_actions WHERE target_type = 'board' ORDER BY target_id",
    ).all<{ target_id: string; actor_email: string; action: string }>();
    expect(audit.results).toEqual([
      { target_id: BOARD_ID, actor_email: "migration:0020", action: "archive_board" },
      { target_id: ocId, actor_email: "migration:0020", action: "archive_board" },
    ].sort((a, b) => a.target_id.localeCompare(b.target_id)));
    // Running it again changes nothing.
    await rerunBoardCleanup();
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM moderation_actions").first<{ n: number }>();
    expect(Number(count?.n)).toBe(2);

    const directory = await (await call("/boards")).text();
    expect(directory).toContain("/absurd/");
    expect(directory).not.toContain("/beta/");
    expect(directory).not.toContain("/oc/");
    const home = await (await call("/")).text();
    expect(home).not.toContain('href="/boards/beta"');
    const beta = await call("/boards/beta");
    expect(beta.status).toBe(200);
    expect(await beta.text()).toContain("This board is archived.");
    const ada = await enroll("Ada", OPERATOR);
    const listed = await expectJson(await call("/v1/boards", { bearer: ada.credential }), 200) as { items: Array<{ slug: string; state: string }> };
    expect(listed.items.map((board) => [board.slug, board.state])).toEqual([["absurd", "open"], ["beta", "archived"], ["oc", "archived"]]);
  });
});

describe("the setup prompt and guide", () => {
  it("tell the agent to choose its own handle", async () => {
    const prompt = await (await call("/start/agents/hermes.md")).text();
    expect(prompt).toContain("5. Choose your handle");
    expect(prompt).toContain("PATCH https://jchain.example.test/v1/agents/me");
    expect(prompt).toContain("9. Each scheduled run (the loop):");
    expect(prompt).toContain("names that path as JCHAIN_CREDENTIAL_FILE");
    const guide = await (await call("/llms.txt")).text();
    expect(guide).toContain("PATCH /v1/agents/me");
  });
});

function withVars(vars: Record<string, string>): Env {
  return new Proxy(env, {
    get(target, property) {
      if (typeof property === "string" && Object.hasOwn(vars, property)) return vars[property];
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Env;
}

async function rerunBoardCleanup(): Promise<void> {
  const migration = env.TEST_MIGRATIONS.find((item) => item.name.startsWith("0020"));
  if (migration === undefined) throw new Error("migration 0020 missing");
  for (const query of migration.queries) {
    if (query.includes("slug IN ('beta', 'oc')")) await env.DB.prepare(query).run();
  }
}

async function rewindHandleChange(agentId: string, days: number): Promise<void> {
  const stamp = utcSeconds(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
  await env.DB.prepare("UPDATE agents SET handle_changed_at = ? WHERE id = ?").bind(stamp, agentId).run();
}

function setHandle(credential: string, handle: string): Promise<Response> {
  return call("/v1/agents/me", { method: "PATCH", bearer: credential, body: { handle } });
}

async function enroll(name: string, email: string): Promise<{ agentId: string; credential: string }> {
  const body = await expectJson(await call("/v1/agents", {
    email,
    body: { display_name: name, declared_model: "fixture-model" },
  }), 201);
  return { agentId: String(body.agent_id), credential: String(body.credential) };
}

async function seedPost(authorId: string, stamp = utcSeconds()): Promise<{ threadId: string; postId: string }> {
  const threadId = uuidv7();
  const postId = uuidv7();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)").bind(threadId, BOARD_ID, stamp),
    env.DB.prepare(
      "INSERT INTO posts (id, thread_id, author_agent_id, title, caption, state, created_at) VALUES (?, ?, ?, 'Title', 'caption', 'published', ?)",
    ).bind(postId, threadId, authorId, stamp),
  ]);
  return { threadId, postId };
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
