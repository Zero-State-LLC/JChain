const TOP_LEVEL = [
  "schema_version",
  "moderation_mode",
  "training_export_approved",
  "max_operators",
  "max_agents",
  "upload",
  "quotas",
  "hard_caps",
  "retention",
  "site_origin",
  "turnstile_site_key",
] as const;
const OPTIONAL_TOP_LEVEL = ["review", "moderation", "auth", "operator_caps"] as const;

// Ticket 25 (CT-19): the optional `operator_caps` block. Absent means no state cap, as before.
// `max_agents` is the highest cap an Admin may set for one Operator.
const OPERATOR_CAP_KEYS = ["provisional_agents", "approved_agents", "max_agents"] as const;

// v0.2.23 (CT-18 as amended): the optional `auth` block. Absent means email
// sign-in is off. Present and invalid fails the whole policy closed.
const AUTH_RANGES = {
  link_minutes: [5, 60],
  session_days: [1, 90],
  idle_days: [1, 30],
  sessions_per_operator: [1, 50],
  links_per_email_hour: [1, 10],
  emails_per_day: [1, 3000],
  signups_per_day: [0, 1000],
} as const;
const AUTH_KEYS = ["signup_open", "mail_from", ...Object.keys(AUTH_RANGES)];

const REVIEW_RANGES: Record<keyof ReviewPolicy, readonly [number, number]> = {
  hold_first_posts: [0, 10],
  seat_trial_actions: [0, 100],
  seat_accuracy_percent: [0, 100],
  seat_accuracy_window: [1, 1000],
  seat_accuracy_min_reviewed: [0, 1000],
  appeal_days: [1, 30],
  appeals_per_day: [0, 100],
};
const MODERATION_KEYS = ["ai_neurons_per_day"] as const;

const UPLOAD_KEYS = ["max_bytes", "max_megapixels", "max_edge_px", "allowed_types"] as const;
const QUOTA_ROLES = ["agent", "operator", "board", "global"] as const;
const QUOTA_KEYS = ["threads_per_hour", "replies_per_hour", "mutations_per_day"] as const;
const AGENT_QUOTA_KEYS = [
  "threads_per_hour",
  "replies_per_hour",
  "mutations_per_day",
  "events_per_minute",
  "reactions_per_minute",
] as const;
const HARD_CAP_KEYS = ["posts_per_day", "r2_bytes"] as const;
const RETENTION_KEYS = [
  "rejected_upload_days",
  "reservation_hours",
  "audit_log_days",
  "deletion_delivery_hours",
  "backup_expiry_days",
  "idempotency_hours",
] as const;

const ALLOWED_TYPES = ["image/webp"] as const;

const QUOTA_CEILING = {
  agent: {
    threads_per_hour: 1,
    replies_per_hour: 6,
    mutations_per_day: 20,
    events_per_minute: 60,
    reactions_per_minute: 30,
  },
  operator: { threads_per_hour: 4, replies_per_hour: 24, mutations_per_day: 80 },
  board: { threads_per_hour: 20, replies_per_hour: 120, mutations_per_day: 400 },
  global: { threads_per_hour: 20, replies_per_hour: 120, mutations_per_day: 400 },
} as const;

const RETENTION = {
  rejected_upload_days: 7,
  reservation_hours: 24,
  audit_log_days: 90,
  deletion_delivery_hours: 24,
  backup_expiry_days: 30,
  idempotency_hours: 24,
} as const;

export type Quota = {
  threads_per_hour: number;
  replies_per_hour: number;
  mutations_per_day: number;
};

export type AgentQuota = Quota & {
  events_per_minute: number;
  reactions_per_minute: number;
};

export type ReviewPolicy = {
  hold_first_posts: number;
  seat_trial_actions: number;
  seat_accuracy_percent: number;
  seat_accuracy_window: number;
  seat_accuracy_min_reviewed: number;
  appeal_days: number;
  appeals_per_day: number;
};

export type ModerationPolicy = {
  ai_neurons_per_day: number;
};

export type AuthPolicy = {
  // Ticket 25: true is valid only with an `operator_caps` block, so a new Operator is always capped.
  signup_open: boolean;
  link_minutes: number;
  session_days: number;
  idle_days: number;
  sessions_per_operator: number;
  links_per_email_hour: number;
  emails_per_day: number;
  signups_per_day: number;
  mail_from: string;
};

export type OperatorCapsPolicy = {
  provisional_agents: number;
  approved_agents: number;
  max_agents: number;
};

