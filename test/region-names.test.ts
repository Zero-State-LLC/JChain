import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FRAMEWORKS } from "../src/agent-setup";
import { renderMarkdown } from "../src/markdown";
import { ADMIN, call, resetAndSeed } from "./harness";

// Accessibility (second independent review): every scrolling region has its own name, so a
// screen reader's landmark list can tell them apart (axe landmark-unique), and the setup prompt
// box, which scrolls, is a focusable region named by its heading.

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetAndSeed();
});

function regionNames(html: string): string[] {
  const names: string[] = [];
  for (const match of html.matchAll(/<[a-z]+ [^>]*role="region"[^>]*>/g)) {
    const tag = match[0];
    const label = /aria-label="([^"]*)"/.exec(tag)?.[1];
    const labelledBy = /aria-labelledby="([^"]*)"/.exec(tag)?.[1];
    names.push(label ?? `#${labelledBy ?? ""}`);
  }
  return names;
}

describe("scroll regions have distinct names", () => {
  it("names each table on the admin page after what it holds", async () => {
    const html = await (await call("/admin", { email: ADMIN })).text();
    const names = regionNames(html);
    for (const name of ["Boards table", "Bindings table", "Content Scan results table", "Content Scan latency table", "Operators table"]) {
      expect(names).toContain(name);
    }
    expect(new Set(names).size).toBe(names.length);
    expect(html).not.toContain("Scrollable table");
  });

  it("names the boards directory and a legal document's table", async () => {
    const boards = await (await call("/boards")).text();
    expect(regionNames(boards)).toContain("Boards directory table");
    const privacy = await (await call("/privacy")).text();
    expect(regionNames(privacy)).toContain("What we collect");
    for (const html of [boards, privacy]) {
      const names = regionNames(html);
      expect(new Set(names).size).toBe(names.length);
      expect(html).not.toContain("Scrollable table");
    }
  });

  it("names a document's tables after the heading above them, else the first header, never twice", () => {
    const html = renderMarkdown([
      "| Lead | Value |", "|---|---|", "| a | 1 |", "",
      "## Fees **now**", "", "| Item | Cost |", "|---|---|", "| x | 2 |", "",
      "| Item | Cost |", "|---|---|", "| y | 3 |",
    ].join("\n"));
    expect(regionNames(html)).toEqual(["Lead table", "Fees now", "Fees now 2"]);
  });
});

describe("the setup prompt box", () => {
  it("is a focusable region named by its heading on every framework", async () => {
    for (const framework of FRAMEWORKS) {
      const html = await (await call(`/start/agents/${framework}`)).text();
      expect(html, framework).toContain('<pre class="prompt" tabindex="0" role="region" aria-labelledby="prompt-title">');
      expect(html, framework).toContain('<h2 id="prompt-title">');
      const names = regionNames(html);
      expect(new Set(names).size, framework).toBe(names.length);
    }
  });
});
