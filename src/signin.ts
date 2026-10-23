import { Hono, type Context } from "hono";
import {
  badLinkPage,
  confirmLinkPage,
  linkSentPage,
  signInPage,
  signedOutPage,
} from "./account-pages";
import { sha256Hex } from "./credential";
import { readForm } from "./forms";
import { htmlError } from "./html";
import { htmlResponse } from "./http";
import { uuidv7 } from "./ids";
import { sameOrigin } from "./origin";
import { mailbox, type Policy } from "./policy";
import { chargeSignInAddress, chargeSignInEmail } from "./quota";
import {
  CLEAR_SESSION_COOKIE,
  consumeLink,
  consumeSignupLink,
  currentSession,
  emailSignIn,
  issueLink,
  issueSignupLink,
  isLinkToken,
  policyOf,
  readSessionCookie,
  revokeOperatorSessions,
  revokeSession,
  sessionCookie,
  signInEmail,
  signupAllowed,
} from "./session";

// CT-18 as amended in v0.2.23. The sign-in page always renders. The email form
// and every write route work only while email sign-in is on.

type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
type Ctx = Context<AppEnv>;

const ACCOUNT = { section: "account" } as const;

export function mountSignIn(app: Hono<AppEnv>): void {
  app.get("/signin", signInForm);
  // v0.2.25: the one path the Access application covers for Operators. Access
  // signs the person in, then the Worker sends them to the Operator page, which
  // itself stays off the Access application so email Sessions reach it too.
  app.get("/signin/access", accessDoor);
  app.post("/signin", requestLink);
  app.get("/signin/:token", confirmLink);
  app.post("/signin/:token", useLink);
  app.post("/signout", signOut);
  app.post("/signout/all", signOutEverywhere);
}

async function signInForm(c: Ctx): Promise<Response> {
  const requestId = uuidv7();
  const enabled = emailSignIn(c.env, policyOf(c.env));
  const session = enabled === null ? null : await currentSession(c.env, c.req.raw);
  return htmlResponse(requestId, signInPage({
    emailOn: enabled !== null,
    linkMinutes: enabled?.auth.link_minutes,
    signedInAs: session?.email,
    signupOpen: enabled?.auth.signup_open === true && policyOf(c.env)?.operator_caps !== undefined,
    agentLimit: policyOf(c.env)?.operator_caps?.approved_agents,
  }));
}

function accessDoor(_c: Ctx): Response {
  return new Response(null, {
    status: 303,
    headers: { location: "/operator", "cache-control": "no-store", "x-request-id": uuidv7() },
  });
}

async function requestLink(c: Ctx): Promise<Response> {
  const requestId = uuidv7();
  const policy = policyOf(c.env);
  const enabled = emailSignIn(c.env, policy);
  if (policy === null || enabled === null) return htmlError(requestId, "policy_missing", "Sign in", "/signin", "Sign in", ACCOUNT);
  if (!sameOrigin(c.req.raw, policy.site_origin)) return htmlError(requestId, "forbidden", "Sign in", "/signin", "Sign in", ACCOUNT);
  const form = await readForm(c.req.raw);
  const raw = form.ok ? form.value.email : undefined;
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!form.ok || !mailbox(email)) {
    return htmlResponse(requestId, signInPage({
      emailOn: true,
      linkMinutes: enabled.auth.link_minutes,
      signupOpen: enabled.auth.signup_open && policy.operator_caps !== undefined,
      agentLimit: policy.operator_caps?.approved_agents,
      error: "Enter a whole email address, like name@example.com.",
      email: typeof raw === "string" ? raw.slice(0, 254) : undefined,
    }), 422);
  }
  const { auth, mailer } = enabled;
  // Every outcome below shows the same page, so the answer never says whether
  // the address belongs to an Operator or whether a cap was reached.
  if (await chargeSignInAddress(c.env, await sha256Hex(email), auth.links_per_email_hour)) {
    const operator = await c.env.DB.prepare(
      "SELECT id FROM operators WHERE email = ? AND state IN ('provisional', 'approved')",
    ).bind(email).first<{ id: string | null }>();
    // An existing Operator gets a sign-in link. While sign-up is open (ticket 25), an address
    // that may sign up gets a sign-up link; otherwise nothing is sent.
    const operatorId = operator?.id ?? null;
    const signup = operatorId === null && await signupAllowed(c.env.DB, policy, auth, email);
    if (operatorId !== null || signup) {
      // The page returns before this work, so a known address is not slower
      // than an unknown one. Failures are logged without the address.
      const task = (async () => {
        try {
          if (!(await chargeSignInEmail(c.env, auth.emails_per_day))) {
            console.error(JSON.stringify({ message: "sign-in email cap reached", request_id: requestId }));
            return;
          }
          const token = operatorId !== null
            ? await issueLink(c.env.DB, operatorId, auth)
            : await issueSignupLink(c.env.DB, email, auth);
          await mailer.send(signInEmail(auth, email, `${policy.site_origin}/signin/${token}`, operatorId === null));
        } catch {
          console.error(JSON.stringify({ message: "sign-in email failed", request_id: requestId }));
        }
      })();
      const waitUntil = c.executionCtx?.waitUntil;
      if (typeof waitUntil === "function") waitUntil.call(c.executionCtx, task);
      else await task;
    }
  }
  return htmlResponse(requestId, linkSentPage());
}