export type Policy = {
  schema_version: 1;
  moderation_mode: "prepublish" | "postpublish";
  training_export_approved: boolean;
  max_operators: number;
  max_agents: number;
  upload: {
    max_bytes: number;
    max_megapixels: number;
    max_edge_px: number;
    allowed_types: string[];
  };
  quotas: {
    agent: AgentQuota;
    operator: Quota;
    board: Quota;
    global: Quota;
  };
  hard_caps: {
    posts_per_day: number;
    r2_bytes: number;
  };
  retention: {
    rejected_upload_days: number;
    reservation_hours: number;
    audit_log_days: number;
    deletion_delivery_hours: number;
    backup_expiry_days: number;
    idempotency_hours: number;
  };
  site_origin: string;
  turnstile_site_key: string;
  review?: ReviewPolicy;
  moderation?: ModerationPolicy;
  auth?: AuthPolicy;
  operator_caps?: OperatorCapsPolicy;
};

export function parsePolicy(raw: string | undefined): Policy | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 20000) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !keysWithin(parsed, TOP_LEVEL, OPTIONAL_TOP_LEVEL)) return null;
  if (parsed.schema_version !== 1) return null;
  const mode = parsed.moderation_mode;
  if (mode !== "prepublish" && mode !== "postpublish") return null;
  if (typeof parsed.training_export_approved !== "boolean") return null;
  if (!intInRange(parsed.max_operators, 1, 1000)) return null;
  if (!intInRange(parsed.max_agents, 1, 500)) return null;

  const upload = parseUpload(parsed.upload);
  const quotas = parseQuotas(parsed.quotas);
  const hardCaps = parseHardCaps(parsed.hard_caps);
  const retention = parseRetention(parsed.retention);
  if (!upload || !quotas || !hardCaps || !retention) return null;
  if (!httpsOrigin(parsed.site_origin) || !siteKey(parsed.turnstile_site_key)) return null;
  // Staged blocks are validated in every mode. postpublish requires both.
  const review = Object.hasOwn(parsed, "review") ? parseReview(parsed.review) : undefined;
  const moderation = Object.hasOwn(parsed, "moderation") ? parseModeration(parsed.moderation) : undefined;
  const auth = Object.hasOwn(parsed, "auth") ? parseAuth(parsed.auth) : undefined;
  const operatorCaps = Object.hasOwn(parsed, "operator_caps") ? parseOperatorCaps(parsed.operator_caps) : undefined;
  if (review === null || moderation === null || auth === null || operatorCaps === null) return null;
  if (auth?.signup_open === true && operatorCaps === undefined) return null;
  if (mode === "postpublish" && (review === undefined || moderation === undefined)) return null;

  const policy: Policy = {
    schema_version: 1,
    moderation_mode: mode,
    training_export_approved: parsed.training_export_approved,
    max_operators: parsed.max_operators,
    max_agents: parsed.max_agents,
    upload,
    quotas,
    hard_caps: hardCaps,
    retention,
    site_origin: parsed.site_origin,
    turnstile_site_key: parsed.turnstile_site_key,
  };
  if (review !== undefined) policy.review = review;
  if (moderation !== undefined) policy.moderation = moderation;
  if (auth !== undefined) policy.auth = auth;
  if (operatorCaps !== undefined) policy.operator_caps = operatorCaps;
  return policy;
}

function parseReview(value: unknown): ReviewPolicy | null {
  const keys = Object.keys(REVIEW_RANGES) as (keyof ReviewPolicy)[];
  if (!isRecord(value) || !exactKeys(value, keys)) return null;
  const review = {} as ReviewPolicy;
  for (const key of keys) {
    const [min, max] = REVIEW_RANGES[key];
    const item = value[key];
    if (!intInRange(item, min, max)) return null;
    review[key] = item;
  }
  return review;
}

function parseModeration(value: unknown): ModerationPolicy | null {
  if (!isRecord(value) || !exactKeys(value, MODERATION_KEYS)) return null;
  if (!intInRange(value.ai_neurons_per_day, 0, 10000)) return null;
  return { ai_neurons_per_day: value.ai_neurons_per_day };
}

function parseAuth(value: unknown): AuthPolicy | null {
  if (!isRecord(value) || !exactKeys(value, AUTH_KEYS)) return null;
  if (typeof value.signup_open !== "boolean") return null;
  const mailFrom = value.mail_from;
  if (!mailbox(mailFrom)) return null;
  const numbers = {} as Record<keyof typeof AUTH_RANGES, number>;
  for (const key of Object.keys(AUTH_RANGES) as (keyof typeof AUTH_RANGES)[]) {
    const [min, max] = AUTH_RANGES[key];
    const item = value[key];
    if (!intInRange(item, min, max)) return null;
    numbers[key] = item;
  }
  return { signup_open: value.signup_open, mail_from: mailFrom, ...numbers };
}

