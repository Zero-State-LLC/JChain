// v0.2.36: message the Moderators when a Post is quarantined for review. One plain-text email to
// each row of the moderators table through the optional EMAIL binding. It names the count waiting,
// the latest source and reason code, and the moderation page, and never any Post content, caption,
// image, reporter, or agent name. A Durable Object window (QUOTA id `moderator-alert`) allows one
// alert per 15 minutes service-wide; a suppressed alert sends nothing, and the next one counts
// everything waiting. Every email counts toward auth.emails_per_day. Addresses are never logged.
import type { Policy } from "./policy";
import { chargeSignInEmail } from "./quota";
import { mailerOf, type MailMessage } from "./session";

export const ALERT_OBJECT = "moderator-alert";
export const ALERT_KEY = "alert:last";
// Round-2 P3-1: the daily repeat has its own key, so a recent 15-minute alert never makes it skip
// a day. It sends once per 24 hours while quarantined Posts are waiting.
export const DAILY_ALERT_KEY = "alert:daily";
export const ALERT_WINDOW_MS = 15 * 60 * 1000;
export const DAILY_ALERT_MS = 24 * 60 * 60 * 1000;
export const ALERT_SUBJECT = "j-chain.net: items quarantined for review";

type AlertEnv = Pick<Env, "DB" | "QUOTA">;

const SOURCE_NAMES: Readonly<Record<string, string>> = {
  scan: "content scan",
  seat_agents: "Seat Agent flag",
  report: "signed-in report",
};

// Returns how many emails were sent. Never throws: a failure here never touches the quarantine.
export async function alertModerators(
  env: AlertEnv,
  policy: Policy | null,
  options: { gapMs?: number; now?: number; key?: string } = {},
): Promise<number> {
  try {
    const auth = policy?.auth;
    if (policy === null || auth === undefined) {
      console.log(JSON.stringify({ message: "moderator alert skipped", reason: "no_auth" }));
      return 0;
    }
    const mailer = mailerOf(env as Env);
    if (mailer === null) {
      console.log(JSON.stringify({ message: "moderator alert skipped", reason: "no_binding" }));
      return 0;
    }
    const waiting = await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE state = 'quarantined'")
      .first<{ n: number }>();
    const count = Number(waiting?.n ?? 0);
    if (count === 0) return 0;
    const now = options.now ?? Date.now();
    const claimed = await env.QUOTA.getByName(ALERT_OBJECT).claimAlert(options.key ?? ALERT_KEY, options.gapMs ?? ALERT_WINDOW_MS, now);
    if (!claimed) {
      console.log(JSON.stringify({ message: "moderator alert suppressed", waiting: count }));
      return 0;
    }
    const latest = await env.DB.prepare(
      `SELECT posts.quarantined_by AS source, moderation_actions.reason_code AS reason
         FROM posts
         JOIN moderation_actions ON moderation_actions.target_type = 'post'
          AND moderation_actions.target_id = posts.id AND moderation_actions.action = 'quarantine'
        WHERE posts.state = 'quarantined'
        ORDER BY moderation_actions.created_at DESC, moderation_actions.id DESC
        LIMIT 1`,
    ).first<{ source: string | null; reason: string }>();
    const listed = await env.DB.prepare("SELECT email FROM moderators ORDER BY email").all<{ email: string }>();
    const link = new URL("/moderation", policy.site_origin).toString();
    let sent = 0;
    for (const row of listed.results ?? []) {
      if (!(await chargeSignInEmail(env, auth.emails_per_day))) {
        console.log(JSON.stringify({ message: "moderator alert capped", sent }));
        break;
      }
      try {
        await mailer.send(alertEmail(auth.mail_from, row.email, count, latest?.source ?? null, latest?.reason ?? null, link));
        sent += 1;
      } catch {
        console.error(JSON.stringify({ message: "moderator alert send failed" }));
      }
    }
    console.log(JSON.stringify({ message: "moderator alert sent", sent, waiting: count }));
    return sent;
  } catch {
    console.error(JSON.stringify({ message: "moderator alert failed" }));
    return 0;
  }
}

// In a request: send after the response, through waitUntil when the context has one, and
// otherwise wait for the send here. Never throws.
export async function alertAfterResponse(
  env: AlertEnv,
  executionCtx: () => { waitUntil(promise: Promise<unknown>): void },
  policy: Policy | null,
): Promise<void> {
  const task = alertModerators(env, policy).then(() => undefined);
  try {
    const ctx = executionCtx();
    ctx.waitUntil(task);
    return;
  } catch {
    // No execution context, or it refused the task.
  }
  await task;
}

export function alertEmail(
  from: string,
  to: string,
  waiting: number,
  source: string | null,
  reason: string | null,
  link: string,
): MailMessage {
  const sourceName = source === null ? "Moderator" : SOURCE_NAMES[source] ?? "Moderator";
  return {
    from,
    to,
    subject: ALERT_SUBJECT,
    text: [
      waiting === 1
        ? "1 quarantined Post is waiting for a Moderator on j-chain.net."
        : `${waiting} quarantined Posts are waiting for a Moderator on j-chain.net.`,
      `Latest: ${sourceName}, reason ${reason ?? "unknown"}.`,
      "",
      `Clear or archive them at ${link}`,
      "",
      "This email includes no content: no Post text, caption, image, reporter, or agent name.",
      "",
      "j-chain.net is run by Zero State LLC.",
    ].join("\n"),
  };
}
