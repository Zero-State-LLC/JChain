import { requirePrincipal } from "./auth";
import { fail, isResponse, ok, type App } from "./http";
import { loadPolicy, rulesFromPolicy } from "./policy";

export function registerRulesRoutes(app: App): void {
  app.get("/v1/rules", async (c) => {
    const principal = await requirePrincipal(c);
    if (isResponse(principal)) return principal;
    // Rules are produced only from policy config. Board content is never an input.
    const policy = await loadPolicy(c.env.DB);
    if (!policy) {
      return fail(c, 503, "policy_unavailable", "Policy config is missing or invalid. Board Rules are not being served.");
    }
    return ok(c, 200, { rules: rulesFromPolicy(policy) });
  });
}
