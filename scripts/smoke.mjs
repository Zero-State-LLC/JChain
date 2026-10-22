// Read-only smoke check for a deployed JChain Worker.
// Usage: node scripts/smoke.mjs <baseUrl>
// Sends no credentials, no writes, and no uploads.

const HSTS = "max-age=31536000";

export async function runSmoke(baseUrl, fetchImpl = fetch) {
  const base = String(baseUrl).replace(/\/+$/, "");
  const lines = [];
  let ok = true;

  function record(pass, name, detail) {
    if (!pass) ok = false;
    lines.push(`${pass ? "ok" : "FAIL"} ${name} ${detail}`);
  }

  async function get(path, accept) {
    try {
      return await fetchImpl(`${base}${path}`, { method: "GET", headers: { accept }, redirect: "manual" });
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function readJson(response) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  function checkHeaders(name, response, html) {
    const hsts = response.headers.get("strict-transport-security");
    const nosniff = response.headers.get("x-content-type-options");
    record(hsts === HSTS, `${name}-hsts`, `strict-transport-security=${hsts ?? "missing"}`);
    record((nosniff ?? "").toLowerCase() === "nosniff", `${name}-nosniff`, `x-content-type-options=${nosniff ?? "missing"}`);
    if (html) {
      const csp = response.headers.get("content-security-policy");
      const frame = response.headers.get("x-frame-options");
      record(csp !== null && csp.includes("frame-ancestors 'none'"), `${name}-csp`, `content-security-policy=${csp ?? "missing"}`);
      record((frame ?? "").toUpperCase() === "DENY", `${name}-frame`, `x-frame-options=${frame ?? "missing"}`);
    }
  }

  function unreachable(name, response) {
    if (response instanceof Response || typeof response?.status === "number") return false;
    record(false, name, `request failed: ${response?.error ?? "unknown"}`);
    return true;
  }

  const health = await get("/health", "application/json");
  if (!unreachable("health", health)) {
    const body = await readJson(health);
    record(health.status === 200 && body?.ok === true, "health", `status=${health.status} ok=${String(body?.ok)}`);
    checkHeaders("health", health, false);
  }

  const version = await get("/version", "application/json");
  if (!unreachable("version", version)) {
    const body = await readJson(version);
    const pass = version.status === 200 && typeof body?.spec === "string" && typeof body?.build === "string";
    record(pass, "version", `status=${version.status} spec=${String(body?.spec)} build=${String(body?.build)}`);
    checkHeaders("version", version, false);
  }

  const unauthenticated = [
    ["openapi", "/v1/openapi.json"],
    ["rules", "/v1/boards/00000000-0000-7000-8000-000000000000/rules"],
  ];
  for (const [name, path] of unauthenticated) {
    const response = await get(path, "application/json");
    if (unreachable(name, response)) continue;
    record(response.status === 401, name, `status=${response.status} expected=401`);
    checkHeaders(name, response, false);
  }

  const pages = [
    ["home", "/"],
    ["boards", "/boards"],
    ["start", "/start"],
    ["signin", "/signin"],
  ];
  for (const [name, path] of pages) {
    const response = await get(path, "text/html");
    if (unreachable(name, response)) continue;
    const type = response.headers.get("content-type") ?? "";
    record(response.status === 200 && type.includes("text/html"), name, `status=${response.status} content-type=${type || "missing"}`);
    checkHeaders(name, response, true);
  }

  const guide = await get("/llms.txt", "text/markdown");
  if (!unreachable("llms", guide)) {
    const type = guide.headers.get("content-type") ?? "";
    let text = "";
    try {
      text = await guide.text();
    } catch {
      text = "";
    }
    record(
      guide.status === 200 && type.includes("text/markdown") && text.startsWith("# j-chain.net"),
      "llms",
      `status=${guide.status} content-type=${type || "missing"}`,
    );
    checkHeaders("llms", guide, false);
  }

  return { ok, lines };
}

async function main(argv) {
  const baseUrl = argv[2];
  if (typeof baseUrl !== "string" || !/^https?:\/\/\S+$/.test(baseUrl)) {
    console.error("usage: node scripts/smoke.mjs <baseUrl>");
    return 2;
  }
  const result = await runSmoke(baseUrl);
  for (const line of result.lines) console.log(line);
  return result.ok ? 0 : 1;
}

async function invokedDirectly() {
  if (typeof process === "undefined" || !Array.isArray(process.argv)) return false;
  const script = process.argv[1];
  if (typeof script !== "string" || script === "") return false;
  try {
    const { pathToFileURL } = await import("node:url");
    return import.meta.url === pathToFileURL(script).href;
  } catch {
    return false;
  }
}

if (await invokedDirectly()) {
  main(process.argv).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`FAIL smoke ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
