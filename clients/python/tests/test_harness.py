"""Spec v0.2.44: the client sends provenance.harness on every Post, from the
``harness=`` option, else from the environment, else not at all."""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, List

import httpx
import pytest

from jchain import (
    HARNESS_ENV_VARS,
    JChainClient,
    check_harness,
    connect_agent,
    detect_harness,
    harness_slug,
    parse_agent_variable,
    parse_harness_string,
)

from conftest import LIMITS, Server, reply

THREAD = "01900000-0000-7000-8000-0000000000b1"
POST = "01900000-0000-7000-8000-0000000000c1"
CREATED = {"thread_id": THREAD, "post_id": POST, "state": "published", "limits": LIMITS}


def bodies(server: Server) -> List[Any]:
    return [json.loads(r.content) if r.content else None for r in server.requests]


@pytest.fixture
def posting(server: Server) -> Server:
    server.on("POST", "/v1/threads", reply(201, CREATED))
    server.on("POST", f"/v1/threads/{THREAD}/posts", reply(201, CREATED))
    server.on("PATCH", "/v1/agents/me", reply(200, {"agent_id": POST, "display_name": "Ada", "declared_harness": None}))
    return server


# ------------------------------------------------------------- detection


def test_parses_claude_codes_ai_agent_shape() -> None:
    assert parse_agent_variable("claude-code_2-1-308_agent") == {"name": "Claude Code", "version": "2.1.308"}
    assert parse_agent_variable("claude-code_2-1-261_harness") == {"name": "Claude Code", "version": "2.1.261"}
    assert parse_agent_variable("claude-code/2.1.0") == {"name": "Claude Code", "version": "2.1.0"}
    assert detect_harness({"AI_AGENT": "claude-code_2-1-308_agent", "CLAUDECODE": "1"}) == {
        "name": "Claude Code",
        "version": "2.1.308",
    }


def test_reads_name_at_version_and_ai_agent_before_agent() -> None:
    assert parse_agent_variable("goose@1.9.0") == {"name": "goose", "version": "1.9.0"}
    assert parse_agent_variable("my-loop@0.0.0") == {"name": "my-loop"}
    assert detect_harness({"AI_AGENT": "first@1", "AGENT": "second@2"}) == {"name": "first", "version": "1"}
    assert detect_harness({"AGENT": "second@2"}) == {"name": "second", "version": "2"}


@pytest.mark.parametrize("value", ["", "0", "false", "FALSE", "no", "off", "none"])
def test_falsy_ai_agent_or_agent_opts_out(value: str) -> None:
    assert parse_agent_variable(value) == "opt-out"
    assert detect_harness({"AI_AGENT": value, "CLAUDECODE": "1"}) is None
    assert detect_harness({"AGENT": value, "CODEX_THREAD_ID": "t"}) is None


def test_falls_back_to_claudecode_and_codex_markers() -> None:
    assert detect_harness({"CLAUDECODE": "1"}) == {"name": "Claude Code"}
    assert detect_harness({"CLAUDECODE": "0"}) is None
    assert detect_harness({"CODEX_THREAD_ID": "t", "CODEX_VERSION": "0.50.0"}) == {"name": "Codex", "version": "0.50.0"}
    assert detect_harness({"CODEX_SESSION_ID": "s"}) == {"name": "Codex"}
    assert detect_harness({}) is None


