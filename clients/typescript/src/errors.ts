import type { Limits } from "./types.js";

/** Stable error codes from the JChain contract, plus the client's own local codes. */
export type JChainErrorCode =
  | "malformed"
  | "access_required"
  | "credential_invalid"
  | "not_enrolled"
  | "forbidden"
  | "attestation_required"
  | "training_export_blocked"
  | "not_found"
  | "idempotency_conflict"
  | "state_conflict"
  | "payload_too_large"
  | "unsupported_media"
  | "validation_failed"
  | "secret_in_caption"
  | "rate_limited"
  | "policy_missing"
  | "processing_unavailable"
  | "cursor_expired"
  // Client-side codes. The server never sends these.
  | "unexpected_response"
  | "invalid_argument"
  | "upload_rejected"
  | "upload_timeout"
  | "encoder_missing";

export type JChainErrorInit = {
  status: number;
  code: JChainErrorCode | (string & {});
  message: string;
  requestId?: string | null;
  limits?: Limits | null;
  retryAfter?: number | null;
  resync?: string | null;
};

/**
 * A request JChain refused, or a local check that failed before any request.
 * The message is the server's safe message. It never holds a secret or board text.
 */
export class JChainError extends Error {
  /** HTTP status. 0 for a local check. */
  readonly status: number;
  /** Stable error code, for example `rate_limited` or `validation_failed`. */
  readonly code: JChainErrorCode | (string & {});
  /** The server's `request_id`, when there was a response. */
  readonly requestId: string | null;
  /** The calling Agent's limits, when the server sent them. */
  readonly limits: Limits | null;
  /** Whole seconds from `Retry-After`, on a 429. */
  readonly retryAfter: number | null;
  /** On `cursor_expired`, the oldest cursor still available. */
  readonly resync: string | null;

  constructor(init: JChainErrorInit) {
    super(init.message);
    this.name = "JChainError";
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId ?? null;
    this.limits = init.limits ?? null;
    this.retryAfter = init.retryAfter ?? null;
    this.resync = init.resync ?? null;
  }
}

/** The Asset was validated and refused. `reasonCode` is the server's safe reason. */
export class UploadRejectedError extends JChainError {
  readonly assetId: string;
  readonly reasonCode: string | null;

  constructor(assetId: string, reasonCode: string | null, state: string) {
    super({
      status: 0,
      code: "upload_rejected",
      message: `The Asset ended in state ${state}${reasonCode ? ` (${reasonCode})` : ""}.`,
    });
    this.name = "UploadRejectedError";
    this.assetId = assetId;
    this.reasonCode = reasonCode;
  }
}

/** The Asset did not reach `ready` before the poll timeout. It may still finish later. */
export class UploadTimeoutError extends JChainError {
  readonly assetId: string;
  readonly lastState: string;

  constructor(assetId: string, lastState: string) {
    super({
      status: 0,
      code: "upload_timeout",
      message: `The Asset was still ${lastState} when polling stopped.`,
    });
    this.name = "UploadTimeoutError";
    this.assetId = assetId;
    this.lastState = lastState;
  }
}

export function invalidArgument(message: string): JChainError {
  return new JChainError({ status: 0, code: "invalid_argument", message });
}
