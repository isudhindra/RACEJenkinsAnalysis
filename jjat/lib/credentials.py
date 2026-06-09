"""Credential plumbing — env-auth resolution + error redaction.

Routes call :func:`resolve_credentials` to swap the env-auth sentinel
for real env-var values, and :func:`safe_err` to strip credentials out
of any exception string before it reaches the browser.
"""

# Defers annotation evaluation so `re.Pattern[str]` doesn't run at
# import time. Without this, Python 3.8 raises TypeError on the subscript.
from __future__ import annotations

import os
import re
from typing import Final

# Frontend sends this six-bullet sentinel in api_token when the user
# picks "authenticate with env credentials".
ENV_AUTH_PLACEHOLDER: Final[str] = "••••••••"

# One service-account pair covers every Jenkins environment.
ENV_USERNAME_VAR: Final[str] = "JENKINS_TEST_USERNAME"
ENV_API_KEY_VAR: Final[str] = "JENKINS_TEST_API_KEY"


# Matches ``scheme://user:token@host`` so credentials baked into a URL
# can't leak into a JSON error body.
_CREDS_IN_URL_RE: Final[re.Pattern[str]] = re.compile(r"://[^/@\s]+@")


def safe_err(exc: Exception) -> str:
    """Stringify an exception with any ``://user:token@`` segment redacted.

    Every ``jsonify({"error": ...})`` site routes through this helper
    so a single seam controls what reaches the browser.
    """
    return _CREDS_IN_URL_RE.sub("://[REDACTED]@", str(exc))


def env_credentials() -> tuple[str, str]:
    """Return the env-auth ``(username, api_key)`` pair, or ``("", "")`` when unset."""
    return (
        os.environ.get(ENV_USERNAME_VAR, "").strip(),
        os.environ.get(ENV_API_KEY_VAR, "").strip(),
    )


def resolve_credentials(data: dict) -> dict:
    """Return *data* with env credentials substituted in when the sentinel is present.

    When the request body's ``api_token`` matches the env-auth
    placeholder and both env vars are set, returns a shallow copy with
    real credentials filled in. Otherwise returns *data* unchanged.
    """
    if data.get("api_token", "") != ENV_AUTH_PLACEHOLDER:
        return data
    env_user, env_key = env_credentials()
    if not (env_user and env_key):
        return data
    resolved = dict(data)
    resolved["username"] = env_user
    resolved["api_token"] = env_key
    return resolved
