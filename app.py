"""
Flask application layer for Jenkins Failure Analysis Tool.
Implements SSE streaming, job state management, and API routes.
"""

import json
import os
import queue
import threading
import time
import uuid
import webbrowser
from datetime import datetime
from typing import Dict, List, Optional, Any

from flask import Flask, render_template, request, jsonify, Response

from models import (
    JobRecord,
    BuildStatus,
    HealthState,
    SSEEvent,
    SSEEventType,
    StageCompletion,
    DataCompleteness,
)
from jenkins_client import JenkinsClient, JenkinsClientError
from pipeline import AnalysisOrchestrator, Classifier


# ============================================================================
# Module-Level State
# ============================================================================

job_store: Dict[str, JobRecord] = {}
active_operation_id: str = ""

# Sentinel token used by the frontend when env-auth was used (API key kept server-side)
_ENV_AUTH_PLACEHOLDER = "••••••••"


def _create_client(data: dict, *, timeout: int = 30) -> JenkinsClient:
    """Create a JenkinsClient from a request-data dict.

    Extracts ``jenkins_url``, ``username``, ``api_token`` from *data*
    and passes *timeout* through.  This eliminates 10 near-identical
    constructor calls scattered across the route handlers.
    """
    return JenkinsClient(
        base_url=data["jenkins_url"],
        username=data["username"],
        api_token=data["api_token"],
        timeout=timeout,
    )


def _resolve_credentials(data: dict) -> dict:
    """Return a copy of *data* with env credentials substituted when the
    API token matches the env-auth placeholder.  This allows every existing
    route to keep using ``data["username"]`` / ``data["api_token"]`` without
    modification while transparently supporting environment-based auth."""
    token = data.get("api_token", "")
    if token == _ENV_AUTH_PLACEHOLDER:
        env_user = os.environ.get("JENKINS_NP_USERNAME", "").strip()
        env_key = os.environ.get("JENKINS_NP_API_KEY", "").strip()
        if env_user and env_key:
            resolved = dict(data)
            resolved["username"] = env_user
            resolved["api_token"] = env_key
            return resolved
    return data


# ============================================================================
# Application Factory
# ============================================================================

def create_app() -> Flask:
    """
    Create and configure Flask application.

    Loads contexts.json at startup (optional). If the file does not exist,
    the connection panel operates in manual mode.

    Returns:
        Configured Flask application instance.
    """
    global job_store

    app = Flask(__name__, template_folder="templates")

    # Defaults
    app.config["thread_pool_size"] = 15
    app.config["default_timeout"] = 30

    # Initialize classifier
    config_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config")
    app.classifier = Classifier(rules_path=os.path.join(config_dir, "rules.yaml"))

    # Load contexts.json (optional — manual mode fallback)
    contexts_data = _load_contexts_json()
    app.config["contexts"] = contexts_data

    # Apply defaults from contexts.json if present
    defaults = contexts_data.get("defaults", {})
    if "max_workers" in defaults:
        app.config["thread_pool_size"] = defaults["max_workers"]
    if "timeout" in defaults:
        app.config["default_timeout"] = defaults["timeout"]

    # Initialize job store
    job_store = {}

    # Register routes
    register_routes(app)

    return app


