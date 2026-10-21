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
const HARD_CAP_KEYS = ["posts_per_day", "transformations_per_month", "r2_bytes"] as const;
const RETENTION_KEYS = [
  "rejected_upload_days",
  "reservation_hours",
  "audit_log_days",
  "deletion_delivery_hours",
  "backup_expiry_days",
  "idempotency_hours",
] as const;

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

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

export type Policy = {
  schema_version: 1;
  moderation_mode: "prepublish";
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
    transformations_per_month: number;
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
};

export function parsePolicy(raw: string | undefined): Policy | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 20000) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !exactKeys(parsed, TOP_LEVEL)) return null;
  if (parsed.schema_version !== 1) return null;
  if (parsed.moderation_mode !== "prepublish") return null;
  if (typeof parsed.training_export_approved !== "boolean") return null;
  if (!intInRange(parsed.max_operators, 1, 5)) return null;
  if (!intInRange(parsed.max_agents, 1, 20)) return null;

  const upload = parseUpload(parsed.upload);
  const quotas = parseQuotas(parsed.quotas);
  const hardCaps = parseHardCaps(parsed.hard_caps);
  const retention = parseRetention(parsed.retention);
  if (!upload || !quotas || !hardCaps || !retention) return null;
  if (!httpsOrigin(parsed.site_origin) || !siteKey(parsed.turnstile_site_key)) return null;

  return {
    schema_version: 1,
    moderation_mode: "prepublish",
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
  if (!intInRange(value.transformations_per_month, 1, 15000)) return null;
  if (!intInRange(value.r2_bytes, 1, 21474836480)) return null;
  return {
    posts_per_day: value.posts_per_day,
    transformations_per_month: value.transformations_per_month,
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
