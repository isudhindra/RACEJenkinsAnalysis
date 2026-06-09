"""Build-trigger (rerun) endpoint.

Single endpoint — ``POST /api/rerun`` — that triggers a fresh build for
each supplied job URL.  Failures are reported per-job so a single bad
URL doesn't kill the whole batch.
"""

from flask import Blueprint, current_app, jsonify, request

from jjat.jenkins_client import JenkinsClientError
from jjat.lib.credentials import resolve_credentials, safe_err
from jjat.lib.jenkins_factory import make_client

bp = Blueprint("rerun", __name__)


@bp.route("/api/rerun", methods=["POST"])
def rerun_builds():
    """Trigger builds for the specified job URLs.

    Returns one result row per requested URL.  ``triggered=True`` means
    Jenkins accepted the build; ``triggered=False`` carries a short
    ``error`` message (permission denied, job disabled, etc.).
    """
    data = resolve_credentials(request.get_json())
    job_urls = data.get("job_urls", [])
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
