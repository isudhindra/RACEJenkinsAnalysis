"""Jenkins view discovery + job-list loading for the configuration panel."""

import json
import os
from pathlib import Path

from flask import Blueprint, current_app, jsonify, request

from jjat.lib.credentials import resolve_credentials, safe_err
from jjat.lib.jenkins_factory import make_client
from jjat.lib.jenkins_urls import resolve_view_url

bp = Blueprint("views", __name__)


# Resolve relative to the project root so tests / setup scripts are CWD-independent.
def _job_lists_dir() -> Path:
    """Return the absolute ``config/job_lists`` directory."""
    return Path(__file__).resolve().parents[2] / "config" / "job_lists"


@bp.route("/api/discover-views", methods=["POST"])
def discover_views():
    """Discover all views on the configured Jenkins instance."""
    data = resolve_credentials(request.get_json())
    try:
        client = make_client(data, timeout=current_app.config["default_timeout"])
        url = f"{client.base_url.rstrip('/')}/api/json?tree=views[name,url]"
        response = client.session.get(url, timeout=current_app.config["default_timeout"])
        response.raise_for_status()
        api_data = response.json()
        return jsonify({"views": api_data.get("views", [])}), 200
    except Exception as e:
        return jsonify({"views": [], "error": f"Failed to connect to Jenkins: {safe_err(e)}"}), 200


@bp.route("/api/discover-view-jobs-count", methods=["POST"])
def discover_view_jobs_count():
    """Return the job count and display name for a specific view."""
    data = resolve_credentials(request.get_json())
    try:
        jenkins_url = data["jenkins_url"]
        client = make_client(data, timeout=current_app.config["default_timeout"])
        view_url = data.get("view_url", "")
        view_path = data.get("view_path", "")

        # Prefer view_path for deterministic URL construction.
        if view_path:
            view_url = resolve_view_url(jenkins_url, view_path)
        elif view_url and not view_url.startswith("http"):
            view_url = client.base_url.rstrip("/") + "/" + view_url.lstrip("/")

        # Reject views that don't belong to the picked Jenkins instance.
        if not view_url.rstrip("/").lower().startswith(jenkins_url.rstrip("/").lower()):
            return jsonify({
                "count": 0,
                "error": "View URL does not belong to selected Jenkins instance",
            }), 200

        url = f"{view_url.rstrip('/')}/api/json?tree=name,jobs[name]"
        response = client.session.get(url, timeout=current_app.config["default_timeout"])
        response.raise_for_status()

        api_data = response.json()
        return jsonify({
            "count": len(api_data.get("jobs", [])),
            "view_name": api_data.get("name", "Unknown"),
        }), 200
    except Exception as e:
        return jsonify({"count": 0, "error": safe_err(e)}), 200


@bp.route("/api/load-job-list", methods=["POST"])
def load_job_list():
    """Load a saved predefined job list from disk.

    Body needs ``job_list_file`` (absolute path). The file itself only
    has to provide ``{"jobs": [...]}``; ``name`` falls back to the
    file's basename — the canonical label lives in ``contexts.json``.
    """
    data = request.get_json()
    file_path = data.get("job_list_file", "")
    if not file_path or not os.path.isabs(file_path):
        return jsonify({"error": "Invalid job list file path", "jobs": []}), 400

    try:
        with open(file_path) as f:
            job_list_data = json.load(f)
        jobs = job_list_data.get("jobs", [])
        fallback_name = os.path.splitext(os.path.basename(file_path))[0]
        return jsonify({
            "jobs": jobs,
            "name": job_list_data.get("name") or fallback_name,
            "count": len(jobs),
        }), 200
    except FileNotFoundError:
        return jsonify({"error": f"Job list file not found: {file_path}", "jobs": []}), 404
    except json.JSONDecodeError as e:
        return jsonify({"error": f"Invalid JSON in job list: {e}", "jobs": []}), 400
    except Exception as e:
        return jsonify({"error": safe_err(e), "jobs": []}), 500


def _validate_job_list_file(fpath: Path):
    """Strict-format check for a job-list JSON file.

    Required: parses as JSON, top-level object, non-empty ``jobs``
    array of non-empty strings. Returns ``(ok, name, count, reason)``;
    when ``ok`` is False, ``reason`` is a short explanation for the log.
    """
    try:
        with open(fpath) as f:
            doc = json.load(f)
    except Exception as e:
        return False, None, 0, f"JSON parse error: {e}"
    if not isinstance(doc, dict):
        return False, None, 0, "root is not a JSON object"
    if "jobs" not in doc:
        return False, None, 0, 'missing required "jobs" key'
    jobs = doc.get("jobs")
    if not isinstance(jobs, list):
        return False, None, 0, '"jobs" must be an array'
    if len(jobs) == 0:
        return False, None, 0, '"jobs" array is empty'
    for j in jobs:
        if not isinstance(j, str) or not j.strip():
            return False, None, 0, '"jobs" entries must be non-empty strings'
    display = doc.get("name")
    if not (isinstance(display, str) and display.strip()):
        display = os.path.splitext(os.path.basename(str(fpath)))[0]
    return True, display, len(jobs), None


@bp.route("/api/list-available-job-lists", methods=["GET"])
def list_available_job_lists():
    """Enumerate every well-formed ``.json`` file under ``config/job_lists/``.

    Shows every saved list in the dropdown — not just the ones bound
    to an instance in ``contexts.json``. ``SAMPLE-*`` files are
    skipped (they're upload templates). Malformed files are rejected
    with the reason logged so the dropdown stays clean.
    """
    out = []
    job_dir = _job_lists_dir()
    if not job_dir.is_dir():
        return jsonify({"lists": []}), 200

    # Mark which lists are bound to a Jenkins instance vs ad-hoc.
    predefined_paths = set()
    try:
        contexts_cfg = current_app.config.get("contexts") or {}
        for inst in contexts_cfg.get("instances", []) or []:
            for jl in inst.get("predefined_job_lists", []) or []:
                p = jl.get("job_list_file")
                if p:
                    predefined_paths.add(os.path.abspath(p))
    except Exception:
        pass  # best-effort flagging

    for fname in sorted(os.listdir(str(job_dir))):
        if not fname.endswith(".json"):
            continue
        if fname.startswith("SAMPLE-") or fname.startswith("sample-"):
            continue
        fpath = job_dir / fname
        ok, display, count, reason = _validate_job_list_file(fpath)
        if not ok:
            try:
                current_app.logger.warning(
                    f"job-list rejected: {fname} — {reason}"
                )
            except Exception:
                pass
            continue
        out.append({
            "name": display,
            "file": str(fpath),
            "count": count,
            "predefined": str(fpath) in predefined_paths,
        })
    return jsonify({"lists": out}), 200
