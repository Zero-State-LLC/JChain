"""The upload state machine: reserve, content, thumb, complete, status."""

from __future__ import annotations

import hashlib

import pytest

import jchain
from conftest import LIMITS, Clock, Server, error, reply, webp

ASSET = "01900000-0000-7000-8000-00000000a55e"
TOKEN = "up_placeholder-upload-token-not-real-000000000"


def status(state: str, reason: str = "") -> object:
    body = {"asset_id": ASSET, "state": state}
    if reason:
        body["reason_code"] = reason
    return reply(body=body)


def flow(server: Server, *statuses: object) -> None:
    server.on("POST", "/v1/uploads", reply(201, {"asset_id": ASSET, "upload_token": TOKEN, "expires_at": "2026-10-23T12:00:00Z", "limits": LIMITS}))
    server.on("PUT", f"/v1/uploads/{ASSET}/content", reply(body={"asset_id": ASSET, "state": "reserved", "limits": LIMITS}))
    server.on("PUT", f"/v1/uploads/{ASSET}/thumb", reply(body={"asset_id": ASSET, "state": "reserved", "limits": LIMITS}))
    server.on("POST", f"/v1/uploads/{ASSET}/complete", reply(202, {"asset_id": ASSET, "state": "uploaded", "limits": LIMITS}))
    server.on("GET", f"/v1/assets/{ASSET}/status", *statuses)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def test_small_image_flow(server: Server, make_client, clock: Clock) -> None:
    image = webp(300, 200)
    flow(server, status("uploaded"), status("validating"), status("ready"))
    result = make_client().upload_image(image)
    assert result["state"] == "ready"
    assert server.calls() == [
        ("POST", "/v1/uploads"),
        ("PUT", f"/v1/uploads/{ASSET}/content"),
        ("POST", f"/v1/uploads/{ASSET}/complete"),
        ("GET", f"/v1/assets/{ASSET}/status"),
        ("GET", f"/v1/assets/{ASSET}/status"),
        ("GET", f"/v1/assets/{ASSET}/status"),
    ]
    reserve, put, complete = server.requests[:3]
    assert Server.json(reserve) == {"content_type": "image/webp", "byte_size": len(image), "sha256": sha(image)}
    assert put.content == image
    assert put.headers["upload-token"] == TOKEN
    assert put.headers["content-type"] == "application/octet-stream"
    assert "authorization" not in put.headers
    assert complete.content == b""
    keys = {r.headers["idempotency-key"] for r in server.requests[:3]}
    assert len(keys) == 1, "one key covers every step so a rerun resumes the same Asset"
    assert clock.sleeps == [0.5, 1.0]


def test_large_image_sends_declared_thumbnail(server: Server, make_client) -> None:
    display, thumb = webp(1280, 640), webp(320, 160)
    flow(server, status("ready"))
    make_client().upload_image(display, thumb, idempotency_key="upload-001")
    assert server.calls()[:4] == [
        ("POST", "/v1/uploads"),
        ("PUT", f"/v1/uploads/{ASSET}/content"),
        ("PUT", f"/v1/uploads/{ASSET}/thumb"),
        ("POST", f"/v1/uploads/{ASSET}/complete"),
    ]
    assert Server.json(server.requests[0])["thumb"] == {"byte_size": len(thumb), "sha256": sha(thumb)}
    assert server.requests[2].content == thumb
    assert {r.headers["idempotency-key"] for r in server.requests[:4]} == {"upload-001"}


def test_encoded_image_is_accepted_directly(server: Server, make_client) -> None:
    from PIL import Image
    import io

    buffer = io.BytesIO()
    Image.new("RGB", (900, 400), (1, 2, 3)).save(buffer, "PNG")
    encoded = jchain.encode_for_jchain(buffer.getvalue())
    flow(server, status("ready"))
    make_client().upload_image(encoded)
    assert server.requests[1].content == encoded.display
    assert server.requests[2].content == encoded.thumb


