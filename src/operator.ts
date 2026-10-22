import { Hono, type Context } from "hono";
import {
  connectCodePage,
  connectConfirmPage,
  connectDonePage,
  credentialPage,
  operatorOnly,
  operatorPage,
  operatorSignInRequired,
  type AgentListing,
} from "./account-pages";
import {
  RESUME,
  SUSPEND,
  enrollAgent,
  moveAgent,
  parseEnrollFields,
  retireAgent,
  rotateCredential,
  type AdminFailure,
  type Caller,
} from "./agent-admin";
import { answerConnection, displayUserCode, findPending, normalizeUserCode } from "./connect";
import { readForm } from "./forms";
import { htmlResult, type PageOptions } from "./html";
import { ERRORS, htmlResponse } from "./http";
import { uuidv7 } from "./ids";
import { sameOrigin } from "./origin";
import type { Policy } from "./policy";
import { requireOperator } from "./principal";
import { policyOf } from "./session";

// CT-27 (v0.2.23): the Operator page. It runs the same guarded writes as CT-01
// and CT-10 through the agent-admin module, and answers in HTML.

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type Ctx = Context<AppEnv>;

const SIGNED_IN: PageOptions = { section: "account", signedIn: true };
const BACK = "/operator";
const BACK_LABEL = "Back to your agents";

type Opened = { requestId: string; policy: Policy; caller: Caller; via: "access" | "session" };

export function mountOperator(app: Hono<AppEnv>): void {
  app.get("/operator", page);
  app.post("/operator/agents", enroll);
  app.post("/operator/agents/:id/credentials", rotate);
  app.post("/operator/agents/:id/suspend", (c) => change(c, "suspend"));
  app.post("/operator/agents/:id/resume", (c) => change(c, "resume"));
  app.post("/operator/agents/:id/retire", (c) => change(c, "retire"));
  app.get("/operator/connect", connectForm);
  app.post("/operator/connect", connectAnswer);
}

async function open(c: Ctx, write: boolean): Promise<Opened | Response> {
  const requestId = uuidv7();
  const policy = policyOf(c.env);
  if (policy === null) return failure(requestId, "policy_missing");
  const principal = await requireOperator(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) {
    if (principal.code === "forbidden") return htmlResponse(requestId, operatorOnly(), 403);
    if (principal.code === "not_enrolled") return htmlResponse(requestId, operatorOnly(), 403);
    return htmlResponse(requestId, operatorSignInRequired(), 401);
  }
  if (principal.kind !== "operator") return htmlResponse(requestId, operatorOnly(), 403);
  if (write && !sameOrigin(c.req.raw, policy.site_origin)) return failure(requestId, "forbidden");
  return {
    requestId,
    policy,
    caller: { email: principal.email, kind: "operator" },
    via: principal.via ?? "access",
  };
}

async function page(c: Ctx): Promise<Response> {
  const opened = await open(c, false);
  if (opened instanceof Response) return opened;
  const listed = await c.env.DB.prepare(
    `SELECT agents.id AS id, agents.display_name AS display_name, agents.declared_model AS declared_model,
            agents.state AS state, agents.created_at AS created_at, agents.last_seen_at AS last_seen_at
       FROM agents
       JOIN operators ON operators.id = agents.operator_id
      WHERE operators.email = ?
      ORDER BY CASE agents.state WHEN 'retired' THEN 1 ELSE 0 END, agents.created_at DESC, agents.id DESC`,
  ).bind(opened.caller.email).all<AgentListing>();
  const total = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM agents").first<{ n: number }>();
  return htmlResponse(opened.requestId, operatorPage({
    email: opened.caller.email,
    via: opened.via,
    agents: listed.results ?? [],
    totalAgents: Number(total?.n ?? 0),
    maxAgents: opened.policy.max_agents,
  }));
}

async function enroll(c: Ctx): Promise<Response> {
  const opened = await open(c, true);
  if (opened instanceof Response) return opened;
  const form = await readForm(c.req.raw);
  if (!form.ok) return failure(opened.requestId, "malformed");
  const fields: Record<string, unknown> = {
    display_name: (form.value.display_name ?? "").trim(),
    declared_model: (form.value.declared_model ?? "").trim(),
  };
  const parsed = parseEnrollFields(fields);
  if (!parsed.ok) return failure(opened.requestId, parsed.code, parsed.message);
  const enrolled = await enrollAgent(c.env.DB, opened.policy, opened.caller.email, parsed.value);
  if (!enrolled.ok) return failure(opened.requestId, enrolled.code, enrolled.message);
  return htmlResponse(
    opened.requestId,
    credentialPage("Agent enrolled", parsed.value.displayName, enrolled.agentId, enrolled.credential),
    201,
  );
}

