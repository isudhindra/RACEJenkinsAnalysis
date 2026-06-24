"""Triggers Jenkins builds for the selected jobs (``/api/rerun``). Returns one
result row per URL, so a single permission failure doesn't fail the whole
batch.
"""

from flask import Blueprint, current_app, jsonify, request

from race.jenkins_client import JenkinsClientError
from race.lib.credentials import resolve_credentials, safe_err
from race.lib.jenkins_factory import make_client
from race.lib.security import limit, require_local_origin, url_belongs_to, validate_jenkins_url

bp = Blueprint("rerun", __name__)


@bp.route("/api/rerun", methods=["POST"])
@limit("20/minute")
def rerun_builds():
    """Trigger Jenkins builds for the supplied URLs, one result row per URL so a single
    permission failure doesn't fail the whole batch.
    """
    csrf = require_local_origin()
    if csrf is not None:
        return csrf
    body = request.get_json(silent=True) or {}
    is_env = body.get("api_token") == "•" * 8
    url_err = validate_jenkins_url(body.get("jenkins_url", ""), is_env_auth=is_env)
    if url_err:
        return jsonify({"error": url_err, "results": []}), 400
    data = resolve_credentials(body)
    job_urls = data.get("job_urls", [])
    if len(job_urls) > 500:
        return jsonify({"error": "Too many URLs in one rerun request", "results": []}), 400

    # Drop any URL that doesn't live under the picked Jenkins.
    base = data.get("jenkins_url") or ""
    job_urls = [u for u in job_urls if url_belongs_to(u, base)]

    client = make_client(data, timeout=current_app.config["default_timeout"])

    results = []
    for job_url in job_urls:
        try:
            success = client.trigger_build(job_url)
            results.append({
                "job_url": job_url,
                "triggered": success,
                "error": None if success else "Permission denied or job disabled",
            })
        except JenkinsClientError as e:
            results.append({
                "job_url": job_url,
                "triggered": False,
                "error": safe_err(e),
            })

    return jsonify({"results": results}), 200
