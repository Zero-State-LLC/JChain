import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import betaDocument from "../policy/beta.json";
import { LEGAL_LINKS, PROHIBITED } from "../src/rules-copy";
import {
  BOARD_ID,
  INSTRUCTIONS,
  MODERATOR,
  OPERATOR,
  UUID_V7,
  agentCount,
  call,
  credentialRow,
  resetAndSeed,
} from "./harness";

const ROUTES = [
  { method: "GET", path: "/" },
  { method: "POST", path: "/v1/agents" },
  { method: "GET", path: "/v1/agents/me" },
  { method: "GET", path: `/v1/agents/${BOARD_ID}` },
  { method: "GET", path: `/v1/agents/${BOARD_ID}/posts` },
  { method: "GET", path: "/v1/boards" },
  { method: "GET", path: `/v1/boards/${BOARD_ID}/rules` },
  { method: "GET", path: `/v1/boards/${BOARD_ID}/threads` },
  { method: "GET", path: "/v1/openapi.json" },
  { method: "POST", path: "/v1/threads" },
  { method: "GET", path: `/v1/threads/${BOARD_ID}` },
  { method: "GET", path: `/v1/threads/${BOARD_ID}/posts` },
  { method: "POST", path: `/v1/threads/${BOARD_ID}/posts` },
  { method: "GET", path: "/v1/events" },
  { method: "POST", path: "/v1/admin/publishing-stop" },
  { method: "POST", path: "/v1/moderation/actions" },
  { method: "POST", path: "/v1/reports" },
  { method: "PUT", path: `/v1/posts/${BOARD_ID}/reactions/plus` },
  { method: "DELETE", path: `/v1/posts/${BOARD_ID}/reactions/plus` },
  { method: "GET", path: "/v1/not-a-route" },
];

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);
afterEach(() => {
  vi.restoreAllMocks();
});

describe("policy fails closed", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it.each(ROUTES)("$method $path returns policy_missing when the binding is missing", async ({ method, path }) => {
    const response = await call(path, { method, policy: null, email: OPERATOR });
    await expectError(response, 503, "policy_missing");
    expect(await agentCount()).toBe(0);
  });

  it.each(ROUTES)("$method $path returns policy_missing for an invalid document", async ({ method, path }) => {
    const response = await call(path, { method, policy: "{}", email: OPERATOR });
    await expectError(response, 503, "policy_missing");
  });

  it.each([
    ["not json", "nope"],
    ["empty", ""],
    ["wrong type", policyJson((policy) => { policy.max_agents = "20"; })],
    ["max_agents below range", policyJson((policy) => { policy.max_agents = 0; })],
    ["max_agents above range", policyJson((policy) => { policy.max_agents = 501; })],
    ["schema_version", policyJson((policy) => { policy.schema_version = 2; })],
    ["moderation_mode", policyJson((policy) => { policy.moderation_mode = "off"; })],
    ["retention", policyJson((policy) => {
      const retention = policy.retention as Record<string, unknown>;
      retention.rejected_upload_days = 8;
    })],
    ["site_origin", policyJson((policy) => { policy.site_origin = "http://jchain.example.test"; })],
    ["turnstile_site_key", policyJson((policy) => { policy.turnstile_site_key = ""; })],
    ["unknown key", policyJson((policy) => { policy.note = "extra"; })],
    ["upload cap", policyJson((policy) => {
      const upload = policy.upload as Record<string, unknown>;
      upload.max_bytes = 10485761;
    })],
    ["allowed types", policyJson((policy) => {
      const upload = policy.upload as Record<string, unknown>;
      upload.allowed_types = ["image/jpeg", "image/png", "image/webp"];
    })],
    ["quota ceiling", policyJson((policy) => {
      const quotas = policy.quotas as { agent: Record<string, unknown> };
      quotas.agent.threads_per_hour = 2;
    })],
  ])("rejects a policy with %s", async (_name, policy) => {
    const response = await call("/v1/boards", { email: OPERATOR, policy });
    await expectError(response, 503, "policy_missing");
  });

  it("accepts the training-export switch either way", async () => {
    const response = await call("/v1/boards", {
      email: OPERATOR,
      policy: policyJson((policy) => { policy.training_export_approved = true; }),
    });
    expect(response.status).toBe(200);
  });
});

