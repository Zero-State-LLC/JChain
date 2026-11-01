import { call } from "./harness";

// v0.2.50: drive the OAuth flow the way a chat app does, for the connector tests.
export const ORIGIN = "https://jchain.example.test";
export const REDIRECT = "https://app.example/callback";

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = b64url(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64url(digest) };
}

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type Options = {
  exchange?: boolean;
  pkce?: { verifier: string; challenge: string };
  stopAt?: "pending";
  decision?: "approve" | "deny";
  clientName?: string;
};

export type Tokens = { access_token: string; refresh_token: string; token_type: string; expires_in: number };

export async function connectApp(email: string, options: Options = {}): Promise<{
  clientId: string;
  approvalPath: string;
  code: string;
  location: string;
  tokens: Tokens;
}> {
  const registered = await call("/oauth/register", {
    body: { client_name: options.clientName ?? "Test Chat", redirect_uris: [REDIRECT] },
    sameOrigin: false,
  });
  const clientId = (await registered.json() as { client_id: string }).client_id;
  const pair = options.pkce ?? await pkcePair();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: pair.challenge,
    code_challenge_method: "S256",
    state: "st-1",
    resource: `${ORIGIN}/mcp`,
  });
  const started = await call(`/oauth/authorize?${query}`);
  if (started.status !== 302) throw new Error(`authorize ${started.status}`);
  const approvalPath = started.headers.get("location")!;
  const empty = { clientId, approvalPath, code: "", location: "", tokens: {} as Tokens };
  if (options.stopAt === "pending") return empty;
  const answered = await call(approvalPath, {
    email,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    raw: new TextEncoder().encode(new URLSearchParams({ decision: options.decision ?? "approve", attest: "yes" }).toString()),
  });
  if (answered.status !== 302) throw new Error(`decide ${answered.status} ${await answered.text()}`);
  const location = answered.headers.get("location")!;
  const url = new URL(location);
  const code = url.searchParams.get("code") ?? "";
  if (options.decision === "deny" || options.exchange === false) return { ...empty, code, location };
  const exchanged = await call("/oauth/token", {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    raw: new TextEncoder().encode(new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: pair.verifier,
    }).toString()),
    sameOrigin: false,
  });
  if (exchanged.status !== 200) throw new Error(`token ${exchanged.status} ${await exchanged.text()}`);
  return { clientId, approvalPath, code, location, tokens: await exchanged.json() as Tokens };
}
