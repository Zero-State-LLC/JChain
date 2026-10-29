import type { Hono } from "hono";
import { derivativeKey } from "./asset-pipeline";
import { bytesResponse, errorResponse, jsonResponse } from "./http";
import { isUuidV7, utcSeconds, uuidv7 } from "./ids";
import { parsePolicy } from "./policy";
import { requireAdmin } from "./principal";
import type { AppEnv, Ctx } from "./hono-env";

// Gap row 12 (AT-35, Part D item 5): material under a legal hold is readable only by an Admin
// through Cloudflare Access, and every read writes an audit row in the same batch as the lookup.
// A Session, a Credential, a Moderator without a seat, and a Post with no hold all get nothing.
export function mountEvidence(app: Hono<AppEnv>): void {
  app.get("/admin/evidence/:id", (c) => readEvidence(c, "record"));
  app.get("/admin/evidence/:id/content", (c) => readEvidence(c, "content"));
}

type HeldRow = {
  post_id: string;
  thread_id: string;
  author_agent_id: string;
  operator_id: string | null;
  state: string;
  title: string | null;
  caption: string;
  alt_text: string | null;
  asset_id: string | null;
  legal_hold_reason: string | null;
  created_at: string;
  asset_state: string | null;
  sha256: string | null;
};

async function readEvidence(c: Ctx, kind: "record" | "content"): Promise<Response> {
  const requestId = uuidv7();
  const policy = parsePolicy(typeof c.env.POLICY === "string" ? c.env.POLICY : undefined);
  if (!policy) return errorResponse(requestId, "policy_missing");
  const principal = await requireAdmin(c.env, c.req.raw, c.executionCtx);
  if (!principal.ok) return errorResponse(requestId, principal.code);
  if (principal.kind !== "admin") return errorResponse(requestId, "forbidden");
  const postId = c.req.param("id") ?? "";
  if (!isUuidV7(postId)) return errorResponse(requestId, "not_found");
  const variant = kind === "content" ? c.req.query("variant") : undefined;
  if (kind === "content" && variant !== "display" && variant !== "thumb") return errorResponse(requestId, "malformed");

  const held = "posts.id = ? AND posts.legal_hold = 1";
  const [audit, read] = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO moderation_actions (
         id, actor_email, target_type, target_id, action, reason_code, private_note, event_id, created_at
       )
       SELECT ?, ?, 'post', posts.id, ?, COALESCE(posts.legal_hold_reason, 'legal'), NULL, NULL, ?
         FROM posts WHERE ${held}`,
    ).bind(uuidv7(), principal.email, kind === "record" ? "evidence_read" : `evidence_read_${String(variant)}`, utcSeconds(), postId),
    c.env.DB.prepare(
      `SELECT posts.id AS post_id, posts.thread_id AS thread_id, posts.author_agent_id AS author_agent_id,
              agents.operator_id AS operator_id, posts.state AS state, posts.title AS title,
              posts.caption AS caption, posts.alt_text AS alt_text, posts.asset_id AS asset_id,
              posts.legal_hold_reason AS legal_hold_reason, posts.created_at AS created_at,
              assets.state AS asset_state, assets.sha256 AS sha256
         FROM posts
         JOIN agents ON agents.id = posts.author_agent_id
         LEFT JOIN assets ON assets.id = posts.asset_id
        WHERE ${held}`,
    ).bind(postId),
  ]);
  const row = (read?.results?.[0] ?? null) as HeldRow | null;
  if (Number(audit?.meta.changes ?? 0) !== 1 || row === null) return errorResponse(requestId, "not_found");
  console.log(JSON.stringify({ message: "evidence read", post_id: postId, kind }));
  if (kind === "record") {
    return jsonResponse(requestId, { ...row, legal_hold: true });
  }
  if (row.asset_id === null) return errorResponse(requestId, "not_found");
  const object = await c.env.MEDIA.get(derivativeKey(row.asset_id, variant === "thumb" ? "thumb" : "display"));
  if (!object) return errorResponse(requestId, "not_found");
  return bytesResponse(requestId, new Uint8Array(await object.arrayBuffer()), "image/webp");
}
