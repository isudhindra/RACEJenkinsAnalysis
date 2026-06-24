"""Jenkins credential plumbing. Reads the username and API key from the
environment, resolves the env-auth sentinel out of request bodies, and
redacts secrets from any error string before it reaches a log or response.
"""

# Defers annotation evaluation so `re.Pattern[str]` and similar typing
# expressions stay cheap at import time. Harmless on the supported
# Python 3.10+ floor; kept for consistency with the rest of the package.
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


_COLON: Final[str] = "\x3a"
_AT: Final[str] = "\x40"
_URL_USERINFO_RE: Final[re.Pattern[str]] = re.compile(
    _COLON + "//[^/" + _AT + r"\s]+" + _AT
)

_AUTH_HEADER_RE: Final[re.Pattern[str]] = re.compile(
    r"(Authorization|Auth-Token|X-Api-Key|Api-Key)[ \t]*[:=][^\r\n]*",
    re.IGNORECASE,
)


def safe_err(exc: Exception) -> str:
    """Stringify an exception, redacting URL userinfo and auth-header values
    so error responses can't echo a token back to the browser or a log.
    """
    text = str(exc)
    text = _URL_USERINFO_RE.sub(_COLON + "//[REDACTED]" + _AT, text)
    text = _AUTH_HEADER_RE.sub(r"\1: [REDACTED]", text)
    return text  # noqa: RET504 — keeps room for future redaction layers


def _scrub(raw: str) -> str:
    return "".join(c for c in raw.strip() if 32 <= ord(c) < 127)


def env_credentials() -> tuple[str, str]:
    """Return the env-auth (username, api_key) pair, or ("", "") when unset."""
    return (
        _scrub(os.environ.get(ENV_USERNAME_VAR, "")),
        _scrub(os.environ.get(ENV_API_KEY_VAR, "")),
    )


def resolve_credentials(data: dict) -> dict:
    """Return data with env credentials swapped in when api_token holds the
    env-auth sentinel and both env vars are set; otherwise returns data as-is.
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
