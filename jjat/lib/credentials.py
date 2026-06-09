"""Credential plumbing — env-auth resolution + error redaction.

Centralises three concerns that every route handler touches:

1. The sentinel string the frontend sends when the user picked the
   "authenticate with environment credentials" shortcut.
2. ``resolve_credentials()`` — substitutes the real env-var values
   into the request body when the sentinel is present, so downstream
   code can keep reading ``data["username"]`` / ``data["api_token"]``
   uniformly regardless of whether credentials came from the browser
   or from the host environment.
3. ``safe_err()`` — stringifies an exception with embedded URL
   credentials redacted, so a Jenkins ``http://user:token@host`` URL
   accidentally pasted into an exception never leaks to the browser.

A single Jenkins service-account credential is enough to read every
environment exposed by the Jenkins instance:

  JENKINS_TEST_USERNAME = svc-account@example.com
  JENKINS_TEST_API_KEY  = <api token>
"""

import os
import re
from typing import Final

# Sentinel token the frontend sends in the api_token field when the
# user chose "authenticate with env credentials".  Six bullet glyphs.
ENV_AUTH_PLACEHOLDER: Final[str] = "••••••••"

# Env-var names the dashboard reads.  One pair, used across all Jenkins
# environments — the service account behind it has read access
# everywhere.
ENV_USERNAME_VAR: Final[str] = "JENKINS_TEST_USERNAME"
ENV_API_KEY_VAR: Final[str] = "JENKINS_TEST_API_KEY"


# Matches any "scheme://user:token@host" segment in an exception string
# so credentials baked into a URL never leak into a JSON error body.
_CREDS_IN_URL_RE: Final[re.Pattern[str]] = re.compile(r"://[^/@\s]+@")


def safe_err(exc: Exception) -> str:
    """Stringify an exception with embedded credentials redacted.

    All ``jsonify({"error": str(e)})`` sites route through this helper
    so that a single seam controls what reaches the browser.

    Args:
        exc: The exception to stringify.

    Returns:
        ``str(exc)`` with any ``://user:token@`` substring rewritten to
        ``://[REDACTED]@``.
    """
    return _CREDS_IN_URL_RE.sub("://[REDACTED]@", str(exc))


def env_credentials() -> tuple[str, str]:
    """Read the env-auth credential pair from ``os.environ``.

    Returns ``("", "")`` when either var is unset or blank.  python-dotenv
    has already populated ``os.environ`` from ``.env`` by the time this
    runs (the app factory loads it at import time).
    """
    return (
        os.environ.get(ENV_USERNAME_VAR, "").strip(),
        os.environ.get(ENV_API_KEY_VAR, "").strip(),
    )


def resolve_credentials(data: dict) -> dict:
    """Return a copy of *data* with env credentials substituted.

    When ``data["api_token"]`` matches the env-auth placeholder, this
    swaps in :data:`ENV_USERNAME_VAR` and :data:`ENV_API_KEY_VAR` from
    the host environment.  Otherwise *data* is returned unchanged.

    The returned dict is always safe to mutate — when substitution
    happens we return a shallow copy.

    Args:
        data: The raw JSON body of a request.

    Returns:
        A dict with ``username`` / ``api_token`` filled in from env
        when the placeholder is present and both env vars are set; the
        original *data* otherwise.
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
