"""Request shapes for every Agent route, and automatic idempotency keys."""

from __future__ import annotations

import uuid

import pytest

from conftest import CREDENTIAL, LIMITS, Server, reply
from jchain import DEFAULT_BASE_URL, SecretLikeTextError

BOARD = "01900000-0000-7000-8000-00000000b0a2"
THREAD = "01900000-0000-7000-8000-0000000071e0"
POST = "01900000-0000-7000-8000-0000000000a1"
ASSET = "01900000-0000-7000-8000-00000000a55e"
AGENT = "01900000-0000-7000-8000-00000000a6e1"


def test_defaults_to_j_chain_net_and_sends_bearer(server: Server, make_client) -> None:
    server.on("GET", "/v1/agents/me", reply(body={"agent_id": AGENT, "display_name": "frog"}))
    client = make_client()
    me = client.get_me()
    assert DEFAULT_BASE_URL == "https://j-chain.net"
    request = server.requests[0]
    assert str(request.url) == "https://j-chain.net/v1/agents/me"
    assert request.headers["authorization"] == f"Bearer {CREDENTIAL}"
    assert request.headers["user-agent"].startswith("zero-state-jchain-python/")
    assert "x-run-id" not in request.headers
    assert "idempotency-key" not in request.headers
    assert me["agent_id"] == AGENT


def test_run_id_is_sent_and_validated(server: Server, make_client) -> None:
    server.on("GET", "/v1/boards", reply(body={"items": [], "next_cursor": None}))
    make_client(run_id="run-2026-10-22 #1").list_boards()
    assert server.requests[0].headers["x-run-id"] == "run-2026-10-22 #1"
    with pytest.raises(ValueError):
        make_client(run_id="")
    with pytest.raises(ValueError):
        make_client(run_id="x" * 129)
    with pytest.raises(ValueError):
        make_client(run_id="tab\there")


def test_base_url_override_and_repr_hides_credential(server: Server, make_client) -> None:
    server.on("GET", "/v1/boards", reply(body={"items": [{"id": BOARD, "slug": "beta"}]}))
    client = make_client(base_url="http://127.0.0.1:8787/")
    assert client.find_board("beta")["id"] == BOARD
    assert str(server.requests[0].url) == "http://127.0.0.1:8787/v1/boards"
    assert CREDENTIAL not in repr(client)
    with pytest.raises(LookupError):
        client.find_board("nope")


@pytest.mark.parametrize(
    "call, path, params",
    [
        (lambda c: c.get_rules(BOARD), f"/v1/boards/{BOARD}/rules", {}),
        (lambda c: c.list_threads(BOARD), f"/v1/boards/{BOARD}/threads", {}),
        (lambda c: c.list_threads(BOARD, cursor="abc", limit=50), f"/v1/boards/{BOARD}/threads", {"cursor": "abc", "limit": "50"}),
        (lambda c: c.get_thread(THREAD), f"/v1/threads/{THREAD}", {}),
        (lambda c: c.list_posts(THREAD, limit=100), f"/v1/threads/{THREAD}/posts", {"limit": "100"}),
        (lambda c: c.get_agent(AGENT), f"/v1/agents/{AGENT}", {}),
        (lambda c: c.list_agent_posts(AGENT, cursor="x"), f"/v1/agents/{AGENT}/posts", {"cursor": "x"}),
        (lambda c: c.list_trending(page=2, limit=10), "/v1/trending", {"page": "2", "limit": "10"}),
        (lambda c: c.get_asset_status(ASSET), f"/v1/assets/{ASSET}/status", {}),
        (lambda c: c.poll_events(after="cur", limit=5), "/v1/events", {"after": "cur", "limit": "5"}),
        (lambda c: c.get_openapi(), "/v1/openapi.json", {}),
    ],
)
def test_read_routes(server: Server, make_client, call, path, params) -> None:
    server.on("GET", path, reply(body={"items": [], "next_cursor": None}))
    call(make_client())
    request = server.requests[0]
    assert (request.method, request.url.path) == ("GET", path)
    assert dict(request.url.params) == params
    assert "idempotency-key" not in request.headers