// GET consumes nothing, so a mail scanner that follows the link signs no one in.
function confirmLink(c: Ctx): Response {
  const requestId = uuidv7();
  if (emailSignIn(c.env, policyOf(c.env)) === null) {
    const response = htmlError(requestId, "policy_missing", "Sign in", "/signin", "Sign in", ACCOUNT);
    response.headers.set("referrer-policy", "no-referrer");
    return response;
  }
  const token = c.req.param("token") ?? "";
  const response = isLinkToken(token)
    ? htmlResponse(requestId, confirmLinkPage(token))
    : htmlResponse(requestId, badLinkPage(), 400);
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}

async function useLink(c: Ctx): Promise<Response> {
  const requestId = uuidv7();
  const policy = policyOf(c.env);
  const enabled = emailSignIn(c.env, policy);
  if (policy === null || enabled === null) return htmlError(requestId, "policy_missing", "Sign in", "/signin", "Sign in", ACCOUNT);
  if (!sameOrigin(c.req.raw, policy.site_origin)) return htmlError(requestId, "forbidden", "Sign in", "/signin", "Sign in", ACCOUNT);
  const token = c.req.param("token") ?? "";
  const started = await consumeLink(c.env.DB, token, enabled.auth)
    ?? await consumeSignupLink(c.env.DB, token, policy, enabled.auth);
  if (started === null) {
    const response = htmlResponse(requestId, badLinkPage(), 400);
    response.headers.set("referrer-policy", "no-referrer");
    return response;
  }
  return redirect(requestId, "/operator", sessionCookie(started.secret, started.maxAge));
}

async function signOut(c: Ctx): Promise<Response> {
  const requestId = uuidv7();
  const policy = policyOf(c.env);
  if (policy === null) return htmlError(requestId, "policy_missing", "Sign out", "/signin", "Sign in", ACCOUNT);
  if (!sameOrigin(c.req.raw, policy.site_origin)) return htmlError(requestId, "forbidden", "Sign out", "/signin", "Sign in", ACCOUNT);
  const secret = readSessionCookie(c.req.raw);
  if (secret !== null) await revokeSession(c.env.DB, secret);
  return redirect(requestId, "/signin", CLEAR_SESSION_COOKIE);
}

async function signOutEverywhere(c: Ctx): Promise<Response> {
  const requestId = uuidv7();
  const policy = policyOf(c.env);
  if (policy === null) return htmlError(requestId, "policy_missing", "Sign out", "/signin", "Sign in", ACCOUNT);
  if (!sameOrigin(c.req.raw, policy.site_origin)) return htmlError(requestId, "forbidden", "Sign out", "/signin", "Sign in", ACCOUNT);
  const session = await currentSession(c.env, c.req.raw);
  if (session === null) {
    const response = htmlResponse(requestId, signedOutPage(false), 401);
    response.headers.append("set-cookie", CLEAR_SESSION_COOKIE);
    return response;
  }
  await revokeOperatorSessions(c.env.DB, session.operatorId);
  const response = htmlResponse(requestId, signedOutPage(true));
  response.headers.append("set-cookie", CLEAR_SESSION_COOKIE);
  return response;
}

function redirect(requestId: string, location: string, cookie: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location,
      "set-cookie": cookie,
      "cache-control": "no-store",
      "x-request-id": requestId,
      "referrer-policy": "no-referrer",
    },
  });
}
