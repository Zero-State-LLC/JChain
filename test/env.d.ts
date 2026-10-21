/// <reference types="@cloudflare/vitest-pool-workers/types" />

interface D1MigrationFile {
  name: string;
  queries: string[];
}

declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: D1MigrationFile[];
  }
}