def _load_contexts_json() -> dict:
    """
    Load and validate contexts.json configuration file.

    Validates the structure:
    - Top-level keys: instances (array), defaults (object)
    - Each instance requires: id, display_name, jenkins_url
    - Each instance has optional: predefined_job_lists
    - Jenkins views are discovered dynamically at runtime (no predefined_views)
    - No duplicate instance ids (first occurrence wins, duplicates skipped with warning)
    - job_list_file paths resolved relative to contexts.json directory

    Returns:
        Parsed contexts dict, or empty dict if file not found / malformed.
    """
    try:
        contexts_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config", "contexts.json")
        with open(contexts_path, "r") as f:
            data = json.load(f)
    except FileNotFoundError:
        print("[INFO] contexts.json not found — operating in manual mode")
        return {}
    except json.JSONDecodeError as e:
        print(f"[WARN] contexts.json is malformed: {e} — operating in manual mode")
        return {}

    if "instances" not in data or not isinstance(data["instances"], list):
        print("[WARN] contexts.json missing 'instances' array — operating in manual mode")
        return {}

    # Validate and deduplicate instances
    instance_required_fields = {"id", "display_name", "jenkins_url"}
    seen_ids = set()
    valid_instances = []
    contexts_dir = os.path.dirname(os.path.abspath(contexts_path))

    for idx, instance in enumerate(data["instances"]):
        # Check instance required fields
        missing = instance_required_fields - set(instance.keys())
        if missing:
            print(f"[WARN] Instance at index {idx} missing fields {missing} — skipped")
            continue

        # Check duplicate instance IDs
        if instance["id"] in seen_ids:
            print(f"[WARN] Duplicate instance id '{instance['id']}' at index {idx} — skipped")
            continue
        seen_ids.add(instance["id"])

        # Remove legacy predefined_views if present (views are now discovered dynamically)
        instance.pop("predefined_views", None)
        instance.pop("allow_dynamic_discovery", None)

        # Validate and resolve predefined_job_lists if present
        job_list_required = {"id", "name", "job_list_file", "environment", "source_mode"}
        if "predefined_job_lists" in instance and isinstance(instance["predefined_job_lists"], list):
            valid_lists = []
            for jl_idx, jl in enumerate(instance["predefined_job_lists"]):
                jl_missing = job_list_required - set(jl.keys())
                if jl_missing:
                    print(f"[WARN] Instance '{instance['id']}' job_list at index {jl_idx} missing fields {jl_missing} — skipped")
                    continue
                # Resolve path relative to contexts.json
                jl["job_list_file"] = os.path.join(contexts_dir, jl["job_list_file"])
                valid_lists.append(jl)
            instance["predefined_job_lists"] = valid_lists

        valid_instances.append(instance)

    data["instances"] = valid_instances
    return data


