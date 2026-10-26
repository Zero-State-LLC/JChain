const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

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