describe("operator enrolls an agent", () => {
  it("returns one credential, stores only its hash, and does not list it again", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const response = await call("/v1/agents", { email: OPERATOR, body: enrollBody() });
    expect(response.status).toBe(201);
    const body = await expectSuccess(response);
    const secret = body.credential;
    const agentId = body.agent_id;
    if (typeof secret !== "string" || typeof agentId !== "string") {
      throw new Error("enroll response did not include agent_id and credential");
    }
    expect(agentId).toMatch(UUID_V7);
    expect(secret).toMatch(/^jc_[A-Za-z0-9_-]+$/);
    expect(secret).not.toContain("=");
    expect(decodeBase64Url(secret.slice(3))).toHaveLength(32);
    expect(Object.keys(body).sort()).toEqual(["agent_id", "credential", "request_id"]);

    // CT-01 has no read route for the hash or expires_at. This is that observation.
    const row = await credentialRow(agentId);
    expect(row).not.toBeNull();
    expect(row?.state).toBe("active");
    expect(row?.expires_at).toBeNull();
    expect(row?.secret_hash).toBe(await sha256Hex(secret));
    for (const value of Object.values(row ?? {})) {
      expect(String(value ?? "")).not.toContain(secret);
    }
    expect(logs.join("\n")).not.toContain(secret);

    const me = await call("/v1/agents/me", { bearer: secret });
    const meBody = await expectSuccess(me);
    expect(meBody).toEqual({
      request_id: expect.stringMatching(UUID_V7),
      agent_id: agentId,
      display_name: "Ada",
    });
    expect(JSON.stringify(meBody)).not.toContain(secret);

    const boards = await call("/v1/boards", { bearer: secret });
    const rules = await call(`/v1/boards/${BOARD_ID}/rules`, { bearer: secret });
    const spec = await call("/v1/openapi.json", { bearer: secret });
    for (const later of [boards, rules, spec]) {
      expect(later.status).toBe(200);
      expect(JSON.stringify(await later.json())).not.toContain(secret);
    }

    const second = await call("/v1/agents", {
      email: OPERATOR,
      body: enrollBody({ display_name: "Bea" }),
    });
    const secondBody = await expectSuccess(second);
    expect(secondBody.credential).not.toBe(secret);
    expect(JSON.stringify(secondBody)).not.toContain(secret);
  });

  it("stores an optional expires_at and does not invent a lifetime", async () => {
    const expiresAt = "2099-01-01T00:00:00Z";
    const withExpiry = await call("/v1/agents", {
      email: OPERATOR,
      body: enrollBody({ expires_at: expiresAt }),
    });
    const withBody = await expectSuccess(withExpiry);
    expect(Object.keys(withBody)).not.toContain("expires_at");
    expect((await credentialRow(String(withBody.agent_id)))?.expires_at).toBe(expiresAt);

    const open = await call("/v1/agents", { email: OPERATOR, body: enrollBody({ display_name: "Bea" }) });
    const openBody = await expectSuccess(open);
    expect((await credentialRow(String(openBody.agent_id)))?.expires_at).toBeNull();
    const me = await call("/v1/agents/me", { bearer: String(openBody.credential) });
    expect(me.status).toBe(200);
  });

  it("rejects an expired credential", async () => {
    const enrolled = await enroll({ expires_at: "2020-01-01T00:00:00Z" });
    const me = await call("/v1/agents/me", { bearer: enrolled.credential });
    const meBody = await expectError(me, 401, "credential_invalid");
    expect(JSON.stringify(meBody)).not.toContain(enrolled.credential);
  });

  it("rejects a malformed expiry without creating an agent", async () => {
    const response = await call("/v1/agents", {
      email: OPERATOR,
      body: enrollBody({ expires_at: "2099-01-01T00:00:00.000Z" }),
    });
    await expectError(response, 400, "malformed");
    expect(await agentCount()).toBe(0);
  });

  it("rejects a display name or model outside its length", async () => {
    const longName = await call("/v1/agents", {
      email: OPERATOR,
      body: enrollBody({ display_name: "a".repeat(41) }),
    });
    await expectError(longName, 422, "validation_failed");
    const longModel = await call("/v1/agents", {
      email: OPERATOR,
      body: enrollBody({ declared_model: "m".repeat(81) }),
    });
    await expectError(longModel, 422, "validation_failed");
    const missing = await call("/v1/agents", { email: OPERATOR, body: { declared_model: "fixture-model" } });
    await expectError(missing, 400, "malformed");
    const extra = await call("/v1/agents", { email: OPERATOR, body: enrollBody({ note: "no" }) });
    await expectError(extra, 400, "malformed");
    expect(await agentCount()).toBe(0);
    const edge = await call("/v1/agents", {
      email: OPERATOR,
      body: enrollBody({ display_name: "a".repeat(40), declared_model: "m".repeat(80) }),
    });
    expect(edge.status).toBe(201);
  });

  it("forbids an agent credential, including one presented with an operator identity", async () => {
    const enrolled = await enroll();
    const asAgent = await call("/v1/agents", { bearer: enrolled.credential, body: enrollBody({ display_name: "Bea" }) });
    await expectError(asAgent, 403, "forbidden");
    const both = await call("/v1/agents", {
      email: OPERATOR,
      bearer: enrolled.credential,
      body: enrollBody({ display_name: "Bea" }),
    });
    await expectError(both, 403, "forbidden");
    expect(await agentCount()).toBe(1);
  });

  it("accepts a roster above the old beta cap", async () => {
    const policy = policyJson((document) => { document.max_agents = 21; });
    const response = await call("/v1/agents", { email: OPERATOR, policy, body: enrollBody() });
    expect(response.status).toBe(201);
  });

  it("forbids enrollment past max_agents", async () => {
    const policy = policyJson((document) => { document.max_agents = 1; });
    const first = await call("/v1/agents", { email: OPERATOR, policy, body: enrollBody() });
    expect(first.status).toBe(201);
    const second = await call("/v1/agents", {
      email: OPERATOR,
      policy,
      body: enrollBody({ display_name: "Bea" }),
    });
    await expectError(second, 403, "forbidden");
    expect(await agentCount()).toBe(1);
  });
});

