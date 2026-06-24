"""Backs the configuration panel — discovers Jenkins views, counts jobs in a
view, and reads saved custom job lists from ``config/job_lists/``. Path-confined
so the loader can't be tricked into reading files outside that directory.
"""

import json
import os
from pathlib import Path

from flask import Blueprint, current_app, jsonify, request

from race.lib.credentials import resolve_credentials, safe_err
from race.lib.jenkins_factory import make_client
from race.lib.jenkins_urls import resolve_view_url
from race.lib.security import require_local_origin, url_belongs_to, validate_jenkins_url

bp = Blueprint("views", __name__)


# Resolve relative to the project root so tests / setup scripts are CWD-independent.
def _job_lists_dir() -> Path:
    """Return the absolute config/job_lists directory anchored at the project root,
    so this is CWD-independent for tests and setup scripts.
    """
    return Path(__file__).resolve().parents[2] / "config" / "job_lists"


@bp.route("/api/discover-views", methods=["POST"])
def discover_views():
    """Discover all views on the configured Jenkins instance for the dropdown."""
    csrf = require_local_origin()
    if csrf is not None:
        return csrf
    body = request.get_json(silent=True) or {}
    is_env = body.get("api_token") == "•" * 8
    url_err = validate_jenkins_url(body.get("jenkins_url", ""), is_env_auth=is_env)
    if url_err:
        return jsonify({"views": [], "error": url_err}), 200
    data = resolve_credentials(body)
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
    """Return the job count and display name for a specific Jenkins view."""
    csrf = require_local_origin()
    if csrf is not None:
        return csrf
    body = request.get_json(silent=True) or {}
    is_env = body.get("api_token") == "•" * 8
    url_err = validate_jenkins_url(body.get("jenkins_url", ""), is_env_auth=is_env)
    if url_err:
        return jsonify({"count": 0, "error": url_err}), 200
    data = resolve_credentials(body)
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
        if not url_belongs_to(view_url, jenkins_url):
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
    """Load a saved custom job list. Path-confined to config/job_lists/ so absolute
    paths and symlink escapes can't be tricked into reading other files.
    """
    csrf = require_local_origin()
    if csrf is not None:
        return csrf

    data = request.get_json(silent=True) or {}
    raw_path = (data.get("job_list_file") or "").strip()
    if not raw_path:
        return jsonify({"error": "Invalid job list file path", "jobs": []}), 400

    # Confine to config/job_lists
    try:
        root = _job_lists_dir().resolve(strict=True)
        candidate = Path(raw_path).resolve(strict=False)
    except (OSError, RuntimeError):
        return jsonify({"error": "Invalid job list file path", "jobs": []}), 400

    try:
        candidate.relative_to(root)
    except ValueError:
        # Not under the allowed root. 
        return jsonify({
            "error": "Job list path is outside the allowed directory",
            "jobs": [],
        }), 400

    if candidate.suffix.lower() != ".json":
        return jsonify({"error": "Job list must be a .json file", "jobs": []}), 400

    try:
        with open(candidate) as f:
            job_list_data = json.load(f)
        if not isinstance(job_list_data, dict):
            return jsonify({"error": "Job list file is malformed", "jobs": []}), 400
        jobs = job_list_data.get("jobs", [])
        if not isinstance(jobs, list):
            return jsonify({"error": "Job list file is malformed", "jobs": []}), 400
        fallback_name = candidate.stem
        return jsonify({
            "jobs": jobs,
            "name": (job_list_data.get("name") or fallback_name),
            "count": len(jobs),
        }), 200
    except FileNotFoundError:
        return jsonify({"error": "Job list file not found", "jobs": []}), 404
    except json.JSONDecodeError:
        return jsonify({"error": "Job list file is not valid JSON", "jobs": []}), 400
    except Exception as e:
        current_app.logger.exception("load-job-list failed")
        return jsonify({"error": safe_err(e), "jobs": []}), 500


def _validate_job_list_file(fpath: Path):
    """Confirm a job-list JSON file parses cleanly and has a non-empty 'jobs' array.
    Returns (ok, name, count, reason); reason is a short log message on failure.
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
    """Enumerate every well-formed .json file under config/job_lists/ for the dropdown.
    Skips SAMPLE-* templates and quietly drops malformed files after logging the reason.
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
