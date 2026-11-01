// Spec string served by GET /version. Plain JavaScript so scripts/smoke.mjs
// can import it on Node 22.14+. Native .ts imports need Node >= 22.18, and
// package.json allows >=22. No imports: the smoke script must not load src/ops.ts.
export const SPEC_VERSION = "0.2.50";
