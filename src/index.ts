import { Hono } from "hono";
import openapi from "../openapi/openapi.yaml";
import { registerAgentRoutes } from "./agents";
import { registerBoardRoutes } from "./boards";
import { fail, newRequestId, resolveRequestId, type AppEnv } from "./http";
import { loadPolicy } from "./policy";
import { registerRulesRoutes } from "./rules";

const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  const requestId = resolveRequestId(c.req.header("X-Request-Id"));
  c.set("requestId", requestId);
  await next();
  c.res.headers.set("X-Request-Id", requestId);
  c.res.headers.set("Cache-Control", "no-store");
  console.log(
    JSON.stringify({
      request_id: requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
    }),
  );
});

app.use("/v1/*", async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") {
    await next();
    return;
  }
  const policy = await loadPolicy(c.env.DB);
  if (!policy) {
    return fail(
      c,
      503,
      "policy_unavailable",
      "Policy config is missing or invalid. The service is refusing writes.",
    );
  }
  await next();
});

app.get("/openapi.yaml", (c) => {
  return c.text(openapi, 200, {
    "Content-Type": "application/yaml; charset=utf-8",
    "X-Request-Id": c.get("requestId"),
    "Cache-Control": "no-store",
  });
});

registerRulesRoutes(app);
registerBoardRoutes(app);
registerAgentRoutes(app);

app.notFound((c) => fail(c, 404, "not_found", "Resource not found."));

app.onError((err, c) => {
  let requestId = newRequestId();
  try {
    const existing = c.get("requestId");
    if (existing) requestId = existing;
  } catch {
    requestId = newRequestId();
  }
  console.error(
    JSON.stringify({
      event: "unhandled_error",
      request_id: requestId,
      message: err instanceof Error ? err.message : "unknown",
    }),
  );
  return c.json(
    {
      request_id: requestId,
      error: { code: "internal_error", message: "The service could not complete the request." },
    },
    500,
    { "X-Request-Id": requestId, "Cache-Control": "no-store" },
  );
});

export default app;
