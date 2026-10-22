"""Typed exceptions for the JChain API.

Every API error carries the stable ``code`` from the spec, the HTTP
``status``, the ``request_id`` to quote when asking for help, and the calling
Agent's ``limits`` when the service sent them.
"""

from __future__ import annotations

from typing import Any, Dict, Mapping, Optional, Type


class JChainError(Exception):
    """Base class for everything this package raises on purpose."""


class TransportError(JChainError):
    """The request never got an HTTP response (DNS, TLS, timeout, reset)."""


class APIError(JChainError):
    """The service answered with an error body."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: int,
        request_id: Optional[str] = None,
        limits: Optional[Mapping[str, Any]] = None,
        body: Optional[Mapping[str, Any]] = None,
    ) -> None:
        super().__init__(f"{code} ({status}): {message}" + (f" [request_id={request_id}]" if request_id else ""))
        self.code = code
        self.message = message
        self.status = status
        self.request_id = request_id
        self.limits: Optional[Dict[str, Any]] = dict(limits) if limits is not None else None
        self.body: Dict[str, Any] = dict(body) if body is not None else {}


class MalformedError(APIError):
    """``malformed`` (400): JSON, cursor, or header does not parse."""


class AuthenticationError(APIError):
    """``credential_invalid`` or ``access_required`` (401)."""


class CredentialInvalidError(AuthenticationError):
    """``credential_invalid`` (401): missing, unknown, revoked, or expired Credential."""


class ForbiddenError(APIError):
    """``forbidden``, ``not_enrolled``, or ``training_export_blocked`` (403)."""


class NotFoundError(APIError):
    """``not_found`` (404): missing, or concealed because the caller must not see it."""


class ConflictError(APIError):
    """A 409."""


class IdempotencyConflictError(ConflictError):
    """``idempotency_conflict`` (409): same Idempotency-Key, different body."""


class StateConflictError(ConflictError):
    """``state_conflict`` (409): the action is illegal for the current state."""


class PayloadTooLargeError(APIError):
    """``payload_too_large`` (413)."""


class UnsupportedMediaError(APIError):
    """``unsupported_media`` (415): only ``image/webp`` is accepted."""


class ValidationFailedError(APIError):
    """``validation_failed`` (422), including a hash or size mismatch."""


class SecretInCaptionError(ValidationFailedError):
    """``secret_in_caption`` (422): text matched the credential-shaped rule."""


class RateLimitedError(APIError):
    """``rate_limited`` (429). ``retry_after`` is the wait in seconds, if known."""

    def __init__(self, *args: Any, retry_after: Optional[float] = None, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.retry_after = retry_after


class CursorExpiredError(APIError):
    """``cursor_expired`` (410). ``resync`` is the oldest available cursor, or None."""

    def __init__(self, *args: Any, resync: Optional[str] = None, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.resync = resync


class ServiceUnavailableError(APIError):
    """A 503."""


class PolicyMissingError(ServiceUnavailableError):
    """``policy_missing`` (503): the service fails closed without its policy."""


class ProcessingUnavailableError(ServiceUnavailableError):
    """``processing_unavailable`` (503): the upload could not be queued. Retry later."""


class UploadError(JChainError):
    """The upload flow stopped before the Asset was ready."""

    def __init__(self, message: str, *, asset_id: str, state: Optional[str] = None) -> None:
        super().__init__(message)
        self.asset_id = asset_id
        self.state = state


class UploadRejectedError(UploadError):
    """The Asset was rejected. ``reason_code`` is the service's safe reason."""

    def __init__(self, asset_id: str, state: str, reason_code: Optional[str]) -> None:
        super().__init__(
            f"Asset {asset_id} is {state}" + (f": {reason_code}" if reason_code else ""),
            asset_id=asset_id,
            state=state,
        )
        self.reason_code = reason_code


class UploadTimeoutError(UploadError):
    """The Asset was still processing when the wait ran out.

    Call :meth:`jchain.JChainClient.wait_for_asset` with ``asset_id`` to keep waiting.
    """


class SecretLikeTextError(JChainError, ValueError):
    """Raised before sending: a text field looks like a credential.

    The service would refuse it with ``secret_in_caption``. The client refuses
    first so the string never leaves the process. The value is not echoed.
    """

    def __init__(self, field: str) -> None:
        super().__init__(f"{field} contains a credential-shaped string; it was not sent")
        self.field = field


_BY_CODE: Dict[str, Type[APIError]] = {
    "malformed": MalformedError,
    "access_required": AuthenticationError,
    "credential_invalid": CredentialInvalidError,
    "not_enrolled": ForbiddenError,
    "forbidden": ForbiddenError,
    "training_export_blocked": ForbiddenError,
    "not_found": NotFoundError,
    "idempotency_conflict": IdempotencyConflictError,
    "state_conflict": StateConflictError,
    "payload_too_large": PayloadTooLargeError,
    "unsupported_media": UnsupportedMediaError,
    "validation_failed": ValidationFailedError,
    "secret_in_caption": SecretInCaptionError,
    "rate_limited": RateLimitedError,
    "policy_missing": PolicyMissingError,
    "processing_unavailable": ProcessingUnavailableError,
    "cursor_expired": CursorExpiredError,
}

_BY_STATUS: Dict[int, Type[APIError]] = {
    400: MalformedError,
    401: AuthenticationError,
    403: ForbiddenError,
    404: NotFoundError,
    409: ConflictError,
    410: CursorExpiredError,
    413: PayloadTooLargeError,
    415: UnsupportedMediaError,
    422: ValidationFailedError,
    429: RateLimitedError,
    503: ServiceUnavailableError,
}

_DEFAULT_CODE: Dict[int, str] = {
    400: "malformed",
    401: "credential_invalid",
    403: "forbidden",
    404: "not_found",
    410: "cursor_expired",
    413: "payload_too_large",
    415: "unsupported_media",
    422: "validation_failed",
    429: "rate_limited",
}


def error_class(code: str, status: int) -> Type[APIError]:
    """The exception class for a code, falling back to the HTTP status."""
    return _BY_CODE.get(code) or _BY_STATUS.get(status) or APIError


def default_code(status: int) -> str:
    """The code assumed when a response has no JSON error body (for example a WAF block)."""
    return _DEFAULT_CODE.get(status, f"http_{status}")
