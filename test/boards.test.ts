import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BOARD_ID, MODERATOR, OPERATOR, UUID_V7, call, resetAndSeed } from "./harness";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);

describe("board catalog", () => {
  it("lists distinct topics and lets an operator add a board", async () => {
    const anon = await call("/boards");
    expect(anon.status).toBe(200);
    expect(anon.headers.get("content-security-policy")).toBe(
      "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'none'; frame-ancestors 'none'",
    );
    const directory = await anon.text();
    expect(directory).toContain("<h1>Boards</h1>");
    expect(directory).toContain('<a href="/boards/beta">/beta/</a>');
    expect(directory).toContain("<td>JChain</td>");
    expect(directory).not.toContain("<form");
    expect(directory).not.toContain("<script");
    expect(directory).not.toContain("<style");
    expect(directory).not.toContain(" style=");

    const operatorPage = await text("/boards", OPERATOR);
    expect(operatorPage).toContain('action="/boards"');
    expect(operatorPage).toContain('for="slug"');
    expect(operatorPage).toContain('for="name"');
    expect(operatorPage).toContain(">Add board</button>");
    expect(await text("/boards", MODERATOR)).not.toContain("<form");

    const created = await expectSuccess(await call("/v1/boards", {
      email: OPERATOR,
      body: { slug: "tech", name: "  Technology  " },
    }), 201);
    expect(created.id).toMatch(UUID_V7);
    expect(created.slug).toBe("tech");
    expect(created.name).toBe("Technology");
    expect(created.id).not.toBe(BOARD_ID);

    const listed = await expectSuccess(await call("/v1/boards", { email: OPERATOR }));
    const items = listed.items as Array<{ id: string; slug: string; name: string }>;
    expect(items.map((item) => [item.slug, item.name])).toEqual([
      ["beta", "JChain"],
      ["tech", "Technology"],
    ]);

    const home = await text("/");
    expect(home).toContain('href="/boards/beta">/beta/ — JChain</a>');
    expect(home).toContain('href="/boards/tech">/tech/ — Technology</a>');
    expect(home).not.toContain(">Board</a>");

    const again = await text("/boards");
    expect(again).toContain('href="/boards/beta">/beta/</a>');
    expect(again).toContain('href="/boards/tech">/tech/</a>');
    expect(again).toContain("<td>Technology</td>");

    const tech = await text("/boards/tech");
    expect(tech).toContain("<h1>Technology</h1>");
    expect(tech).toContain("No published threads.");
    expect(tech).toContain('href="/boards">Boards</a>');
    expect(tech).not.toContain("<style");
    expect(tech).not.toContain(" style=");

    const rules = await expectSuccess(await call(`/v1/boards/${String(created.id)}/rules`, { email: OPERATOR }));
    expect(rules.slug).toBe("tech");
    expect(rules.board_id).toBe(created.id);
    expect(rules.prohibited).toEqual([]);

    const duplicate = await expectError(await call("/v1/boards", {
      email: OPERATOR,
      body: { slug: "tech", name: "Other technology" },
    }), 409, "state_conflict");
    expect(duplicate.error.message).toBe("A board with this slug already exists.");
    await expectError(await call("/v1/boards", {
      email: OPERATOR,
      body: { slug: "Tech", name: "Technology" },
    }), 422, "validation_failed");
    await expectError(await call("/v1/boards", {
      email: OPERATOR,
      body: { slug: "a".repeat(21), name: "Too long" },
    }), 422, "validation_failed");
    await expectError(await call("/v1/boards", {
      email: OPERATOR,
      body: { slug: "meta", name: "   " },
    }), 422, "validation_failed");
    await expectError(await call("/v1/boards", {
      email: OPERATOR,
      body: { slug: "meta", name: "bad\nname" },
    }), 422, "validation_failed");
    await expectError(await call("/v1/boards", {
      email: OPERATOR,
      body: { slug: "meta", name: "Meta", extra: true },
    }), 400, "malformed");

    const enrolled = await expectSuccess(await call("/v1/agents", {
      email: OPERATOR,
      body: { display_name: "Ada", declared_model: "fixture-model" },
    }), 201);
    await expectError(await call("/v1/boards", {
      bearer: String(enrolled.credential),
      body: { slug: "art", name: "Art" },
    }), 403, "forbidden");
    await expectError(await call("/v1/boards", {
      email: MODERATOR,
      body: { slug: "art", name: "Art" },
    }), 403, "forbidden");
    await expectError(await call("/v1/boards", {
      body: { slug: "art", name: "Art" },
    }), 401, "access_required");
    await expectError(await call("/v1/boards", {
      email: OPERATOR,
      sameOrigin: false,
      body: { slug: "games", name: "Games" },
    }), 403, "forbidden");

    const form = new URLSearchParams({ slug: "art", name: "Art & <games>" });
    const htmlAdd = await call("/boards", {
      method: "POST",
      email: OPERATOR,
      raw: new TextEncoder().encode(form.toString()),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(htmlAdd.status).toBe(201);
    expect(htmlAdd.headers.get("content-type")).toContain("text/html");
    const added = await htmlAdd.text();
    expect(added).toContain('href="/boards/art"');
    expect(added).toContain("Art &amp; &lt;games&gt; is open.");
    expect(added).not.toContain("<script");
    expect(await text("/boards/art")).toContain("<h1>Art &amp; &lt;games&gt;</h1>");

    const htmlDup = await call("/boards", {
      method: "POST",
      email: OPERATOR,
      raw: new TextEncoder().encode(new URLSearchParams({ slug: "art", name: "Again" }).toString()),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(htmlDup.status).toBe(409);
    expect(htmlDup.headers.get("content-type")).toContain("text/html");
    expect(await htmlDup.text()).toContain("A board with this slug already exists.");

    const htmlAnon = await call("/boards", {
      method: "POST",
      raw: new TextEncoder().encode(new URLSearchParams({ slug: "meta", name: "Meta" }).toString()),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(htmlAnon.status).toBe(401);
    expect(htmlAnon.headers.get("content-type")).toContain("text/html");
    expect(await htmlAnon.text()).not.toContain("\"error\"");

    const finalList = await expectSuccess(await call("/v1/boards", { bearer: String(enrolled.credential) }));
    const slugs = (finalList.items as Array<{ slug: string }>).map((item) => item.slug);
    expect(slugs).toEqual(["art", "beta", "tech"]);
  });
});

async function text(pathname: string, email?: string): Promise<string> {
  const response = await call(pathname, email === undefined ? {} : { email });
  expect(response.status).toBe(200);
  return response.text();
}

async function expectSuccess(response: Response, status = 200): Promise<Record<string, unknown>> {
  expect(response.status).toBe(status);
  const body = await response.json() as Record<string, unknown>;
  expect(body.error).toBeUndefined();
  return body;
}

async function expectError(
  response: Response,
  status: number,
  code: string,
): Promise<{ error: { code: string; message: string } }> {
  expect(response.status).toBe(status);
  const body = await response.json() as { error: { code: string; message: string } };
  expect(body.error.code).toBe(code);
  return body;
}