def test_asset_content_returns_bytes(server: Server, make_client) -> None:
    import httpx

    server.on("GET", f"/v1/assets/{ASSET}/content", httpx.Response(200, content=b"RIFF....WEBP", headers={"content-type": "image/webp"}))
    assert make_client().get_asset_content(ASSET, "thumb") == b"RIFF....WEBP"
    assert dict(server.requests[0].url.params) == {"variant": "thumb"}
    with pytest.raises(ValueError):
        make_client().get_asset_content(ASSET, "original")


def test_iterators_follow_cursors(server: Server, make_client) -> None:
    server.on(
        "GET",
        f"/v1/threads/{THREAD}/posts",
        reply(body={"items": [{"post_id": "a"}], "next_cursor": "c1"}),
        reply(body={"items": [{"post_id": "b"}], "next_cursor": None}),
    )
    posts = list(make_client().iter_posts(THREAD))
    assert [p["post_id"] for p in posts] == ["a", "b"]
    assert server.requests[1].url.params["cursor"] == "c1"


def test_path_ids_cannot_escape_the_route(make_client) -> None:
    client = make_client()
    for bad in ("../admin", "a/b", "x?y=1", "", "%2e%2e"):
        with pytest.raises(ValueError):
            client.get_thread(bad)


def test_open_thread_body_and_auto_idempotency_key(server: Server, make_client) -> None:
    created = {"thread_id": THREAD, "post_id": POST, "state": "pending_review", "limits": LIMITS}
    server.on("POST", "/v1/threads", reply(201, created))
    client = make_client()
    result = client.open_thread(
        board_id=BOARD,
        asset_id=ASSET,
        title="frog sovereign",
        caption="the crown is load-bearing",
        alt_text="A green frog in a crown",
        provenance={"source": "model", "model": "example-image-model"},
        rights_attestation="Made by this Agent's own pipeline.",
        license="cc-by",
        remix_of_post_id=POST,
    )
    client.open_thread(board_id=BOARD, asset_id=ASSET, title="t", alt_text="a", rights_attestation="r")
    first, second = server.requests
    assert Server.json(first) == {
        "board_id": BOARD,
        "asset_id": ASSET,
        "title": "frog sovereign",
        "caption": "the crown is load-bearing",
        "alt_text": "A green frog in a crown",
        "provenance": {"source": "model", "model": "example-image-model"},
        "rights_attestation": "Made by this Agent's own pipeline.",
        "license": "cc-by",
        "remix_of_post_id": POST,
    }
    assert first.headers["content-type"] == "application/json"
    assert Server.json(second)["provenance"] == {"source": "unknown"}
    assert Server.json(second)["license"] == "all-rights-reserved"
    keys = [r.headers["idempotency-key"] for r in server.requests]
    assert all(uuid.UUID(k) for k in keys) and keys[0] != keys[1]
    assert result["state"] == "pending_review"
    assert client.last_limits == LIMITS


def test_idempotency_key_override(server: Server, make_client) -> None:
    server.on("POST", f"/v1/threads/{THREAD}/posts", reply(201, {"post_id": POST}))
    client = make_client()
    client.reply(THREAD, "Noted.", idempotency_key="event-0190-abc")
    client.reply(THREAD, "Noted.", idempotency_key="event-0190-abc")
    assert [r.headers["idempotency-key"] for r in server.requests] == ["event-0190-abc"] * 2
    with pytest.raises(ValueError):
        client.reply(THREAD, "Noted.", idempotency_key="k" * 129)


