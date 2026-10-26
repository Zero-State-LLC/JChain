import { defineConfig } from "vitest/config";

// Plain Node tests. This file stops vitest from picking up the Worker config at the repo root.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
