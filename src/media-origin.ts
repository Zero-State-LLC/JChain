// v0.2.37 (#74, Open Question 19; Danny, 2026-10-23 11:34 PM PT: "ok handle your work"): Cloudflare's
// CSAM Scanning Tool hashes images as they enter the Cloudflare cache, and bytes the Worker reads
// from R2 never do. So a published derivative is read through a zone-cached origin host (the R2
// bucket on its own custom domain, cache-eligible by a Cache Rule, and blocked by a WAF rule unless
// the request carries the shared origin key). Only bytes the anonymous reader may already see go
// that way; every gated read stays on R2.
//
// A 451 from the origin is the tool's block: fail closed, quarantine every published Post on the
// Asset under a legal hold, and alert the Moderators after the response. The NCMEC report stays
// human. Any other answer, or a thrown fetch, falls back to R2, as the Content Scan fails open.
import { derivativeKey } from "./asset-pipeline";
import { utcSeconds } from "./ids";
import { alertAfterResponse } from "./moderator-alert";
import type { Policy } from "./policy";
import { MEDIA_MATCH_ACTOR, quarantineStatements } from "./quarantine";

export const ORIGIN_KEY_HEADER = "x-jchain-origin";
export const MEDIA_SOURCE_HEADER = "x-jchain-media";
export const ORIGIN_CACHE_TTL_SECONDS = 86400;

// Env comes from `wrangler types`, and MEDIA_ORIGIN is a production-only var while MEDIA_ORIGIN_KEY
// is a secret, so both are read through this optional shape (as the gauges read theirs).
type MediaOriginEnv = { MEDIA_ORIGIN?: unknown; MEDIA_ORIGIN_KEY?: unknown };

export type MediaOrigin = { base: string; key: string };

export type OriginRead =
  | { kind: "bytes"; bytes: Uint8Array; cacheStatus: string }
  | { kind: "missing" }
  | { kind: "blocked" }
  | { kind: "fallback"; status: number | null };

type AlertCtx = () => { waitUntil(promise: Promise<unknown>): void };

// Both values must be non-empty strings; otherwise the origin path is off and R2 serves as before.
export function mediaOriginOf(env: Env): MediaOrigin | null {
  const vars = env as unknown as MediaOriginEnv;
  const base = vars.MEDIA_ORIGIN;
  const key = vars.MEDIA_ORIGIN_KEY;
  if (typeof base !== "string" || base === "" || typeof key !== "string" || key === "") return null;
  return { base: base.replace(/\/+$/, ""), key };
}

export async function readFromOrigin(
  origin: MediaOrigin,
  assetId: string,
  variant: "display" | "thumb",
): Promise<OriginRead> {
  let response: Response;
  try {
    response = await fetch(`${origin.base}/${derivativeKey(assetId, variant)}`, {
      headers: { [ORIGIN_KEY_HEADER]: origin.key },
      cf: { cacheEverything: true, cacheTtl: ORIGIN_CACHE_TTL_SECONDS },
    });
  } catch {
    return fallback(null, assetId);
  }
  if (response.status === 200) {
    try {
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { kind: "bytes", bytes, cacheStatus: cacheStatusOf(response) };
    } catch {
      return fallback(200, assetId);
    }
  }
  await discard(response);
  if (response.status === 404) return { kind: "missing" };
  if (response.status === 451) return { kind: "blocked" };
  return fallback(response.status, assetId);
}

// The tool blocked the bytes. Every published Post on the Asset is quarantined under a legal hold
// in one batch, with its hashes blocked as prohibited, through the shared step. The source is
// 'report' so no author can appeal it: only 'scan' and 'seat_agents' quarantines are appealable,
// and the appeal route does not look at the legal hold. Never throws; the caller has already
// decided the response.
export async function quarantineMediaMatch(
  env: Env,
  executionCtx: AlertCtx,
  policy: Policy | null,
  assetId: string,
): Promise<void> {
  try {
    const post = await env.DB.prepare(
      `SELECT id FROM posts WHERE asset_id = ? AND state = 'published' ORDER BY created_at, id LIMIT 1`,
    ).bind(assetId).first<{ id: string }>();
    if (!post) {
      console.error(JSON.stringify({ event: "media_origin_blocked", asset_id: assetId, quarantined: 0 }));
      return;
    }
    const plan = await quarantineStatements(env.DB, {
      postId: post.id,
      assetId,
      source: "report",
      actor: MEDIA_MATCH_ACTOR,
      reasonCode: "csam",
      prohibited: true,
      legalHold: true,
      at: utcSeconds(),
    });
    const results = await env.DB.batch(plan.statements);
    const applied = Number(results[plan.updateIndex]?.meta.changes ?? 0) === 1;
    console.error(JSON.stringify({
      event: "media_origin_blocked",
      asset_id: assetId,
      quarantined: applied ? 1 + plan.siblingIds.length : 0,
    }));
    if (applied) await alertAfterResponse(env, executionCtx, policy);
  } catch {
    console.error(JSON.stringify({ event: "media_origin_quarantine_failed", asset_id: assetId }));
  }
}

function fallback(status: number | null, assetId: string): OriginRead {
  console.warn(JSON.stringify({ event: "media_origin_fallback", status, asset_id: assetId }));
  return { kind: "fallback", status };
}

// The x-jchain-media value for a published image served from R2: "r2" when the origin is not
// configured, "r2-fallback-<status>" (or "-error" when the fetch threw) when it was tried and
// failed, so a misconfigured origin is visible from outside without logs.
export function fallbackSource(read: OriginRead | null): string {
  if (read === null || read.kind !== "fallback") return "r2";
  return `r2-fallback-${read.status === null ? "error" : String(read.status)}`;
}

function cacheStatusOf(response: Response): string {
  const raw = (response.headers.get("cf-cache-status") ?? "").trim().toLowerCase();
  return /^[a-z-]{1,20}$/.test(raw) ? raw : "none";
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to release.
  }
}
