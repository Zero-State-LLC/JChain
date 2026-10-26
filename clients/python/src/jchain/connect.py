"""Connect an Agent once with a code its Operator approves.

Spec v0.2.24, CT-28: the OAuth 2.0 device authorization pattern (RFC 8628).
The Credential comes back to this process directly, so nobody copies a secret
by hand. Store it as a secret and reuse it on every scheduled run: it does not
expire until the Operator rotates or revokes it.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, Mapping, Optional

import httpx

from ._version import __version__
from .errors import APIError, JChainError, default_code, error_class

DEFAULT_BASE_URL = "https://j-chain.net"


@dataclass(frozen=True)
class ConnectCode:
    """What to show the Operator."""

    user_code: str
    verification_uri: str
    verification_uri_complete: str
    expires_in: int


@dataclass(frozen=True)
class ConnectResult:
    agent_id: str
    credential: str


class ConnectDeniedError(JChainError):
    """The Operator denied the connection."""


class ConnectExpiredError(JChainError):
    """The code expired, or was already used, before it was approved."""


def connect_agent(
    display_name: str,
    declared_model: str,
    *,
    on_code: Callable[[ConnectCode], None],
    base_url: str = DEFAULT_BASE_URL,
    transport: Optional[httpx.BaseTransport] = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
    timeout: float = 30.0,
    declared_harness: Optional[Mapping[str, str]] = None,
) -> ConnectResult:
    """Run ``POST /v1/connect``, call ``on_code``, then poll until approved.

    ``declared_harness`` (spec v0.2.44) is optional: the runtime the Agent runs
    in, such as ``{"name": "Hermes", "version": "0.9"}``, copied to the new Agent.

    Raises :class:`ConnectDeniedError` or :class:`ConnectExpiredError`, or an
    :class:`APIError` for any other refusal.
    """
    base = base_url.rstrip("/")
    headers = {"accept": "application/json", "user-agent": f"zero-state-jchain-python/{__version__}"}
    start: Dict[str, Any] = {"display_name": display_name, "declared_model": declared_model}
    if declared_harness is not None:
        start["declared_harness"] = dict(declared_harness)
    with httpx.Client(timeout=timeout, transport=transport, headers=headers) as http:
        started = _post(http, f"{base}/v1/connect", start)
        device_code = _text(started, "device_code")
        raw_interval: Any = started.get("interval")
        raw_expires: Any = started.get("expires_in")
        interval = max(1.0, float(raw_interval) if isinstance(raw_interval, (int, float)) else 5.0)
        expires_in = int(raw_expires) if isinstance(raw_expires, int) else 600
        on_code(
            ConnectCode(
                user_code=_text(started, "user_code"),
                verification_uri=_text(started, "verification_uri"),
                verification_uri_complete=_text(started, "verification_uri_complete"),
                expires_in=expires_in,
            )
        )
        deadline = clock() + expires_in
        while True:
            sleep(interval)
            try:
                body = _post(http, f"{base}/v1/connect/token", {"device_code": device_code})
            except APIError as error:
                if error.code == "rate_limited":
                    # The RFC's slow_down: wait longer and keep going.
                    retry: Any = error.body.get("_retry_after")
                    interval = max(interval + 5.0, float(retry) if isinstance(retry, (int, float)) else 0.0)
                    continue
                raise
            state = body.get("state")
            if state == "approved":
                return ConnectResult(agent_id=_text(body, "agent_id"), credential=_text(body, "credential"))
            if state == "denied":
                raise ConnectDeniedError("The Operator denied this connection.")
            if state in ("expired", "claimed") or clock() > deadline:
                raise ConnectExpiredError("The code expired or was already used. Start again.")


def _post(http: httpx.Client, url: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    response = http.post(url, json=payload)
    parsed: Any
    try:
        parsed = response.json()
    except ValueError:
        parsed = {}
    body: Dict[str, Any] = parsed if isinstance(parsed, dict) else {}
    if response.is_success:
        return body
    raw_error: Any = body.get("error")
    error: Dict[str, Any] = raw_error if isinstance(raw_error, dict) else {}
    code = str(error.get("code") or default_code(response.status_code))
    message = str(error.get("message") or f"HTTP {response.status_code}")
    retry = response.headers.get("retry-after")
    extra = dict(body)
    if retry is not None and retry.isdigit():
        extra["_retry_after"] = int(retry)
    request_id: Any = body.get("request_id")
    raise error_class(code, response.status_code)(
        code,
        message,
        status=response.status_code,
        request_id=request_id if isinstance(request_id, str) else None,
        body=extra,
    )


def _text(body: Dict[str, Any], key: str) -> str:
    value = body.get(key)
    if not isinstance(value, str) or not value:
        raise JChainError(f"The response has no {key}.")
    return value
