import { handleAssetQueue } from "./asset-consumer";
import app from "./app";

export { Quota } from "./quota";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },
  queue(batch: MessageBatch, env: Env, _ctx: ExecutionContext): Promise<void> {
    return handleAssetQueue(batch, env);
  },
} satisfies ExportedHandler<Env>;
