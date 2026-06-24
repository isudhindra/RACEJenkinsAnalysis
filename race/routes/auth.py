"""Credential validation endpoints — checks user-supplied or env-based Jenkins
credentials by hitting a lightweight Jenkins endpoint. Always returns HTTP 200
with ``{valid, message}`` so the frontend reads the body, not the status.
"""

import os

from flask import Blueprint, current_app, jsonify, request

from race.lib.credentials import (
    ENV_API_KEY_VAR,
    ENV_USERNAME_VAR,
    env_credentials,
    resolve_credentials,
    safe_err,
)
from race.lib.jenkins_factory import make_client
from race.lib.security import debug_log, require_local_origin, validate_jenkins_url

bp = Blueprint("auth", __name__)


@bp.route("/api/validate", methods=["POST"])
def validate_credentials():
    """Validate Jenkins credentials by hitting a lightweight endpoint.
    Always returns 200 with {valid, message} so the frontend reads the body.
    """
    csrf = require_local_origin()
    if csrf is not None:
        return csrf

    data = resolve_credentials(request.get_json(silent=True) or {})
    is_env_auth = (request.get_json(silent=True) or {}).get("api_token") == "•" * 8

    url_error = validate_jenkins_url(data.get("jenkins_url", ""), is_env_auth=is_env_auth)
    if url_error:
        return jsonify({"valid": False, "message": url_error}), 200

    try:
        client = make_client(data, timeout=current_app.config["default_timeout"])
        is_valid = client.validate_credentials()
        if is_valid:
            return jsonify({"valid": True, "message": "Credentials validated successfully"}), 200
        return jsonify({"valid": False, "message": "Invalid credentials or Jenkins unreachable"}), 200
    except Exception as e:
        return jsonify({"valid": False, "message": safe_err(e)}), 200


@bp.route("/api/env-credentials-check", methods=["GET"])
def env_credentials_check():
    """Report whether both env-auth variables are set, including the variable names
    so the UI can tell the user which to populate when missing.
    """
    csrf = require_local_origin()
    if csrf is not None:
        return csrf

    username, api_key = env_credentials()
    return jsonify({
        "available": bool(username and api_key),
        "username_var": ENV_USERNAME_VAR,
        "api_key_var": ENV_API_KEY_VAR,
    }), 200


@bp.route("/api/env-validate", methods=["POST"])
def env_validate_credentials():
    """Authenticate against an allowlisted Jenkins instance using env-supplied creds.
    Allowlist enforced via contexts.json so env tokens can't hit arbitrary servers.
    """
    csrf = require_local_origin()
    if csrf is not None:
        return csrf

    data = request.get_json(silent=True) or {}
    jenkins_url = (data.get("jenkins_url") or "").strip()

    # Env-auth: enforce the contexts.json allowlist.
    url_error = validate_jenkins_url(jenkins_url, is_env_auth=True)
    if url_error:
        return jsonify({"valid": False, "message": url_error}), 200

    username, api_key = env_credentials()
    if not username or not api_key:
        debug_log(f"[ENV-AUTH] Aborting: env vars missing for {jenkins_url}")
        return jsonify({
            "valid": False,
            "message": f"Environment credentials are not available — set {ENV_USERNAME_VAR} and {ENV_API_KEY_VAR}",
        }), 200

    # Length-diff diagnostic surfaces hidden control-char contamination.
    raw_user = os.environ.get(ENV_USERNAME_VAR, "")
    raw_key = os.environ.get(ENV_API_KEY_VAR, "")
    debug_log(
        f"[ENV-AUTH] Validating env credentials "
        f"(user_len={len(username)} raw={len(raw_user)}, "
        f"token_len={len(api_key)} raw={len(raw_key)}) "
        f"against {jenkins_url} (timeout={current_app.config['default_timeout']}s)..."
    )
    if len(username) != len(raw_user.strip()) or len(api_key) != len(raw_key.strip()):
        debug_log("[ENV-AUTH] WARNING: env var contained non-printable chars — scrubbed before use.")
    try:
        client = make_client(
            {"jenkins_url": jenkins_url, "username": username, "api_token": api_key},
            timeout=current_app.config["default_timeout"],
        )
        ok = client.validate_credentials()
        debug_log(f"[ENV-AUTH] Jenkins responded — valid={ok}")
        if ok:
            # Username deliberately not returned to the client.
            return jsonify({
                "valid": True,
                "message": "Environment credentials validated successfully",
            }), 200
        return jsonify({"valid": False, "message": "Environment credentials rejected by Jenkins"}), 200
    except Exception as e:
        debug_log(f"[ENV-AUTH] Exception: {safe_err(e)}")
        return jsonify({"valid": False, "message": safe_err(e)}), 200
