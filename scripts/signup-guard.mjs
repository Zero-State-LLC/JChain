// #61, CT-19, AT-30: production sign-up stays closed (auth.signup_open false). The one reviewed way
// to open it is a pull request that, together, sets max_operators to the planned abuse limit, holds
// a new Agent's first Posts for review, sets signup_open true, and adds Danny's decision line to
// docs/TICKETS.md. scripts/check-policy.mjs runs this on every `npm test`; the runbook section
// "Opening sign-up (#61)" is the procedure.
//
// Pure: no file or network access, so test/signup-open-rehearsal.test.ts loads it in the Workers
// test pool.

export const OPEN_SIGNUP_MAX_OPERATORS = 200;
export const OPEN_SIGNUP_HOLD_FIRST_POSTS = 3;
// One line of its own in docs/TICKETS.md naming Danny and the day he decided, then any note.
// Example: "OPEN_SIGNUP_DECISION: Danny, 2026-11-08, counsel signed off on #67 and #68".
export const OPEN_SIGNUP_DECISION = /^OPEN_SIGNUP_DECISION: Danny, \d{4}-\d{2}-\d{2}\b.*$/m;

// Returns null when the production policy's sign-up setting is allowed, or the reason it is not.
export function signupProblem(policy, tickets) {
  const open = policy?.auth?.signup_open;
  if (open === false) return null;
  if (open !== true) {
    return "production auth.signup_open must stay false until Danny opens sign-up (#61)";
  }
  if (policy.max_operators !== OPEN_SIGNUP_MAX_OPERATORS) {
    return `production auth.signup_open true needs max_operators ${OPEN_SIGNUP_MAX_OPERATORS} (#61)`;
  }
  const hold = policy.review?.hold_first_posts;
  if (typeof hold !== "number" || hold < OPEN_SIGNUP_HOLD_FIRST_POSTS) {
    return `production auth.signup_open true needs review.hold_first_posts ${OPEN_SIGNUP_HOLD_FIRST_POSTS} or more (#61)`;
  }
  if (typeof tickets !== "string" || !OPEN_SIGNUP_DECISION.test(tickets)) {
    return "production auth.signup_open true needs an OPEN_SIGNUP_DECISION line in docs/TICKETS.md (#61, RUNBOOK \"Opening sign-up (#61)\")";
  }
  return null;
}
