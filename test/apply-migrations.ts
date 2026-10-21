import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Setup can run outside a test file's storage. Applying again in the test
// file is safe: only migrations that are not recorded are run.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