describe("human identity is ctx.access email only", () => {
  it("does not accept a client email header", async () => {
    const response = await call("/v1/agents", {
      body: enrollBody(),
      headers: {
        "cf-access-authenticated-user-email": OPERATOR,
        "x-jchain-email": OPERATOR,
      },
    });
    await expectError(response, 401, "access_required");
    expect(await agentCount()).toBe(0);
  });

  it("matches an enrolled operator case-insensitively", async () => {
    const response = await call("/v1/agents", { email: "Operator@Example.Test", body: enrollBody() });
    expect(response.status).toBe(201);
  });

  it("rejects a moderator and an unknown email", async () => {
    const moderator = await call("/v1/agents", { email: MODERATOR, body: enrollBody() });
    await expectError(moderator, 403, "forbidden");
    const stranger = await call("/v1/agents", { email: "stranger@example.test", body: enrollBody() });
    await expectError(stranger, 403, "not_enrolled");
    expect(await agentCount()).toBe(0);
  });
});

describe("credentials that must not read or change state", () => {
  it("rejects a missing, unknown, or revoked credential", async () => {
    const missing = await call("/v1/agents/me");
    await expectError(missing, 401, "credential_invalid");
    const unknown = await call("/v1/boards", { bearer: "jc_not-a-real-credential" });
    await expectError(unknown, 401, "credential_invalid");

    const enrolled = await enroll();
    const hash = await sha256Hex(enrolled.credential);
    await env.DB.prepare("UPDATE credentials SET state = 'revoked' WHERE secret_hash = ?").bind(hash).run();
    const me = await call("/v1/agents/me", { bearer: enrolled.credential });
    const meBody = await expectError(me, 401, "credential_invalid");
    const enrollAgain = await call("/v1/agents", {
      bearer: enrolled.credential,
      body: enrollBody({ display_name: "Bea" }),
    });
    await expectError(enrollAgain, 401, "credential_invalid");
    expect(await agentCount()).toBe(1);
    expect(JSON.stringify(meBody)).not.toContain(enrolled.credential);
  });

  it("returns only the caller from GET /v1/agents/me", async () => {
    const ada = await enroll({ display_name: "Ada" });
    const bea = await enroll({ display_name: "Bea" });
    const response = await call(`/v1/agents/me?agent_id=${bea.agentId}`, { bearer: ada.credential });
    const body = await expectSuccess(response);
    expect(body.agent_id).toBe(ada.agentId);
    expect(body.display_name).toBe("Ada");
    expect(JSON.stringify(body)).not.toContain(bea.credential);
    expect(JSON.stringify(body)).not.toContain(bea.agentId);

    const operator = await call("/v1/agents/me", { email: OPERATOR });
    await expectError(operator, 401, "credential_invalid");
  });
});

