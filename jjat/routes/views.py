"""Jenkins view discovery + job-list loading.

Three endpoints used by the configuration panel:

* ``POST /api/discover-views`` — list every view on the Jenkins host.
* ``POST /api/discover-view-jobs-count`` — show "(N jobs in <view>)".
* ``POST /api/load-job-list`` — load a saved predefined job list file.
"""

import json
import os

from flask import Blueprint, current_app, jsonify, request

from jjat.lib.credentials import resolve_credentials, safe_err
from jjat.lib.jenkins_factory import make_client
from jjat.lib.jenkins_urls import resolve_view_url

bp = Blueprint("views", __name__)


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

        # The view must belong to the Jenkins instance the user picked.
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

    Expects:
        ``{"job_list_file": "<absolute-path>"}``

    Returns:
        ``{"jobs": [...], "name": "...", "count": N}``

    The job-list file itself only needs to contain ``{"jobs": [...]}``.
    ``name`` is derived from the file's basename when the JSON doesn't
    carry one (the canonical label lives in ``contexts.json``).
    """
    data = request.get_json()
    file_path = data.get("job_list_file", "")
    if not file_path or not os.path.isabs(file_path):
        return jsonify({"error": "Invalid job list file path", "jobs": []}), 400

    try:
        with open(file_path) as f:
            job_list_data = json.load(f)
        jobs = job_list_data.get("jobs", [])
        # File may omit "name"; fall back to its basename (sans .json).
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