def register_routes(app: Flask) -> None:
    """Register all API routes and static routes."""

    @app.route("/", methods=["GET"])
    def dashboard():
        """Serve dashboard.html with contexts config and analysis taxonomy."""
        taxonomy = {
            "domain_colors": app.classifier.domain_colors,
            "fallback_labels": app.classifier.fallback_labels,
        }
        return render_template(
            "dashboard.html",
            contexts=json.dumps(app.config.get("contexts", {})),
            analysis_taxonomy=json.dumps(taxonomy),
        )

    @app.route("/api/validate", methods=["POST"])
    def validate_credentials():
        """Validate Jenkins credentials by testing connectivity."""
        data = _resolve_credentials(request.get_json())
        try:
            client = _create_client(data, timeout=app.config["default_timeout"])
            is_valid = client.validate_credentials()
            if is_valid:
                return jsonify({"valid": True, "message": "Credentials validated successfully"}), 200
            else:
                return jsonify({"valid": False, "message": "Invalid credentials or Jenkins unreachable"}), 200
        except Exception as e:
            return jsonify({"valid": False, "message": str(e)}), 200

    @app.route("/api/env-credentials-check", methods=["GET"])
    def env_credentials_check():
        """Check whether JENKINS_NP_USERNAME and JENKINS_NP_API_KEY are present and non-empty."""
        username = os.environ.get("JENKINS_NP_USERNAME", "").strip()
        api_key = os.environ.get("JENKINS_NP_API_KEY", "").strip()
        available = bool(username and api_key)
        return jsonify({"available": available}), 200

    @app.route("/api/env-validate", methods=["POST"])
    def env_validate_credentials():
        """Authenticate against the selected Jenkins instance using environment credentials."""
        data = request.get_json()
        jenkins_url = data.get("jenkins_url", "").strip()
        if not jenkins_url:
            return jsonify({"valid": False, "message": "Jenkins URL is required"}), 200

        username = os.environ.get("JENKINS_NP_USERNAME", "").strip()
        api_key = os.environ.get("JENKINS_NP_API_KEY", "").strip()
        if not username or not api_key:
            return jsonify({"valid": False, "message": "Environment credentials are not available"}), 200

        try:
            client = _create_client(
                {"jenkins_url": jenkins_url, "username": username, "api_token": api_key},
                timeout=app.config["default_timeout"],
            )
            is_valid = client.validate_credentials()
            if is_valid:
                return jsonify({
                    "valid": True,
                    "message": "Environment credentials validated successfully",
                    "username": username,
                }), 200
            else:
                return jsonify({"valid": False, "message": "Environment credentials rejected by Jenkins"}), 200
        except Exception as e:
            return jsonify({"valid": False, "message": str(e)}), 200

    @app.route("/api/discover-views", methods=["POST"])
    def discover_views():
        """Discover all views in a Jenkins instance."""
        data = _resolve_credentials(request.get_json())
        try:
            client = _create_client(data, timeout=app.config["default_timeout"])
            # Request view information from Jenkins API
            url = f"{client.base_url.rstrip('/')}/api/json?tree=views[name,url]"
            response = client.session.get(url, timeout=app.config["default_timeout"])
            response.raise_for_status()

            api_data = response.json()
            views = api_data.get("views", [])

            return jsonify({"views": views}), 200
        except Exception as e:
            return jsonify({"views": [], "error": f"Failed to connect to Jenkins: {str(e)}"}), 200

    @app.route("/api/discover-view-jobs-count", methods=["POST"])
    def discover_view_jobs_count():
        """Get the job count for a specific view."""
        data = _resolve_credentials(request.get_json())
        try:
            jenkins_url = data["jenkins_url"]
            client = _create_client(data, timeout=app.config["default_timeout"])
            view_url = data.get("view_url", "")
            view_path = data.get("view_path", "")

            # Prefer view_path for deterministic URL construction
            if view_path:
                view_url = _resolve_view_url(jenkins_url, view_path)
            elif view_url and not view_url.startswith("http"):
                view_url = client.base_url.rstrip("/") + "/" + view_url.lstrip("/")

            # Validate view belongs to the Jenkins instance
            if not view_url.rstrip("/").lower().startswith(jenkins_url.rstrip("/").lower()):
                return jsonify({"count": 0, "error": "View URL does not belong to selected Jenkins instance"}), 200

            # Fetch view data to get job count and view name
            url = f"{view_url.rstrip('/')}/api/json?tree=name,jobs[name]"
            response = client.session.get(url, timeout=app.config["default_timeout"])
            response.raise_for_status()

            api_data = response.json()
            view_name = api_data.get("name", "Unknown")
            jobs = api_data.get("jobs", [])
            count = len(jobs)

            return jsonify({"count": count, "view_name": view_name}), 200
        except Exception as e:
            return jsonify({"count": 0, "error": str(e)}), 200

    @app.route("/api/load-job-list", methods=["POST"])
    def load_job_list():
        """
        Load a custom job list from a predefined JSON file.

        Expects: { "job_list_file": "<absolute-path>" }
        Returns: { "jobs": ["job-name-1", ...], "name": "...", "count": N }
        """
        data = request.get_json()
        file_path = data.get("job_list_file", "")

        if not file_path or not os.path.isabs(file_path):
            return jsonify({"error": "Invalid job list file path", "jobs": []}), 400

        try:
            with open(file_path, "r") as f:
                job_list_data = json.load(f)

            jobs = job_list_data.get("jobs", [])
            name = job_list_data.get("name", "Custom Job List")
            description = job_list_data.get("description", "")

            return jsonify({
                "jobs": jobs,
                "name": name,
                "description": description,
                "count": len(jobs),
            }), 200
        except FileNotFoundError:
            return jsonify({"error": f"Job list file not found: {file_path}", "jobs": []}), 404
        except json.JSONDecodeError as e:
            return jsonify({"error": f"Invalid JSON in job list: {e}", "jobs": []}), 400
        except Exception as e:
            return jsonify({"error": str(e), "jobs": []}), 500

    @app.route("/api/fetch/stream", methods=["POST"])
    def fetch_stream():
        """
        Stream full fetch of jobs via SSE.

        Clears job_store, generates new operation ID, runs Stage 1 → Stage 2.
        """
        global job_store, active_operation_id

        data = _resolve_credentials(request.get_json())
        operation_id = str(uuid.uuid4())
        active_operation_id = operation_id
        job_store = {}

        source_mode = data.get("source_mode")
        jenkins_url = data.get("jenkins_url")
        username = data.get("username")
        api_token = data.get("api_token")
        max_workers = data.get("max_workers", app.config["thread_pool_size"])

        client = _create_client(data, timeout=app.config["default_timeout"])

        # Determine job list based on source mode
        if source_mode == "view_url":
            view_url = data.get("view_url", "")
            view_path = data.get("view_path", "")

            # If view_path provided, construct deterministic URL from jenkins_url + view_path
            if view_path:
                view_url = _resolve_view_url(jenkins_url, view_path)
            elif view_url and not view_url.startswith("http"):
                # Legacy: relative path fallback
                view_url = jenkins_url.rstrip("/") + "/" + view_url.lstrip("/")

            # Validate: view_url must belong to the selected jenkins_url
            normalized_base = jenkins_url.rstrip("/").lower()
            normalized_view = view_url.rstrip("/").lower()
            if not normalized_view.startswith(normalized_base):
                err_msg = (
                    f"View URL mismatch: '{view_url}' does not belong to "
                    f"Jenkins instance '{jenkins_url}'. Views must be bound "
                    f"to their parent Jenkins instance."
                )
                def mismatch_gen():
                    yield _format_sse({"event_type": "error", "message": err_msg, "operation_id": operation_id})
                return Response(mismatch_gen(), mimetype="text/event-stream")

            try:
                jobs = client.discover_jobs_from_view(view_url)
            except JenkinsClientError as exc:
                err_msg = str(exc)
                def error_gen():
                    yield _format_sse({"event_type": "error", "message": err_msg, "operation_id": operation_id})
                return Response(error_gen(), mimetype="text/event-stream")
        elif source_mode == "job_list":
            # Custom job list mode — job_names is a list of job name strings
            job_names = data.get("job_names", [])
            base = jenkins_url.rstrip("/")
            jobs = [{"name": jn, "url": f"{base}/job/{jn}/"} for jn in job_names]
        else:
            # Fallback: JSON list mode — jobs come as list of {"name": ..., "url": ...}
            jobs = data.get("jobs", [])

        if not jobs:
            def empty_gen():
                yield _format_sse({
                    "event_type": "fetch_complete",
                    "operation_id": operation_id,
                    "total_jobs": 0,
                    "duration_seconds": 0,
                })
            return Response(empty_gen(), mimetype="text/event-stream")

        orchestrator = AnalysisOrchestrator(
            client=client,
            classifier=app.classifier,
            max_workers=max_workers,
        )

        def generator():
            yield from _stream_full_fetch(operation_id, orchestrator, jobs)

        return Response(generator(), mimetype="text/event-stream")

    @app.route("/api/refresh/stream", methods=["POST"])
    def refresh_stream():
        """
        Stream selective refresh of jobs via SSE.

        Does NOT clear job_store — selectively updates entries.
        Supports scopes: all, failed, unstable, selected, single.
        """
        global job_store, active_operation_id

        data = _resolve_credentials(request.get_json())
        operation_id = str(uuid.uuid4())
        active_operation_id = operation_id

        scope = data.get("scope", "all")
        job_ids = data.get("job_ids", [])
        jenkins_url = data.get("jenkins_url")
        username = data.get("username")
        api_token = data.get("api_token")
        max_workers = data.get("max_workers", app.config["thread_pool_size"])

        target_jobs = _get_target_jobs_for_refresh(scope, job_ids)

        if not target_jobs:
            def empty_gen():
                yield _format_sse({
                    "event_type": "fetch_complete",
                    "operation_id": operation_id,
                    "total_jobs": 0,
                    "duration_seconds": 0,
                })
            return Response(empty_gen(), mimetype="text/event-stream")

        client = _create_client(data, timeout=app.config["default_timeout"])
        orchestrator = AnalysisOrchestrator(
            client=client,
            classifier=app.classifier,
            max_workers=max_workers,
        )

        # Convert target job URLs to {"name": ..., "url": ...} dicts
        jobs_for_refresh = []
        for job_url in target_jobs:
            existing = job_store.get(job_url)
            job_name = existing.job_name if existing else job_url.rstrip("/").split("/")[-1]
            jobs_for_refresh.append({"name": job_name, "url": job_url})

        def generator():
            yield from _stream_selective_refresh(operation_id, orchestrator, jobs_for_refresh)

        return Response(generator(), mimetype="text/event-stream")

    @app.route("/api/rerun", methods=["POST"])
    def rerun_builds():
        """Trigger builds for specified job URLs."""
        data = _resolve_credentials(request.get_json())
        job_urls = data.get("job_urls", [])
        jenkins_url = data.get("jenkins_url")
        username = data.get("username")
        api_token = data.get("api_token")

        client = _create_client(data, timeout=app.config["default_timeout"])
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
                    "error": str(e),
                })

        return jsonify({"results": results}), 200

    @app.route("/api/refresh-single", methods=["POST"])
    def refresh_single_job():
        """Re-fetch and re-analyze a single job, returning the updated record.

        This is the targeted row-level refresh endpoint.  Unlike the SSE-based
        /api/refresh/stream it runs synchronously, touches only one job in
        *job_store*, and returns a plain JSON response — making it ideal for
        in-place row updates without disrupting the rest of the table.
        """
        global job_store

        data = _resolve_credentials(request.get_json())
        job_url = data.get("job_url")
        job_name = data.get("job_name")
        jenkins_url = data.get("jenkins_url")
        username = data.get("username")
        api_token = data.get("api_token")

        if not job_url:
            return jsonify({"error": "job_url is required"}), 400

        # Derive job_name from existing store or from the URL
        if not job_name:
            existing = job_store.get(job_url)
            job_name = existing.job_name if existing else job_url.rstrip("/").split("/")[-1]

        try:
            client = _create_client(data, timeout=app.config["default_timeout"])
            orchestrator = AnalysisOrchestrator(
                client=client,
                classifier=app.classifier,
                max_workers=1,
            )

            record = orchestrator.analyze_single_job(job_url, job_name)
            job_store[job_url] = record

            return jsonify(record.to_dict()), 200
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @app.route("/api/analyze-on-demand", methods=["POST"])
    def analyze_on_demand():
        """Perform synchronous deep analysis on a single job."""
        global job_store

        data = _resolve_credentials(request.get_json())
        job_url = data.get("job_url")
        job_name = data.get("job_name")
        jenkins_url = data.get("jenkins_url")
        username = data.get("username")
        api_token = data.get("api_token")

        try:
            client = _create_client(data, timeout=app.config["default_timeout"])
            orchestrator = AnalysisOrchestrator(
                client=client,
                classifier=app.classifier,
                max_workers=1,
            )

            record = orchestrator.analyze_single_job(job_url, job_name)
            job_store[job_url] = record

            return jsonify(record.to_dict()), 200
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @app.route("/api/console-log", methods=["POST"])
    def get_console_log():
        """
        Fetch the full console log for a specific build.

        Expects: { "job_url", "build_number", "jenkins_url", "username", "api_token" }
        Returns: Full console text as text/plain.

        The frontend overlay streams this into the Console Log Viewer.
        Credentials are resolved via _resolve_credentials (supports env-auth).
        """
        data = _resolve_credentials(request.get_json())
        job_url = data.get("job_url", "").strip()
        build_number = data.get("build_number")
        jenkins_url = data.get("jenkins_url", "").strip()
        username = data.get("username", "").strip()
        api_token = data.get("api_token", "").strip()

        if not job_url:
            return jsonify({"error": "job_url is required"}), 400
        if not build_number:
            return jsonify({"error": "build_number is required"}), 400
        if not jenkins_url or not username or not api_token:
            return jsonify({"error": "Jenkins credentials are required"}), 400

        # Normalise build_number to int
        try:
            build_number = int(build_number)
        except (TypeError, ValueError):
            return jsonify({"error": "build_number must be a valid integer"}), 400

        try:
            client = _create_client(data, timeout=app.config["default_timeout"])
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
            return jsonify({"error": str(e)}), 502
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @app.route("/api/config", methods=["GET"])
    def get_config():
        """Return configuration, contexts, and analysis taxonomy."""
        return jsonify({
            "thread_pool_size": app.config.get("thread_pool_size", 15),
            "default_timeout": app.config.get("default_timeout", 30),
            "contexts": app.config.get("contexts", {}),
            "analysis_taxonomy": {
                "domain_colors": app.classifier.domain_colors,
                "fallback_labels": app.classifier.fallback_labels,
            },
        }), 200


