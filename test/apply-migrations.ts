import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Official D1 recipe: setup may run more than once. Applying pending
// migrations is idempotent. Tests also apply them per file so isolation
// cannot boot a database without the schema.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
