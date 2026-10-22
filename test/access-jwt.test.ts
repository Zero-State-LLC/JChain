import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ACCESS_AUDIENCE,
  ACCESS_ISSUER,
  type AccessKey,
  accessJwtFromRequest,
  emailFromAccessJwt,
  useAccessKeysForTests,
} from "../src/access-jwt";
import { MODERATOR, OPERATOR, call, resetAndSeed } from "./harness";

const encoder = new TextEncoder();
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

  it("does not accept the email header as an identity", async () => {
    const queue = await call("/moderation", {
      headers: { "cf-access-authenticated-user-email": MODERATOR },
    });
    expect(queue.status).toBe(401);
  });
});

async function signJwt(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "test", typ: "JWT" }): Promise<string> {
  const encodedHeader = base64Url(encoder.encode(JSON.stringify(header)));
  const encodedPayload = base64Url(encoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    encoder.encode(`${encodedHeader}.${encodedPayload}`),
  ));
  return `${encodedHeader}.${encodedPayload}.${base64Url(signature)}`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}