describe("board rules and board list", () => {
  it("returns the seeded board and the fixed rules document", async () => {
    const enrolled = await enroll();
    const boards = await call("/v1/boards", { bearer: enrolled.credential });
    expect(await boards.json()).toEqual({
      request_id: expect.stringMatching(UUID_V7),
      items: [{ id: BOARD_ID, slug: "beta", name: "JChain", description: "", state: "open" }],
      next_cursor: null,
    });

    const rules = await call(`/v1/boards/${BOARD_ID}/rules`, { bearer: enrolled.credential });
    expect(await rules.json()).toEqual({
      request_id: expect.stringMatching(UUID_V7),
      schema_version: 1,
      board_id: BOARD_ID,
      slug: "beta",
      moderation: "prepublish",
      upload: {
        max_bytes: 10485760,
        max_megapixels: 20,
        max_edge_px: 8192,
        allowed_types: ["image/webp"],
        thumb_edge_px: 320,
      },
      quotas: {
        agent: {
          threads_per_hour: 1,
          replies_per_hour: 6,
          mutations_per_day: 20,
          events_per_minute: 60,
          reactions_per_minute: 30,
        },
        operator: { threads_per_hour: 4, replies_per_hour: 24, mutations_per_day: 80 },
        board: { threads_per_hour: 20, replies_per_hour: 120, mutations_per_day: 400 },
        global: { threads_per_hour: 20, replies_per_hour: 120, mutations_per_day: 400 },
      },
      allowed_licenses: ["all-rights-reserved", "cc-by", "cc-by-sa", "cc0"],
      prohibited: [...PROHIBITED],
      legal: { ...LEGAL_LINKS },
      instructions: INSTRUCTIONS,
      authorship: { rule_version: "2026-10-22", rule: expect.stringContaining("Operators direct. Agents author.") },
    });

    const asOperator = await call("/v1/boards", { email: OPERATOR });
    expect(asOperator.status).toBe(200);
    const asModerator = await call(`/v1/boards/${BOARD_ID}/rules`, { email: MODERATOR });
    expect(asModerator.status).toBe(200);
    const missing = await call("/v1/boards/01900000-0000-7000-8000-000000000099/rules", { bearer: enrolled.credential });
    await expectError(missing, 404, "not_found");
    const anonymous = await call("/v1/boards");
    await expectError(anonymous, 401, "access_required");
  });

  it("echoes the policy upload numbers and no post field", async () => {
    const enrolled = await enroll();
    const policy = policyJson((document) => {
      const upload = document.upload as Record<string, unknown>;
      upload.max_bytes = 2048;
    });
    const rules = await call(`/v1/boards/${BOARD_ID}/rules`, { bearer: enrolled.credential, policy });
    const body = await expectSuccess(rules) as { upload: { max_bytes: number }; instructions: string };
    expect(body.upload.max_bytes).toBe(2048);
    expect(body.instructions).toBe(INSTRUCTIONS);
    expect(JSON.stringify(body)).not.toContain("caption");
  });
});

describe("X-Run-Id", () => {
  it("logs a valid run id beside request_id and grants no authority", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const response = await call("/v1/agents", {
      email: OPERATOR,
      body: enrollBody(),
      headers: { "x-run-id": "west-run (1)" },
    });
    const body = await expectSuccess(response);
    const line = logs.map(parseLog).find((entry) => entry?.run_id === "west-run (1)");
    expect(line).toMatchObject({ request_id: body.request_id, run_id: "west-run (1)" });

    vi.restoreAllMocks();
    const unauthenticated = await call("/v1/agents", {
      body: enrollBody(),
      headers: { "x-run-id": OPERATOR },
    });
    await expectError(unauthenticated, 401, "access_required");
  });

  it("rejects an invalid run id without logging it or creating an agent", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    // A newline cannot be placed in a header. DEL is outside ASCII 0x20–0x7E.
    const invalid = "run-\u007f";
    const response = await call("/v1/agents", {
      email: OPERATOR,
      body: enrollBody(),
      headers: { "x-run-id": invalid },
    });
    await expectError(response, 400, "malformed");
    expect(await agentCount()).toBe(0);
    expect(logs.join("\n")).not.toContain(invalid);
    const tooLong = await call("/v1/boards", { email: OPERATOR, headers: { "x-run-id": "y".repeat(129) } });
    await expectError(tooLong, 400, "malformed");
    const embeddedSpace = await call("/v1/boards", { email: OPERATOR, headers: { "x-run-id": "west run" } });
    expect(embeddedSpace.status).toBe(200);
  });
});

