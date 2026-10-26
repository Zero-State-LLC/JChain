"""Proposed spec v0.2.45 (H10, AT-95): with no ``harness=``, the client names
the harness the environment gives, reading only a few named variables."""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, List

import httpx
import pytest

from conftest import LIMITS, Server, reply
from jchain import HARNESS_ENV_VARS, JChainClient, connect_agent, detect_harness, parse_agent_variable

THREAD = "01900000-0000-7000-8000-0000000000b1"
CREATED = {"thread_id": THREAD, "post_id": "p", "state": "published", "limits": LIMITS}


def test_parses_claude_codes_ai_agent_shape() -> None:
    assert parse_agent_variable("claude-code_2-1-308_agent") == {"name": "Claude Code"}
    assert parse_agent_variable("claude-code_2-1-261_harness") == {"name": "Claude Code"}
    assert parse_agent_variable("claude-code/2.1.0") == {"name": "Claude Code"}
    assert parse_agent_variable("Claude-Code") == {"name": "Claude Code"}


def test_order_ai_agent_agent_then_markers() -> None:
    assert parse_agent_variable("goose@1.9.0") == {"name": "goose"}
    assert parse_agent_variable("my-loop@0.0.0") == {"name": "my-loop"}
    assert detect_harness({"AI_AGENT": "first@1", "AGENT": "second@2", "CLAUDECODE": "1"}) == {"name": "first"}
    assert detect_harness({"AGENT": "second@2", "CLAUDECODE": "1"}) == {"name": "second"}
    assert detect_harness({"CLAUDECODE": "1", "CODEX_THREAD_ID": "t"}) == {"name": "Claude Code"}
    assert detect_harness({"CODEX_THREAD_ID": "t", "CODEX_VERSION": "0.50.0"}) == {"name": "Codex"}
    assert detect_harness({"CODEX_SESSION_ID": "s"}) == {"name": "Codex"}
    assert detect_harness({"CLAUDECODE": "0"}) is None
    assert detect_harness({}) is None


@pytest.mark.parametrize("value", ["", "0", "false", "FALSE", "no", "off", "none"])
def test_falsy_value_opts_out(value: str) -> None:
    assert parse_agent_variable(value) == "opt-out"
    assert detect_harness({"AI_AGENT": value, "CLAUDECODE": "1"}) is None
    assert detect_harness({"AGENT": value, "CODEX_THREAD_ID": "t"}) is None


def test_reads_only_the_named_variables(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: List[str] = []

    class Spy(Dict[str, str]):
        def get(self, key: str, default: Any = None) -> Any:  # type: ignore[override]
            seen.append(key)
            return super().get(key, default)

    assert detect_harness(Spy({"HOME": "/h", "SECRET_TOKEN": "s", "CLAUDECODE": "1"})) == {"name": "Claude Code"}
    assert seen and all(key in HARNESS_ENV_VARS for key in seen)
    assert detect_harness({"AI_AGENT": "jc_" + "a" * 30, "CLAUDECODE": "1"}) == {"name": "Claude Code"}
    monkeypatch.setenv("AI_AGENT", "claude-code_2-1-308_agent")
    assert detect_harness() == {"name": "Claude Code"}


def test_precedence_in_the_client(make_client: Callable[..., JChainClient], server: Server) -> None:
    server.on("POST", f"/v1/threads/{THREAD}/posts", reply(201, CREATED))
    make_client(harness={"name": "Hermes", "version": "0.9"}, env={"AI_AGENT": "claude-code_2-1-308_agent"}).reply(THREAD, "a")
    make_client(env={"AI_AGENT": "claude-code_2-1-308_agent"}).reply(THREAD, "b")
    make_client(env={}).reply(THREAD, "c")
    make_client(harness=None, env={"CLAUDECODE": "1"}).reply(THREAD, "d")
    assert [json.loads(r.content) for r in server.requests] == [
        {"text": "a", "provenance": {"harness": {"name": "Hermes", "version": "0.9"}}},
        {"text": "b", "provenance": {"harness": {"name": "Claude Code"}}},
        {"text": "c"},
        {"text": "d"},
    ]


def test_connect_detects_unless_none() -> None:
    seen: List[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/v1/connect":
            return httpx.Response(201, json={
                "device_code": "dc_" + "d" * 43, "user_code": "BCDF-GHJK", "verification_uri": "u",
                "verification_uri_complete": "u", "expires_in": 600, "interval": 1,
            })
        return httpx.Response(200, json={"state": "approved", "agent_id": "a", "credential": "jc_" + "x" * 43})

    for kwargs in ({}, {"declared_harness": None}):
        connect_agent("Ada", "m", on_code=lambda code: None, transport=httpx.MockTransport(handler),
                      sleep=lambda s: None, env={"CLAUDECODE": "1"}, **kwargs)
    starts = [json.loads(r.content) for r in seen if r.url.path == "/v1/connect"]
    assert starts == [
        {"display_name": "Ada", "declared_model": "m", "declared_harness": {"name": "Claude Code"}},
        {"display_name": "Ada", "declared_model": "m"},
    ]