# ============================================================================
# SSE Streaming Generators
# ============================================================================

def _format_sse(data: dict) -> str:
    """Format a dict as an SSE data line."""
    return f"data: {json.dumps(data)}\n\n"


def _resolve_view_url(jenkins_url: str, view_path: str) -> str:
    """
    Resolve a view path to a full view URL.

    Args:
        jenkins_url: Base Jenkins URL.
        view_path: Relative view path (e.g., "view/My-View").

    Returns:
        Full view URL with trailing slash.
    """
    return jenkins_url.rstrip("/") + "/" + view_path.strip("/") + "/"


def _create_error_record(event: SSEEvent) -> JobRecord:
    """
    Create an error JobRecord from a JOB_ERROR SSE event.

    Args:
        event: SSEEvent with event_type == JOB_ERROR.

    Returns:
        JobRecord with health_state=FETCH_ERROR and error_message populated.
    """
    return JobRecord(
        job_name=event.payload.get("job_name", "Unknown"),
        job_url=event.job_id,
        health_state=HealthState.FETCH_ERROR,
        error_message=event.payload.get("error_message", "Unknown error"),
        data_completeness=DataCompleteness.FETCH_ERROR,
    )


def _stream_pipeline(
    operation_id: str,
    orchestrator: AnalysisOrchestrator,
    jobs: List[Dict[str, str]],
    clear_store: bool = False,
    compute_full_stats: bool = False,
):
    """
    Generator for SSE pipeline (full fetch or selective refresh).

    Unified implementation for both full fetch and selective refresh operations.
    Optionally clears job_store at start (full fetch) and computes richer
    completion statistics (full fetch) vs minimal stats (refresh).

    Args:
        operation_id: Unique operation ID for this batch.
        orchestrator: AnalysisOrchestrator instance.
        jobs: List of {"name": str, "url": str} dicts.
        clear_store: If True, clear job_store before Stage 1 (full fetch mode).
        compute_full_stats: If True, compute and send failed/unstable/classified counts.
    """
    global job_store, active_operation_id

    if clear_store:
        job_store.clear()

    start_time = time.time()
    event_queue = queue.Queue()

    def on_result(event: SSEEvent):
        """Callback: enqueue SSE events from orchestrator worker threads."""
        event_queue.put(event)

    # ========================================================================
    # STAGE 1: Fetch job metadata
    # ========================================================================
    stage_1_thread = threading.Thread(
        target=orchestrator.run_stage_1,
        args=(jobs, operation_id, on_result),
        daemon=True,
    )
    stage_1_thread.start()

    stage_1_records: List[JobRecord] = []

    while stage_1_thread.is_alive() or not event_queue.empty():
        if operation_id != active_operation_id:
            return  # Abandoned operation

        try:
            event = event_queue.get(timeout=0.5)
        except queue.Empty:
            continue

        if event.event_type == SSEEventType.JOB_METADATA:
            record = _find_record_from_event(event, orchestrator)
            if record:
                job_store[event.job_id] = record
                stage_1_records.append(record)
            yield _format_sse({
                "event_type": "job_metadata",
                "operation_id": event.operation_id,
                **event.payload,
            })

        elif event.event_type == SSEEventType.JOB_ERROR:
            error_record = _create_error_record(event)
            job_store[event.job_id] = error_record
            yield _format_sse({
                "event_type": "job_error",
                "operation_id": event.operation_id,
                **event.payload,
            })

        elif event.event_type == SSEEventType.PROGRESS_UPDATE:
            yield _format_sse({
                "event_type": "progress_update",
                "operation_id": event.operation_id,
                **event.payload,
            })

    stage_1_thread.join(timeout=5.0)

    # ========================================================================
    # STAGE 2: Deep analysis on FAILED/UNSTABLE jobs
    # ========================================================================
    # For full fetch: analyze all failed/unstable in job_store
    # For refresh: analyze only among refreshed records
    if compute_full_stats:
        # Full fetch mode: filter from entire job_store
        failed_records = [
            r for r in job_store.values()
            if r.health_state in (HealthState.FAILED, HealthState.UNSTABLE)
        ]
    else:
        # Refresh mode: filter from stage_1_records only
        failed_records = [
            r for r in stage_1_records
            if r.health_state in (HealthState.FAILED, HealthState.UNSTABLE)
        ]

    if failed_records:
        stage_2_thread = threading.Thread(
            target=orchestrator.run_stage_2,
            args=(failed_records, operation_id, on_result),
            daemon=True,
        )
        stage_2_thread.start()

        while stage_2_thread.is_alive() or not event_queue.empty():
            if operation_id != active_operation_id:
                return

            try:
                event = event_queue.get(timeout=0.5)
            except queue.Empty:
                continue

            if event.event_type == SSEEventType.JOB_ENRICHED:
                # Record was mutated in-place by orchestrator; re-serialize
                if event.job_id in job_store:
                    yield _format_sse({
                        "event_type": "job_enriched",
                        "operation_id": event.operation_id,
                        **job_store[event.job_id].to_dict(),
                    })
                else:
                    yield _format_sse({
                        "event_type": "job_enriched",
                        "operation_id": event.operation_id,
                        **event.payload,
                    })

            elif event.event_type == SSEEventType.PROGRESS_UPDATE:
                yield _format_sse({
                    "event_type": "progress_update",
                    "operation_id": event.operation_id,
                    **event.payload,
                })

        stage_2_thread.join(timeout=5.0)

    # ========================================================================
    # FETCH_COMPLETE
    # ========================================================================
    duration = time.time() - start_time

    if compute_full_stats:
        # Full fetch mode: compute richer completion stats
        total_jobs = len(job_store)
        failed_count = sum(1 for r in job_store.values() if r.health_state == HealthState.FAILED)
        unstable_count = sum(1 for r in job_store.values() if r.health_state == HealthState.UNSTABLE)
        classified_count = sum(1 for r in job_store.values() if r.classification is not None)

        yield _format_sse({
            "event_type": "fetch_complete",
            "operation_id": operation_id,
            "total_jobs": total_jobs,
            "failed_count": failed_count,
            "unstable_count": unstable_count,
            "classified_count": classified_count,
            "duration_seconds": round(duration, 1),
        })
    else:
        # Refresh mode: minimal stats
        yield _format_sse({
            "event_type": "fetch_complete",
            "operation_id": operation_id,
            "total_jobs": len(jobs),
            "duration_seconds": round(duration, 1),
        })