describe("OpenAPI", () => {
  it("describes the routes this ticket adds and contains no sample credential", async () => {
    const enrolled = await enroll();
    const response = await call("/v1/openapi.json", { bearer: enrolled.credential });
    const body = await expectSuccess(response) as {
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
    };
    expect(body.openapi).toBe("3.1.0");
    expect(Object.keys(body.paths).sort()).toEqual([
      "/v1/admin/publishing-stop",
      "/v1/admin/seats/{seat}",
      "/v1/agents",
      "/v1/agents/me",
      "/v1/agents/{id}",
      "/v1/agents/{id}/credentials",
      "/v1/agents/{id}/posts",
      "/v1/agents/{id}/resume",
      "/v1/agents/{id}/retire",
      "/v1/agents/{id}/suspend",
      "/v1/assets/{id}/content",
      "/v1/assets/{id}/status",
      "/v1/boards",
      "/v1/boards/{id}",
      "/v1/boards/{id}/rules",
      "/v1/boards/{id}/threads",
      "/v1/connect",
      "/v1/connect/token",
      "/v1/credentials/{id}/revoke",
      "/v1/deletion-requests",
      "/v1/events",
      "/v1/exports",
      "/v1/exports/{id}",
      "/v1/moderation/actions",
      "/v1/openapi.json",
      "/v1/posts/{id}/flag",
      "/v1/posts/{id}/reactions/{type}",
      "/v1/posts/{id}/vote",
      "/v1/reports",
      "/v1/rules",
      "/v1/threads",
      "/v1/threads/{id}",
      "/v1/threads/{id}/posts",
      "/v1/trending",
      "/v1/uploads",
      "/v1/uploads/{id}/complete",
      "/v1/uploads/{id}/content",
      "/v1/uploads/{id}/thumb",
    ]);
    expect(Object.keys(body.paths["/v1/agents"] ?? {})).toEqual(["post"]);
    expect(Object.keys(body.paths["/v1/agents/me"] ?? {})).toEqual(["get"]);
    expect(Object.keys(body.paths["/v1/agents/{id}"] ?? {})).toEqual(["get"]);
    expect(Object.keys(body.paths["/v1/agents/{id}/credentials"] ?? {})).toEqual(["post"]);
    expect(Object.keys(body.paths["/v1/agents/{id}/posts"] ?? {})).toEqual(["get"]);
    expect(Object.keys(body.paths["/v1/agents/{id}/resume"] ?? {})).toEqual(["post"]);
    expect(Object.keys(body.paths["/v1/agents/{id}/retire"] ?? {})).toEqual(["post"]);
    expect(Object.keys(body.paths["/v1/agents/{id}/suspend"] ?? {})).toEqual(["post"]);
    expect(Object.keys(body.paths["/v1/assets/{id}/content"] ?? {})).toEqual(["get"]);
    expect(Object.keys(body.paths["/v1/assets/{id}/status"] ?? {})).toEqual(["get"]);
    expect(Object.keys(body.paths["/v1/boards"] ?? {})).toEqual(["get", "post"]);
    const createBoard = body.paths["/v1/boards"]?.post as {
      requestBody?: {
        required?: boolean;
        content?: {
          "application/json"?: {
            schema?: {
              additionalProperties?: boolean;
              required?: string[];
              properties?: Record<string, { type?: string; pattern?: string; minLength?: number; maxLength?: number }>;
            };
          };
        };
      };
    };
    const boardSchema = createBoard.requestBody?.content?.["application/json"]?.schema;
    expect(createBoard.requestBody?.required).toBe(true);
    expect(boardSchema?.additionalProperties).toBe(false);
    expect(boardSchema?.required).toEqual(["slug", "name"]);
    expect(boardSchema?.properties?.slug).toEqual({
      type: "string",
      pattern: "^[a-z][a-z0-9]{0,19}$",
      minLength: 1,
      maxLength: 20,
    });
    expect(boardSchema?.properties?.name).toEqual({ type: "string", minLength: 1, maxLength: 60 });
    expect(Object.keys(body.paths["/v1/boards/{id}/rules"] ?? {})).toEqual(["get"]);
    expect(Object.keys(body.paths["/v1/boards/{id}/threads"] ?? {})).toEqual(["get"]);
    expect(Object.keys(body.paths["/v1/credentials/{id}/revoke"] ?? {})).toEqual(["post"]);
    expect(Object.keys(body.paths["/v1/deletion-requests"] ?? {})).toEqual(["post"]);
    expect(Object.keys(body.paths["/v1/events"] ?? {})).toEqual(["get"]);
    expect(Object.keys(body.paths["/v1/exports"] ?? {})).toEqual(["post"]);
    expect(Object.keys(body.paths["/v1/exports/{id}"] ?? {})).toEqual(["get"]);
    expect(Object.keys(body.paths["/v1/admin/publishing-stop"] ?? {})).toEqual(["post"]);
    expect(Object.keys(body.paths["/v1/moderation/actions"] ?? {})).toEqual(["post"]);
    expect(Object.keys(body.paths["/v1/reports"] ?? {})).toEqual(["post"]);
    expect(Object.keys(body.paths["/v1/posts/{id}/reactions/{type}"] ?? {})).toEqual(["delete", "put"]);
    expect(Object.keys(body.paths["/v1/openapi.json"] ?? {})).toEqual(["get"]);
    expect(Object.keys(body.paths["/v1/threads"] ?? {})).toEqual(["post"]);
    expect(Object.keys(body.paths["/v1/threads/{id}"] ?? {})).toEqual(["get"]);
    expect(Object.keys(body.paths["/v1/threads/{id}/posts"] ?? {})).toEqual(["get", "post"]);
    expect(Object.keys(body.paths["/v1/uploads"] ?? {})).toEqual(["post"]);
    expect(Object.keys(body.paths["/v1/uploads/{id}/complete"] ?? {})).toEqual(["post"]);
    expect(Object.keys(body.paths["/v1/uploads/{id}/content"] ?? {})).toEqual(["put"]);
    expect(Object.keys(body.paths["/v1/uploads/{id}/thumb"] ?? {})).toEqual(["put"]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("jc_");
    expect(serialized).not.toContain("up_");
    expect(serialized).not.toContain("-----BEGIN");
    expect(serialized).not.toContain(enrolled.credential);
  });
});

type ErrorBody = { request_id: string; error: { code: string; message: string } };
type SuccessBody = Record<string, unknown>;

async function expectError(response: Response, status: number, code: string): Promise<ErrorBody> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/json");
  const requestId = response.headers.get("x-request-id");
  expect(requestId).toMatch(UUID_V7);
  const body = await response.json() as ErrorBody;
  expect(body.request_id).toBe(requestId);
  expect(body.error.code).toBe(code);
  expect(body.error.message.length).toBeGreaterThan(0);
  return body;
}

async function expectSuccess(response: Response): Promise<SuccessBody> {
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  const requestId = response.headers.get("x-request-id");
  expect(requestId).toMatch(UUID_V7);
  const body = await response.json() as SuccessBody;
  expect(body.request_id).toBe(requestId);
  return body;
}

function enrollBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { display_name: "Ada", declared_model: "fixture-model", ...extra };
}

async function enroll(extra: Record<string, unknown> = {}): Promise<{ agentId: string; credential: string }> {
  const response = await call("/v1/agents", { email: OPERATOR, body: enrollBody(extra) });
  const body = await expectSuccess(response);
  return { agentId: String(body.agent_id), credential: String(body.credential) };
}

function policyJson(mutate: (policy: Record<string, unknown>) => void): string {
  const policy = JSON.parse(JSON.stringify(betaDocument)) as Record<string, unknown>;
  mutate(policy);
  return JSON.stringify(policy);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function parseLog(line: string): { request_id?: string; run_id?: string } | undefined {
  try {
    return JSON.parse(line) as { request_id?: string; run_id?: string };
  } catch {
    return undefined;
  }
}
