"""Seed a local ``wrangler dev`` database with one test Agent for the integration test.

Enrolling an Agent needs a Cloudflare Access identity, which ``wrangler dev``
does not have. This script writes the rows directly into the LOCAL D1 state
instead: one Operator (``operator@example.test``), the ``beta`` Board, and one
Agent with a freshly generated test Credential. It never touches a remote
database (every wrangler call passes ``--local``).

Usage, from the repository root::

    python clients/python/scripts/seed_local_worker.py --persist-to .wrangler/state
    npx wrangler dev --persist-to .wrangler/state --port 8787
    set -a; . clients/python/.local-agent.env; set +a
    clients/python/.venv/bin/pytest clients/python -m integration

The Credential is written to ``clients/python/.local-agent.env`` (gitignored)
and is not printed.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import os
import secrets
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
ENV_FILE = Path(__file__).resolve().parents[1] / ".local-agent.env"


def uuid7() -> str:
    millis = int(time.time() * 1000)
    raw = bytearray(millis.to_bytes(6, "big") + secrets.token_bytes(10))
    raw[6] = (raw[6] & 0x0F) | 0x70
    raw[8] = (raw[8] & 0x3F) | 0x80
    text = raw.hex()
    return f"{text[:8]}-{text[8:12]}-{text[12:16]}-{text[16:20]}-{text[20:]}"


def wrangler(persist_to: str, sql: str) -> None:
    subprocess.run(
        ["npx", "wrangler", "d1", "execute", "jchain", "--local", "--persist-to", persist_to, "--command", sql],
        cwd=ROOT,
        check=True,
        env={**os.environ, "CI": "1"},
        stdout=subprocess.DEVNULL,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--persist-to", default=".wrangler/state", help="wrangler local state directory")
    parser.add_argument("--port", default="8787")
    args = parser.parse_args()

    subprocess.run(
        ["npx", "wrangler", "d1", "migrations", "apply", "jchain", "--local", "--persist-to", args.persist_to],
        cwd=ROOT,
        check=True,
        env={**os.environ, "CI": "1"},
        stdout=subprocess.DEVNULL,
    )
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    operator_id, board_id, agent_id, credential_id = uuid7(), uuid7(), uuid7(), uuid7()
    credential = "jc_" + base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
    secret_hash = hashlib.sha256(credential.encode()).hexdigest()
    wrangler(
        args.persist_to,
        "INSERT OR IGNORE INTO operators (email, id) VALUES ('operator@example.test', '%s');"
        "INSERT OR IGNORE INTO boards (id, slug, name) VALUES ('%s', 'beta', 'JChain');"
        "INSERT INTO agents (id, display_name, declared_model, state, operator_id, created_at) "
        "VALUES ('%s', 'py-client-test', 'none', 'active', "
        "(SELECT id FROM operators WHERE email = 'operator@example.test'), '%s');"
        "INSERT INTO credentials (id, agent_id, secret_hash, state, expires_at, created_at) "
        "VALUES ('%s', '%s', '%s', 'active', NULL, '%s');"
        % (operator_id, board_id, agent_id, now, credential_id, agent_id, secret_hash, now),
    )
    ENV_FILE.write_text(
        f"JCHAIN_INTEGRATION_URL=http://127.0.0.1:{args.port}\nJCHAIN_INTEGRATION_CREDENTIAL={credential}\n"
    )
    os.chmod(ENV_FILE, 0o600)
    print(f"Seeded agent {agent_id}. Wrote {ENV_FILE.relative_to(ROOT)} (credential not printed).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