def _stream_full_fetch(
    operation_id: str,
    orchestrator: AnalysisOrchestrator,
    jobs: List[Dict[str, str]],
):
    """
    Generator for full fetch SSE stream.

    Wrapper for _stream_pipeline with full fetch settings:
    - Clears job_store before Stage 1
    - Computes richer completion statistics
    """
    yield from _stream_pipeline(
        operation_id,
        orchestrator,
        jobs,
        clear_store=True,
        compute_full_stats=True,
    )


def _stream_selective_refresh(
    operation_id: str,
    orchestrator: AnalysisOrchestrator,
    jobs: List[Dict[str, str]],
):
    """
    Generator for selective refresh SSE stream.

    Wrapper for _stream_pipeline with selective refresh settings:
    - Does NOT clear job_store (selectively updates entries)
    - Does NOT compute full statistics (only sends total_jobs count)
    """
    yield from _stream_pipeline(
        operation_id,
        orchestrator,
        jobs,
        clear_store=False,
        compute_full_stats=False,
    )


# ============================================================================
# Helper Functions
# ============================================================================

def _find_record_from_event(event: SSEEvent, orchestrator: AnalysisOrchestrator) -> Optional[JobRecord]:
    """
    Retrieve the full JobRecord from the orchestrator's internal store.

    The orchestrator's run_stage_1 stores complete JobRecord objects (with
    three_run_context, test_metrics, etc.) in its _records dict. We use
    those directly instead of reconstructing from the serialized payload,
    which would lose typed fields needed by Stage 2.
    """
    try:
        job_url = event.job_id
        # Use orchestrator's internal record store (populated during Stage 1)
        if hasattr(orchestrator, '_records') and job_url in orchestrator._records:
            return orchestrator._records[job_url]

        # Fallback: reconstruct from payload (without three_run_context)
        payload = event.payload
        status_str = payload.get("current_status", "UNKNOWN")
        status = BuildStatus(status_str) if status_str in BuildStatus.__members__ else BuildStatus.UNKNOWN

        health_str = payload.get("health_state", "UNKNOWN")
        health = HealthState(health_str) if health_str in HealthState.__members__ else HealthState.UNKNOWN

        dc_str = payload.get("data_completeness", "COMPLETE")
        dc = DataCompleteness(dc_str) if dc_str in DataCompleteness.__members__ else DataCompleteness.COMPLETE

        record = JobRecord(
            job_name=payload.get("job_name", "Unknown"),
            job_url=payload.get("job_url", event.job_id),
            current_status=status,
            health_state=health,
            data_completeness=dc,
            stage=StageCompletion.STAGE_1,
            error_message=payload.get("error_message"),
        )
        return record
    except Exception:
        return None


def _get_target_jobs_for_refresh(scope: str, job_ids: List[str]) -> List[str]:
    """
    Determine which job URLs should be refreshed based on scope.

    Args:
        scope: 'all', 'failed', 'unstable', or 'selected'/'single'
        job_ids: List of specific job URLs (for 'selected'/'single' scope)

    Returns:
        List of target job URLs.
    """
    global job_store

    if scope == "all":
        return list(job_store.keys())
    elif scope == "failed":
        return [url for url, record in job_store.items() if record.health_state == HealthState.FAILED]
    elif scope == "unstable":
        return [url for url, record in job_store.items() if record.health_state == HealthState.UNSTABLE]
    elif scope in ("selected", "single"):
        return job_ids if job_ids else []
    return []


# ============================================================================
# Application Startup
# ============================================================================

if __name__ == "__main__":
    app = create_app()

    # Auto-open browser on startup
    def open_browser():
        time.sleep(1.5)
        webbrowser.open("http://localhost:5000")

    browser_thread = threading.Thread(target=open_browser, daemon=True)
    browser_thread.start()

    # Run Flask app
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
