"""Error mapping and bounded 429 retries."""

from __future__ import annotations

import email.utils
import time

import httpx
import pytest

import jchain
from conftest import LIMITS, REQUEST_ID, Clock, Server, error, reply

THREAD = "01900000-0000-7000-8000-0000000071e0"
REPLY_PATH = f"/v1/threads/{THREAD}/posts"


@pytest.mark.parametrize(
    "code, status, cls",
    [
        ("malformed", 400, jchain.MalformedError),
        ("access_required", 401, jchain.AuthenticationError),
        ("credential_invalid", 401, jchain.CredentialInvalidError),
        ("not_enrolled", 403, jchain.ForbiddenError),
        ("forbidden", 403, jchain.ForbiddenError),
        ("training_export_blocked", 403, jchain.ForbiddenError),
        ("not_found", 404, jchain.NotFoundError),
        ("idempotency_conflict", 409, jchain.IdempotencyConflictError),
        ("state_conflict", 409, jchain.StateConflictError),
        ("payload_too_large", 413, jchain.PayloadTooLargeError),
        ("unsupported_media", 415, jchain.UnsupportedMediaError),
        ("validation_failed", 422, jchain.ValidationFailedError),
        ("secret_in_caption", 422, jchain.SecretInCaptionError),
        ("rate_limited", 429, jchain.RateLimitedError),
        ("policy_missing", 503, jchain.PolicyMissingError),
        ("processing_unavailable", 503, jchain.ProcessingUnavailableError),
        ("cursor_expired", 410, jchain.CursorExpiredError),
    ],
)
def test_every_spec_code_maps_to_a_typed_error(server: Server, make_client, code, status, cls) -> None:
    server.on("POST", REPLY_PATH, error(code, status, limits=LIMITS))
    with pytest.raises(cls) as caught:
        make_client(max_retries=0).reply(THREAD, "hi")
    err = caught.value
    assert isinstance(err, jchain.APIError) and isinstance(err, jchain.JChainError)
    assert (err.code, err.status, err.request_id) == (code, status, REQUEST_ID)
    assert err.limits == LIMITS
    assert err.message == f"{code} message"
    assert REQUEST_ID in str(err)


def test_secret_in_caption_is_a_validation_failure() -> None:
    assert issubclass(jchain.SecretInCaptionError, jchain.ValidationFailedError)
    assert issubclass(jchain.IdempotencyConflictError, jchain.ConflictError)


def test_cursor_expired_carries_resync(server: Server, make_client) -> None:
    server.on("GET", "/v1/events", error("cursor_expired", 410, resync="oldest-cursor"))
    with pytest.raises(jchain.CursorExpiredError) as caught:
        make_client().poll_events(after="stale")
    assert caught.value.resync == "oldest-cursor"


def test_unknown_code_falls_back_to_status(server: Server, make_client) -> None:
    server.on("GET", "/v1/boards", error("brand_new_code", 409))
    with pytest.raises(jchain.ConflictError) as caught:
        make_client().list_boards()
    assert caught.value.code == "brand_new_code"


def test_non_json_error_still_maps(server: Server, make_client) -> None:
    server.on("GET", "/v1/boards", httpx.Response(502, text="<html>bad gateway</html>", headers={"content-type": "text/html"}))
    with pytest.raises(jchain.APIError) as caught:
        make_client().list_boards()
    assert (caught.value.code, caught.value.status, caught.value.request_id) == ("http_502", 502, None)


def test_transport_failure_is_typed(make_client) -> None:
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route", request=request)

    with pytest.raises(jchain.TransportError):
        make_client(transport=httpx.MockTransport(boom)).list_boards()


def test_429_honours_retry_after_and_reuses_the_key(server: Server, make_client, clock: Clock) -> None:
    server.on(
        "POST",
        REPLY_PATH,
        error("rate_limited", 429, headers={"retry-after": "2"}, limits=LIMITS),
        reply(201, {"post_id": "p"}),
    )
    result = make_client().reply(THREAD, "hi")
    assert result["post_id"] == "p"
    assert clock.sleeps == [2.0]
    keys = {r.headers["idempotency-key"] for r in server.requests}
    assert len(server.requests) == 2 and len(keys) == 1


def test_429_retries_are_bounded(server: Server, make_client, clock: Clock) -> None:
    server.on("GET", "/v1/events", error("rate_limited", 429, headers={"retry-after": "5"}, limits=LIMITS))
    with pytest.raises(jchain.RateLimitedError) as caught:
        make_client(max_retries=2).poll_events()
    assert len(server.requests) == 3
    assert clock.sleeps == [5.0, 5.0]
    assert caught.value.retry_after == 5.0
    assert caught.value.limits == LIMITS


def test_long_retry_after_raises_at_once(server: Server, make_client, clock: Clock) -> None:
    server.on("POST", "/v1/threads", error("rate_limited", 429, headers={"retry-after": "3600"}, limits=LIMITS))
    with pytest.raises(jchain.RateLimitedError) as caught:
        make_client().open_thread(board_id="b", asset_id="a", title="t", alt_text="a", rights_attestation="r")
    assert len(server.requests) == 1
    assert clock.sleeps == []
    assert caught.value.retry_after == 3600.0


def test_429_without_body_or_header_backs_off(server: Server, make_client, clock: Clock) -> None:
    # The zone WAF rule can answer 429 before the Worker does: no JSON, no Retry-After.
    waf = httpx.Response(429, text="rate limited", headers={"content-type": "text/plain"})
    server.on("GET", "/v1/boards", waf, waf, reply(body={"items": []}))
    assert make_client().list_boards() == []
    assert clock.sleeps == [1.0, 2.0]


def test_retry_after_http_date(server: Server, make_client, clock: Clock) -> None:
    when = email.utils.formatdate(time.time() + 30, usegmt=True)
    server.on("GET", "/v1/boards", error("rate_limited", 429, headers={"retry-after": when}), reply(body={"items": []}))
    make_client().list_boards()
    assert len(clock.sleeps) == 1 and 25 <= clock.sleeps[0] <= 31


def test_max_retries_zero_never_sleeps(server: Server, make_client, clock: Clock) -> None:
    server.on("GET", "/v1/boards", error("rate_limited", 429, headers={"retry-after": "1"}))
    with pytest.raises(jchain.RateLimitedError):
        make_client(max_retries=0).list_boards()
    assert clock.sleeps == []


def test_limits_on_errors_update_last_limits(server: Server, make_client) -> None:
    server.on("POST", REPLY_PATH, error("state_conflict", 409, limits=LIMITS))
    client = make_client()
    with pytest.raises(jchain.StateConflictError):
        client.reply(THREAD, "into a locked thread")
    assert client.last_limits == LIMITS
