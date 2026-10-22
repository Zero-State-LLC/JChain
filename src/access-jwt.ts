const ISSUER = "https://noisy-moon-2f8b.cloudflareaccess.com";
const AUDIENCE = "e741f2323fa334b133b485c4c64d23965bb35b7db655f398790181db5804ff9b";
const CERTS_URL = `${ISSUER}/cdn-cgi/access/certs`;
const SKEW_MS = 60_000;
const CACHE_MS = 60 * 60 * 1000;
const REFRESH_GAP_MS = 60_000;
const MAX_TOKEN_LENGTH = 8192;

export const ACCESS_ISSUER = ISSUER;
export const ACCESS_AUDIENCE = AUDIENCE;

export type AccessKey = { kid: string; n: string; e: string };

type JwtCheck = {
  issuer: string;
  audience: string;
  now: number;
  keys: AccessKey[];
};

let testKeys: AccessKey[] | undefined;
let cached: { expiresAt: number; keys: AccessKey[] } | undefined;
let lastForcedRefresh = Number.NEGATIVE_INFINITY;

export function useAccessKeysForTests(keys: AccessKey[] | undefined): void {
  testKeys = keys;
}

export function resetAccessKeyCacheForTests(): void {
  cached = undefined;
  lastForcedRefresh = Number.NEGATIVE_INFINITY;
}

export function accessJwtFromRequest(request: Request): string | null {
  const cookie = jwtFromCookie(request.headers.get("cookie"));
  if (cookie !== null) return cookie;
  const header = request.headers.get("cf-access-jwt-assertion");
  if (header !== null && isCompactJwt(header)) return header;
  return null;
}

export async function loadAccessKeys(now = Date.now(), force = false): Promise<AccessKey[] | null> {
  if (testKeys !== undefined) return testKeys;
  if (force) {
    if (cached !== undefined && now - lastForcedRefresh < REFRESH_GAP_MS) return cached.keys;
    lastForcedRefresh = now;
  } else if (cached !== undefined && cached.expiresAt > now) {
    return cached.keys;
  }
  try {
    const response = await fetch(CERTS_URL);
    if (!response.ok) return cached?.keys ?? null;
    const keys = readKeys(await response.json());
    if (keys.length === 0) return cached?.keys ?? null;
    cached = { expiresAt: now + CACHE_MS, keys };
    return keys;
  } catch {
    return cached?.keys ?? null;
  }
}

export async function emailForAccessToken(token: string, now = Date.now()): Promise<string | null> {
  const keys = await loadAccessKeys(now);
  if (keys === null || keys.length === 0) return null;
  const check: JwtCheck = { issuer: ACCESS_ISSUER, audience: ACCESS_AUDIENCE, now, keys };
  const email = await emailFromAccessJwt(token, check);
  if (email !== null) return email;
  const kid = jwtKid(token);
  if (kid === null || keys.some((key) => key.kid === kid)) return null;
  const refreshed = await loadAccessKeys(now, true);
  if (refreshed === null) return null;
  return emailFromAccessJwt(token, { ...check, keys: refreshed });
}

export async function emailFromAccessJwt(token: string, check: JwtCheck): Promise<string | null> {
  if (!isCompactJwt(token)) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  const header = decodeJson(encodedHeader ?? "");
  if (header === null || header.alg !== "RS256" || typeof header.kid !== "string") return null;
  const key = check.keys.find((candidate) => candidate.kid === header.kid);
  if (key === undefined) return null;
  const signed = await signatureMatches(encodedHeader ?? "", encodedPayload ?? "", encodedSignature ?? "", key);
  if (!signed) return null;
  const payload = decodeJson(encodedPayload ?? "");
  if (payload === null || payload.iss !== check.issuer || !audienceMatches(payload.aud, check.audience)) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 < check.now - SKEW_MS) return null;
  if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf * 1000 > check.now + SKEW_MS)) {
    return null;
  }
  return normalizeEmail(payload.email);
}

async function signatureMatches(encodedHeader: string, encodedPayload: string, encodedSignature: string, key: AccessKey): Promise<boolean> {
  try {
    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: key.n, e: key.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const data = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
    const signature = base64UrlBytes(encodedSignature);
    if (signature === null) return false;
    return crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, bytesBuffer(signature), data);
  } catch {
    return false;
  }
}

function jwtKid(token: string): string | null {
  if (!isCompactJwt(token)) return null;
  const header = decodeJson(token.split(".")[0] ?? "");
  if (header === null || header.alg !== "RS256" || typeof header.kid !== "string") return null;
  return header.kid;
}

function jwtFromCookie(header: string | null): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const split = trimmed.indexOf("=");
    if (split <= 0) continue;
    if (trimmed.slice(0, split) !== "CF_Authorization") continue;
    const value = trimmed.slice(split + 1);
    if (isCompactJwt(value)) return value;
  }
  return null;
}

function isCompactJwt(value: string): boolean {
  if (value.length < 5 || value.length > MAX_TOKEN_LENGTH) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  return parts.every((part) => part.length > 0 && /^[A-Za-z0-9_-]+$/.test(part));
}

function audienceMatches(aud: unknown, expected: string): boolean {
  if (typeof aud === "string") return aud === expected;
  return Array.isArray(aud) && aud.some((item) => item === expected);
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !email.includes("@") || email.includes(" ")) return null;
  for (let index = 0; index < email.length; index += 1) {
    if (email.charCodeAt(index) < 0x20) return null;
  }
  return email;
}

function readKeys(body: unknown): AccessKey[] {
  if (typeof body !== "object" || body === null || !("keys" in body) || !Array.isArray(body.keys)) return [];
  const keys: AccessKey[] = [];
  for (const key of body.keys) {
    if (typeof key !== "object" || key === null) continue;
    if (!("kid" in key) || !("n" in key) || !("e" in key) || !("kty" in key)) continue;
    if (key.kty !== "RSA" || typeof key.kid !== "string" || typeof key.n !== "string" || typeof key.e !== "string") continue;
    keys.push({ kid: key.kid, n: key.n, e: key.e });
  }
  return keys;
}

function decodeJson(segment: string): Record<string, unknown> | null {
  const bytes = base64UrlBytes(segment);
  if (bytes === null) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function base64UrlBytes(segment: string): Uint8Array | null {
  try {
    const padded = segment.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (segment.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function bytesBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
