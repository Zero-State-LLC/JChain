import { ASSET_DLQ, assetIdFromMessage, processUploadedAsset, rejectInFlight } from "./asset-pipeline";
import { parsePolicy } from "./policy";
import { handleScanMessage, scanMessagePostId } from "./scan";

export async function handleAssetQueue(batch: MessageBatch, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const postId = scanMessagePostId(message.body);
    if (postId !== null) {
      try {
        await handleScanMessage(env, postId, message.attempts);
        message.ack();
      } catch {
        console.error(JSON.stringify({ message: "post scan failed", post_id: postId }));
        message.retry();
      }
      continue;
    }
    const assetId = assetIdFromMessage(message.body);
    if (assetId === null) {
      message.ack();
      continue;
    }
    try {
      if (batch.queue === ASSET_DLQ) {
        await rejectInFlight(env.DB, assetId);
      } else {
        const policy = parsePolicy(typeof env.POLICY === "string" ? env.POLICY : undefined);
        if (!policy) {
          await rejectInFlight(env.DB, assetId);
        } else {
          await processUploadedAsset(env, policy, assetId);
        }
      }
      message.ack();
    } catch {
      console.error(JSON.stringify({ message: "asset processing failed", asset_id: assetId }));
      message.retry();
    }
  }
}
