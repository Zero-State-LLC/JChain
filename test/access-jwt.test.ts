import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCESS_AUDIENCE,
  ACCESS_ISSUER,
  type AccessKey,
  accessJwtCandidates,
  accessJwtFromRequest,
  emailForAccessToken,
  emailFromAccessJwt,
  resetAccessKeyCacheForTests,
  useAccessKeysForTests,
} from "../src/access-jwt";
import { MODERATOR, OPERATOR, call, resetAndSeed } from "./harness";

const encoder = new TextEncoder();
const CERTS_URL = `${ACCESS_ISSUER}/cdn-cgi/access/certs`;
let privateKey: CryptoKey;
let publicKey: AccessKey;

beforeAll(async () => {
  const generated = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  if (!("privateKey" in generated)) throw new Error("expected a key pair");
  privateKey = generated.privateKey;
  const exported = await crypto.subtle.exportKey("jwk", generated.publicKey);
  if (!("n" in exported) || typeof exported.n !== "string" || typeof exported.e !== "string") {
    throw new Error("expected a public JWK");
  }
  publicKey = { kid: "test", n: exported.n, e: exported.e };
});

afterEach(() => {
  useAccessKeysForTests(undefined);
  resetAccessKeyCacheForTests();
  vi.restoreAllMocks();
});

describe("Access JWT", () => {
  it("accepts a current RS256 token for this application and rejects the others", async () => {
    const now = Date.now();
    const token = await signJwt({
      iss: ACCESS_ISSUER,
      aud: [ACCESS_AUDIENCE],
      email: "Moderator@Example.Test",
      exp: Math.floor(now / 1000) + 600,
      nbf: Math.floor(now / 1000) - 10,
    });
    const check = { issuer: ACCESS_ISSUER, audience: ACCESS_AUDIENCE, now, keys: [publicKey] };
    expect(await emailFromAccessJwt(token, check)).toBe(MODERATOR);
    expect(await emailFromAccessJwt(await signJwt({
      iss: "https://other.cloudflareaccess.com",
      aud: [ACCESS_AUDIENCE],
      email: MODERATOR,
      exp: Math.floor(now / 1000) + 600,
    }), check)).toBeNull();
    expect(await emailFromAccessJwt(await signJwt({
      iss: ACCESS_ISSUER,
      aud: ["someone-else"],
      email: MODERATOR,
      exp: Math.floor(now / 1000) + 600,
    }), check)).toBeNull();
    expect(await emailFromAccessJwt(await signJwt({
      iss: ACCESS_ISSUER,
      aud: [ACCESS_AUDIENCE],
      email: MODERATOR,
      exp: Math.floor(now / 1000) - 120,
    }), check)).toBeNull();
    expect(await emailFromAccessJwt(await signJwt(
      { iss: ACCESS_ISSUER, aud: [ACCESS_AUDIENCE], email: MODERATOR, exp: Math.floor(now / 1000) + 600 },
      { alg: "none", kid: "test" },
    ), check)).toBeNull();
    const [header, payload] = token.split(".");
    expect(await emailFromAccessJwt(`${header}.${payload}.${header}`, check)).toBeNull();
  });

  it("reads the session cookie and ignores the email header", () => {
    const request = new Request("https://jchain.example.test/moderation", {
      headers: {
        cookie: "theme=plain; CF_Authorization=aa.bb.cc; other=1",
        "cf-access-authenticated-user-email": MODERATOR,
      },
    });
    expect(accessJwtFromRequest(request)).toBe("aa.bb.cc");
    const headerOnly = new Request("https://jchain.example.test/moderation", {
      headers: { "cf-access-jwt-assertion": "aa.bb.cc" },
    });
    expect(accessJwtFromRequest(headerOnly)).toBe("aa.bb.cc");
    const emailOnly = new Request("https://jchain.example.test/moderation", {
      headers: { "cf-access-authenticated-user-email": MODERATOR },
    });
    expect(accessJwtFromRequest(emailOnly)).toBeNull();
    const both = new Request("https://jchain.example.test/moderation", {
      headers: {
        cookie: "CF_Authorization=aa.bb.cc",
        "cf-access-jwt-assertion": "dd.ee.ff",
      },
    });
    expect(accessJwtCandidates(both)).toEqual(["dd.ee.ff", "aa.bb.cc"]);
    expect(accessJwtFromRequest(both)).toBe("dd.ee.ff");
  });
});

