"""Central place for all defensive checks — CSRF, SSRF, auth, rate-limit,
response headers. Routes and the app factory import the small helpers here
so no endpoint has to roll its own security logic.
"""

from __future__ import annotations

import ipaddress
import os
import secrets
import socket
from typing import Iterable, Optional, Set, Tuple
from urllib.parse import urlparse

from flask import Flask, current_app, jsonify, request


def debug_log(message: str) -> None:
    """Emit message only when RACE_DEBUG=1 is set, so the env-auth
    fingerprint never enters stdout by default.
    """
    if os.environ.get("RACE_DEBUG", "").strip().lower() not in ("1", "true", "yes"):
        return
    try:
        current_app.logger.info(message)
    except RuntimeError:
        # Outside a Flask app context — boot path.
        print(message)

# Origins the dashboard is allowed
_ALLOWED_ORIGINS: Tuple[str, ...] = (
    "http://127.0.0.1",
    "http://localhost",
)


def _resolve_to_ips(host: str) -> Iterable[str]:
    """Best-effort DNS resolution; returns an empty iterable on failure."""
    try:
        return {info[4][0] for info in socket.getaddrinfo(host, None)}
    except (socket.gaierror, OSError, UnicodeError):
        return ()


def _is_internal_ip(ip_str: str) -> bool:
    """True if the IP is loopback / RFC1918 / link-local / cloud-metadata —
    i.e. somewhere a public Jenkins should never live (SSRF guard).
    """
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return False
    # Collapse IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) — Python's is_loopback
    # returns False for these but the kernel routes them to v4 on connect.
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return (
        ip.is_loopback
        or ip.is_link_local
        or ip.is_private
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def _jenkins_allowlist() -> Set[str]:
    """Return the set of normalised base URLs from contexts.json. Empty means
    manual mode — the SSRF internal-IP guard still applies in that branch.
    """
    contexts = current_app.config.get("contexts") or {}
    return {
        _normalise_url(inst["jenkins_url"])
        for inst in contexts.get("instances", [])
        if isinstance(inst, dict) and inst.get("jenkins_url")
    }


def _normalise_url(url: str) -> str:
    """Strip trailing slashes for stable allowlist comparison."""
    return (url or "").strip().rstrip("/")


def url_belongs_to(child_url: str, base_url: str) -> bool:
    """True iff child_url lives under base_url (same scheme/host/port, path is a
    full-segment prefix). Component-wise compare blocks userinfo + suffix tricks.
    """
    try:
        c = urlparse((child_url or "").strip())
        b = urlparse((base_url or "").strip())
    except ValueError:
        return False
    if not (c.scheme and c.hostname and b.scheme and b.hostname):
        return False
    if "@" in (c.netloc or "") or "@" in (b.netloc or ""):
        return False
    if (c.scheme.lower(), c.hostname.lower(), c.port) != (
        b.scheme.lower(), b.hostname.lower(), b.port,
    ):
        return False
    base_path = (b.path or "/").rstrip("/")
    child_path = (c.path or "/").rstrip("/")
    return child_path == base_path or child_path.startswith(base_path + "/")


def validate_jenkins_url(url: str, *, is_env_auth: bool = False) -> Optional[str]:
    """Validate a user-supplied Jenkins URL (scheme, public IP, allowlist when
    env-auth); returns an error string on failure or None on success.
    """
    if not url:
        return "Jenkins URL is required"

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return "Jenkins URL must use http or https"
    if not parsed.hostname:
        return "Jenkins URL is missing a hostname"

    # Resolve and reject internal targets — SSRF defence.
    ips = list(_resolve_to_ips(parsed.hostname))
    if not ips:
        return "Jenkins hostname could not be resolved"
    for ip in ips:
        if _is_internal_ip(ip):
            return "Jenkins URL resolves to an internal address and is not allowed"

    # Env-auth path: the server is about to use its own credentials.
    if is_env_auth:
        allow = _jenkins_allowlist()
        if not allow:
            return "Env-auth requires a Jenkins instance preconfigured in contexts.json"
        if _normalise_url(url) not in allow:
            return "This Jenkins URL is not in the configured allowlist for env-auth"

    return None


def require_local_origin() -> Optional[Tuple[object, int]]:
    """CSRF guard — reject requests whose Origin/Referer isn't a local-loopback
    origin. Returns None on pass, or a 403 Flask response tuple on reject.
    """
    origin = request.headers.get("Origin") or ""
    referer = request.headers.get("Referer") or ""

    def _origin_is_local(value: str) -> bool:
        if not value:
            return False
        parsed = urlparse(value)
        if parsed.scheme not in ("http", "https"):
            return False
        return any(
            value.startswith(allowed + ":") or value.startswith(allowed + "/")
            or parsed.hostname in ("127.0.0.1", "localhost", "::1")
            for allowed in _ALLOWED_ORIGINS
        )

    if origin and _origin_is_local(origin):
        return None
    if referer and _origin_is_local(referer):
        return None

    # No Origin and no Referer means likely curl / non-browser tooling.
    # Allow when both are absent (local CLI use), but reject when present-but-foreign.
    if not origin and not referer:
        return None

    return jsonify({"error": "Cross-origin request rejected"}), 403


def limit(rate: str):
    """Soft wrapper around flask_limiter's @limiter.limit; stashes the rate on
    the view so application.py can apply it after the Limiter is constructed.
    """
    def decorator(view_func):
        existing = getattr(view_func, "_race_rate_limits", [])
        view_func._race_rate_limits = existing + [rate]
        return view_func
    return decorator


def guard_jenkins_request(body: dict) -> Tuple[Optional[dict], Optional[Tuple[object, int]]]:
    """URL-validate plus env-auth swap for Jenkins-talking routes; returns
    (resolved_data, None) on success or (None, error_response) on failure.
    """
    from race.lib.credentials import resolve_credentials  # local import → no cycle
    body = body or {}
    is_env_auth = body.get("api_token") == "•" * 8
    url_err = validate_jenkins_url(body.get("jenkins_url", ""), is_env_auth=is_env_auth)
    if url_err:
        return None, (jsonify({"error": url_err}), 400)
    return resolve_credentials(body), None


def _local_token_401(message: str):
    """Build a 401 response tagged with X-RACE-Auth-Error: local-token so the
    browser can distinguish a RACE-token failure from an upstream Jenkins 401.
    """
    resp = jsonify({"error": message, "auth_error_kind": "local-token"})
    resp.headers["X-RACE-Auth-Error"] = "local-token"
    return resp, 401


def install_local_api_token_guard(app: Flask) -> None:
    """Require X-RACE-Token on every /api/* call (or ?token= for SSE).
    Keeps other local processes off the API; /api/config is exempt.
    Local-token 401s carry an X-RACE-Auth-Error header so the browser can
    show a hard-refresh banner only when the RACE token itself failed —
    upstream Jenkins 401s (no such header) get a different banner.
    """
    @app.before_request
    def _check_token():
        path = request.path or ""
        if not path.startswith("/api/"):
            return None
        if path == "/api/config":
            return None

        expected = app.config.get("LOCAL_API_TOKEN")
        if not expected:
            return jsonify({"error": "Local API token not configured"}), 503

        # SSE uses the query-param fallback because EventSource can't add headers.
        supplied = request.headers.get("X-RACE-Token", "") or request.args.get("token", "")
        if not supplied:
            return _local_token_401(
                "Missing X-RACE-Token header — see ~/.race/token (README has details)"
            )
        if not secrets.compare_digest(str(supplied), str(expected)):
            return _local_token_401("Invalid X-RACE-Token")
        return None


def install_security_headers(app: Flask) -> None:
    """Set standard hardening headers (nosniff, X-Frame DENY, CSP, etc.) on every response."""
    @app.after_request
    def _add(resp):
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("X-Frame-Options", "DENY")
        resp.headers.setdefault("Referrer-Policy", "no-referrer")
        # CSP still allows 'unsafe-inline' — nonce migration is the documented next step.
        resp.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; "
            "connect-src 'self'; "
            "frame-ancestors 'none';",
        )
        return resp
