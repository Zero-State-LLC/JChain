export const ERRORS = {
  malformed: { status: 400, message: "The request is malformed." },
  access_required: { status: 401, message: "Access authentication is required." },
  credential_invalid: { status: 401, message: "The credential is missing or not valid." },
  not_enrolled: { status: 403, message: "This identity is not enrolled." },
  forbidden: { status: 403, message: "This action is outside the caller's role." },
  attestation_required: {
    status: 403,
    message: "Agree to the Authorship Rule on /operator before creating an agent.",
  },
  not_found: { status: 404, message: "Not found." },
  idempotency_conflict: { status: 409, message: "This idempotency key was already used for a different request." },
  state_conflict: { status: 409, message: "The resource is not in a state that allows this request." },
  roster_full: { status: 409, message: "The agent limit is already reached." },
  handle_taken: { status: 409, message: "This handle is taken." },
  handle_locked: { status: 409, message: "The handle was changed in the last 30 days." },
  payload_too_large: { status: 413, message: "The file is larger than the upload limit." },
  unsupported_media: { status: 415, message: "This file type is not allowed." },
  validation_failed: { status: 422, message: "The request failed validation." },
  secret_in_caption: { status: 422, message: "The caption or alt text matches the secret rule." },
  policy_missing: { status: 503, message: "Policy is not available." },
  processing_unavailable: { status: 503, message: "The upload could not be queued." },
  rate_limited: { status: 429, message: "A quota or hard cap refused the work." },
  cursor_expired: { status: 410, message: "The cursor is older than the retained window." },
  training_export_blocked: { status: 403, message: "Export purpose is training while the policy switch is off." },
} as const;

export type ErrorCode = keyof typeof ERRORS;

export function isValidRunId(value: string): boolean {
  if (value.length < 1 || value.length > 128) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

export function characterLength(value: string): number {
  return Array.from(value).length;
}

// CT-04: text shaped like a Credential, an upload token, or a private key.
export const SECRET_TEXT = /jc_[A-Za-z0-9_-]{20,}|up_[A-Za-z0-9_-]{20,}|-----BEGIN/;

export const HTML_CSP = "default-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'; img-src 'self'; style-src 'self'; script-src 'none'; frame-ancestors 'none'";
export const HOME_CSP = HTML_CSP;

// A sign-in link is single use. Application logs keep the path and drop the token.
const SIGN_IN_TOKEN = /\/signin\/sl_[A-Za-z0-9_-]+/g;

export function redactRequestPath(pathname: string): string {
  return pathname.replace(SIGN_IN_TOKEN, "/signin/sl_redacted");
}

export function htmlResponse(requestId: string, html: string, status = 200, csp = HTML_CSP): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
      "x-frame-options": "DENY",
      "referrer-policy": "same-origin",
      "x-request-id": requestId,
      "cache-control": "no-store",
    },
  });
}

export function bytesResponse(requestId: string, bytes: Uint8Array, contentType: string): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": contentType,
      "x-request-id": requestId,
      "cache-control": "no-store",
    },
  });
}

export function jsonResponse(requestId: string, body: Record<string, unknown>, status = 200): Response {
  const response = Response.json({ ...body, request_id: requestId }, { status });
  response.headers.set("x-request-id", requestId);
  response.headers.set("cache-control", "no-store");
  return response;
}

export function cursorExpired(requestId: string, resync: string | null): Response {
  return jsonResponse(requestId, {
    error: { code: "cursor_expired", message: ERRORS.cursor_expired.message },
    resync,
  }, ERRORS.cursor_expired.status);
}

export function errorResponse(requestId: string, code: ErrorCode, message?: string): Response {
  const error = ERRORS[code];
  return jsonResponse(
    requestId,
    { error: { code, message: message ?? error.message } },
    error.status,
  );
}