describe("Access JWT on a human route", () => {
  beforeEach(resetAndSeed);

  it("lets the verified session open moderation and list boards", async () => {
    useAccessKeysForTests([publicKey]);
    const now = Math.floor(Date.now() / 1000);
    const moderator = await signJwt({
      iss: ACCESS_ISSUER,
      aud: [ACCESS_AUDIENCE],
      email: MODERATOR,
      exp: now + 600,
      nbf: now - 10,
    });
    const queue = await call("/moderation", { headers: { cookie: `CF_Authorization=${moderator}` } });
    expect(queue.status).toBe(200);
    expect(await queue.text()).toContain("No posts are waiting for review.");

    const operator = await signJwt({
      iss: ACCESS_ISSUER,
      aud: [ACCESS_AUDIENCE],
      email: OPERATOR,
      exp: now + 600,
    });
    const boards = await call("/v1/boards", { headers: { cookie: `CF_Authorization=${operator}` } });
    expect(boards.status).toBe(200);
    const body = await boards.json() as { items: { slug: string }[] };
    expect(body.items.map((item) => item.slug)).toContain("beta");
  });

  it("keeps a binding identity when the cookie is not a token", async () => {
    const queue = await call("/moderation", {
      email: MODERATOR,
      headers: { cookie: "CF_Authorization=not-a-token" },
    });
    expect(queue.status).toBe(200);
  });

  it("uses a valid header when the cookie does not verify", async () => {
    useAccessKeysForTests([publicKey]);
    const now = Math.floor(Date.now() / 1000);
    const moderator = await signJwt({
      iss: ACCESS_ISSUER,
      aud: [ACCESS_AUDIENCE],
      email: MODERATOR,
      exp: now + 600,
    });
    const queue = await call("/moderation", {
      headers: {
        cookie: "CF_Authorization=aa.bb.cc",
        "cf-access-jwt-assertion": moderator,
      },
    });
    expect(queue.status).toBe(200);
  });

  it("does not accept the email header as an identity", async () => {
    const queue = await call("/moderation", {
      headers: { "cf-access-authenticated-user-email": MODERATOR },
    });
    expect(queue.status).toBe(401);
  });
});

describe("Access key refresh", () => {
  it("loads a new kid once and then waits before another refresh", async () => {
    const rotated = await generateKey();
    const now = Date.now();
    const payload = {
      iss: ACCESS_ISSUER,
      aud: [ACCESS_AUDIENCE],
      email: MODERATOR,
      exp: Math.floor(now / 1000) + 600,
    };
    const token = await signJwt(payload, { alg: "RS256", kid: "rotated", typ: "JWT" }, rotated.privateKey);
    const calls = mockCerts([jwkSet(publicKey), jwkSet(rotated.publicKey)]);
    expect(await emailForAccessToken(token, now)).toBe(MODERATOR);
    expect(calls.count).toBe(2);

    const unknown = await signJwt(payload, { alg: "RS256", kid: "other", typ: "JWT" }, rotated.privateKey);
    expect(await emailForAccessToken(unknown, now)).toBeNull();
    expect(calls.count).toBe(2);
    expect(await emailForAccessToken(unknown, now + 60_000)).toBeNull();
    expect(calls.count).toBe(3);
  });

  it("does not refresh when the cached kid is present", async () => {
    const now = Date.now();
    const token = await signJwt({
      iss: ACCESS_ISSUER,
      aud: [ACCESS_AUDIENCE],
      email: MODERATOR,
      exp: Math.floor(now / 1000) + 600,
    });
    const calls = mockCerts([jwkSet(publicKey)]);
    expect(await emailForAccessToken(token, now)).toBe(MODERATOR);
    expect(await emailForAccessToken(token, now)).toBe(MODERATOR);
    expect(calls.count).toBe(1);

    const wrongKey = await generateKey();
    const forged = await signJwt({
      iss: ACCESS_ISSUER,
      aud: [ACCESS_AUDIENCE],
      email: MODERATOR,
      exp: Math.floor(now / 1000) + 600,
    }, { alg: "RS256", kid: "test", typ: "JWT" }, wrongKey.privateKey);
    expect(await emailForAccessToken(forged, now)).toBeNull();
    expect(calls.count).toBe(1);
  });
});

async function signJwt(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", kid: "test", typ: "JWT" },
  key: CryptoKey = privateKey,
): Promise<string> {
  const encodedHeader = base64Url(encoder.encode(JSON.stringify(header)));
  const encodedPayload = base64Url(encoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(`${encodedHeader}.${encodedPayload}`),
  ));
  return `${encodedHeader}.${encodedPayload}.${base64Url(signature)}`;
}

async function generateKey(): Promise<{ privateKey: CryptoKey; publicKey: AccessKey }> {
  const generated = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  if (!("privateKey" in generated)) throw new Error("expected a key pair");
  const exported = await crypto.subtle.exportKey("jwk", generated.publicKey);
  if (!("n" in exported) || typeof exported.n !== "string" || typeof exported.e !== "string") {
    throw new Error("expected a public JWK");
  }
  return { privateKey: generated.privateKey, publicKey: { kid: "rotated", n: exported.n, e: exported.e } };
}

function jwkSet(key: AccessKey): { keys: Array<AccessKey & { kty: "RSA"; alg: "RS256" }> } {
  return { keys: [{ kty: "RSA", alg: "RS256", kid: key.kid, n: key.n, e: key.e }] };
}

function mockCerts(sets: Array<{ keys: unknown[] }>): { count: number } {
  const calls = { count: 0 };
  vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url !== CERTS_URL) return Promise.reject(new Error(`unexpected fetch ${url}`));
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = sets[Math.min(calls.count, sets.length - 1)];
    calls.count += 1;
    return Promise.resolve(Response.json(body));
  });
  return calls;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}