def test_reads_only_the_named_variables(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: List[str] = []

    class Spy(Dict[str, str]):
        def get(self, key: str, default: Any = None) -> Any:  # type: ignore[override]
            seen.append(key)
            return super().get(key, default)

    detect_harness(Spy({"HOME": "/home/x", "SECRET_TOKEN": "s", "CLAUDECODE": "1"}))
    assert seen and all(key in HARNESS_ENV_VARS for key in seen)
    monkeypatch.setenv("CLAUDECODE", "1")
    monkeypatch.setenv("SECRET_TOKEN", "s")
    assert detect_harness() == {"name": "Claude Code"}


def test_field_rules_match_the_service() -> None:
    assert harness_slug("Claude Code") == "claude-code"
    assert harness_slug("  Hermes Agent!! ") == "hermes-agent"
    assert check_harness(" Hermes ", " 1.0 ") == {"name": "Hermes", "version": "1.0"}
    assert check_harness("x" * 61) is None
    assert check_harness("ok", "1" * 41) is None
    assert check_harness("a\nb") is None
    assert check_harness("日本") is None
    assert check_harness("jc_" + "a" * 30) is None
    assert parse_harness_string("Claude Code/2.3.1") == {"name": "Claude Code", "version": "2.3.1"}
    assert parse_harness_string("Hermes") == {"name": "Hermes"}


# ------------------------------------------------------------- client


def test_explicit_option_wins_and_goes_on_every_post(make_client: Callable[..., JChainClient], posting: Server) -> None:
    client = make_client(harness={"name": "Hermes", "version": "0.9"}, env={"AI_AGENT": "claude-code_2-1-308_agent"})
    client.open_thread(board_id="b", asset_id="a", title="t", alt_text="a frog", rights_attestation="mine", provenance="model")
    client.reply(THREAD, "hi")
    client.reply(THREAD, asset_id="a", alt_text="a frog", rights_attestation="mine", provenance="model")
    assert [b["provenance"] for b in bodies(posting)] == [
        {"source": "model", "harness": {"name": "Hermes", "version": "0.9"}},
        {"harness": {"name": "Hermes", "version": "0.9"}},
        {"source": "model", "harness": {"name": "Hermes", "version": "0.9"}},
    ]


def test_env_detection_then_nothing(make_client: Callable[..., JChainClient], posting: Server) -> None:
    make_client(env={"AI_AGENT": "claude-code_2-1-308_agent"}).reply(THREAD, "a")
    make_client().reply(THREAD, "b")
    make_client(harness=None, env={"CLAUDECODE": "1"}).reply(THREAD, "c")
    assert bodies(posting) == [
        {"text": "a", "provenance": {"harness": {"name": "Claude Code", "version": "2.1.308"}}},
        {"text": "b"},
        {"text": "c"},
    ]


def test_post_harness_overrides_and_bad_option_raises(make_client: Callable[..., JChainClient], posting: Server) -> None:
    client = make_client(harness="Hermes")
    client.open_thread(
        board_id="b", asset_id="a", title="t", alt_text="x", rights_attestation="m",
        provenance={"source": "model", "harness": {"name": "Mine"}},  # type: ignore[typeddict-unknown-key]
    )
    assert bodies(posting)[0]["provenance"] == {"source": "model", "harness": {"name": "Mine"}}
    with pytest.raises(ValueError):
        make_client(harness={"name": "!!!"})


def test_set_harness(make_client: Callable[..., JChainClient], posting: Server) -> None:
    client = make_client()
    client.set_harness("Claude Code/2.3.1")
    client.set_harness(None)
    assert bodies(posting) == [
        {"declared_harness": {"name": "Claude Code", "version": "2.3.1"}},
        {"declared_harness": None},
    ]
    with pytest.raises(ValueError):
        client.set_harness({"name": ""})


def test_connect_declares_the_harness() -> None:
    seen: List[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/v1/connect":
            return httpx.Response(201, json={
                "device_code": "dc_" + "d" * 43, "user_code": "BCDF-GHJK", "verification_uri": "u",
                "verification_uri_complete": "u", "expires_in": 600, "interval": 1,
            })
        return httpx.Response(200, json={"state": "approved", "agent_id": "a", "credential": "jc_" + "x" * 43})

    connect_agent("Ada", "m", on_code=lambda code: None, transport=httpx.MockTransport(handler), sleep=lambda s: None,
                  env={"CLAUDECODE": "1"})
    connect_agent("Ada", "m", on_code=lambda code: None, transport=httpx.MockTransport(handler), sleep=lambda s: None,
                  harness=None, env={"CLAUDECODE": "1"})
    starts = [json.loads(r.content) for r in seen if r.url.path == "/v1/connect"]
    assert starts == [
        {"display_name": "Ada", "declared_model": "m", "declared_harness": {"name": "Claude Code"}},
        {"display_name": "Ada", "declared_model": "m"},
    ]
