"""Streams a Jenkins build's console log to the browser as ``text/plain``
(``/api/console-log``). Keeps the Jenkins API token server-side so the browser
never sees credentials.
"""

from flask import Blueprint, Response, current_app, jsonify, request, stream_with_context

from race.jenkins_client import JenkinsClientError
from race.lib.credentials import resolve_credentials, safe_err
from race.lib.jenkins_factory import make_client
from race.lib.security import require_local_origin, url_belongs_to, validate_jenkins_url

bp = Blueprint("console", __name__)


@bp.route("/api/console-log", methods=["POST"])
def get_console_log():
    """Stream a build's full console log to the browser as text/plain.
    Credentials stay server-side so the browser never sees the Jenkins token.
    """
    csrf = require_local_origin()
    if csrf is not None:
        return csrf
    body = request.get_json(silent=True) or {}
    is_env = body.get("api_token") == "•" * 8
    url_err = validate_jenkins_url(body.get("jenkins_url", ""), is_env_auth=is_env)
    if url_err:
        return jsonify({"error": url_err}), 400
    data = resolve_credentials(body)
    job_url = (data.get("job_url") or "").strip()
    build_number = data.get("build_number")
    jenkins_url = (data.get("jenkins_url") or "").strip()
    username = (data.get("username") or "").strip()
    api_token = (data.get("api_token") or "").strip()

    # job_url must live under the picked Jenkins.
    if not url_belongs_to(job_url, jenkins_url):
        return jsonify({"error": "job_url does not belong to the selected Jenkins instance"}), 400

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
        # Two-phase open
        response, byte_iter = client.open_console_stream(job_url, build_number)
        try:
            response.raise_for_status()
        except Exception as exc:
            try:
                response.close()
            except Exception:
                pass
            raise JenkinsClientError(
                f"Jenkins returned {getattr(exc, 'response', response).status_code}: {exc}",
                job_url=job_url,
            )
        return Response(
            stream_with_context(byte_iter),
            # Flask auto-appends ``charset=utf-8`` when the mimetype is
            # text/* and has no charset, so don't write one ourselves.
            mimetype="text/plain",
            headers={
                "X-CLV-Cached": "true",
                "X-CLV-Source": "jenkins",
                # Defeat any intermediate buffering
                "X-Accel-Buffering": "no",
                "Cache-Control": "no-cache",
            },
        )
    except JenkinsClientError as e:
        return jsonify({"error": safe_err(e)}), 502
    except Exception as e:
        return jsonify({"error": safe_err(e)}), 500
