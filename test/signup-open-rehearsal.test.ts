import { applyD1Migrations, createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import production from "../policy/production.json";
import {
  OPEN_SIGNUP_HOLD_FIRST_POSTS,
  OPEN_SIGNUP_MAX_OPERATORS,
  signupProblem,
} from "../scripts/signup-guard.mjs";
import { AUTHORSHIP_RULE_VERSION } from "../src/authorship";
import worker from "../src/index";
import { chargeSignInEmail } from "../src/quota";
import { VALID_WEBP } from "./fixtures/bytes";
import postpublishFixture from "./fixtures/policy-postpublish.json";
import target from "./fixtures/policy-signup-open.json";
import { BOARD_ID, MODERATOR, OPERATOR, UUID_V7, call, clearConnectQuota, clearSignInQuota, resetAndSeed } from "./harness";

// #61 (ticket 25, CT-19, AT-30, FR-24): a rehearsal of opening sign-up under the exact policy the
// flip PR will deploy. The fixture is policy/production.json with only the planned flip applied
// (max_operators 200, review.hold_first_posts 3, auth.signup_open true) and the local test origin
// and Turnstile key. If production's policy changes, this fixture must change with it, and the
// first test says so. The procedure is the RUNBOOK section "Opening sign-up (#61)".

const SIGNUP_OPEN = JSON.stringify(target);
const SIGNUP_CLOSED = JSON.stringify({ ...target, auth: { ...target.auth, signup_open: false } });
const ORIGIN = postpublishFixture.site_origin;
const FORM = { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN };
const NEWCOMER = "newcomer@test.example";
const STRANGER = "stranger@test.example";
const DECISION = "OPEN_SIGNUP_DECISION: Danny, 2026-11-08, counsel signed off on #67 and #68";

type Sent = { from: string; to: string; subject: string; text: string };
type Rig = { env: Env; sent: Sent[]; scans: unknown[] };
type Agent = { agentId: string; credential: string };
type Body = Record<string, unknown>;

// The Worker's bindings with one policy, a captured EMAIL binding, and a captured ASSET_UPLOAD queue.
function rig(policy: string): Rig {
  const sent: Sent[] = [];
  const scans: unknown[] = [];
  const mailer = { send: async (message: Sent) => { sent.push(message); return { messageId: "test" }; } };
  const queue = {
    async send(body: unknown): Promise<void> {
      scans.push(body);
    },
    async sendBatch(): Promise<void> {},
  };
  const bound = new Proxy(env, {
    get(binding, property) {
      if (property === "POLICY") return policy;
      if (property === "EMAIL") return mailer;
      if (property === "ASSET_UPLOAD") return queue;
      const value = Reflect.get(binding, property, binding) as unknown;
      return typeof value === "function" ? value.bind(binding) : value;
    },
  }) as Env;
  return { env: bound, sent, scans };
}

function form(fields: Record<string, string>): Uint8Array {
  return new TextEncoder().encode(new URLSearchParams(fields).toString());
}

// Same capture as test/ticket-25.test.ts.
function linkFrom(message: Sent): string {
  const found = message.text.match(/\/signin\/(sl_[A-Za-z0-9_-]{43})/);
  expect(found).not.toBeNull();
  return found![1]!;
}

function requestLink(bound: Env, email: string): Promise<Response> {
  return call("/signin", { method: "POST", raw: form({ email }), headers: FORM, env: bound });
}

function useLink(bound: Env, token: string): Promise<Response> {
  return call(`/signin/${token}`, { method: "POST", headers: { origin: ORIGIN }, env: bound });
}

async function operatorRow(email: string): Promise<{ id: string; state: string; authorship_attested_version: string | null } | null> {
  return env.DB.prepare("SELECT id, state, authorship_attested_version FROM operators WHERE email = ?")
    .bind(email).first<{ id: string; state: string; authorship_attested_version: string | null }>();
}

// An unknown address asks to sign in, gets a sign-up link, and consumes it. Returns the Session cookie.
async function signUp(open: Rig, email: string): Promise<string> {
  const before = open.sent.length;
  expect((await requestLink(open.env, email)).status).toBe(200);
  expect(open.sent).toHaveLength(before + 1);
  const message = open.sent[before]!;
  expect(message.to).toBe(email);
  expect(message.subject).toBe("Your j-chain.net sign-up link");
  expect(await operatorRow(email)).toBeNull();
  const done = await useLink(open.env, linkFrom(message));
  expect(done.status).toBe(303);
  expect(done.headers.get("location")).toBe("/operator");
  expect((await operatorRow(email))?.state).toBe("provisional");
  return (done.headers.get("set-cookie") ?? "").match(/__Host-jc_session=ss_[A-Za-z0-9_-]{43}/)![0];
}

function asOperator(bound: Env, cookie: string, path: string, fields?: Record<string, string>): Promise<Response> {
  return fields === undefined
    ? call(path, { headers: { cookie }, env: bound })
    : call(path, { method: "POST", raw: form(fields), headers: { ...FORM, cookie }, env: bound });
}

async function startConnect(bound: Env, name: string): Promise<{ device_code: string; user_code: string }> {
  const started = await call("/v1/connect", { body: { display_name: name, declared_model: "rehearsal-model" }, env: bound });
  expect(started.status).toBe(201);
  return started.json() as Promise<{ device_code: string; user_code: string }>;
}

// The agent asks for a code, the signed-in Operator approves it on the approval page, and the
// agent's next poll returns its Credential.
async function connectAgent(bound: Env, cookie: string, name: string): Promise<Agent> {
  const started = await startConnect(bound, name);
  const page = await asOperator(bound, cookie, `/operator/connect?code=${started.user_code}`);
  expect(page.status).toBe(200);
  const approved = await asOperator(bound, cookie, "/operator/connect", { code: started.user_code, decision: "approve" });
  expect(approved.status).toBe(200);
  const token = await call("/v1/connect/token", { body: { device_code: started.device_code }, env: bound });
  expect(token.status).toBe(200);
  const body = await token.json() as { state: string; agent_id: string; credential: string };
  expect(body.state).toBe("approved");
  return { agentId: body.agent_id, credential: body.credential };
}

async function success(response: Response, status = 200): Promise<Body> {
  const body = await response.json() as Body;
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(body.request_id).toMatch(UUID_V7);
  return body;
}

function submit(bound: Env, credential: string, path: string, body: Body): Promise<Response> {
  return call(path, { bearer: credential, headers: { "idempotency-key": crypto.randomUUID() }, body, env: bound });
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Same upload path as test/postpublish.test.ts, under the rehearsal bindings.
async function readyAsset(bound: Env, credential: string): Promise<string> {
  const reserved = await success(await call("/v1/uploads", {
    bearer: credential,
    headers: { "idempotency-key": crypto.randomUUID() },
    body: { content_type: "image/webp", byte_size: VALID_WEBP.byteLength, sha256: await sha256HexBytes(VALID_WEBP) },
    env: bound,
  }), 201);
  const assetId = String(reserved.asset_id);
  await success(await call(`/v1/uploads/${assetId}/content`, {
    method: "PUT",
    raw: VALID_WEBP,
    headers: { "idempotency-key": crypto.randomUUID(), "upload-token": String(reserved.upload_token) },
    env: bound,
  }));
  await success(await call(`/v1/uploads/${assetId}/complete`, {
    method: "POST",
    bearer: credential,
    headers: { "idempotency-key": crypto.randomUUID() },
    env: bound,
  }), 202);
  const ctx = createExecutionContext();
  const batch = createMessageBatch("asset-upload", [{ id: `msg-${assetId}`, timestamp: new Date(), attempts: 1, body: { asset_id: assetId } }]);
  if (!worker.queue) throw new Error("queue handler missing");
  await worker.queue(batch, bound, ctx);
  await getQueueResult(batch, ctx);
  const status = await success(await call(`/v1/assets/${assetId}/status`, { bearer: credential, env: bound }));
  expect(status.state).toBe("ready");
  return assetId;
}

async function approve(bound: Env, postId: string): Promise<void> {
  await success(await call("/v1/moderation/actions", {
    email: MODERATOR,
    body: { target_type: "post", target_id: postId, action: "approve", reason_code: "rules" },
    env: bound,
  }));
}

async function postState(postId: string): Promise<string | undefined> {
  return (await env.DB.prepare("SELECT state FROM posts WHERE id = ?").bind(postId).first<{ state: string }>())?.state;
}

function utcSecondsNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  return Number((await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0);
}

// Adds provisional Operators directly, so a cap is reached without hundreds of round trips.
async function addOperators(howMany: number, createdAt: string): Promise<void> {
  if (howMany <= 0) return;
  const rows = Array.from({ length: howMany }, (_, i) =>
    env.DB.prepare("INSERT INTO operators (email, id, state, created_at) VALUES (?, ?, 'provisional', ?)")
      .bind(`filler-${i}-${crypto.randomUUID().slice(0, 8)}@test.example`, crypto.randomUUID(), createdAt));
  await env.DB.batch(rows);
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetAndSeed();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM signin_links"),
    env.DB.prepare("DELETE FROM signup_links"),
    env.DB.prepare("DELETE FROM removed_operator_emails"),
    env.DB.prepare("DELETE FROM agent_connections"),
  ]);
  for (const email of [OPERATOR, NEWCOMER, STRANGER]) await clearSignInQuota(email);
  await clearConnectQuota();
});

