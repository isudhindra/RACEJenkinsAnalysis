"""Per-job analysis endpoints.

``/api/refresh-single`` and ``/api/analyze-on-demand`` do almost the
same thing, but are kept separate for caller-side intent clarity:
refresh-single fires after auto-poll detects a status change;
analyze-on-demand fires from the per-row refresh icon.
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
    """Re-fetch and re-analyse one job for in-place row updates."""
    data = resolve_credentials(request.get_json())
    job_url = data.get("job_url")
    job_name = data.get("job_name")

    if not job_url:
        return jsonify({"error": "job_url is required"}), 400

    # Fall back to the existing record's name, then to the URL tail.
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
    """Synchronous Stage 1 + Stage 2 analysis for a single job."""
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
