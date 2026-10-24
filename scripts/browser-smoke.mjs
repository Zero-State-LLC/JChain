// Real-browser smoke and accessibility check for a deployed JChain Worker.
//
//   node scripts/browser-smoke.mjs <baseUrl> [--out browser-smoke.json]
//   node scripts/browser-smoke.mjs --annotate browser-smoke.json
//
// Playwright and axe-core are not repository dependencies (CI runs `npm ci` against the lockfile).
// The workflow installs them in a separate directory and passes it as BROWSER_DEPS_DIR (or
// `--deps <dir>`); this script loads them from there with createRequire.
//
// Read-only: it discovers a Board, a Thread, and an Agent through public GET pages, then loads
// each human page in headless Chromium at a phone and a desktop viewport. It never clicks,
// submits a form, signs in, or writes anything.
//
// Each page and viewport loads twice:
// 1. A strict context that keeps the page CSP. It checks the HTTP status, console errors and
//    `securitypolicyviolation` events, stylesheets, the body background, images after scrolling
//    to the bottom, and horizontal overflow.
// 2. An audit context with Playwright's `bypassCSP: true`, so axe-core can be injected with
//    `page.addScriptTag({ content })` into pages served with `script-src 'none'`. Bypassing the
//    CSP would hide violations, which is why the CSP checks run in the strict context only.
//
// One `ok` or `FAIL` line per page and viewport; a JSON summary (`--out`); exit 1 on any FAIL.

import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_FILE = path.join(HERE, "..", "public", "brand", "tokens-v2.css");

export const VIEWPORTS = [
  { name: "375x812", width: 375, height: 812 },
  { name: "1280x800", width: 1280, height: 800 },
];

const BLOCKING_IMPACTS = new Set(["critical", "serious"]);

// Confirmed axe false positives only, each narrowed to one rule id and one exact selector, with
// the reason. Keep this empty unless a finding is checked by hand and is not a real page issue.
// Example: { id: "color-contrast", selector: ".card-media > img", reason: "..." }
export const AXE_ALLOWLIST = [];

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

// ---------------------------------------------------------------------------------------------
// Pure helpers (no browser).

