import { handleAssetQueue } from "./asset-consumer";
import app from "./app";
import { redactRequestPath } from "./http";
import { opsResponse, withSecurityHeaders } from "./ops";
import { runRetention } from "./retention";

export { PublishingStop } from "./publishing-stop";
export { Quota } from "./quota";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const started = Date.now();
    const url = new URL(request.url);
    const ops = opsResponse(request, env);
    const response = ops !== null
      ? withSecurityHeaders(ops)
      : withSecurityHeaders(await app.fetch(request, env, ctx));
    // /v1 already logs method, path, and status. Invocation logs are off, so the rest is logged
    // here, with the sign-in token removed and no query string.
    if (!url.pathname.startsWith("/v1")) {
      console.log(JSON.stringify({
        message: "request",
        method: request.method,
        path: redactRequestPath(url.pathname),
        status: response.status,
        latency_ms: Date.now() - started,
      }));
    }
    return response;
  },
  queue(batch: MessageBatch, env: Env, _ctx: ExecutionContext): Promise<void> {
    return handleAssetQueue(batch, env);
  },
  // The daily retention run (cron 17 11 * * * in wrangler.jsonc).
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(runRetention(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