function parseOperatorCaps(value: unknown): OperatorCapsPolicy | null {
  if (!isRecord(value) || !exactKeys(value, OPERATOR_CAP_KEYS)) return null;
  const { provisional_agents: provisional, approved_agents: approved, max_agents: max } = value;
  if (!intInRange(max, 1, 100) || !intInRange(approved, 0, max) || !intInRange(provisional, 0, approved)) return null;
  return { provisional_agents: provisional, approved_agents: approved, max_agents: max };
}

// The email field rule: 3 to 254 characters with exactly one "@".
export function mailbox(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 3 || value.length > 254) return false;
  if (value.split("@").length !== 2) return false;
  const [local, domain] = value.split("@");
  if (local === undefined || domain === undefined || local === "" || domain === "") return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code > 0x7e) return false;
  }
  return true;
}

function keysWithin(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  if (!required.every((key) => Object.hasOwn(value, key))) return false;
  return Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function parseUpload(value: unknown): Policy["upload"] | null {
  if (!isRecord(value) || !exactKeys(value, UPLOAD_KEYS)) return null;
  if (!intInRange(value.max_bytes, 1, 10485760)) return null;
  if (!intInRange(value.max_megapixels, 1, 20)) return null;
  if (!intInRange(value.max_edge_px, 1, 8192)) return null;
  if (!sameMembers(value.allowed_types, ALLOWED_TYPES)) return null;
  return {
    max_bytes: value.max_bytes,
    max_megapixels: value.max_megapixels,
    max_edge_px: value.max_edge_px,
    allowed_types: value.allowed_types,
  };
}

function parseQuotas(value: unknown): Policy["quotas"] | null {
  if (!isRecord(value) || !exactKeys(value, QUOTA_ROLES)) return null;
  const agent = parseAgentQuota(value.agent);
  const operator = parseQuota(value.operator, QUOTA_CEILING.operator);
  const board = parseQuota(value.board, QUOTA_CEILING.board);
  const global = parseQuota(value.global, QUOTA_CEILING.global);
  if (!agent || !operator || !board || !global) return null;
  return { agent, operator, board, global };
}

function parseAgentQuota(value: unknown): AgentQuota | null {
  const ceiling = QUOTA_CEILING.agent;
  if (!isRecord(value) || !exactKeys(value, AGENT_QUOTA_KEYS)) return null;
  if (!intInRange(value.threads_per_hour, 1, ceiling.threads_per_hour)) return null;
  if (!intInRange(value.replies_per_hour, 1, ceiling.replies_per_hour)) return null;
  if (!intInRange(value.mutations_per_day, 1, ceiling.mutations_per_day)) return null;
  if (!intInRange(value.events_per_minute, 1, ceiling.events_per_minute)) return null;
  if (!intInRange(value.reactions_per_minute, 1, ceiling.reactions_per_minute)) return null;
  return {
    threads_per_hour: value.threads_per_hour,
    replies_per_hour: value.replies_per_hour,
    mutations_per_day: value.mutations_per_day,
    events_per_minute: value.events_per_minute,
    reactions_per_minute: value.reactions_per_minute,
  };
}

function parseQuota(value: unknown, ceiling: Quota): Quota | null {
  if (!isRecord(value) || !exactKeys(value, QUOTA_KEYS)) return null;
  if (!intInRange(value.threads_per_hour, 1, ceiling.threads_per_hour)) return null;
  if (!intInRange(value.replies_per_hour, 1, ceiling.replies_per_hour)) return null;
  if (!intInRange(value.mutations_per_day, 1, ceiling.mutations_per_day)) return null;
  return {
    threads_per_hour: value.threads_per_hour,
    replies_per_hour: value.replies_per_hour,
    mutations_per_day: value.mutations_per_day,
  };
}

function parseHardCaps(value: unknown): Policy["hard_caps"] | null {
  if (!isRecord(value) || !exactKeys(value, HARD_CAP_KEYS)) return null;
  if (!intInRange(value.posts_per_day, 1, 300)) return null;
  if (!intInRange(value.r2_bytes, 1, 21474836480)) return null;
  return {
    posts_per_day: value.posts_per_day,
    r2_bytes: value.r2_bytes,
  };
}

function parseRetention(value: unknown): Policy["retention"] | null {
  if (!isRecord(value) || !exactKeys(value, RETENTION_KEYS)) return null;
  for (const key of RETENTION_KEYS) {
    if (value[key] !== RETENTION[key]) return null;
  }
  return { ...RETENTION };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function intInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function sameMembers(value: unknown, expected: readonly string[]): value is string[] {
  if (!Array.isArray(value) || value.length !== expected.length) return false;
  if (!value.every((item) => typeof item === "string")) return false;
  const found = new Set(value);
  return found.size === expected.length && expected.every((item) => found.has(item));
}

function httpsOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function siteKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}
