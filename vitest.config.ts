import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      // The client packages under clients/ run their own Node test suites.
      exclude: [...configDefaults.exclude, "clients/**"],
      setupFiles: ["./test/apply-migrations.ts"],
      fileParallelism: false,
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  };
});
