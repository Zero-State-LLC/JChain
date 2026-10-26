"""Harness detection from the environment (proposed spec v0.2.45, H10).

Used only when no ``harness=`` is given. Precedence: the option, then the
environment, then nothing (the service keeps the Agent's declaration). Only
the variables in :data:`HARNESS_ENV_VARS` are read; nothing else in the
environment is read or sent.
"""

from __future__ import annotations

import os
import re
from typing import Dict, Literal, Mapping, Optional, Union

from .types import Harness

#: The only environment variables :func:`detect_harness` reads.
HARNESS_ENV_VARS = ("AI_AGENT", "AGENT", "CLAUDECODE", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_VERSION")

#: The default of ``harness=``: detect from the environment.
DETECT: object = object()

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


def _fits(text: str, limit: int) -> bool:
    return 1 <= len(text) <= limit and not _CONTROL.search(text) and not _SECRET.search(text)


def _usable(name: str, version: Optional[str]) -> Optional[Harness]:
    # The service's field rules, applied quietly: an unusable value is ignored.
    name = name.strip()
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    if not _fits(name, 60) or slug == "":
        return None
    version = (version or "").strip()
    if version == "" or version.lower() in _PLACEHOLDER_VERSIONS or not _fits(version, 40):
        return Harness(name=name)
    return Harness(name=name, version=version)


def parse_agent_variable(raw: str) -> Union[Harness, None, Literal["opt-out"]]:
    """Read one ``AI_AGENT`` or ``AGENT`` value: a lowercase-hyphen name,
    optionally ``@version``, or Claude Code's ``claude-code_2-1-308_agent``.
    Returns ``"opt-out"`` for a falsy value and ``None`` when unusable."""
    value = raw.strip()
    if value.lower() in _OPT_OUT:
        return "opt-out"
    claude = _CLAUDE_CODE.match(value)
    if claude:
        return _usable("Claude Code", claude.group(1).replace("-", "."))
    slashed = _CLAUDE_CODE_SLASH.match(value)
    if slashed:
        return _usable("Claude Code", slashed.group(1))
    at = value.rfind("@")
    name = value[:at] if at > 0 else value
    return _usable(_KNOWN_AGENT_NAMES.get(name, name), value[at + 1 :] if at > 0 else None)


def detect_harness(env: Optional[Mapping[str, str]] = None) -> Optional[Harness]:
    """The harness the environment names, or ``None``. In order: ``AI_AGENT``,
    then ``AGENT`` (the cross-tool convention @vercel/detect-agent promotes; a
    falsy value opts out of detection altogether), then ``CLAUDECODE=1``
    (Claude Code), then ``CODEX_THREAD_ID`` or ``CODEX_SESSION_ID`` (set by the
    Codex CLI on the commands it runs; ``CODEX_VERSION`` is the version)."""
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
        return _usable("Codex", source.get("CODEX_VERSION"))
    return None


def _process_env() -> Dict[str, str]:
    # Copy only the named variables.
    return {key: os.environ[key] for key in HARNESS_ENV_VARS if key in os.environ}
