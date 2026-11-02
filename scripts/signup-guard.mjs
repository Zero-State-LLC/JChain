// #61, CT-19, AT-30: production sign-up. Danny opened it on 2026-11-02 with no first-Post hold
// ("I don't have that kind of time to moderate"). The guard no longer asks for
// review.hold_first_posts. Instead, signup_open true passes only when, together:
// - max_operators is the planned abuse limit (200),
// - docs/TICKETS.md has Danny's OPEN_SIGNUP_DECISION line,
// - the production policy runs postpublish with a Workers AI budget, so every Post is scanned
//   right after it publishes, and
// - the three safety checks below are still wired in the source: the upload Blocked Hash check,
//   the CSAM legal hold, and the scan's automatic quarantine.
// scripts/check-policy.mjs reads the source files and runs this on every `npm test`; the runbook
// section "Opening sign-up (#61)" is the procedure.
//
// Pure: no file or network access, so test/signup-open-rehearsal.test.ts loads it in the Workers
// test pool.

export const OPEN_SIGNUP_MAX_OPERATORS = 200;
// One line of its own in docs/TICKETS.md naming Danny and the day he decided, then any note.
// Example: "OPEN_SIGNUP_DECISION: Danny, 2026-11-02 - open sign-up, no first-post hold".
export const OPEN_SIGNUP_DECISION = /^OPEN_SIGNUP_DECISION: Danny, \d{4}-\d{2}-\d{2}\b.*$/m;

// Each safety check names source files and the code each must still contain. A missing marker
// means someone removed or rewrote the check; the guard then refuses signup_open true until the
// marker here is updated in the same reviewed change.
export const SAFETY_MARKERS = {
  // CT-21: exact match against the Blocked Hash list at upload, and a prohibited match
  // quarantines the Asset before any Post can use it.
  upload_hash_check: {
    "src/asset-pipeline.ts": [
      "const match = await blockedMatch(env.DB, [asset.sha256, asset.thumb_sha256, displayHash, thumbHash]);",
      "if (match.prohibited) await quarantineBlocked(env.DB, assetId);",
    ],
  },
  // A CSAM Scanning Tool match and a csam report quarantine under a legal hold.
  csam_legal_hold: {
    "src/media-origin.ts": ['reasonCode: "csam",', "prohibited: true,", "legalHold: true,"],
    "src/reports.ts": ['legalHold: body.reasonCode === "csam",'],
  },
  // CT-23: a published Post is queued for the Content Scan, and an unsafe verdict quarantines it.
  scan_auto_quarantine: {
    "src/threads.ts": ["await env.ASSET_UPLOAD.send({ post_id: postId });"],
    "src/scan.ts": ["quarantined = await quarantineForScan(env, postId, verdict.categories, neurons, at);"],
  },
};

export const SAFETY_CHECKS = Object.keys(SAFETY_MARKERS);

// sources maps a repository path to its text. Returns { check: true | false } for each check.
export function safetyFromSources(sources) {
  const result = {};
  for (const [check, files] of Object.entries(SAFETY_MARKERS)) {
    result[check] = Object.entries(files).every(([path, markers]) => {
      const text = sources?.[path];
      return typeof text === "string" && markers.every((marker) => text.includes(marker));
    });
  }
  return result;
}

// Returns null when the production policy's sign-up setting is allowed, or the reason it is not.
export function signupProblem(policy, tickets, safety) {
  const open = policy?.auth?.signup_open;
  if (open === false) return null;
  if (open !== true) {
    return "production auth.signup_open must be false, or true with the #61 conditions";
  }
  if (policy.max_operators !== OPEN_SIGNUP_MAX_OPERATORS) {
    return `production auth.signup_open true needs max_operators ${OPEN_SIGNUP_MAX_OPERATORS} (#61)`;
  }
  if (typeof tickets !== "string" || !OPEN_SIGNUP_DECISION.test(tickets)) {
    return "production auth.signup_open true needs an OPEN_SIGNUP_DECISION line in docs/TICKETS.md (#61, RUNBOOK \"Opening sign-up (#61)\")";
  }
  if (policy.moderation_mode !== "postpublish") {
    return "production auth.signup_open true needs moderation_mode postpublish, so every Post is scanned after it publishes (#61)";
  }
  const neurons = policy.moderation?.ai_neurons_per_day;
  if (typeof neurons !== "number" || neurons <= 0) {
    return "production auth.signup_open true needs moderation.ai_neurons_per_day above 0 for the Content Scan (#61)";
  }
  for (const check of SAFETY_CHECKS) {
    if (safety?.[check] !== true) {
      return `production auth.signup_open true needs the ${check} safety check enabled (#61, scripts/signup-guard.mjs)`;
    }
  }
  return null;
}
