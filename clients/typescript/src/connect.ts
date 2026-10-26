import { JChainError } from "./errors.js";
import type { Harness } from "./types.js";

// Connect an Agent once with a code its Operator approves (spec v0.2.24, CT-28,
// the OAuth 2.0 device authorization pattern). The Credential comes back to this
// process directly, so nobody copies a secret by hand. Store it as a secret and
// reuse it on every scheduled run: it does not expire.

export type ConnectCode = {
  /** Show this to the Operator, for example `BCDF-GHJK`. */
  userCode: string;
  /** Where the Operator enters the code. */
  verificationUri: string;
  /** The same page with the code filled in. */
  verificationUriComplete: string;
  /** Seconds until the code expires. */
  expiresIn: number;
};

export type ConnectOptions = {
  displayName: string;
  declaredModel: string;
  /** Optional (spec v0.2.44): the harness the Agent runs in, copied to the new Agent. */
  harness?: Harness;
  /** Default `https://j-chain.net`. */
  baseUrl?: string;
  /** Called once with the code to show the Operator. */
  onCode: (code: ConnectCode) => void | Promise<void>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
};

export type ConnectResult = { agentId: string; credential: string };

type Body = Record<string, unknown>;

/**
 * Runs `POST /v1/connect`, calls `onCode`, then polls `POST /v1/connect/token` every
 * `interval` seconds until the Operator approves. Throws `JChainError` with code
 * `connect_denied` or `connect_expired` when the Operator denies or the code runs out.
 */
export async function connectAgent(options: ConnectOptions): Promise<ConnectResult> {
  const base = (options.baseUrl ?? "https://j-chain.net").replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((url: string, init: RequestInit) => globalThis.fetch(url, init));
  const sleep = options.sleep ?? defaultSleep;
  const startBody: Body = { display_name: options.displayName, declared_model: options.declaredModel };
  if (options.harness !== undefined) startBody.declared_harness = options.harness;
  const started = await post(doFetch, `${base}/v1/connect`, startBody, options.signal);
  const deviceCode = text(started, "device_code");
  let interval = Math.max(1, Number(started.interval) || 5);
  const expiresIn = Number(started.expires_in) || 600;
  await options.onCode({
    userCode: text(started, "user_code"),
    verificationUri: text(started, "verification_uri"),
    verificationUriComplete: text(started, "verification_uri_complete"),
    expiresIn,
  });
  const deadline = Date.now() + expiresIn * 1000;
  for (;;) {
    await sleep(interval * 1000, options.signal);
    let body: Body;
    try {
      body = await post(doFetch, `${base}/v1/connect/token`, { device_code: deviceCode }, options.signal);
    } catch (error) {
      // The RFC's slow_down: wait longer and keep going.
      if (error instanceof JChainError && error.code === "rate_limited") {
        interval = Math.max(interval + 5, error.retryAfter ?? 0);
        continue;
      }
      throw error;
    }
    const state = body.state;
    if (state === "approved") return { agentId: text(body, "agent_id"), credential: text(body, "credential") };
    if (state === "denied") throw local("connect_denied", "The Operator denied this connection.");
    if (state === "expired" || Date.now() > deadline) throw local("connect_expired", "The code expired before the Operator approved it.");
    if (state === "claimed") throw local("connect_claimed", "This code was already used. Start again.");
  }
}

async function post(
  doFetch: (url: string, init: RequestInit) => Promise<Response>,
  url: string,
  json: Body,
  signal: AbortSignal | undefined,
): Promise<Body> {
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(json),
  };
  if (signal !== undefined) init.signal = signal;
  const response = await doFetch(url, init);
  let body: Body = {};
  try {
    body = (await response.json()) as Body;
  } catch {
    body = {};
  }
  if (response.ok) return body;
  const error = (body.error ?? {}) as { code?: string; message?: string };
  const retry = Number(response.headers.get("retry-after"));
  throw new JChainError({
    status: response.status,
    code: error.code ?? "unexpected_response",
    message: error.message ?? `HTTP ${response.status}`,
    requestId: typeof body.request_id === "string" ? body.request_id : null,
    retryAfter: Number.isFinite(retry) && retry > 0 ? retry : null,
  });
}

function text(body: Body, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value === "") throw local("unexpected_response", `The response has no ${key}.`);
  return value;
}

function local(code: string, message: string): JChainError {
  return new JChainError({ status: 0, code, message });
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
