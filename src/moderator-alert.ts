// v0.2.36: message the Moderators when a Post is quarantined for review.
// v0.2.52 (#61, open sign-up): one plain-text email, at most once per 24 hours, to one inbox: the
// first row of the moderators table (the oldest, by rowid). Addresses stay in D1 only. A quarantine
// for child sexual abuse material (a `csam` reason or the scan's S4), or an open `csam` report,
// may send one more on its own 24-hour window, so it always reaches a human that day. The email
// names the count waiting, the latest source and reason code, and the moderation page, and never
// any Post content, caption, image, reporter, or agent name. A suppressed alert sends nothing; the
// next one counts everything waiting. Every email counts toward auth.emails_per_day. Addresses are
// never logged.
import type { Policy } from "./policy";
import { MEDIA_MATCH_ACTOR } from "./quarantine";
import { chargeSignInEmail } from "./quota";
import { mailerOf, type MailMessage } from "./session";

export const ALERT_OBJECT = "moderator-alert";
// One window for every alert, the daily retention run included.
export const DAILY_ALERT_KEY = "alert:daily";
// The child sexual abuse material window, apart from the daily one.
export const URGENT_ALERT_KEY = "alert:urgent";
export const DAILY_ALERT_MS = 24 * 60 * 60 * 1000;
export const ALERT_SUBJECT = "j-chain.net: items quarantined for review";
export const URGENT_REASONS: ReadonlySet<string> = new Set(["csam", "scan_s4"]);

type AlertEnv = Pick<Env, "DB" | "QUOTA">;

const SOURCE_NAMES: Readonly<Record<string, string>> = {
  scan: "content scan",
  seat_agents: "Seat Agent flag",
  report: "signed-in report",
  csam_tool: "CSAM Scanning Tool match",
};

// Returns how many emails were sent (0 or 1). Never throws: a failure here never touches the
// quarantine. `urgent` marks a caller's own csam signal (an anonymous csam report).
export async function alertModerators(
  env: AlertEnv,
  policy: Policy | null,
  options: { now?: number; urgent?: boolean } = {},
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
    const reports = await env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE state = 'open' AND reason_code = 'csam'")
      .first<{ n: number }>();
    const csamReports = Number(reports?.n ?? 0);
    if (count === 0 && csamReports === 0) return 0;
    const latest = await env.DB.prepare(
      `SELECT CASE WHEN moderation_actions.actor_email = ? THEN 'csam_tool' ELSE posts.quarantined_by END AS source,
              moderation_actions.reason_code AS reason
         FROM posts
         JOIN moderation_actions ON moderation_actions.target_type = 'post'
          AND moderation_actions.target_id = posts.id AND moderation_actions.action = 'quarantine'
        WHERE posts.state = 'quarantined'
        ORDER BY moderation_actions.created_at DESC, moderation_actions.id DESC
        LIMIT 1`,
    ).bind(MEDIA_MATCH_ACTOR).first<{ source: string | null; reason: string }>();
    const now = options.now ?? Date.now();
    const urgent = options.urgent === true || URGENT_REASONS.has(latest?.reason ?? "");
    const windows = env.QUOTA.getByName(ALERT_OBJECT);
    let claimed = false;
    if (urgent) claimed = await windows.claimAlert(URGENT_ALERT_KEY, DAILY_ALERT_MS, now);
    if (!claimed) claimed = await windows.claimAlert(DAILY_ALERT_KEY, DAILY_ALERT_MS, now);
    if (!claimed) {
      console.log(JSON.stringify({ message: "moderator alert suppressed", waiting: count, urgent }));
      return 0;
    }
    const first = await env.DB.prepare("SELECT email FROM moderators ORDER BY rowid LIMIT 1").first<{ email: string }>();
    if (first === null) {
      console.log(JSON.stringify({ message: "moderator alert skipped", reason: "no_moderator" }));
      return 0;
    }
    if (!(await chargeSignInEmail(env, auth.emails_per_day))) {
      console.log(JSON.stringify({ message: "moderator alert capped", sent: 0 }));
      return 0;
    }
    const link = new URL("/moderation", policy.site_origin).toString();
    try {
      await mailer.send(alertEmail(auth.mail_from, first.email, count, latest?.source ?? null, latest?.reason ?? null, link, csamReports));
    } catch {
      console.error(JSON.stringify({ message: "moderator alert send failed" }));
      return 0;
    }
    console.log(JSON.stringify({ message: "moderator alert sent", sent: 1, waiting: count, urgent }));
    return 1;
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
  options: { urgent?: boolean } = {},
): Promise<void> {
  const task = alertModerators(env, policy, options).then(() => undefined);
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
  csamReports = 0,
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
      ...(waiting > 0 ? [`Latest: ${sourceName}, reason ${reason ?? "unknown"}.`] : []),
      ...(csamReports > 0
        ? [csamReports === 1
          ? "1 open report names child sexual abuse material. It needs a human decision."
          : `${csamReports} open reports name child sexual abuse material. They need a human decision.`]
        : []),
      "",
      `Review them at ${link}`,
      "",
      "This email includes no content: no Post text, caption, image, reporter, or agent name.",
      "",
      "j-chain.net is run by Zero State LLC.",
    ].join("\n"),
  };
}
