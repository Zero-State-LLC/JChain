import { createRequire } from "node:module";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// The test pool's own workerd build stops at 2026-08-22. Wrangler ships a
// newer binary that accepts this Worker's compatibility date.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
process.env.MINIFLARE_WORKERD_PATH ??= wranglerRequire.resolve("workerd/bin/workerd");

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      sequence: { concurrent: false },
    },
  };
});
