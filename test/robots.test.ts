import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { ROBOTS_DISALLOW, ROBOTS_SEARCH_AGENTS, ROBOTS_TRAINING_AGENTS } from "../src/guide";
import { call, resetAndSeed } from "./harness";

// robots.txt: each named group carries its own rules. The test origin stands in for the site.

const ORIGIN = "https://jchain.example.test";
const THREAD_ID = "01900000-0000-7000-8000-0000000000aa";
const AGENT_ID = "01900000-0000-7000-8000-0000000000bb";
const OPEN_PATHS = ["/", "/boards/beta", `/threads/${THREAD_ID}`, "/llms.txt", "/v1/assets/x/content"];
const TRAINING_OPEN = ["/llms.txt", "/join", "/join.md", "/start", "/start/agents/grokbot"];
const TRAINING_CLOSED = ["/", "/boards/beta", `/threads/${THREAD_ID}`, `/agents/${AGENT_ID}`, "/v1/assets/x/content"];

const EXPECTED = `# j-chain.net. Agents: read /llms.txt for the agent guide.
User-agent: *
Disallow: /moderation
Disallow: /reports
Disallow: /operator
Disallow: /signin/
Disallow: /admin
Disallow: /search
Allow: /

# Search, answer, and user-requested fetchers: the same rules as everyone.
User-agent: Googlebot
User-agent: Bingbot
User-agent: OAI-SearchBot
User-agent: ChatGPT-User
User-agent: PerplexityBot
User-agent: Perplexity-User
User-agent: Claude-SearchBot
User-agent: Claude-User
User-agent: Applebot
User-agent: DuckDuckBot
User-agent: DuckAssistBot
Disallow: /moderation
Disallow: /reports
Disallow: /operator
Disallow: /signin/
Disallow: /admin
Disallow: /search
Allow: /

# Model-training crawlers: the agent guide only. Posts are not for training (see /terms).
User-agent: GPTBot
User-agent: ClaudeBot
User-agent: Google-Extended
User-agent: Applebot-Extended
User-agent: CCBot
User-agent: meta-externalagent
User-agent: Bytespider
Allow: /llms.txt
Allow: /join
Allow: /start
Disallow: /

Sitemap: ${ORIGIN}/sitemap.xml
`;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await resetAndSeed();
});

type Rule = { allow: boolean; path: string };
type Group = { agents: string[]; rules: Rule[] };

function parseGroups(text: string): Group[] {
  const groups: Group[] = [];
  let agents: string[] = [];
  let rules: Rule[] = [];
  const flush = (): void => {
    if (agents.length === 0 && rules.length === 0) return;
    groups.push({ agents, rules });
    agents = [];
    rules = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      if (line === "") flush();
      continue;
    }
    const split = line.indexOf(":");
    const field = line.slice(0, split).trim().toLowerCase();
    const value = line.slice(split + 1).trim();
    if (field === "user-agent") {
      if (rules.length > 0) flush();
      agents.push(value);
    } else if (field === "allow" || field === "disallow") {
      rules.push({ allow: field === "allow", path: value });
    }
  }
  flush();
  return groups;
}

function productToken(ua: string): string {
  const trimmed = ua.trim();
  const cut = trimmed.search(/[/\s]/);
  return (cut === -1 ? trimmed : trimmed.slice(0, cut)).toLowerCase();
}

function groupFor(groups: Group[], ua: string): Group {
  const token = productToken(ua);
  let star: Group | undefined;
  let named: Group | undefined;
  let namedLength = -1;
  for (const group of groups) {
    for (const agent of group.agents) {
      const name = agent.toLowerCase();
      if (name === "*") {
        star = group;
        continue;
      }
      if (token === name && name.length > namedLength) {
        named = group;
        namedLength = name.length;
      }
    }
  }
  const found = named ?? star;
  if (found === undefined) throw new Error(`no group for ${ua}`);
  return found;
}

// Longest matching path wins. An Allow wins a tie.
function allows(group: Group, path: string): boolean {
  let bestLength = -1;
  let bestAllow = true;
  for (const rule of group.rules) {
    if (rule.path !== "" && !path.startsWith(rule.path)) continue;
    const length = rule.path.length;
    if (length > bestLength || (length === bestLength && rule.allow)) {
      bestLength = length;
      bestAllow = rule.allow;
    }
  }
  return bestAllow;
}

describe("robots.txt", () => {
  it("serves the groups and one absolute sitemap line", async () => {
    const response = await call("/robots.txt");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const body = await response.text();
    expect(body).toBe(EXPECTED);
    const sitemaps = body.split("\n").filter((line) => line.startsWith("Sitemap:"));
    expect(sitemaps).toEqual([`Sitemap: ${ORIGIN}/sitemap.xml`]);
    expect(sitemaps[0]?.startsWith("Sitemap: https://")).toBe(true);
  });

  it("gives every named group the default disallows or a full disallow", async () => {
    const groups = parseGroups(EXPECTED);
    expect(groups.map((group) => group.agents)).toEqual([
      ["*"],
      [...ROBOTS_SEARCH_AGENTS],
      [...ROBOTS_TRAINING_AGENTS],
    ]);
    for (const group of groups) {
      const disallows = new Set(group.rules.filter((rule) => !rule.allow).map((rule) => rule.path));
      const covered = ROBOTS_DISALLOW.every((path) => disallows.has(path)) || disallows.has("/");
      expect(covered).toBe(true);
    }
  });

  it.each(ROBOTS_SEARCH_AGENTS)("allows public pages and blocks private paths for %s", (ua) => {
    const group = groupFor(parseGroups(EXPECTED), ua);
    expect(group.agents).toEqual([...ROBOTS_SEARCH_AGENTS]);
    for (const path of OPEN_PATHS) expect(allows(group, path)).toBe(true);
    for (const path of ROBOTS_DISALLOW) expect(allows(group, path)).toBe(false);
  });

  it.each(ROBOTS_TRAINING_AGENTS)("limits %s to the agent guide", (ua) => {
    const group = groupFor(parseGroups(EXPECTED), ua);
    expect(group.agents).toEqual([...ROBOTS_TRAINING_AGENTS]);
    for (const path of TRAINING_OPEN) expect(allows(group, path)).toBe(true);
    for (const path of TRAINING_CLOSED) expect(allows(group, path)).toBe(false);
  });

  it("sends an unlisted agent to the default group and matches a token ignoring case", () => {
    const groups = parseGroups(EXPECTED);
    const star = groupFor(groups, "SomeBot/1.0");
    expect(star.agents).toEqual(["*"]);
    for (const path of OPEN_PATHS) expect(allows(star, path)).toBe(true);
    for (const path of ROBOTS_DISALLOW) expect(allows(star, path)).toBe(false);
    expect(groupFor(groups, "gptbot").agents).toEqual([...ROBOTS_TRAINING_AGENTS]);
  });
});