def test_dedup_returns_without_sending_bytes(server: Server, make_client) -> None:
    server.on("POST", "/v1/uploads", reply(200, {"asset_id": ASSET, "deduped": True, "limits": LIMITS}))
    result = make_client().upload_image(webp(64, 64))
    assert result == {"asset_id": ASSET, "state": "ready", "deduped": True}
    assert server.calls() == [("POST", "/v1/uploads")]


def test_rejected_asset_raises_with_reason(server: Server, make_client) -> None:
    flow(server, status("validating"), status("rejected", "invalid_image"))
    with pytest.raises(jchain.UploadRejectedError) as caught:
        make_client().upload_image(webp(100, 100))
    assert (caught.value.asset_id, caught.value.state, caught.value.reason_code) == (ASSET, "rejected", "invalid_image")


def test_wait_times_out_with_backoff_cap(server: Server, make_client, clock: Clock) -> None:
    flow(server, status("validating"))
    with pytest.raises(jchain.UploadTimeoutError) as caught:
        make_client().upload_image(webp(100, 100), timeout=20)
    assert caught.value.asset_id == ASSET and caught.value.state == "validating"
    assert clock.sleeps[:5] == [0.5, 1.0, 2.0, 4.0, 5.0]
    assert max(clock.sleeps) == 5.0
    assert sum(clock.sleeps) == pytest.approx(20)


def test_wait_false_stops_after_complete(server: Server, make_client) -> None:
    flow(server, status("ready"))
    assert make_client().upload_image(webp(100, 100), wait=False) == {"asset_id": ASSET, "state": "uploaded"}
    assert server.calls()[-1] == ("POST", f"/v1/uploads/{ASSET}/complete")


def test_rate_limited_step_is_retried_with_same_key(server: Server, make_client, clock: Clock) -> None:
    flow(server, status("ready"))
    server.routes[("PUT", f"/v1/uploads/{ASSET}/content")].insert(
        0, error("rate_limited", 429, headers={"retry-after": "1"}, limits=LIMITS)
    )
    make_client().upload_image(webp(100, 100))
    puts = [r for r in server.requests if r.method == "PUT"]
    assert len(puts) == 2 and puts[0].headers["idempotency-key"] == puts[1].headers["idempotency-key"]
    assert clock.sleeps[0] == 1.0


def test_server_error_mid_flow_is_typed(server: Server, make_client) -> None:
    flow(server)
    server.routes[("POST", f"/v1/uploads/{ASSET}/complete")] = [error("processing_unavailable", 503, limits=LIMITS)]
    with pytest.raises(jchain.ProcessingUnavailableError):
        make_client().upload_image(webp(100, 100))


@pytest.mark.parametrize(
    "display, thumb, reason",
    [
        (lambda: webp(321, 100), lambda: None, "invalid_image"),  # over 320 needs a thumb
        (lambda: webp(1280, 640), lambda: webp(320, 320), "invalid_image"),  # wrong shape
        (lambda: webp(1280, 640), lambda: webp(321, 160), "invalid_image"),  # thumb over 320
        (lambda: b"\x89PNG\r\n\x1a\n" + b"\x00" * 30, lambda: None, "unsupported_type"),
        (lambda: open_fixture("animated.webp"), lambda: None, "animated"),
    ],
)
def test_local_checks_fail_before_any_request(server: Server, make_client, display, thumb, reason) -> None:
    with pytest.raises(jchain.WebPError) as caught:
        make_client().upload_image(display(), thumb())
    assert caught.value.reason == reason
    assert server.requests == []


def open_fixture(name: str) -> bytes:
    from pathlib import Path

    path = Path(__file__).resolve().parents[3] / "test" / "fixtures" / name
    if not path.exists():
        pytest.skip(f"repo fixture {name} not present")
    return path.read_bytes()
