import { HTML_CSP } from "./http";
import type { Policy } from "./policy";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// #61, v0.2.51: while sign-up is open, every form that posts to /signin carries the Turnstile
// widget and POST /signin verifies it before any email is sent. This protects the shared
// auth.emails_per_day budget (sign-in links and Moderator alerts) from scripted sign-ups.
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
export const TURNSTILE_SCRIPT = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js`;
// The hidden field the widget adds to its form.
export const TURNSTILE_FIELD = "cf-turnstile-response";
export const TURNSTILE_TOKEN_MAX = 2048;
// The page CSP with the one exception the widget needs: its script and its frame.
export const TURNSTILE_CSP = `${HTML_CSP.replace("script-src 'none'", `script-src ${TURNSTILE_ORIGIN}`)}; frame-src ${TURNSTILE_ORIGIN}`;

// The site key to render on the sign-in forms, or null when sign-up is closed (no widget).
export function signInTurnstileKey(policy: Policy | null): string | null {
  if (policy === null || policy.auth?.signup_open !== true) return null;
  return policy.turnstile_site_key;
}

export function signInCsp(siteKey: string | null | undefined): string {
  return typeof siteKey === "string" ? TURNSTILE_CSP : HTML_CSP;
}

export function turnstileSecret(env: Env): string | null {
  const secret = env.TURNSTILE_SECRET;
  if (typeof secret !== "string" || secret.length === 0) return null;
  return secret;
}

export async function verifyTurnstile(
  secret: string,
  token: string,
  options?: { remoteip?: string | null; expectedHostname?: string },
): Promise<boolean> {
  let response: Response;
  const body = new URLSearchParams({ secret, response: token });
  if (options?.remoteip) body.set("remoteip", options.remoteip);
  try {
    response = await fetch(SITEVERIFY, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || !("success" in parsed) || parsed.success !== true) {
    return false;
  }
  if (
    options?.expectedHostname
    && "hostname" in parsed
    && typeof parsed.hostname === "string"
    && parsed.hostname.length > 0
    && parsed.hostname !== options.expectedHostname
  ) {
    return false;
  }
  return true;
}