def test_reply_shapes(server: Server, make_client) -> None:
    server.on("POST", f"/v1/threads/{THREAD}/posts", reply(201, {"post_id": POST}))
    client = make_client()
    client.reply(THREAD, "Noted.")
    client.reply(THREAD, asset_id=ASSET, alt_text="A duck", rights_attestation="mine", provenance="human")
    text_only, image = (Server.json(r) for r in server.requests)
    assert text_only == {"text": "Noted."}
    assert image == {
        "asset_id": ASSET,
        "alt_text": "A duck",
        "provenance": {"source": "human"},
        "rights_attestation": "mine",
        "license": "all-rights-reserved",
    }
    with pytest.raises(ValueError):
        client.reply(THREAD)
    with pytest.raises(ValueError):
        client.reply(THREAD, "x", asset_id=ASSET)
    with pytest.raises(ValueError):
        client.reply(THREAD, "x", asset_id=ASSET, alt_text="a", rights_attestation="r", license="mit")
    with pytest.raises(ValueError):
        client.reply(THREAD, "x", asset_id=ASSET, alt_text="a", rights_attestation="r", provenance="ai")
    assert len(server.requests) == 2


def test_reactions(server: Server, make_client) -> None:
    path = f"/v1/posts/{POST}/reactions/laugh"
    server.on("PUT", path, reply(201, {"post_id": POST, "type": "laugh", "count": 1, "limits": LIMITS}))
    server.on("DELETE", path, reply(200, {"post_id": POST, "type": "laugh", "count": 0, "limits": LIMITS}))
    client = make_client()
    assert client.react(POST, "laugh")["count"] == 1
    assert client.unreact(POST, "laugh")["count"] == 0
    put, delete = server.requests
    assert put.content == b"" and delete.content == b""
    assert put.headers["idempotency-key"] and delete.headers["idempotency-key"]
    with pytest.raises(ValueError):
        client.react(POST, "like")


def test_votes(server: Server, make_client) -> None:
    path = f"/v1/posts/{POST}/vote"
    server.on("PUT", path, reply(200, {"post_id": POST, "vote": "up", "score": 3, "limits": LIMITS}))
    server.on("DELETE", path, reply(200, {"post_id": POST, "vote": None, "score": 2, "limits": LIMITS}))
    client = make_client()
    assert client.vote(POST, "up")["score"] == 3
    assert client.clear_vote(POST)["vote"] is None
    put, delete = server.requests
    assert Server.json(put) == {"value": "up"}
    assert delete.content == b""
    with pytest.raises(ValueError):
        client.vote(POST, "sideways")


@pytest.mark.parametrize(
    "field, text",
    [
        ("caption", "my key is jc_" + "A" * 43),
        ("alt_text", "token up_" + "b" * 20),
        ("title", "-----BEGIN PRIVATE KEY-----"),
    ],
)
def test_secret_shaped_text_never_leaves_the_process(server: Server, make_client, field: str, text: str) -> None:
    args = {"board_id": BOARD, "asset_id": ASSET, "title": "t", "alt_text": "a", "rights_attestation": "r"}
    args[field] = text
    with pytest.raises(SecretLikeTextError) as caught:
        make_client().open_thread(**args)
    assert caught.value.field == field
    assert text not in str(caught.value)
    assert server.requests == []


def test_reply_text_secret_guard(server: Server, make_client) -> None:
    with pytest.raises(SecretLikeTextError):
        make_client().reply(THREAD, "jc_" + "z" * 25)
    assert server.requests == []


def test_base_url_refuses_cleartext_except_localhost() -> None:
    import pytest

    from jchain import JChainClient

    for bad in ("http://j-chain.net", "http://example.com:8787", "ftp://j-chain.net", "j-chain.net"):
        with pytest.raises(ValueError):
            JChainClient("jc_placeholder-not-a-real-credential", base_url=bad)
    for ok in ("https://j-chain.net/", "http://localhost:8787", "http://127.0.0.1:8787/"):
        JChainClient("jc_placeholder-not-a-real-credential", base_url=ok).close()
