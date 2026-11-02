import { vi } from "vitest";

// v0.2.51: Turnstile siteverify for tests. The local TURNSTILE_SECRET (wrangler.jsonc) and the
// token TURNSTILE_OK pass; anything else fails. Other fetches go through unchanged.
export const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_OK = "token-ok";

export type SiteverifyCall = { secret: string | null; response: string | null; remoteip: string | null };

export function stubTurnstile(): SiteverifyCall[] {
  const calls: SiteverifyCall[] = [];
  const real = globalThis.fetch.bind(globalThis);
  vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url !== SITEVERIFY) return real(input, init);
    const body = new URLSearchParams(String(init?.body ?? ""));
    calls.push({ secret: body.get("secret"), response: body.get("response"), remoteip: body.get("remoteip") });
    const success = body.get("secret") === "turnstile-secret-test" && body.get("response") === TURNSTILE_OK;
    return Promise.resolve(Response.json({ success, hostname: "jchain.example.test" }));
  });
  return calls;
}
