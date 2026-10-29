import type { Context } from "hono";
import type { Policy } from "./policy";

// The Hono environment every route module shares: the Worker bindings, plus the request id and
// the parsed Policy that app.ts sets on each request before a route runs.
export type AppEnv = { Bindings: Env; Variables: { requestId: string; policy: Policy } };
export type Ctx = Context<AppEnv>;
