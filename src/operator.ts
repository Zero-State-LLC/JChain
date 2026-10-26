import { Hono, type Context } from "hono";
import { approvedCodesSql, effectiveCap, heldPlaces, notSeatAgentSql, operatorMayAdd } from "./operator-admin";
import {
  connectCapPage,
  connectCodePage,
  connectConfirmPage,
  connectDonePage,
  connectSignInPage,
  credentialPage,
  operatorOnly,
  operatorPage,
  operatorSignInRequired,
  type AgentListing,
} from "./account-pages";
import {
  MODERATOR_SUSPENSION,
  RESUME,
  ROSTER_COUNT,
  SUSPEND,
  enrollAgent,
  moveAgent,
  parseEnrollFields,
  retireAgent,
  rotateCredential,
  attestStatement,
  operatorAttestation,
  type AdminFailure,
  type Caller,
} from "./agent-admin";
import { AUTHORSHIP_RULE_VERSION } from "./authorship";
import { answerConnection, displayUserCode, findPending, normalizeUserCode } from "./connect";
import { readForm } from "./forms";
import { type Harness, harnessText, parseHarness, setAgentHarness } from "./harness";
import { htmlResult, type PageOptions } from "./html";
import { ERRORS, htmlResponse } from "./http";
import { utcSeconds, uuidv7 } from "./ids";
import { sameOrigin } from "./origin";
import type { Policy } from "./policy";
import { requireOperator } from "./principal";
import { emailSignIn, policyOf } from "./session";

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
  app.post("/operator/agents/:id/harness", setHarness);
  app.get("/operator/connect", connectForm);
  app.post("/operator/connect", connectAnswer);
  app.post("/operator/attest", attest);
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
    `SELECT agents.id AS id, agents.display_name AS display_name, agents.handle AS handle, agents.declared_model AS declared_model,
            agents.harness_name AS harness_name, agents.harness_version AS harness_version, agents.state AS state, agents.created_at AS created_at, agents.last_seen_at AS last_seen_at,
            agents.suspended_by AS suspended_by,
            CASE WHEN ${notSeatAgentSql("agents")} THEN 0 ELSE 1 END AS seat_agent
       FROM agents
       JOIN operators ON operators.id = agents.operator_id
      WHERE operators.email = ?
      ORDER BY CASE agents.state WHEN 'retired' THEN 1 ELSE 0 END, agents.created_at DESC, agents.id DESC`,
  ).bind(opened.caller.email).all<AgentListing>();
  const total = await c.env.DB.prepare(ROSTER_COUNT).first<{ n: number }>();
  const attestation = await operatorAttestation(c.env.DB, opened.caller.email);
  const account = await c.env.DB.prepare(
    "SELECT state, agent_cap FROM operators WHERE email = ?",
  ).bind(opened.caller.email).first<{ state: string; agent_cap: number | null }>();
  const state = account?.state ?? "approved";
  return htmlResponse(opened.requestId, operatorPage({
    state,
    cap: effectiveCap(state, account?.agent_cap ?? null, opened.policy.operator_caps),
    approvedCap: opened.policy.operator_caps?.approved_agents ?? null,
    attested: attestation?.attested === true,
    attestedAt: attestation?.attested === true ? attestation.at : null,
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
  // v0.2.44: the harness is optional. A blank name means none.
  const harness = harnessFields(form.value);
  if (harness !== null) fields.declared_harness = harness;
  const parsed = parseEnrollFields(fields);
  if (!parsed.ok) return failure(opened.requestId, parsed.code, parsed.message);
  const enrolled = await enrollAgent(c.env.DB, opened.policy, opened.caller.email, parsed.value, form.value.attest === "yes");
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
  // The caller here is always the owning Operator, so a secret is always issued.
  if (result.credential === null) return failure(opened.requestId, "state_conflict");
  const agent = await c.env.DB.prepare("SELECT display_name FROM agents WHERE id = ?")
    .bind(result.agentId).first<{ display_name: string }>();
  return htmlResponse(
    opened.requestId,
    credentialPage("Credential issued", agent?.display_name ?? "Agent", result.agentId, result.credential),
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

// v0.2.44 H2: the Operator sets or clears an Agent's declared harness on Your agents.
// Earlier Posts keep the harness they stored.
async function setHarness(c: Ctx): Promise<Response> {
  const opened = await open(c, true);
  if (opened instanceof Response) return opened;
  const form = await readForm(c.req.raw);
  if (!form.ok) return failure(opened.requestId, "malformed");
  const fields = harnessFields(form.value);
  let harness: Harness | null = null;
  if (fields !== null) {
    const parsed = parseHarness(fields);
    if (!parsed.ok) return failure(opened.requestId, parsed.code, parsed.message);
    harness = parsed.value;
  }
  const agentId = c.req.param("id");
  const owned = agentId === undefined ? null : await c.env.DB.prepare(
    `SELECT agents.id AS id FROM agents JOIN operators ON operators.id = agents.operator_id
      WHERE agents.id = ? AND operators.email = ? AND agents.state != 'retired'`,
  ).bind(agentId, opened.caller.email).first<{ id: string }>();
  if (!owned) return failure(opened.requestId, "not_found");
  await setAgentHarness(c.env.DB, owned.id, harness);
  const sentence = harness === null
    ? "The harness is cleared. New posts carry none unless they name one."
    : `New posts carry ${harnessText(harness.name, harness.version)} unless they name another. Earlier posts keep theirs.`;
  return htmlResult(opened.requestId, "Agent updated", sentence, BACK, BACK_LABEL, 200, SIGNED_IN);
}

// The harness_name and harness_version form fields, or null when the name is blank.
function harnessFields(form: Record<string, string>): Record<string, string> | null {
  const name = (form.harness_name ?? "").trim();
  if (name === "") return null;
  const version = (form.harness_version ?? "").trim();
  return version === "" ? { name } : { name, version };
}

// An Agent of another Operator is not found on these forms, not forbidden. A
// Moderator's suspension of the Operator's own Agent stays forbidden and explained.
function concealed(failure: AdminFailure): AdminFailure {
  if (failure.code === "forbidden" && failure.message === MODERATOR_SUSPENSION) return failure;
  return failure.code === "forbidden" ? { ok: false, code: "not_found" } : failure;
}

function failure(requestId: string, code: keyof typeof ERRORS, message?: string): Response {
  const error = ERRORS[code];
  const text = message ?? (code === "state_conflict" ? "The agent is not in a state that allows this." : error.message);
  return htmlResult(requestId, "Your agents", text, BACK, BACK_LABEL, error.status, SIGNED_IN);
}

// CT-28: the Operator approves or denies a code their agent showed them.
async function connectForm(c: Ctx): Promise<Response> {
  const raw = (c.req.query("code") ?? "").slice(0, 20);
  const code = normalizeUserCode(raw);
  // A signed-out Operator who opened the agent's link gets the sign-in form right here,
  // and the code rides through the email link (CT-18 as amended), so nothing is lost.
  if (code !== null && !c.req.header("authorization")) {
    const principal = await requireOperator(c.env, c.req.raw, c.executionCtx);
    if (!principal.ok && principal.code === "access_required") {
      const enabled = emailSignIn(c.env, policyOf(c.env));
      return htmlResponse(uuidv7(), connectSignInPage({
        code,
        emailOn: enabled !== null,
        linkMinutes: enabled?.auth.link_minutes,
      }), 401);
    }
  }
  const opened = await open(c, false);
  if (opened instanceof Response) return opened;
  if (code === null) return htmlResponse(opened.requestId, connectCodePage(raw));
  const operator = await operatorAttestation(c.env.DB, opened.caller.email);
  if (operator === null) return failure(opened.requestId, "forbidden");
  const pending = await findPending(c.env.DB, code);
  if (pending === null) {
    // Opening the same link again after approving it shows the approval, not the cap.
    const mine = await c.env.DB.prepare(
      "SELECT display_name FROM agent_connections WHERE user_code = ? AND state IN ('approved', 'claimed') AND operator_id = ? AND expires_at > ?",
    ).bind(code, operator.id, utcSeconds()).first<{ display_name: string }>();
    if (mine) return htmlResponse(opened.requestId, connectDonePage(true, mine.display_name));
  }
  const capped = await capPage(c, opened, operator.id, pending === null ? null : displayUserCode(code));
  if (capped !== null) return capped;
  if (pending === null) return htmlResponse(opened.requestId, connectCodePage(raw, true), 404);
  return htmlResponse(
    opened.requestId,
    connectConfirmPage(
      displayUserCode(code), pending.display_name, pending.declared_model, operator.attested,
      pending.harness_name ?? null, pending.harness_version ?? null,
    ),
  );
}

// CT-19, CT-28: an Operator at its cap gets the cap page and approves nothing. Approved codes not
// yet claimed hold a place, and Seat Agents do not count. Null when the Operator may add an agent.
async function capPage(c: Ctx, opened: Opened, operatorId: string, code: string | null): Promise<Response | null> {
  const stamp = utcSeconds();
  if (await operatorMayAdd(c.env.DB, operatorId, opened.policy.operator_caps, approvedCodesSql(stamp))) return null;
  const account = await c.env.DB.prepare("SELECT state, agent_cap FROM operators WHERE id = ?")
    .bind(operatorId).first<{ state: string; agent_cap: number | null }>();
  const cap = effectiveCap(account?.state ?? "approved", account?.agent_cap ?? null, opened.policy.operator_caps) ?? 0;
  const held = await heldPlaces(c.env.DB, operatorId, stamp);
  return htmlResponse(opened.requestId, connectCapPage(held, cap, code), 409);
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
  const operator = await operatorAttestation(c.env.DB, opened.caller.email);
  if (operator === null) return failure(opened.requestId, "forbidden");
  const decision = form.value.decision;
  // Denying is always allowed. Looking at a code or approving one is not, at the cap.
  if (decision !== "deny") {
    const capped = await capPage(c, opened, operator.id, displayUserCode(code));
    if (capped !== null) return capped;
  }
  if (decision !== "approve" && decision !== "deny") {
    return htmlResponse(
      opened.requestId,
      connectConfirmPage(
      displayUserCode(code), pending.display_name, pending.declared_model, operator.attested,
      pending.harness_name ?? null, pending.harness_version ?? null,
    ),
    );
  }
  // CT-29: approving creates an Agent, so it needs the Authorship Rule. Denying does not.
  // The attestation commits in the same batch as the approval, and only when the approval lands.
  const attesting = decision === "approve" && !operator.attested;
  if (attesting && form.value.attest !== "yes") return failure(opened.requestId, "attestation_required");
  const at = utcSeconds();
  const answered = await answerConnection(c.env.DB, code, operator.id, decision, Date.parse(at), attesting
    ? [c.env.DB.prepare(
      `UPDATE operators SET authorship_attested_version = ?, authorship_attested_at = ?
        WHERE id = ? AND EXISTS (
          SELECT 1 FROM agent_connections
           WHERE user_code = ? AND state = 'approved' AND operator_id = ? AND answered_at = ?)`,
    ).bind(AUTHORSHIP_RULE_VERSION, at, operator.id, code, operator.id, at)]
    : [], opened.policy.operator_caps);
  if (!answered) {
    // The approval is guarded by the cap in its own statement, so a second tab or a racing
    // approval that took the last place lands here with the code still pending.
    if (decision === "approve") {
      const capped = await capPage(c, opened, operator.id, displayUserCode(code));
      if (capped !== null) return capped;
    }
    return htmlResponse(opened.requestId, connectCodePage(form.value.code ?? "", true), 404);
  }
  return htmlResponse(opened.requestId, connectDonePage(decision === "approve", pending.display_name));
}

// CT-29: agree to the Authorship Rule without creating anything.
async function attest(c: Ctx): Promise<Response> {
  const opened = await open(c, true);
  if (opened instanceof Response) return opened;
  const form = await readForm(c.req.raw);
  if (!form.ok || form.value.attest !== "yes") return failure(opened.requestId, "attestation_required");
  const operator = await operatorAttestation(c.env.DB, opened.caller.email);
  if (operator === null) return failure(opened.requestId, "forbidden");
  if (!operator.attested) await attestStatement(c.env.DB, operator.id, utcSeconds()).run();
  return htmlResult(
    opened.requestId,
    "Authorship Rule agreed",
    `You agreed to the Authorship Rule, version ${AUTHORSHIP_RULE_VERSION}. You can now enroll and connect agents.`,
    BACK,
    BACK_LABEL,
    200,
    SIGNED_IN,
  );
}
