from __future__ import annotations

import io
import json
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

import httpx
import pytest

from jchain import JChainClient

CREDENTIAL = "jc_placeholder-not-a-real-credential"
REQUEST_ID = "01900000-0000-7000-8000-000000000000"
LIMITS = {
    "threads": {"remaining": 1, "reset_at": "2026-10-22T13:00:00Z"},
    "replies": {"remaining": 6, "reset_at": "2026-10-22T13:00:00Z"},
    "mutations": {"remaining": 20, "reset_at": "2026-10-23T00:00:00Z"},
    "events": {"remaining": 60, "reset_at": "2026-10-22T12:01:00Z"},
    "reactions": {"remaining": 30, "reset_at": "2026-10-22T12:01:00Z"},
}

Handler = Callable[[httpx.Request], httpx.Response]


def reply(status: int = 200, body: Optional[Dict[str, Any]] = None, headers: Optional[Dict[str, str]] = None) -> httpx.Response:
    payload = {"request_id": REQUEST_ID, **(body or {})}
    return httpx.Response(status, json=payload, headers={"x-request-id": REQUEST_ID, **(headers or {})})


def error(code: str, status: int, *, headers: Optional[Dict[str, str]] = None, **extra: Any) -> httpx.Response:
    return reply(status, {"error": {"code": code, "message": f"{code} message"}, **extra}, headers)


@dataclass
class Server:
    """Routes ``(METHOD, path)`` to queued responses and records every request."""

    routes: Dict[Tuple[str, str], List[Any]] = field(default_factory=dict)
    requests: List[httpx.Request] = field(default_factory=list)

    def on(self, method: str, path: str, *responses: Any) -> "Server":
        self.routes.setdefault((method, path), []).extend(responses)
        return self

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        queue = self.routes.get((request.method, request.url.path))
        if not queue:
            return error("not_found", 404)
        item = queue.pop(0) if len(queue) > 1 else queue[0]
        return item(request) if callable(item) else item

    def calls(self) -> List[Tuple[str, str]]:
        return [(r.method, r.url.path) for r in self.requests]

    @staticmethod
    def json(request: httpx.Request) -> Any:
        return json.loads(request.content) if request.content else None


class Clock:
    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: List[float] = []

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def server() -> Server:
    return Server()


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def make_client(server: Server, clock: Clock) -> Callable[..., JChainClient]:
    def build(**kwargs: Any) -> JChainClient:
        kwargs.setdefault("transport", httpx.MockTransport(server))
        kwargs.setdefault("sleep", clock.sleep)
        kwargs.setdefault("clock", clock)
        return JChainClient(CREDENTIAL, **kwargs)

    return build


def webp(width: int, height: int, *, mode: str = "RGB") -> bytes:
    from PIL import Image

    buffer = io.BytesIO()
    Image.new(mode, (width, height), (90, 200, 120)).save(buffer, "WEBP", quality=80)
    return buffer.getvalue()
