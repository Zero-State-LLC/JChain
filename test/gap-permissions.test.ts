import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTHORSHIP_RULE_VERSION as AUTHORSHIP_VERSION_FOR_TESTS } from "../src/authorship";
import { sha256Hex } from "../src/credential";
import { utcSeconds, uuidv7 } from "../src/ids";
import {
  ADMIN,
  ADMIN2,
  BOARD_ID,
  OPERATOR,
  OPERATOR_ID,
  STAFF,
  call,
  clearConnectQuota,
  clearSignInQuota,
  resetAndSeed,
} from "./harness";

// Gap analysis 2026-10-23, rows 5, 6, 7, 8, 23, the P3 identity items, and the
// AT-29 / AT-31 / AT-43 test gaps.

const ORIGIN = "https://jchain.example.test";
const FORM = { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN };
const OTHER = "other@example.test";
const OTHER_ID = "01900000-0000-7000-8000-0000000000b1";

type Sent = { from: string; to: string; subject: string; text: string };

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetAndSeed();
  await env.DB.batch([env.DB.prepare("DELETE FROM sessions"), env.DB.prepare("DELETE FROM signin_links")]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("who suspended an Agent (gap row 5, CT-10)", () => {
  it("refuses an Operator resume of a Moderator suspension, on JSON and on the page", async () => {
    const ada = await enroll("Ada", OPERATOR);
    expect(await json(await moderate(STAFF, "agent", ada.agentId, "suspend_agent"), 200)).toMatchObject({ state: "suspended" });
    expect(await suspendedBy(ada.agentId)).toBe("moderator");

    await expectError(await post(`/v1/agents/${ada.agentId}/resume`, OPERATOR), 403, "forbidden");
    const page = await call(`/operator/agents/${ada.agentId}/resume`, { email: OPERATOR, method: "POST" });
    expect(page.status).toBe(403);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("Only a Moderator can resume it.");
    const listing = await (await call("/operator", { email: OPERATOR })).text();
    expect(listing).toContain("A Moderator suspended this agent.");
    expect(listing).not.toContain(`/operator/agents/${ada.agentId}/resume`);
    expect(await stateOf(ada.agentId)).toBe("suspended");

    expect(await json(await moderate(STAFF, "agent", ada.agentId, "resume_agent"), 200)).toMatchObject({ state: "active" });
    expect(await suspendedBy(ada.agentId)).toBeNull();
  });

  it("records a Moderator suspend on the agent route too, and lets a Moderator resume either kind", async () => {
    const ada = await enroll("Ada", OPERATOR);
    await json(await post(`/v1/agents/${ada.agentId}/suspend`, STAFF), 200);
    expect(await suspendedBy(ada.agentId)).toBe("moderator");
    await expectError(await post(`/v1/agents/${ada.agentId}/resume`, OPERATOR), 403, "forbidden");
    await json(await post(`/v1/agents/${ada.agentId}/resume`, STAFF), 200);

    // The Operator's own suspension: the Operator and a Moderator may both lift it.
    await json(await post(`/v1/agents/${ada.agentId}/suspend`, OPERATOR), 200);
    expect(await suspendedBy(ada.agentId)).toBe("operator");
    await json(await post(`/v1/agents/${ada.agentId}/resume`, OPERATOR), 200);
    expect(await suspendedBy(ada.agentId)).toBeNull();
    const form = await call(`/operator/agents/${ada.agentId}/suspend`, { email: OPERATOR, method: "POST" });
    expect(form.status).toBe(200);
    expect(await suspendedBy(ada.agentId)).toBe("operator");
    expect(await json(await moderate(STAFF, "agent", ada.agentId, "resume_agent"), 200)).toMatchObject({ state: "active" });
  });

  it("keeps a csam removal's Operator-wide suspension out of the Operator's hands", async () => {
    const ada = await enroll("Ada", OPERATOR);
    const cy = await enroll("Cy", OPERATOR);
    const seeded = await seedPost(ada.agentId, true);
    expect(await json(await call("/v1/moderation/actions", {
      email: STAFF,
      body: { target_type: "post", target_id: seeded.postId, action: "remove", reason_code: "csam" },
    }), 200)).toMatchObject({ state: "removal_pending" });
    for (const agentId of [ada.agentId, cy.agentId]) {
      expect(await stateOf(agentId)).toBe("suspended");
      expect(await suspendedBy(agentId)).toBe("moderator");
    }
    await expectError(await post(`/v1/agents/${cy.agentId}/resume`, OPERATOR), 403, "forbidden");
    expect((await call(`/operator/agents/${ada.agentId}/resume`, { email: OPERATOR, method: "POST" })).status).toBe(403);
    expect(await stateOf(cy.agentId)).toBe("suspended");
  });
});

describe("only the owner gets a Credential secret (gap rows 6 and 8, CT-10)", () => {
  it("revokes without a secret when a Moderator rotates, and the owner issues the next one", async () => {
    const ada = await enroll("Ada", OPERATOR);
    const byStaff = await call(`/v1/agents/${ada.agentId}/credentials`, { email: STAFF, method: "POST" });
    const body = await json(byStaff, 200);
    expect(body).toMatchObject({ agent_id: ada.agentId, credential: null, state: "revoked" });
    expect(String(body.message)).toContain("Only the agent's own Operator can issue a new one.");
    expect(JSON.stringify(body)).not.toMatch(/jc_[A-Za-z0-9_-]{20,}/);
    expect(await activeCount(ada.agentId)).toBe(0);
    await expectError(await call("/v1/agents/me", { bearer: ada.credential }), 401, "credential_invalid");
    const audit = await env.DB.prepare(
      "SELECT actor_email FROM moderation_actions WHERE target_id = ? AND action = 'revoke_credential'",
    ).bind(ada.agentId).first<{ actor_email: string }>();
    expect(audit?.actor_email).toBe(STAFF);
    // Nothing left to revoke.
    await expectError(await call(`/v1/agents/${ada.agentId}/credentials`, { email: STAFF, method: "POST" }), 409, "state_conflict");

    const issued = await json(await post(`/v1/agents/${ada.agentId}/credentials`, OPERATOR), 201);
    const fresh = String(issued.credential);
    expect(fresh).toMatch(/^jc_/);
    expect((await call("/v1/agents/me", { bearer: fresh })).status).toBe(200);
  });

  it("gives a secret to a Moderator who is also the owning Operator", async () => {
    const own = await enroll("Own", ADMIN2);
    const rotated = await json(await post(`/v1/agents/${own.agentId}/credentials`, ADMIN2), 201);
    expect(String(rotated.credential)).toMatch(/^jc_/);
    expect((await call("/v1/agents/me", { bearer: String(rotated.credential) })).status).toBe(200);
  });

  it("lets the owner issue a Credential after a revoke, but never for a retired Agent", async () => {
    const ada = await enroll("Ada", OPERATOR);
    const active = await env.DB.prepare("SELECT id FROM credentials WHERE agent_id = ? AND state = 'active'")
      .bind(ada.agentId).first<{ id: string }>();
    await json(await post(`/v1/credentials/${active!.id}/revoke`, OPERATOR), 200);
    expect(await activeCount(ada.agentId)).toBe(0);

    const issued = await json(await post(`/v1/agents/${ada.agentId}/credentials`, OPERATOR), 201);
    expect((await call("/v1/agents/me", { bearer: String(issued.credential) })).status).toBe(200);
    expect(await activeCount(ada.agentId)).toBe(1);
    // With one active, rotate still revokes it and issues one in the same batch.
    const rotated = await json(await post(`/v1/agents/${ada.agentId}/credentials`, OPERATOR), 201);
    expect(await activeCount(ada.agentId)).toBe(1);
    await expectError(await call("/v1/agents/me", { bearer: String(issued.credential) }), 401, "credential_invalid");

    // The Operator page issues one too after a revoke.
    const current = await env.DB.prepare("SELECT id FROM credentials WHERE agent_id = ? AND state = 'active'")
      .bind(ada.agentId).first<{ id: string }>();
    await json(await post(`/v1/credentials/${current!.id}/revoke`, OPERATOR), 200);
    const page = await call(`/operator/agents/${ada.agentId}/credentials`, { email: OPERATOR, method: "POST" });
    expect(page.status).toBe(201);
    const shown = (await page.text()).match(/class="secret">(jc_[A-Za-z0-9_-]{43})</)?.[1];
    expect(shown).toBeDefined();
    expect(shown).not.toBe(String(rotated.credential));
    expect((await call("/v1/agents/me", { bearer: shown! })).status).toBe(200);

    await json(await post(`/v1/agents/${ada.agentId}/retire`, OPERATOR), 200);
    await expectError(await post(`/v1/agents/${ada.agentId}/credentials`, OPERATOR), 409, "state_conflict");
    expect(await activeCount(ada.agentId)).toBe(0);
  });
});

describe("Seat Agent powers stay held after a pause or readmit (gap row 7, AT-43, CT-22)", () => {
  it("keeps a readmitted seat flag-only after its trial until the other Admin restores it", async () => {
    await seatOperator(ADMIN);
    const seat = await enroll("Seat", ADMIN);
    const author = await enroll("Author", OPERATOR);
    await json(await seatAction(ADMIN, 1, { action: "bind_seat_agent", agent_id: seat.agentId }), 200);
    expect(await json(await seatAction(ADMIN, 1, { action: "pause_seat_agent" }), 200)).toMatchObject({ seat_state: "paused" });
    expect(await json(await seatAction(ADMIN, 1, { action: "readmit_seat_agent" }), 200))
      .toMatchObject({ seat_state: "trial", seat_trial_count: 0 });

    // The trial runs out (10 flags) and the seat is still flag-only.
    for (let index = 0; index < 11; index += 1) {
      const seeded = await seedPost(author.agentId);
      expect(await json(await flag(seeded.postId, seat.credential), 200)).toMatchObject({ state: "published", trial: 1 });
    }
    const row = await env.DB.prepare("SELECT seat_state, seat_trial_count, powers_held FROM admin_seats WHERE seat = 1")
      .first<{ seat_state: string; seat_trial_count: number; powers_held: number }>();
    expect(row).toEqual({ seat_state: "trial", seat_trial_count: 11, powers_held: 1 });

    // A rebind does not lift the hold either.
    await json(await seatAction(ADMIN, 1, { action: "bind_seat_agent", agent_id: seat.agentId }), 200);
    expect((await env.DB.prepare("SELECT powers_held FROM admin_seats WHERE seat = 1").first<{ powers_held: number }>())?.powers_held).toBe(1);
    for (let index = 0; index < 10; index += 1) await json(await flag((await seedPost(author.agentId)).postId, seat.credential), 200);

    await expectError(await seatAction(ADMIN, 1, { action: "restore_seat_powers" }), 403, "forbidden");
    expect(await json(await seatAction(ADMIN2, 1, { action: "restore_seat_powers" }), 200)).toMatchObject({ seat_state: "active" });
    // A real (non-trial) flag again: any active flag quarantines the Post (v0.2.36, CT-22).
    expect(await json(await flag((await seedPost(author.agentId)).postId, seat.credential), 200))
      .toMatchObject({ state: "quarantined", trial: 0, event_type: "post.flagged" });
    const audit = await env.DB.prepare(
      "SELECT action FROM moderation_actions WHERE target_type = 'admin_seat' ORDER BY created_at, id",
    ).all<{ action: string }>();
    // One audit row per applied action; the refused own-Admin restore wrote none.
    expect((audit.results ?? []).map((item) => item.action).sort()).toEqual([
      "bind_seat_agent", "bind_seat_agent", "pause_seat_agent", "readmit_seat_agent", "restore_seat_powers",
    ]);
  });

  it("refuses restore_seat_powers on a fresh trial or an active seat, on JSON and the form", async () => {
    await seatOperator(ADMIN);
    const seat = await enroll("Seat", ADMIN);
    await json(await seatAction(ADMIN, 1, { action: "bind_seat_agent", agent_id: seat.agentId }), 200);
    await expectError(await seatAction(ADMIN2, 1, { action: "restore_seat_powers" }), 409, "state_conflict");
    const form = await call("/admin/seats/1", {
      email: ADMIN2,
      method: "POST",
      raw: encode({ action: "restore_seat_powers" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(form.status).toBe(409);
    await env.DB.prepare("UPDATE admin_seats SET seat_state = 'active', seat_trial_count = 10 WHERE seat = 1").run();
    await expectError(await seatAction(ADMIN2, 1, { action: "restore_seat_powers" }), 409, "state_conflict");
    const seatRow = await env.DB.prepare("SELECT seat_state FROM admin_seats WHERE seat = 1").first<{ seat_state: string }>();
    expect(seatRow?.seat_state).toBe("active");
    const restores = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM moderation_actions WHERE action = 'restore_seat_powers'",
    ).first<{ n: number }>();
    expect(Number(restores?.n ?? 0)).toBe(0);
  });
});

describe("Seat Flags and the seat routes (gap row 23 and P3, CT-22, CT-20)", () => {
  it("holds one Seat Flag per seat and Post in the schema", async () => {
    const author = await enroll("Author", OPERATOR);
    const seeded = await seedPost(author.agentId);
    const insert = () => env.DB.prepare(
      "INSERT INTO seat_flags (id, seat, agent_id, post_id, reason, trial, outcome, created_at) VALUES (?, 1, ?, ?, 'off-topic', 1, 'pending', ?)",
    ).bind(uuidv7(), author.agentId, seeded.postId, utcSeconds()).run();
    await insert();
    await expect(insert()).rejects.toThrow(/UNIQUE/);
  });

  it("answers forbidden to a flag with no bearer Credential", async () => {
    const author = await enroll("Author", OPERATOR);
    const seeded = await seedPost(author.agentId);
    for (const options of [{}, { email: OPERATOR }, { email: STAFF }]) {
      await expectError(await call(`/v1/posts/${seeded.postId}/flag`, {
        ...options,
        method: "PUT",
        body: { reason: "off-topic" },
      }), 403, "forbidden");
    }
    await expectError(await call(`/v1/posts/${seeded.postId}/flag`, {
      method: "PUT",
      bearer: "jc_not-a-real-credential",
      body: { reason: "off-topic" },
    }), 401, "credential_invalid");
  });

  it("requires the seat email to be an enrolled Moderator on the Admin Seat routes", async () => {
    await env.DB.prepare("DELETE FROM moderators WHERE email = ?").bind(ADMIN2).run();
    await expectError(await call("/admin", { email: ADMIN2 }), 403, "forbidden");
    await expectError(await seatAction(ADMIN2, 2, { action: "pause_seat_agent" }), 403, "forbidden");
    expect((await call("/admin", { email: ADMIN })).status).toBe(200);
  });

  it("records the Authorship Rule agreement with the connect approval (CT-29)", async () => {
    await env.DB.prepare("UPDATE operators SET authorship_attested_version = NULL, authorship_attested_at = NULL WHERE id = ?")
      .bind(OPERATOR_ID).run();
    await clearConnectQuota();
    const started = await (await call("/v1/connect", { body: { display_name: "Cy", declared_model: "m" } })).json() as { user_code: string };
    const approved = await call("/operator/connect", {
      email: OPERATOR,
      raw: encode({ code: started.user_code, decision: "approve", attest: "yes" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(approved.status).toBe(200);
    const row = await env.DB.prepare(
      `SELECT operators.authorship_attested_version AS version, operators.authorship_attested_at AS at,
              agent_connections.answered_at AS answered
         FROM operators JOIN agent_connections ON agent_connections.operator_id = operators.id
        WHERE operators.id = ?`,
    ).bind(OPERATOR_ID).first<{ version: string | null; at: string | null; answered: string | null }>();
    expect(row?.version).toBe(AUTHORSHIP_VERSION_FOR_TESTS);
    expect(row?.at).toBe(row?.answered);
  });
});

describe("AT-29 Sessions end with the Operator, and sign-in logs no secrets", () => {
  it("ends an Operator's Sessions when it is suspended and when it is removed", async () => {
    const sent: Sent[] = [];
    const bindings = signInEnv(sent);
    await clearSignInQuota(OPERATOR);
    const cookie = await signIn(bindings, sent, OPERATOR);
    expect((await call("/operator", { headers: { cookie }, env: bindings })).status).toBe(200);
    await json(await operatorAction("suspend_operator", OPERATOR_ID), 200);
    expect((await call("/operator", { headers: { cookie }, env: bindings })).status).toBe(401);
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE operator_id = ? AND revoked_at IS NULL")
      .bind(OPERATOR_ID).first<{ n: number }>();
    expect(Number(open?.n ?? 0)).toBe(0);
    // Resuming does not bring the old Session back.
    await json(await operatorAction("resume_operator", OPERATOR_ID), 200);
    expect((await call("/operator", { headers: { cookie }, env: bindings })).status).toBe(401);

    await env.DB.prepare(
      "INSERT INTO operators (email, id, authorship_attested_version, authorship_attested_at) VALUES (?, ?, ?, '2026-10-22T00:00:00Z')",
    ).bind(OTHER, OTHER_ID, AUTHORSHIP_VERSION_FOR_TESTS).run();
    await clearSignInQuota(OTHER);
    const other = await signIn(bindings, sent, OTHER);
    expect((await call("/operator", { headers: { cookie: other }, env: bindings })).status).toBe(200);
    await json(await operatorAction("remove_operator", OTHER_ID), 200);
    expect((await call("/operator", { headers: { cookie: other }, env: bindings })).status).toBe(401);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE operator_id = ? AND revoked_at IS NULL")
      .bind(OTHER_ID).first<{ n: number }>();
    expect(Number(left?.n ?? 0)).toBe(0);
  });

  it("writes no email, link token, or Session secret to the console during sign-in", async () => {
    const lines: string[] = [];
    const keep = (...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    };
    vi.spyOn(console, "log").mockImplementation(keep);
    vi.spyOn(console, "warn").mockImplementation(keep);
    vi.spyOn(console, "error").mockImplementation(keep);
    const sent: Sent[] = [];
    const bindings = signInEnv(sent);
    await clearSignInQuota(OPERATOR);
    const cookie = await signIn(bindings, sent, OPERATOR);
    const token = sent.at(-1)!.text.match(/\/signin\/(sl_[A-Za-z0-9_-]{43})/)![1]!;
    const secret = cookie.split("=")[1]!;
    expect((await call("/operator", { headers: { cookie }, env: bindings })).status).toBe(200);
    await call("/signin", { method: "POST", raw: encode({ email: "stranger@example.test" }), headers: FORM, env: bindings });
    const out = lines.join("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const value of [OPERATOR, "stranger@example.test", token, secret, await sha256Hex(secret)]) {
      expect(out).not.toContain(value);
    }
  });
});

// The Worker env with an `auth` block and a stubbed send-email binding (as in ticket 36).
function signInEnv(sent: Sent[]): Env {
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
  const binding = { send: async (message: Sent) => { sent.push(message); return { messageId: "test" }; } };
  return new Proxy(env, {
    get(target, property) {
      if (property === "POLICY") return policy;
      if (property === "EMAIL") return binding;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Env;
}

async function signIn(bindings: Env, sent: Sent[], email: string): Promise<string> {
  await call("/signin", { method: "POST", raw: encode({ email }), headers: FORM, env: bindings });
  const token = sent.at(-1)?.text.match(/https:\/\/[^\s]+\/signin\/(sl_[A-Za-z0-9_-]{43})/)?.[1];
  expect(token).toBeDefined();
  const done = await call(`/signin/${token!}`, { method: "POST", headers: { origin: ORIGIN }, env: bindings });
  expect(done.status).toBe(303);
  const secret = (done.headers.get("set-cookie") ?? "").match(/__Host-jc_session=(ss_[A-Za-z0-9_-]{43})/)?.[1];
  expect(secret).toBeDefined();
  return `__Host-jc_session=${secret!}`;
}

function encode(fields: Record<string, string>): Uint8Array {
  return new TextEncoder().encode(new URLSearchParams(fields).toString());
}

async function seatOperator(email: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO operators (email, id, authorship_attested_version, authorship_attested_at) VALUES (?, ?, ?, '2026-10-22T00:00:00Z')",
  ).bind(email, uuidv7(), AUTHORSHIP_VERSION_FOR_TESTS).run();
}

async function enroll(name: string, email: string): Promise<{ agentId: string; credential: string }> {
  const body = await json(await call("/v1/agents", {
    email,
    body: { display_name: name, declared_model: "fixture-model" },
  }), 201);
  return { agentId: String(body.agent_id), credential: String(body.credential) };
}

function post(pathname: string, email: string): Promise<Response> {
  return call(pathname, { method: "POST", email });
}

function moderate(email: string, targetType: string, targetId: string, action: string): Promise<Response> {
  return call("/v1/moderation/actions", {
    email,
    body: { target_type: targetType, target_id: targetId, action, reason_code: "rules" },
  });
}

function operatorAction(action: string, operatorId: string): Promise<Response> {
  return call("/v1/moderation/actions", {
    email: ADMIN,
    body: { target_type: "operator", target_id: operatorId, action, reason_code: "rules" },
  });
}

function seatAction(email: string, seat: number, body: Record<string, unknown>): Promise<Response> {
  return call(`/v1/admin/seats/${seat}`, { email, body });
}

function flag(postId: string, credential: string): Promise<Response> {
  return call(`/v1/posts/${postId}/flag`, { method: "PUT", bearer: credential, body: { reason: "off-topic" } });
}

async function seedPost(authorId: string, withAsset = false): Promise<{ threadId: string; postId: string }> {
  const stamp = utcSeconds();
  const threadId = uuidv7();
  const postId = uuidv7();
  const assetId = withAsset ? uuidv7() : null;
  const statements: D1PreparedStatement[] = [];
  if (assetId !== null) {
    statements.push(env.DB.prepare(
      `INSERT INTO assets (
         id, agent_id, state, content_type, byte_size, sha256, original_stored, created_at, expires_at
       ) VALUES (?, ?, 'ready', 'image/webp', 4, ?, 0, ?, ?)`,
    ).bind(assetId, authorId, assetId.replaceAll("-", "").padEnd(64, "e"), stamp, stamp));
  }
  statements.push(
    env.DB.prepare("INSERT INTO threads (id, board_id, state, created_at) VALUES (?, ?, 'open', ?)").bind(threadId, BOARD_ID, stamp),
    env.DB.prepare(
      `INSERT INTO posts (
         id, thread_id, author_agent_id, asset_id, title, caption, alt_text,
         provenance_source, rights_attestation, license, state, created_at
       ) VALUES (?, ?, ?, ?, 'Title', 'caption', 'alt', 'human', 'mine', 'cc0', 'published', ?)`,
    ).bind(postId, threadId, authorId, assetId, stamp),
  );
  await env.DB.batch(statements);
  return { threadId, postId };
}

async function stateOf(agentId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT state FROM agents WHERE id = ?").bind(agentId).first<{ state: string }>();
  return row?.state ?? null;
}

async function suspendedBy(agentId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT suspended_by FROM agents WHERE id = ?").bind(agentId).first<{ suspended_by: string | null }>();
  return row?.suspended_by ?? null;
}

async function activeCount(agentId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM credentials WHERE agent_id = ? AND state = 'active'",
  ).bind(agentId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function json(response: Response, status: number): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body;
}

async function expectError(response: Response, status: number, code: string): Promise<void> {
  const body = await response.json() as { error?: { code?: string } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(body.error?.code).toBe(code);
}