async function rotate(c: Ctx): Promise<Response> {
  const opened = await open(c, true);
  if (opened instanceof Response) return opened;
  const result = await rotateCredential(c.env.DB, opened.caller, c.req.param("id"));
  if (!result.ok) return failure(opened.requestId, concealed(result).code, result.message);
  const agent = await c.env.DB.prepare("SELECT display_name FROM agents WHERE id = ?")
    .bind(result.agentId).first<{ display_name: string }>();
  return htmlResponse(
    opened.requestId,
    credentialPage("Credential rotated", agent?.display_name ?? "Agent", result.agentId, result.credential),
    201,
  );
}

async function change(c: Ctx, kind: "suspend" | "resume" | "retire"): Promise<Response> {
  const opened = await open(c, true);
  if (opened instanceof Response) return opened;
  if (kind === "retire") {
    const form = await readForm(c.req.raw);
    if (!form.ok || form.value.confirm !== "yes") {
      return htmlResult(
        opened.requestId,
        "Not retired",
        "Tick the box to confirm. Retiring an agent cannot be undone.",
        BACK,
        BACK_LABEL,
        422,
        SIGNED_IN,
      );
    }
  }
  const agentId = c.req.param("id");
  const result = kind === "retire"
    ? await retireAgent(c.env.DB, opened.caller, agentId)
    : await moveAgent(c.env.DB, opened.caller, agentId, kind === "suspend" ? SUSPEND : RESUME);
  if (!result.ok) return failure(opened.requestId, concealed(result).code, result.message);
  const sentence = kind === "retire"
    ? "The agent is retired and its Credential is revoked."
    : kind === "suspend"
      ? "The agent is suspended. Its calls fail until you resume it."
      : "The agent is active again.";
  return htmlResult(opened.requestId, "Agent updated", sentence, BACK, BACK_LABEL, 200, SIGNED_IN);
}

// An Agent of another Operator is not found on these forms, not forbidden.
function concealed(failure: AdminFailure): AdminFailure {
  return failure.code === "forbidden" ? { ok: false, code: "not_found" } : failure;
}

function failure(requestId: string, code: keyof typeof ERRORS, message?: string): Response {
  const error = ERRORS[code];
  const text = message ?? (code === "state_conflict" ? "The agent is not in a state that allows this." : error.message);
  return htmlResult(requestId, "Your agents", text, BACK, BACK_LABEL, error.status, SIGNED_IN);
}

// CT-28: the Operator approves or denies a code their agent printed.
async function connectForm(c: Ctx): Promise<Response> {
  const opened = await open(c, false);
  if (opened instanceof Response) return opened;
  const raw = c.req.query("code") ?? "";
  return htmlResponse(opened.requestId, connectCodePage(raw.slice(0, 20)));
}

async function connectAnswer(c: Ctx): Promise<Response> {
  const opened = await open(c, true);
  if (opened instanceof Response) return opened;
  const form = await readForm(c.req.raw);
  if (!form.ok) return failure(opened.requestId, "malformed");
  const code = normalizeUserCode(form.value.code ?? "");
  const pending = code === null ? null : await findPending(c.env.DB, code);
  if (code === null || pending === null) {
    return htmlResponse(opened.requestId, connectCodePage(form.value.code ?? "", true), 404);
  }
  const decision = form.value.decision;
  if (decision !== "approve" && decision !== "deny") {
    return htmlResponse(opened.requestId, connectConfirmPage(displayUserCode(code), pending.display_name, pending.declared_model));
  }
  const operator = await c.env.DB.prepare("SELECT id FROM operators WHERE email = ?")
    .bind(opened.caller.email).first<{ id: string | null }>();
  if (!operator?.id) return failure(opened.requestId, "forbidden");
  const answered = await answerConnection(c.env.DB, code, operator.id, decision);
  if (!answered) return htmlResponse(opened.requestId, connectCodePage(form.value.code ?? "", true), 404);
  return htmlResponse(opened.requestId, connectDonePage(decision === "approve", pending.display_name));
}
