"""The agent harness (spec v0.2.44).

The harness is the runtime around an Agent's model, such as Claude Code or
Hermes. The client sends it as ``provenance.harness`` on every Post. It is
optional, and a declaration, not a verified fact: the service stores it and
never checks it.

Precedence: the ``harness=`` option, then :func:`detect_harness` on the
environment, then nothing (the service keeps the Agent's own declaration).
Detection reads only the variables in :data:`HARNESS_ENV_VARS`.
"""

from __future__ import annotations

import os
import re
from typing import Dict, Mapping, Optional, Union

from typing import Literal, TypedDict


class _HarnessBase(TypedDict):
    name: str


class Harness(_HarnessBase, total=False):
    """A harness declaration: a name and, when known, a version."""

    version: str


HarnessArg = Union[str, Mapping[str, Optional[str]], None]

#: The default of every ``harness=`` argument: detect from the environment.
DETECT: object = object()

#: The only environment variables :func:`detect_harness` reads. Nothing else is read or sent.
HARNESS_ENV_VARS = ("AI_AGENT", "AGENT", "CLAUDECODE", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_VERSION")

_NAME_MAX = 60
_VERSION_MAX = 40
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_SECRET = re.compile(r"jc_[A-Za-z0-9_-]{20,}|up_[A-Za-z0-9_-]{20,}|-----BEGIN")
# Values of AI_AGENT or AGENT that mean "do not report a harness".
_OPT_OUT = frozenset({"", "0", "false", "no", "off", "none"})
# Versions that say nothing: dropped, so the name is sent alone.
_PLACEHOLDER_VERSIONS = frozenset({"0.0.0", "0.0.0-dev", "unknown", "dev", "-"})
# AI_AGENT names with a display name, verified at the source.
_KNOWN_AGENT_NAMES = {
    # Claude Code sets AI_AGENT=claude-code_<version with hyphens>_<role> (seen live: claude-code_2-1-308_agent).
    "claude-code": "Claude Code",
}
_CLAUDE_CODE = re.compile(r"^claude-code_(\d+(?:-\d+)*)_[A-Za-z0-9-]+$")
_CLAUDE_CODE_SLASH = re.compile(r"^claude-code/(.+)$")


def harness_slug(name: str) -> str:
    """The service's slug: lowercase, each run outside a-z and 0-9 becomes one hyphen, ends trimmed."""
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def _fits(text: str, limit: int) -> bool:
    return 1 <= len(text) <= limit and not _CONTROL.search(text) and not _SECRET.search(text)


def check_harness(name: object, version: object = None) -> Optional[Harness]:
    """Apply the service's field rules. Returns the trimmed declaration, or ``None`` when it would be refused."""
    if not isinstance(name, str):
        return None
    name = name.strip()
    if not _fits(name, _NAME_MAX) or harness_slug(name) == "":
        return None
    if version is None:
        return Harness(name=name)
    if not isinstance(version, str):
        return None
    version = version.strip()
    if version == "":
        return Harness(name=name)
    if not _fits(version, _VERSION_MAX):
        return None
    return Harness(name=name, version=version)


def parse_harness_string(text: str) -> Optional[Harness]:
    """Parse ``"name"`` or ``"name/version"``."""
    text = text.strip()
    slash = text.rfind("/")
    if slash <= 0:
        return check_harness(text)
    return check_harness(text[:slash], text[slash + 1 :])


def drop_placeholder(version: Optional[str]) -> Optional[str]:
    """A version that says nothing (such as ``0.0.0``) becomes ``None``."""
    if version is None:
        return None
    version = version.strip()
    return None if version == "" or version.lower() in _PLACEHOLDER_VERSIONS else version


def parse_agent_variable(raw: str) -> Union[Harness, None, Literal["opt-out"]]:
    """Read one ``AI_AGENT`` or ``AGENT`` value: a lowercase-hyphen name, optionally
    ``@version``, or Claude Code's ``claude-code_2-1-308_agent``. Returns ``"opt-out"`` for a
    falsy value and ``None`` when the value is not usable."""
    value = raw.strip()
    if value.lower() in _OPT_OUT:
        return "opt-out"
    claude = _CLAUDE_CODE.match(value)
    if claude:
        return check_harness("Claude Code", claude.group(1).replace("-", "."))
    slashed = _CLAUDE_CODE_SLASH.match(value)
    if slashed:
        return check_harness("Claude Code", drop_placeholder(slashed.group(1)))
    at = value.rfind("@")
    name = value[:at] if at > 0 else value
    version = drop_placeholder(value[at + 1 :]) if at > 0 else None
    return check_harness(_KNOWN_AGENT_NAMES.get(name, name), version)


def detect_harness(env: Optional[Mapping[str, str]] = None) -> Optional[Harness]:
    """Detect the harness from the environment, reading only :data:`HARNESS_ENV_VARS`.

    1. ``AI_AGENT``, then ``AGENT`` (the cross-tool convention @vercel/detect-agent promotes).
       A falsy value (empty, ``0``, ``false``, ``no``, ``off``, ``none``) opts out.
    2. ``CLAUDECODE=1``: Claude Code.
    3. ``CODEX_THREAD_ID`` or ``CODEX_SESSION_ID`` (set by the Codex CLI on the commands it runs):
       Codex, with ``CODEX_VERSION`` when usable.
    """
    source: Mapping[str, str] = _process_env() if env is None else env
    for key in ("AI_AGENT", "AGENT"):
        raw = source.get(key)
        if raw is None:
            continue
        parsed = parse_agent_variable(raw)
        if parsed == "opt-out":
            return None
        if parsed is not None:
            return parsed
    if (source.get("CLAUDECODE") or "").strip() == "1":
        return Harness(name="Claude Code")
    if (source.get("CODEX_THREAD_ID") or "").strip() or (source.get("CODEX_SESSION_ID") or "").strip():
        return check_harness("Codex", drop_placeholder(source.get("CODEX_VERSION"))) or Harness(name="Codex")
    return None


def coerce_harness(value: HarnessArg) -> Optional[Harness]:
    """Turn a ``harness=`` argument into a declaration. Raises ``ValueError`` when it fails the field rules."""
    if value is None:
        return None
    if isinstance(value, str):
        parsed = parse_harness_string(value)
    else:
        parsed = check_harness(value.get("name"), value.get("version"))
    if parsed is None:
        raise ValueError(
            "harness needs a name of 1 to 60 characters with a letter or digit, "
            "and an optional version of 1 to 40, one line each, nothing secret-shaped"
        )
    return parsed


def _process_env() -> Dict[str, str]:
    # Copy only the named variables.
    return {key: os.environ[key] for key in HARNESS_ENV_VARS if key in os.environ}
