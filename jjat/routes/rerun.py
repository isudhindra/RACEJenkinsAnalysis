"""Build-trigger (rerun) endpoint — fires a build per URL, reports failures per-job."""

from flask import Blueprint, current_app, jsonify, request

from jjat.jenkins_client import JenkinsClientError
from jjat.lib.credentials import resolve_credentials, safe_err
from jjat.lib.jenkins_factory import make_client

bp = Blueprint("rerun", __name__)


@bp.route("/api/rerun", methods=["POST"])
def rerun_builds():
    """Trigger builds for the supplied URLs. Returns one row per URL with ``triggered`` + ``error``."""
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
