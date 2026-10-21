const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function turnstileSecret(env: Env): string | null {
  const secret = env.TURNSTILE_SECRET;
  if (typeof secret !== "string" || secret.length === 0) return null;
  return secret;
}

export async function verifyTurnstile(secret: string, token: string): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(SITEVERIFY, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token }),
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
  return typeof parsed === "object" && parsed !== null && "success" in parsed && parsed.success === true;
}
