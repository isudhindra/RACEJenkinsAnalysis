"""Console-log fetching.

Single endpoint that proxies Jenkins's ``consoleText`` so the frontend
Console Log Viewer doesn't have to hold a Jenkins API token in the
browser.
"""

from flask import Blueprint, Response, current_app, jsonify, request

from jjat.jenkins_client import JenkinsClientError
from jjat.lib.credentials import resolve_credentials, safe_err
from jjat.lib.jenkins_factory import make_client

bp = Blueprint("console", __name__)


@bp.route("/api/console-log", methods=["POST"])
def get_console_log():
    """Fetch the full console log for a specific build.

    Expects:
        ``{"job_url", "build_number", "jenkins_url", "username", "api_token"}``

    Returns:
        Full console text as ``text/plain``.  The frontend streams the
        body chunk-by-chunk into the Console Log Viewer.

    Credentials are resolved via :func:`resolve_credentials` (supports
    env-auth).
    """
    data = resolve_credentials(request.get_json())
    job_url = (data.get("job_url") or "").strip()
    build_number = data.get("build_number")
    jenkins_url = (data.get("jenkins_url") or "").strip()
    username = (data.get("username") or "").strip()
    api_token = (data.get("api_token") or "").strip()

    if not job_url:
        return jsonify({"error": "job_url is required"}), 400
    if not build_number:
        return jsonify({"error": "build_number is required"}), 400
    if not jenkins_url or not username or not api_token:
        return jsonify({"error": "Jenkins credentials are required"}), 400

    try:
        build_number = int(build_number)
    except (TypeError, ValueError):
        return jsonify({"error": "build_number must be a valid integer"}), 400

    try:
        client = make_client(data, timeout=current_app.config["default_timeout"])
        console_text = client.fetch_console_full(job_url, build_number)
        return Response(
            console_text,
            mimetype="text/plain",
            headers={
                "X-CLV-Cached": "true",
                "X-CLV-Source": "jenkins",
            },
        )
    except JenkinsClientError as e:
        return jsonify({"error": safe_err(e)}), 502
    except Exception as e:
        return jsonify({"error": safe_err(e)}), 500
