"""Authentication endpoints.

All three return HTTP 200 with ``{"valid": bool, "message": str}``
even on auth failure — the frontend interprets the JSON, never the
status code. HTTP 5xx is reserved for genuine server errors.
"""

from flask import Blueprint, current_app, jsonify, request

from jjat.lib.credentials import (
    ENV_API_KEY_VAR,
    ENV_USERNAME_VAR,
    env_credentials,
    resolve_credentials,
    safe_err,
)
from jjat.lib.jenkins_factory import make_client

bp = Blueprint("auth", __name__)


@bp.route("/api/validate", methods=["POST"])
def validate_credentials():
    """Validate Jenkins credentials by hitting a lightweight endpoint."""
    data = resolve_credentials(request.get_json())
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
    """Report whether both env-auth variables are set.

    Names are included so the UI can tell the user which variables to
    populate when creds are missing.
    """
    username, api_key = env_credentials()
    return jsonify({
        "available": bool(username and api_key),
        "username_var": ENV_USERNAME_VAR,
        "api_key_var": ENV_API_KEY_VAR,
    }), 200


@bp.route("/api/env-validate", methods=["POST"])
def env_validate_credentials():
    """Authenticate against the selected Jenkins instance with env creds."""
    data = request.get_json() or {}
    jenkins_url = (data.get("jenkins_url") or "").strip()
    if not jenkins_url:
        return jsonify({"valid": False, "message": "Jenkins URL is required"}), 200

    username, api_key = env_credentials()
    if not username or not api_key:
        return jsonify({
            "valid": False,
            "message": f"Environment credentials are not available — set {ENV_USERNAME_VAR} and {ENV_API_KEY_VAR}",
        }), 200

    try:
        client = make_client(
            {"jenkins_url": jenkins_url, "username": username, "api_token": api_key},
            timeout=current_app.config["default_timeout"],
        )
        if client.validate_credentials():
            return jsonify({
                "valid": True,
                "message": "Environment credentials validated successfully",
                "username": username,
            }), 200
        return jsonify({"valid": False, "message": "Environment credentials rejected by Jenkins"}), 200
    except Exception as e:
        return jsonify({"valid": False, "message": safe_err(e)}), 200
