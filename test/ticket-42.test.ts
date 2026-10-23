import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import postpublishFixture from "./fixtures/policy-postpublish.json";
import { ADMIN, STAFF, call, resetAndSeed } from "./harness";

const POSTPUBLISH = JSON.stringify(postpublishFixture);

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);

function section(html: string): string {
  const start = html.indexOf('id="admin-policy"');
  return html.slice(start, html.indexOf("</section>", start));
}

describe("AT-31 the admin Policy section (ticket 42)", () => {
  it("shows the effective policy and binding presence, never a secret value", async () => {
    // The local policy has an auth block, so EMAIL is needed. Stub it so every needed binding is present.
    const withEmail = new Proxy(env, {
      get(target, property) {
        if (property === "EMAIL") return { send: async () => undefined };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Env;
    const html = await (await call("/admin", { email: ADMIN, env: withEmail })).text();
    const policy = section(html);
    expect(policy).toContain("Moderation mode <code>prepublish</code>");
    expect(policy).toContain("<code>DB</code>");
    expect(policy).toContain("<code>TURNSTILE_SECRET</code>");
    expect(policy).toContain("Effective policy document");
    expect(policy).toContain("&quot;moderation_mode&quot;: &quot;prepublish&quot;");
    expect(policy).toContain("Every binding the policy relies on is present.");
    expect(html).not.toContain("turnstile-secret-test");
  });

  it("flags EMAIL as missing when the policy has an auth block", async () => {
    const policy = section(await (await call("/admin", { email: ADMIN })).text());
    expect(policy).toContain('<span class="flag">Missing</span> <code>EMAIL</code>');
  });

  it("flags a missing AI binding under postpublish", async () => {
    const html = await (await call("/admin", { email: ADMIN, policy: POSTPUBLISH })).text();
    const policy = section(html);
    expect(policy).toContain('<span class="flag">Missing</span> <code>AI</code>');
    expect(policy).toMatch(/<code>AI<\/code><\/td><td>Workers AI for the Content Scan<\/td><td>In postpublish mode<\/td><td><span class="flag">Missing, needed<\/span>/);
  });

  it("is Admin only", async () => {
    expect((await call("/admin", { email: STAFF })).status).toBe(403);
  });
});
