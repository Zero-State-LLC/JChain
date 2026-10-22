import { handleAssetQueue } from "./asset-consumer";
import app from "./app";
import { runRetention } from "./retention";

export { PublishingStop } from "./publishing-stop";
export { Quota } from "./quota";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },
  queue(batch: MessageBatch, env: Env, _ctx: ExecutionContext): Promise<void> {
    return handleAssetQueue(batch, env);
  },
  // Inert until a cron trigger is configured for this Worker.
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(runRetention(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
