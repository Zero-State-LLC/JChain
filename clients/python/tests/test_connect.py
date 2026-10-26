from __future__ import annotations

from typing import List

import httpx
import pytest

from jchain import ConnectCode, ConnectDeniedError, connect_agent

CREDENTIAL = "jc_" + "x" * 43
DEVICE = "dc_" + "d" * 43
STARTED = {
    "device_code": DEVICE,
    "user_code": "BCDF-GHJK",
    "verification_uri": "https://j-chain.net/operator/connect",
    "verification_uri_complete": "https://j-chain.net/operator/connect?code=BCDF-GHJK",
    "expires_in": 600,
    "interval": 5,
}


def scripted(replies: List[httpx.Response], seen: List[httpx.Request]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return replies.pop(0)

    return httpx.MockTransport(handler)


def test_connect_waits_slows_down_and_returns_the_credential() -> None:
    seen: List[httpx.Request] = []
    replies = [
        httpx.Response(201, json=STARTED),
        httpx.Response(200, json={"state": "pending"}),
        httpx.Response(429, json={"error": {"code": "rate_limited", "message": "slow"}}, headers={"retry-after": "12"}),
        httpx.Response(200, json={"state": "approved", "agent_id": "a1", "credential": CREDENTIAL}),
    ]
    shown: List[ConnectCode] = []
    waits: List[float] = []
    result = connect_agent(
        "Ada",
        "m",
        on_code=shown.append,
        transport=scripted(replies, seen),
        sleep=waits.append,
    )
    assert result.credential == CREDENTIAL
    assert result.agent_id == "a1"
    assert shown[0].user_code == "BCDF-GHJK"
    assert str(seen[0].url) == "https://j-chain.net/v1/connect"
    assert str(seen[1].url) == "https://j-chain.net/v1/connect/token"
    assert waits == [5.0, 5.0, 12.0]


def test_connect_raises_when_denied() -> None:
    seen: List[httpx.Request] = []
    replies = [httpx.Response(201, json=STARTED), httpx.Response(200, json={"state": "denied"})]
    with pytest.raises(ConnectDeniedError):
        connect_agent("Ada", "m", on_code=lambda code: None, transport=scripted(replies, seen), sleep=lambda s: None)


def test_connect_sends_an_optional_harness() -> None:
    import json

    seen: List[httpx.Request] = []
    replies = [
        httpx.Response(201, json=STARTED),
        httpx.Response(200, json={"state": "approved", "agent_id": "a1", "credential": CREDENTIAL}),
    ]
    connect_agent(
        "Ada",
        "m",
        on_code=lambda code: None,
        transport=scripted(replies, seen),
        sleep=lambda s: None,
        declared_harness={"name": "Hermes", "version": "0.9"},
    )
    assert json.loads(seen[0].content) == {
        "display_name": "Ada",
        "declared_model": "m",
        "declared_harness": {"name": "Hermes", "version": "0.9"},
    }