export function voidColor(css) {
  const match = /--color-void\s*:\s*#([0-9a-fA-F]{6})\b/.exec(css);
  if (!match) return null;
  const hex = match[1];
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

function unique(values) {
  return [...new Set(values)];
}

export function boardSlugs(html) {
  return unique([...html.matchAll(/href="\/boards\/([a-z][a-z0-9]{0,19})"/g)].map((m) => m[1]));
}

export function threadIds(html) {
  return unique([...html.matchAll(new RegExp(`href="/threads/(${UUID})"`, "g"))].map((m) => m[1]));
}

export function agentIds(html) {
  return unique([...html.matchAll(new RegExp(`href="/agents/(${UUID})"`, "g"))].map((m) => m[1]));
}

function decodeEntities(text) {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

export function firstHeading(html) {
  const match = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
  if (!match) return "";
  return decodeEntities(match[1].replace(/<[^>]*>/g, "")).trim();
}

// The longest word of letters or digits in the title (at least 3 characters when one exists).
export function searchTerm(title) {
  const words = title.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return "";
  return words.reduce((best, word) => (word.length > best.length ? word : best), words[0]);
}

export function pageList(targets) {
  const pages = [
    { name: "home", path: "/" },
    { name: "boards", path: "/boards" },
  ];
  if (targets.board) {
    pages.push({ name: "board-new", path: `/boards/${targets.board}?sort=new` });
    pages.push({ name: "board-active", path: `/boards/${targets.board}?sort=active` });
  }
  if (targets.thread) pages.push({ name: "thread", path: `/threads/${targets.thread}` });
  if (targets.agent) pages.push({ name: "agent", path: `/agents/${targets.agent}` });
  pages.push({ name: "trending", path: "/trending" });
  if (targets.searchTerm) pages.push({ name: "search", path: `/search?q=${encodeURIComponent(targets.searchTerm)}` });
  pages.push(
    { name: "start", path: "/start" },
    { name: "signin", path: "/signin" },
    { name: "terms", path: "/terms" },
    { name: "privacy", path: "/privacy" },
    { name: "acceptable-use", path: "/acceptable-use" },
    { name: "rules", path: "/rules" },
  );
  return pages;
}

function allowlisted(id, target) {
  return AXE_ALLOWLIST.some((entry) => entry.id === id && entry.selector === target);
}

// Keeps critical and serious violations, one entry per node, minus allowlisted nodes.
export function blockingViolations(violations) {
  const out = [];
  for (const violation of violations) {
    for (const node of violation.nodes ?? []) {
      const impact = node.impact ?? violation.impact ?? "unknown";
      if (!BLOCKING_IMPACTS.has(impact)) continue;
      const target = (node.target ?? []).map((part) => (Array.isArray(part) ? part.join(" >>> ") : String(part))).join(" ");
      if (allowlisted(violation.id, target)) continue;
      out.push({ id: violation.id, impact, target, help: violation.help, helpUrl: violation.helpUrl });
    }
  }
  return out;
}

// Groups the same problem across pages and viewports, so annotations stay few and readable.
export function findings(results, discoveryErrors) {
  const byKey = new Map();
  const add = (key, message, where) => {
    const entry = byKey.get(key) ?? { message, where: [] };
    if (where !== null && !entry.where.includes(where)) entry.where.push(where);
    byKey.set(key, entry);
  };
  for (const error of discoveryErrors) add(`discover ${error}`, `discover: ${error}`, null);
  for (const result of results) {
    const where = `${result.page}@${result.viewport}`;
    for (const reason of result.reasons) add(reason, reason, where);
    for (const v of result.axe) {
      add(`axe ${v.id} ${v.target}`, `axe ${v.id} (${v.impact}) at ${v.target}: ${v.help} ${v.helpUrl}`, where);
    }
  }
  return [...byKey.values()];
}

function escapeData(text) {
  return String(text).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeProperty(text) {
  return escapeData(text).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

// GitHub keeps 10 error annotations per step, so the first nine findings get their own and the
// tenth says how many more there are; the notice carries the whole summary.
export function annotations(summary) {
  const lines = [];
  const list = summary.findings ?? [];
  const shown = list.slice(0, 9);
  for (const finding of shown) {
    const where = finding.where.length === 0 ? "" : ` [${finding.where.join(", ")}]`;
    lines.push(`::error title=${escapeProperty("Browser smoke")}::${escapeData(`${finding.message}${where}`)}`);
  }
  if (list.length > shown.length) {
    lines.push(`::error title=${escapeProperty("Browser smoke")}::${escapeData(`${list.length - shown.length} more findings; see the Browser smoke summary notice`)}`);
  }
  const compact = {
    ok: summary.ok,
    base: summary.base,
    targets: summary.targets,
    versions: summary.versions,
    checked: (summary.results ?? []).length,
    failed: (summary.results ?? []).filter((r) => !r.ok).map((r) => `${r.page}@${r.viewport}`),
    findings: list.map((f) => ({ message: f.message, where: f.where })),
  };
  let text = JSON.stringify(compact);
  if (text.length > 60000) text = `${text.slice(0, 60000)}... (truncated; the full summary is the browser-smoke artifact)`;
  lines.push(`::notice title=${escapeProperty("Browser smoke summary")}::${escapeData(text)}`);
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Discovery through public GET pages.

async function getHtml(base, pathname) {
  const response = await fetch(`${base}${pathname}`, {
    method: "GET",
    headers: { accept: "text/html", "user-agent": "jchain-browser-smoke" },
  });
  const text = await response.text();
  if (response.status !== 200) throw new Error(`GET ${pathname} returned ${response.status}`);
  return text;
}

export async function discover(base) {
  const targets = { board: null, thread: null, agent: null, threadTitle: null, searchTerm: null };
  const errors = [];
  try {
    const slugs = boardSlugs(await getHtml(base, "/boards"));
    if (slugs.length === 0) errors.push("no board link on /boards");
    for (const slug of slugs) {
      targets.board ??= slug;
      const threads = threadIds(await getHtml(base, `/boards/${slug}`));
      if (threads.length > 0) {
        targets.board = slug;
        targets.thread = threads[0];
        break;
      }
    }
    if (slugs.length > 0 && targets.thread === null) errors.push("no thread link on any board page");
    if (targets.thread !== null) {
      const html = await getHtml(base, `/threads/${targets.thread}`);
      targets.threadTitle = firstHeading(html);
      targets.searchTerm = searchTerm(targets.threadTitle) || null;
      if (targets.searchTerm === null) errors.push("thread title has no word to search for");
      const agents = agentIds(html);
      if (agents.length > 0) targets.agent = agents[0];
      else errors.push(`no agent link on /threads/${targets.thread}`);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return { targets, errors };
}

// ---------------------------------------------------------------------------------------------
// Browser checks.

function loadDeps(dir) {
  if (typeof dir !== "string" || dir === "") {
    throw new Error("set BROWSER_DEPS_DIR (or --deps) to the directory where playwright and axe-core are installed");
  }
  const root = path.resolve(dir);
  const require = createRequire(path.join(root, "package.json"));
  const { chromium } = require("playwright");
  const axeFile = require.resolve("axe-core/axe.min.js");
  const version = (name) => {
    try {
      return JSON.parse(readFileSync(path.join(root, "node_modules", name, "package.json"), "utf8")).version;
    } catch {
      return "unknown";
    }
  };
  return {
    chromium,
    axeSource: readFileSync(axeFile, "utf8"),
    versions: { playwright: version("playwright"), "axe-core": version("axe-core") },
  };
}

const CSP_RECORDER = `
  window.__jchainCsp = [];
  document.addEventListener("securitypolicyviolation", (event) => {
    window.__jchainCsp.push({
      directive: event.effectiveDirective || event.violatedDirective,
      blocked: event.blockedURI,
      source: event.sourceFile,
      line: event.lineNumber,
    });
  });
`;

function shortUrl(base, url) {
  return url.startsWith(base) ? url.slice(base.length) || "/" : url;
}

async function strictChecks(context, base, target, expectedBackground) {
  const reasons = new Set();
  // Paths whose request failed or returned an error status, so one broken file is one reason.
  const broken = new Set();
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    // Chromium logs every failed resource and every CSP violation to the console as well. The
    // response and requestfailed listeners and the CSP event recorder report those precisely.
    if (text.startsWith("Failed to load resource") || text.includes("Content Security Policy")) return;
    const source = message.location()?.url ? shortUrl(base, message.location().url) : "";
    const where = source !== "" && source !== target.path ? ` (${source})` : "";
    reasons.add(`console error: ${text.slice(0, 300)}${where}`);
  });
  page.on("pageerror", (error) => reasons.add(`page error: ${String(error?.message ?? error).slice(0, 300)}`));
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "failed";
    if (failure.includes("ERR_ABORTED")) return;
    broken.add(shortUrl(base, request.url()));
    reasons.add(`request failed: ${request.resourceType()} ${shortUrl(base, request.url())} ${failure}`);
  });
  page.on("response", (response) => {
    const request = response.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) return;
    if (response.status() >= 400) {
      broken.add(shortUrl(base, response.url()));
      reasons.add(`${request.resourceType()} ${shortUrl(base, response.url())} returned ${response.status()}`);
    }
  });
  try {
    const response = await page.goto(`${base}${target.path}`, { waitUntil: "load", timeout: 30000 });
    const status = response?.status() ?? 0;
    if (status !== 200) {
      reasons.add(`status ${status}`);
      return [...reasons];
    }

    // Scroll to the bottom in steps so lazy images load, then wait for them to settle.
    await page.evaluate(async () => {
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
      for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await pause(120);
      }
      window.scrollTo(0, document.documentElement.scrollHeight);
      await pause(300);
    });
    await page.evaluate(async () => {
      const pending = [...document.images].filter((img) => !img.complete);
      await Promise.race([
        Promise.all(pending.map((img) => new Promise((resolve) => {
          img.addEventListener("load", resolve, { once: true });
          img.addEventListener("error", resolve, { once: true });
        }))),
        new Promise((resolve) => setTimeout(resolve, 10000)),
      ]);
    });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => undefined);

    const state = await page.evaluate(() => {
      const links = [...document.querySelectorAll('link[rel="stylesheet"]')];
      const sheets = links.map((link) => {
        let readable = false;
        try {
          readable = link.sheet !== null && link.sheet.cssRules.length > 0;
        } catch {
          readable = false;
        }
        return { href: link.getAttribute("href"), readable };
      });
      const images = [...document.images]
        .filter((img) => img.getClientRects().length > 0)
        .map((img) => ({ src: img.getAttribute("src"), complete: img.complete, width: img.naturalWidth }));
      return {
        styleSheets: document.styleSheets.length,
        sheets,
        background: getComputedStyle(document.body).backgroundColor,
        images,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        csp: Array.isArray(window.__jchainCsp) ? window.__jchainCsp : null,
      };
    });

    if (state.csp === null) reasons.add("CSP recorder did not run");
    for (const v of state.csp ?? []) {
      const source = v.source ? shortUrl(base, v.source) : "";
      const from = source === "" ? "" : source === target.path ? ` at line ${v.line}` : ` from ${source}:${v.line}`;
      reasons.add(`CSP violation: ${v.directive} blocked ${v.blocked || "inline"}${from}`);
    }
    if (state.styleSheets === 0) reasons.add("no stylesheets applied");
    for (const sheet of state.sheets) {
      if (!sheet.readable && !broken.has(sheet.href)) reasons.add(`stylesheet ${sheet.href} did not load`);
    }
    if (expectedBackground !== null && state.background !== expectedBackground) {
      reasons.add(`body background ${state.background}, expected the void ${expectedBackground}`);
    }
    for (const img of state.images) {
      if ((!img.complete || img.width === 0) && !broken.has(img.src)) reasons.add(`image ${img.src} did not load`);
    }
    if (state.scrollWidth > state.innerWidth + 1) {
      reasons.add(`horizontal overflow: scrollWidth ${state.scrollWidth} > innerWidth ${state.innerWidth}`);
    }
  } catch (error) {
    reasons.add(`strict load error: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  } finally {
    await page.close().catch(() => undefined);
  }
  return [...reasons];
}

async function axeChecks(context, base, target, axeSource) {
  const page = await context.newPage();
  try {
    const response = await page.goto(`${base}${target.path}`, { waitUntil: "load", timeout: 30000 });
    if ((response?.status() ?? 0) !== 200) return { error: `audit load status ${response?.status() ?? 0}`, violations: [] };
    await page.addScriptTag({ content: axeSource });
    const injected = await page.evaluate(() => typeof window.axe?.run === "function");
    if (!injected) return { error: "axe-core injection failed (bypassCSP did not allow the script)", violations: [] };
    const result = await page.evaluate(async () => {
      const run = await window.axe.run(document, { resultTypes: ["violations"] });
      return run.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        helpUrl: v.helpUrl,
        nodes: v.nodes.map((n) => ({ impact: n.impact, target: n.target })),
      }));
    });
    return { error: null, violations: blockingViolations(result) };
  } catch (error) {
    return { error: `axe error: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`, violations: [] };
  } finally {
    await page.close().catch(() => undefined);
  }
}

export async function runBrowserSmoke(baseUrl, depsDir) {
  const base = String(baseUrl).replace(/\/+$/, "");
  const deps = loadDeps(depsDir);
  const expectedBackground = voidColor(readFileSync(TOKENS_FILE, "utf8"));
  const startedAt = new Date().toISOString();
  const { targets, errors } = await discover(base);
  if (expectedBackground === null) errors.push("could not read --color-void from tokens-v2.css");
  const pages = pageList(targets);
  const results = [];
  const lines = [];
  for (const error of errors) lines.push(`FAIL discover ${error}`);

  const browser = await deps.chromium.launch();
  try {
    for (const viewport of VIEWPORTS) {
      const size = { width: viewport.width, height: viewport.height };
      const strict = await browser.newContext({ viewport: size });
      await strict.addInitScript({ content: CSP_RECORDER });
      const audit = await browser.newContext({ viewport: size, bypassCSP: true });
      try {
        for (const target of pages) {
          const reasons = await strictChecks(strict, base, target, expectedBackground);
          const audited = await axeChecks(audit, base, target, deps.axeSource);
          if (audited.error !== null) reasons.push(audited.error);
          const ok = reasons.length === 0 && audited.violations.length === 0;
          results.push({ page: target.name, path: target.path, viewport: viewport.name, ok, reasons, axe: audited.violations });
          const why = [
            ...reasons,
            ...audited.violations.map((v) => `axe ${v.id} (${v.impact}) ${v.target} ${v.helpUrl}`),
          ];
          lines.push(ok ? `ok ${target.name} ${viewport.name}` : `FAIL ${target.name} ${viewport.name} ${why.join("; ")}`);
        }
      } finally {
        await strict.close().catch(() => undefined);
        await audit.close().catch(() => undefined);
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  const summary = {
    ok: errors.length === 0 && results.every((r) => r.ok),
    base,
    startedAt,
    finishedAt: new Date().toISOString(),
    versions: deps.versions,
    targets,
    viewports: VIEWPORTS.map((v) => v.name),
    pages: pages.map((p) => p.path),
    discoveryErrors: errors,
    results,
    findings: findings(results, errors),
  };
  return { summary, lines };
}

// ---------------------------------------------------------------------------------------------
// CLI.

function option(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

async function main(argv) {
  const args = argv.slice(2);
  const annotateFile = option(args, "--annotate");
  if (annotateFile !== undefined) {
    if (!existsSync(annotateFile)) {
      console.log(`::error title=Browser smoke::no summary at ${escapeData(annotateFile)}; the run did not finish (see the job log)`);
      return 0;
    }
    const summary = JSON.parse(readFileSync(annotateFile, "utf8"));
    for (const line of annotations(summary)) console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const rows = (summary.results ?? []).map((r) => `| ${r.page} | ${r.viewport} | ${r.ok ? "ok" : "FAIL"} |`);
      const found = (summary.findings ?? []).map((f) => `- ${f.message}${f.where.length ? ` (${f.where.join(", ")})` : ""}`);
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
        "## Browser smoke", "", `Base ${summary.base}, ok: ${summary.ok}`, "",
        "| Page | Viewport | Result |", "|---|---|---|", ...rows, "", ...found, "",
      ].join("\n"));
    }
    return 0;
  }
  const baseUrl = args.find((arg, i) => !arg.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--")));
  if (typeof baseUrl !== "string" || !/^https?:\/\/\S+$/.test(baseUrl)) {
    console.error("usage: node scripts/browser-smoke.mjs <baseUrl> [--out file.json] [--deps dir]");
    return 2;
  }
  const out = option(args, "--out") ?? "browser-smoke.json";
  const deps = option(args, "--deps") ?? process.env.BROWSER_DEPS_DIR;
  const { summary, lines } = await runBrowserSmoke(baseUrl, deps);
  for (const line of lines) console.log(line);
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`summary written to ${out}`);
  return summary.ok ? 0 : 1;
}

function invokedDirectly() {
  const script = process.argv[1];
  if (typeof script !== "string" || script === "") return false;
  return import.meta.url === pathToFileURL(path.resolve(script)).href;
}

if (invokedDirectly()) {
  main(process.argv).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`FAIL browser-smoke ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
