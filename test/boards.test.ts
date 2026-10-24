import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ADMIN, ADMIN2, BOARD_ID, OPERATOR, STAFF, UUID_V7, call, resetAndSeed } from "./harness";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(resetAndSeed);

describe("board catalog", () => {
  it("lists distinct topics and lets only an admin add a board", async () => {
    const anon = await call("/boards");
    expect(anon.status).toBe(200);
    expect(anon.headers.get("content-security-policy")).toBe(
      "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'none'; frame-ancestors 'none'",
    );
    const directory = await anon.text();
    expect(directory).toContain("<h1>Boards</h1>");
    expect(directory).toContain('<a href="/boards/beta">/beta/</a>');
    expect(directory).toContain("<td>JChain</td>");
    expect(directory).not.toContain('method="post"');
    expect(directory).not.toContain("<script");
    expect(directory).not.toContain("<style");
    expect(directory).not.toContain(" style=");

    const adminPage = await text("/boards", ADMIN);
    expect(adminPage).toContain('action="/boards"');
    expect(adminPage).toContain('for="slug"');
    expect(adminPage).toContain('for="name"');
    expect(adminPage).toContain(">Add board</button>");
    expect(await text("/boards", ADMIN2)).toContain(">Add board</button>");
    const operatorPage = await text("/boards", OPERATOR);
    expect(operatorPage).not.toContain('method="post"');
    expect(operatorPage).not.toContain("Add a board");
    expect(await text("/boards", STAFF)).not.toContain('method="post"');

    await expectError(await call("/v1/boards", {
      email: OPERATOR,
      body: { slug: "tech", name: "Technology" },
    }), 403, "forbidden");

    const created = await expectSuccess(await call("/v1/boards", {
      email: ADMIN,
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
    expect(home).toContain('href="/boards/beta"><span class="slug">/beta/</span><span class="name">JChain</span>');
    expect(home).toContain('href="/boards/tech"><span class="slug">/tech/</span><span class="name">Technology</span>');
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
    // AT-38: the exact CT-12 descriptions.
    expect(rules.prohibited).toEqual([
      {
        code: "id-document",
        description: "Images or text of a government or personal identity document, such as a passport, driver's licence, national ID card, or social security card, real or forged.",
      },
      {
        code: "csam",
        description: "Any sexual depiction of a minor, including drawn, edited, or AI-generated images.",
      },
    ]);

    const duplicate = await expectError(await call("/v1/boards", {
      email: ADMIN,
      body: { slug: "tech", name: "Other technology" },
    }), 409, "state_conflict");
    expect(duplicate.error.message).toBe("A board with this slug already exists.");
    await expectError(await call("/v1/boards", {
      email: ADMIN,
      body: { slug: "Tech", name: "Technology" },
    }), 422, "validation_failed");
    await expectError(await call("/v1/boards", {
      email: ADMIN,
      body: { slug: "a".repeat(21), name: "Too long" },
    }), 422, "validation_failed");
    await expectError(await call("/v1/boards", {
      email: ADMIN,
      body: { slug: "meta", name: "   " },
    }), 422, "validation_failed");
    await expectError(await call("/v1/boards", {
      email: ADMIN,
      body: { slug: "meta", name: "bad\nname" },
    }), 422, "validation_failed");
    await expectError(await call("/v1/boards", {
      email: ADMIN,
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
      email: STAFF,
      body: { slug: "art", name: "Art" },
    }), 403, "forbidden");
    await expectError(await call("/v1/boards", {
      email: "stranger@example.test",
      body: { slug: "art", name: "Art" },
    }), 403, "not_enrolled");
    await expectError(await call("/v1/boards", {
      body: { slug: "art", name: "Art" },
    }), 401, "access_required");
    await expectError(await call("/v1/boards", {
      email: ADMIN,
      sameOrigin: false,
      body: { slug: "games", name: "Games" },
    }), 403, "forbidden");

    const htmlRefused = await call("/boards", {
      method: "POST",
      email: OPERATOR,
      raw: new TextEncoder().encode(new URLSearchParams({ slug: "art", name: "Art" }).toString()),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(htmlRefused.status).toBe(403);
    expect(htmlRefused.headers.get("content-type")).toContain("text/html");

    const form = new URLSearchParams({ slug: "art", name: "Art & <games>" });
    const htmlAdd = await call("/boards", {
      method: "POST",
      email: ADMIN,
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
      email: ADMIN,
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

describe("admin-only boards (v0.2.21)", () => {
  it("audits each admin board write and drops the power when the seat is cleared", async () => {
    const created = await expectSuccess(await call("/v1/boards", {
      email: ADMIN2,
      body: { slug: "tech", name: "Technology" },
    }), 201);
    const patched = await call(`/v1/boards/${String(created.id)}`, {
      method: "PATCH",
      email: ADMIN,
      body: { description: "Wires." },
    });
    expect(patched.status).toBe(200);
    const audit = await env.DB.prepare(
      "SELECT actor_email, target_type, target_id, action FROM moderation_actions WHERE target_type = 'board' ORDER BY action",
    ).all<{ actor_email: string; target_type: string; target_id: string; action: string }>();
    expect(audit.results).toEqual([
      { actor_email: ADMIN2, target_type: "board", target_id: created.id, action: "create_board" },
      { actor_email: ADMIN, target_type: "board", target_id: created.id, action: "edit_board" },
    ]);

    await env.DB.prepare("UPDATE admin_seats SET email = NULL WHERE seat = 2").run();
    await expectError(await call("/v1/boards", {
      email: ADMIN2,
      body: { slug: "art", name: "Art" },
    }), 403, "forbidden");
    expect(await text("/boards", ADMIN2)).not.toContain('method="post"');

    await env.DB.prepare("DELETE FROM moderators WHERE email = ?").bind(ADMIN).run();
    await expectError(await call("/v1/boards", {
      email: ADMIN,
      body: { slug: "art", name: "Art" },
    }), 403, "not_enrolled");
  });

  it("has exactly two admin seats and refuses a third or a mixed-case email", async () => {
    const seats = await env.DB.prepare("SELECT seat FROM admin_seats ORDER BY seat").all<{ seat: number }>();
    expect(seats.results.map((row) => row.seat)).toEqual([1, 2]);
    await expect(env.DB.prepare("INSERT INTO admin_seats (seat, email) VALUES (3, NULL)").run()).rejects.toThrow();
    await expect(env.DB.prepare("UPDATE admin_seats SET email = 'Admin@Example.test' WHERE seat = 2").run())
      .rejects.toThrow();
    await expect(env.DB.prepare("UPDATE admin_seats SET email = ? WHERE seat = 2").bind(ADMIN).run())
      .rejects.toThrow();
  });
});

describe("starter boards (v0.2.21)", () => {
  const STARTER = [
    "absurd", "agents", "animals", "caps", "cursed", "found", "fried", "macros", "oc", "reaction", "remix", "wholesome",
  ];

  it("seeds the starter boards idempotently and never changes an existing board", async () => {
    await env.DB.prepare("UPDATE boards SET name = ?, description = ? WHERE id = ?")
      .bind("JChain", "Kept as is.", BOARD_ID).run();
    await env.DB.prepare("INSERT INTO boards (id, slug, name, description) VALUES (?, ?, ?, ?)")
      .bind("01900000-0000-7000-8000-0000000000c1", "found", "Local found", "Already here.").run();
    await applySeed();
    await applySeed();
    const rows = await env.DB.prepare("SELECT id, slug, name, description FROM boards ORDER BY slug")
      .all<{ id: string; slug: string; name: string; description: string }>();
    expect(rows.results.map((row) => row.slug)).toEqual([...STARTER, "beta"].sort());
    expect(rows.results.find((row) => row.slug === "beta")).toEqual({
      id: BOARD_ID, slug: "beta", name: "JChain", description: "Kept as is.",
    });
    expect(rows.results.find((row) => row.slug === "found")).toEqual({
      id: "01900000-0000-7000-8000-0000000000c1", slug: "found", name: "Local found", description: "Already here.",
    });
    for (const row of rows.results) {
      expect(row.slug).toMatch(/^[a-z][a-z0-9]{0,19}$/);
      expect(row.id).toMatch(UUID_V7);
      expect([...row.name].length).toBeGreaterThan(0);
      expect([...row.name].length).toBeLessThanOrEqual(60);
      expect([...row.description].length).toBeLessThanOrEqual(500);
      expect(row.description).not.toMatch(/[\u2013\u2014]/);
    }
    const seats = await env.DB.prepare("SELECT seat, email FROM admin_seats ORDER BY seat").all();
    expect(seats.results).toHaveLength(2);

    const listed = await expectSuccess(await call("/v1/boards", { email: OPERATOR }));
    expect((listed.items as Array<{ slug: string }>).map((item) => item.slug)).toEqual([...STARTER, "beta"].sort());
    const directory = await text("/boards");
    expect(directory).toContain('<a href="/boards/reaction">/reaction/</a>');
    expect(directory).toContain("<td>Reaction Images</td>");
  });
});

// Runs the starter-board migration's statements again. The migration has
// already run once in beforeAll, and resetAndSeed cleared its boards.
async function applySeed(): Promise<void> {
  const migrations = env.TEST_MIGRATIONS as Array<{ name: string; queries: string[] }>;
  const seed = migrations.find((migration) => migration.name.startsWith("0012_"));
  expect(seed).toBeDefined();
  for (const query of seed?.queries ?? []) {
    await env.DB.prepare(query).run();
  }
}

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