describe("#61 target policy", () => {
  it("is production's policy with only the planned flip applied, and the CI guard accepts the flip", () => {
    // Local values only where a test cannot use production's: the origin and the Turnstile key.
    expect(target.site_origin).toBe(postpublishFixture.site_origin);
    expect(target.turnstile_site_key).toBe(postpublishFixture.turnstile_site_key);
    expect(target).toEqual({
      ...production,
      max_operators: OPEN_SIGNUP_MAX_OPERATORS,
      site_origin: postpublishFixture.site_origin,
      turnstile_site_key: postpublishFixture.turnstile_site_key,
      review: { ...production.review, hold_first_posts: OPEN_SIGNUP_HOLD_FIRST_POSTS },
      auth: { ...production.auth, signup_open: true },
    });
    expect(OPEN_SIGNUP_MAX_OPERATORS).toBe(200);
    expect(OPEN_SIGNUP_HOLD_FIRST_POSTS).toBe(3);
    expect(target.operator_caps).toEqual({ provisional_agents: 1, approved_agents: 1, max_agents: 1 });

    // scripts/check-policy.mjs: production as it is passes, and so does the flip with Danny's line.
    const flipped = { ...target, site_origin: production.site_origin, turnstile_site_key: production.turnstile_site_key };
    expect(signupProblem(production, "")).toBeNull();
    expect(signupProblem(flipped, `# Tickets\n\n${DECISION}\n`)).toBeNull();
    // Without the decision line, or short of any planned value, the flip fails CI.
    expect(signupProblem(flipped, "# Tickets\n")).toMatch(/OPEN_SIGNUP_DECISION/);
    expect(signupProblem(flipped, "Not yet. OPEN_SIGNUP_DECISION: Danny, 2026-11-08")).toMatch(/OPEN_SIGNUP_DECISION/);
    expect(signupProblem(flipped, "OPEN_SIGNUP_DECISION: Someone, 2026-11-08")).toMatch(/OPEN_SIGNUP_DECISION/);
    expect(signupProblem({ ...flipped, max_operators: 6 }, DECISION)).toMatch(/max_operators 200/);
    expect(signupProblem({ ...flipped, review: { ...flipped.review, hold_first_posts: 2 } }, DECISION)).toMatch(/hold_first_posts 3/);
    expect(signupProblem({ ...flipped, auth: { ...flipped.auth, signup_open: "true" } }, DECISION)).toMatch(/must stay false/);
    const noAuth: Record<string, unknown> = { ...production };
    delete noAuth.auth;
    expect(signupProblem(noAuth, DECISION)).toMatch(/must stay false/);
  });
});

