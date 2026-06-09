"""Per-job analysis endpoints.

* ``POST /api/refresh-single`` — synchronous targeted refresh of one
  job that updates ``state.job_store`` and returns the new record.
* ``POST /api/analyze-on-demand`` — synchronous deep analysis of a
  single job (typically used to populate a row without a full fetch).

Both endpoints look very similar, but they exist as separate routes for
caller-side intent clarity: the frontend uses ``refresh-single`` after
auto-poll detects a status change, and ``analyze-on-demand`` from the
per-row refresh icon.
"""

from flask import Blueprint, current_app, jsonify, request

from jjat.lib import state
from jjat.lib.credentials import resolve_credentials, safe_err
from jjat.lib.jenkins_factory import make_client
from jjat.lib.timeutils import parse_promotion_time
from jjat.pipeline import AnalysisOrchestrator

bp = Blueprint("analysis", __name__)


@bp.route("/api/refresh-single", methods=["POST"])
def refresh_single_job():
    """Re-fetch and re-analyse a single job.

    Touches only one entry in ``state.job_store`` and returns a plain
    JSON record — ideal for in-place row updates without disrupting the
    rest of the table.
    """
    data = resolve_credentials(request.get_json())
    job_url = data.get("job_url")
    job_name = data.get("job_name")

    if not job_url:
        return jsonify({"error": "job_url is required"}), 400

    # Derive job_name from the existing record or the URL tail.
    if not job_name:
        existing = state.job_store.get(job_url)
        job_name = existing.job_name if existing else job_url.rstrip("/").split("/")[-1]

    try:
        promotion_time = parse_promotion_time(data)
        client = make_client(data, timeout=current_app.config["default_timeout"])
        orchestrator = AnalysisOrchestrator(
            client=client,
            classifier=current_app.classifier,  # type: ignore[attr-defined]
            max_workers=1,
            promotion_time=promotion_time,
        )
        record = orchestrator.analyze_single_job(job_url, job_name)
        state.job_store[job_url] = record
        return jsonify(record.to_dict(promotion_time=promotion_time)), 200
    except Exception as e:
        return jsonify({"error": safe_err(e)}), 500


@bp.route("/api/analyze-on-demand", methods=["POST"])
def analyze_on_demand():
    """Perform synchronous deep analysis on a single job (Stage 1 + Stage 2)."""
    data = resolve_credentials(request.get_json())
    job_url = data.get("job_url")
    job_name = data.get("job_name")

    try:
        promotion_time = parse_promotion_time(data)
        client = make_client(data, timeout=current_app.config["default_timeout"])
        orchestrator = AnalysisOrchestrator(
            client=client,
            classifier=current_app.classifier,  # type: ignore[attr-defined]
            max_workers=1,
            promotion_time=promotion_time,
        )
        record = orchestrator.analyze_single_job(job_url, job_name)
        state.job_store[job_url] = record
        return jsonify(record.to_dict(promotion_time=promotion_time)), 200
    except Exception as e:
        return jsonify({"error": safe_err(e)}), 500