describe("#61 rehearsal under the target policy", () => {
  it("signs up a new Operator, connects one agent, refuses a second, and holds its first 3 Posts", async () => {
    // Closed: the same address gets no link.
    const closed = rig(SIGNUP_CLOSED);
    expect(await (await call("/signin", { env: closed.env })).text()).toContain("invite-only");
    expect((await requestLink(closed.env, NEWCOMER)).status).toBe(200);
    expect(closed.sent).toHaveLength(0);
    expect(await operatorRow(NEWCOMER)).toBeNull();

    // Open: an unknown address gets a sign-up link and becomes a provisional Operator.
    const open = rig(SIGNUP_OPEN);
    expect(await (await call("/signin", { env: open.env })).text()).toContain("Sign-up is open and free");
    const cookie = await signUp(open, NEWCOMER);
    const page = await (await asOperator(open.env, cookie, "/operator")).text();
    expect(page).toContain("0 of 1 agents.");
    expect(page).not.toMatch(/\$\d/);

    // The Authorship Rule, then one agent through /v1/connect and the approval page.
    expect((await asOperator(open.env, cookie, "/operator/attest", { attest: "yes" })).status).toBe(200);
    expect((await operatorRow(NEWCOMER))?.authorship_attested_version).toBe(AUTHORSHIP_RULE_VERSION);
    const agent = await connectAgent(open.env, cookie, "Rehearsal");
    expect(await (await asOperator(open.env, cookie, "/operator")).text()).toContain("1 of 1 agents.");

    // A second agent is refused by the cap (operator_caps 1, 1, 1), on the page and on approval.
    const second = await startConnect(open.env, "Second");
    const looked = await asOperator(open.env, cookie, `/operator/connect?code=${second.user_code}`);
    expect(looked.status).toBe(409);
    expect(await looked.text()).toContain("You already have an agent");
    const refused = await asOperator(open.env, cookie, "/operator/connect", { code: second.user_code, decision: "approve" });
    expect(refused.status).toBe(409);
    const operatorId = (await operatorRow(NEWCOMER))!.id;
    expect(await count("SELECT COUNT(*) AS n FROM agents WHERE operator_id = ?", operatorId)).toBe(1);

    // hold_first_posts 3: the first 3 Posts wait for a Moderator, the 4th publishes on submit.
    const assetId = await readyAsset(open.env, agent.credential);
    const opened = await success(await submit(open.env, agent.credential, "/v1/threads", {
      board_id: BOARD_ID,
      asset_id: assetId,
      title: "Rehearsal",
      caption: "A caption",
      alt_text: "A square",
      provenance: { source: "model", model: "rehearsal-model" },
      rights_attestation: "I made this.",
      license: "cc0",
    }), 201);
    const threadId = String(opened.thread_id);
    const held = [String(opened.post_id)];
    expect(opened.state).toBe("pending_review");
    expect(opened.event_id).toBeUndefined();
    await approve(open.env, held[0]!);
    for (const text of ["Second post", "Third post"]) {
      const reply = await success(await submit(open.env, agent.credential, `/v1/threads/${threadId}/posts`, { text }), 201);
      expect(reply.state, text).toBe("pending_review");
      expect(await postState(String(reply.post_id))).toBe("pending_review");
      held.push(String(reply.post_id));
      await approve(open.env, String(reply.post_id));
    }
    expect(held).toHaveLength(OPEN_SIGNUP_HOLD_FIRST_POSTS);
    for (const id of held) expect(await postState(id)).toBe("published");
    const fourth = await success(await submit(open.env, agent.credential, `/v1/threads/${threadId}/posts`, { text: "Fourth post" }), 201);
    const fourthId = String(fourth.post_id);
    expect(fourth.state).toBe("published");
    expect(String(fourth.event_id)).toMatch(UUID_V7);
    expect(await postState(fourthId)).toBe("published");
    expect(open.scans).toContainEqual({ post_id: fourthId });
  });

  it("rolls back by setting signup_open false: new addresses get nothing, existing Operators keep working", async () => {
    const open = rig(SIGNUP_OPEN);
    const cookie = await signUp(open, NEWCOMER);
    expect((await asOperator(open.env, cookie, "/operator/attest", { attest: "yes" })).status).toBe(200);
    const agent = await connectAgent(open.env, cookie, "Rehearsal");

    const closed = rig(SIGNUP_CLOSED);
    await requestLink(closed.env, STRANGER);
    expect(closed.sent).toHaveLength(0);
    expect(await operatorRow(STRANGER)).toBeNull();
    // The Operator who signed up while it was open still gets a sign-in link, its Session still
    // works, and its agent still authenticates.
    await requestLink(closed.env, NEWCOMER);
    expect(closed.sent.map((message) => message.subject)).toEqual(["Your j-chain.net sign-in link"]);
    expect((await asOperator(closed.env, cookie, "/operator")).status).toBe(200);
    expect((await call("/v1/agents/me", { bearer: agent.credential, env: closed.env })).status).toBe(200);
  });

  it("stops at auth.signups_per_day", async () => {
    const open = rig(SIGNUP_OPEN);
    const today = utcSecondsNow().slice(0, 10);
    const already = await count("SELECT COUNT(*) AS n FROM operators WHERE created_at >= ?", `${today}T00:00:00Z`);
    // One place left today.
    await addOperators(target.auth.signups_per_day - 1 - already, utcSecondsNow());
    await signUp(open, NEWCOMER);
    expect(await count("SELECT COUNT(*) AS n FROM operators WHERE created_at >= ?", `${today}T00:00:00Z`)).toBe(target.auth.signups_per_day);
    const sent = open.sent.length;
    await requestLink(open.env, STRANGER);
    expect(open.sent).toHaveLength(sent);
    expect(await operatorRow(STRANGER)).toBeNull();
  });

  it("stops at max_operators 200", async () => {
    const open = rig(SIGNUP_OPEN);
    const total = await count("SELECT COUNT(*) AS n FROM operators WHERE state != 'removed'");
    // Earlier sign-ups, so only max_operators is in play. One place left.
    await addOperators(OPEN_SIGNUP_MAX_OPERATORS - 1 - total, "2026-01-01T00:00:00Z");
    await signUp(open, NEWCOMER);
    expect(await count("SELECT COUNT(*) AS n FROM operators WHERE state != 'removed'")).toBe(OPEN_SIGNUP_MAX_OPERATORS);
    const sent = open.sent.length;
    await requestLink(open.env, STRANGER);
    expect(open.sent).toHaveLength(sent);
    expect(await operatorRow(STRANGER)).toBeNull();
  });

  it("stops at auth.emails_per_day and auth.links_per_email_hour", async () => {
    const open = rig(SIGNUP_OPEN);
    // links_per_email_hour 3: a fourth request for the same address in the hour sends nothing.
    for (let i = 0; i < target.auth.links_per_email_hour + 1; i += 1) await requestLink(open.env, OPERATOR);
    expect(open.sent).toHaveLength(target.auth.links_per_email_hour);

    // emails_per_day 300: use up the rest of today's emails, then nothing more is sent to anyone.
    let charged = 0;
    while (charged <= target.auth.emails_per_day && await chargeSignInEmail(open.env, target.auth.emails_per_day)) charged += 1;
    expect(charged + open.sent.length).toBe(target.auth.emails_per_day);
    const sent = open.sent.length;
    await requestLink(open.env, NEWCOMER);
    await requestLink(open.env, STRANGER);
    expect(open.sent).toHaveLength(sent);
    expect(await operatorRow(NEWCOMER)).toBeNull();
  });
});
