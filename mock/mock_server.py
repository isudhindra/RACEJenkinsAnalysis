"""
Self-contained mock server for the Jenkins Failure Analysis Dashboard.

Emulates ALL backend API routes with representative mock data and realistic
SSE streaming behavior. Serves the real dashboard.html template from the
parent directory so the full UI can be tested end-to-end.

Usage:
    cd Jenkins/mock
    python3 mock_server.py

Then open http://localhost:5111 in browser.

All mock data and behavior is contained in this file and mock_data.py.
Delete the entire mock/ folder to remove all mock artifacts.
"""

import json
import os
import sys
import time
import uuid
import hashlib
import threading

from flask import Flask, render_template, request, jsonify, Response

# Import mock data from sibling module
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mock_data import generate_mock_jobs, MOCK_CONTEXTS, BASE

# ============================================================================
# APP SETUP
# ============================================================================

# Point templates and static folder to parent directory so external JS modules load
PARENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
app = Flask(
    __name__,
    template_folder=os.path.join(PARENT_DIR, "templates"),
    static_folder=os.path.join(PARENT_DIR, "static"),
)

# In-memory state
mock_jobs = []
active_operation_id = None

# ============================================================================
# LOG CACHE — fetch-once, analyze-locally
# ============================================================================
# Cache keyed by "job_url::build_number" → { lines: list[str], timestamp: float }
# TTL: 30 minutes. Completed build logs are immutable (same build = same log).
# In-progress builds are never cached (their logs are still growing).

LOG_CACHE = {}
LOG_CACHE_LOCK = threading.Lock()
LOG_CACHE_TTL = 1800  # 30 minutes


def _cache_key(job_url, build_number):
    """Deterministic cache key from job URL + build number."""
    raw = f"{job_url}::{build_number}"
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


def _cache_get(job_url, build_number):
    """Return cached log lines or None if miss/expired."""
    key = _cache_key(job_url, build_number)
    with LOG_CACHE_LOCK:
        entry = LOG_CACHE.get(key)
        if entry is None:
            return None
        if time.time() - entry["timestamp"] > LOG_CACHE_TTL:
            del LOG_CACHE[key]
            return None
        return entry["lines"]


def _cache_put(job_url, build_number, lines):
    """Store log lines in cache."""
    key = _cache_key(job_url, build_number)
    with LOG_CACHE_LOCK:
        LOG_CACHE[key] = {"lines": lines, "timestamp": time.time()}


def _cache_stats():
    """Return cache size and key count for diagnostics."""
    with LOG_CACHE_LOCK:
        return {"entries": len(LOG_CACHE)}


def _format_sse(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


# ============================================================================
# ROUTES
# ============================================================================

@app.route("/", methods=["GET"])
def dashboard():
    """Serve the real dashboard template with mock contexts."""
    taxonomy = {
        "domain_colors": {
            "API / Backend Service": "blue",
            "Environment / Infrastructure": "orange",
            "Build / Configuration": "purple",
            "UI / Frontend": "teal",
            "Test Data": "amber",
            "Automation / Framework": "slate",
            "Browser / Driver": "indigo",
            "Unknown": "gray",
        },
        "fallback_labels": {
            "no_console_log": "No Console Data",
            "no_pattern_match": "Unclassified Failure",
            "success": "\u2014",
            "in_progress": "Build Running",
            "aborted": "Build Aborted",
        },
    }
    return render_template(
        "dashboard.html",
        contexts=json.dumps(MOCK_CONTEXTS),
        analysis_taxonomy=json.dumps(taxonomy),
    )


@app.route("/api/validate", methods=["POST"])
def validate_credentials():
    """Always validates successfully for mock."""
    # Simulate brief network latency
    time.sleep(0.3)
    return jsonify({"valid": True, "message": "Mock credentials validated successfully"}), 200


@app.route("/api/env-credentials-check", methods=["GET"])
def env_credentials_check():
    """Check whether JENKINS_NP_USERNAME and JENKINS_NP_API_KEY are present and non-empty."""
    username = os.environ.get("JENKINS_NP_USERNAME", "").strip()
    api_key = os.environ.get("JENKINS_NP_API_KEY", "").strip()
    available = bool(username and api_key)
    return jsonify({"available": available}), 200


@app.route("/api/env-validate", methods=["POST"])
def env_validate_credentials():
    """Authenticate using environment credentials (mock always succeeds)."""
    data = request.get_json()
    jenkins_url = data.get("jenkins_url", "").strip()
    if not jenkins_url:
        return jsonify({"valid": False, "message": "Jenkins URL is required"}), 200

    username = os.environ.get("JENKINS_NP_USERNAME", "").strip()
    api_key = os.environ.get("JENKINS_NP_API_KEY", "").strip()
    if not username or not api_key:
        return jsonify({"valid": False, "message": "Environment credentials are not available"}), 200

    time.sleep(0.3)
    return jsonify({
        "valid": True,
        "message": "Environment credentials validated successfully",
        "username": username,
    }), 200


@app.route("/api/discover-views", methods=["POST"])
def discover_views():
    """Return mock views."""
    time.sleep(0.2)
    views = [
        {"name": "All Test Jobs", "url": f"{BASE}/view/All-Tests/"},
        {"name": "Failed Jobs Only", "url": f"{BASE}/view/Failed-Only/"},
        {"name": "Frontend Suite", "url": f"{BASE}/view/Frontend-Suite/"},
        {"name": "API Regression", "url": f"{BASE}/view/API-Regression/"},
    ]
    return jsonify({"views": views}), 200


@app.route("/api/discover-view-jobs-count", methods=["POST"])
def discover_view_jobs_count():
    """Return mock job count for selected view."""
    time.sleep(0.2)
    data = request.get_json()
    view_path = data.get("view_path", "")

    if "Failed" in view_path:
        return jsonify({"count": 16, "view_name": "Failed Jobs Only"}), 200
    elif "Frontend" in view_path:
        return jsonify({"count": 7, "view_name": "Frontend Suite"}), 200
    elif "API" in view_path:
        return jsonify({"count": 10, "view_name": "API Regression"}), 200
    else:
        return jsonify({"count": 36, "view_name": "All Test Jobs"}), 200


@app.route("/api/load-job-list", methods=["POST"])
def load_job_list():
    """Return mock job list based on the selected file path."""
    data = request.get_json()
    file_path = data.get("job_list_file", "")

    if "payments" in file_path.lower():
        jobs = ["payment-api-unit-tests", "checkout-integration-tests", "order-processing-e2e",
                "payment-gateway-smoke", "refund-workflow-tests"]
        name = "Payments Regression Pack"
    elif "checkout" in file_path.lower() or "critical" in file_path.lower():
        jobs = ["cart-service-regression", "checkout-integration-tests", "order-processing-e2e",
                "shipping-api-integration"]
        name = "Critical Checkout Jobs"
    else:
        jobs = ["payment-api-unit-tests", "checkout-integration-tests", "order-processing-e2e"]
        name = "Custom Job List"

    return jsonify({
        "jobs": jobs,
        "name": name,
        "description": f"Predefined job list: {name}",
        "count": len(jobs),
    }), 200


@app.route("/api/fetch/stream", methods=["POST"])
def fetch_stream():
    """
    SSE stream that simulates the two-stage fetch pipeline.

    Stage 1: Emits job_metadata events with staggered delays (simulates parallel fetch).
    Stage 2: Emits job_enriched events for failed/unstable jobs.
    Final:   Emits fetch_complete.
    """
    global mock_jobs, active_operation_id

    operation_id = str(uuid.uuid4())
    active_operation_id = operation_id
    all_jobs = generate_mock_jobs()
    mock_jobs = all_jobs

    data = request.get_json() or {}
    view_path = data.get("view_path", "")

    # Filter based on selected view
    if "Failed" in view_path:
        target_jobs = [j for j in all_jobs if j["health_state"] in ("FAILED", "UNSTABLE", "FETCH_ERROR")]
    elif "Frontend" in view_path:
        target_jobs = [j for j in all_jobs if "ui" in j["job_name"].lower() or "selenium" in j["job_name"].lower() or "frontend" in j["job_name"].lower() or "cdn" in j["job_name"].lower() or "ssl" in j["job_name"].lower()]
    else:
        target_jobs = all_jobs

    total = len(target_jobs)

    def generate():
        start = time.time()

        # ── Stage 1: Metadata events ──
        for idx, job in enumerate(target_jobs):
            if active_operation_id != operation_id:
                return

            # First emit as stage-1 metadata (without classification for failed jobs)
            stage1_payload = dict(job)
            is_non_passing = job["health_state"] in ("FAILED", "UNSTABLE")

            if is_non_passing:
                stage1_payload["classification"] = None
                stage1_payload["failure_evidence"] = None
                stage1_payload["stage"] = "STAGE_1"

            # FETCH_ERROR jobs: emit job_metadata first (so the row is created)
            # followed by a job_error event (so the error badge appears).
            # This matches how the real backend stores error records in job_store
            # while the frontend needs both events to render the row + error state.
            if job["health_state"] == "FETCH_ERROR":
                yield _format_sse({
                    "event_type": "job_metadata",
                    "operation_id": operation_id,
                    **stage1_payload,
                })
                yield _format_sse({
                    "event_type": "job_error",
                    "operation_id": operation_id,
                    "job_url": job["job_url"],
                    "job_name": job["job_name"],
                    "error_message": job.get("error_message", "Unknown error"),
                    "error": job.get("error_message", "Unknown error"),
                })
            else:
                yield _format_sse({
                    "event_type": "job_metadata",
                    "operation_id": operation_id,
                    **stage1_payload,
                })

            # Progress update
            yield _format_sse({
                "event_type": "progress_update",
                "operation_id": operation_id,
                "completed": idx + 1,
                "total": total,
                "stage": "stage_1",
            })

            # Staggered delay — simulate parallel fetch latency
            time.sleep(0.08)

        # ── Stage 2: Enrichment events for failed/unstable ──
        failed_jobs = [j for j in target_jobs if j["health_state"] in ("FAILED", "UNSTABLE")]
        for idx, job in enumerate(failed_jobs):
            if active_operation_id != operation_id:
                return

            yield _format_sse({
                "event_type": "job_enriched",
                "operation_id": operation_id,
                **job,  # Full payload with classification + failure_evidence
            })

            yield _format_sse({
                "event_type": "progress_update",
                "operation_id": operation_id,
                "completed": idx + 1,
                "total": len(failed_jobs),
                "stage": "stage_2",
            })

            time.sleep(0.12)

        # ── Fetch complete ──
        duration = time.time() - start
        failed_count = sum(1 for j in target_jobs if j["health_state"] == "FAILED")
        unstable_count = sum(1 for j in target_jobs if j["health_state"] == "UNSTABLE")

        yield _format_sse({
            "event_type": "fetch_complete",
            "operation_id": operation_id,
            "total_jobs": total,
            "failed_count": failed_count,
            "unstable_count": unstable_count,
            "classified_count": failed_count + unstable_count,
            "duration_seconds": round(duration, 1),
        })

    return Response(generate(), mimetype="text/event-stream")


@app.route("/api/refresh/stream", methods=["POST"])
def refresh_stream():
    """SSE stream for selective refresh — re-emits metadata + enrichment for target jobs."""
    global active_operation_id

    operation_id = str(uuid.uuid4())
    active_operation_id = operation_id

    data = request.get_json() or {}
    scope = data.get("scope", "all")
    job_ids = data.get("job_ids", [])

    if scope == "failed":
        targets = [j for j in mock_jobs if j["health_state"] == "FAILED"]
    elif scope == "unstable":
        targets = [j for j in mock_jobs if j["health_state"] == "UNSTABLE"]
    elif scope == "aborted":
        targets = [j for j in mock_jobs if j["health_state"] == "ABORTED"]
    elif scope == "single" and job_ids:
        targets = [j for j in mock_jobs if j["job_url"] in job_ids]
    elif scope == "selected" and job_ids:
        targets = [j for j in mock_jobs if j["job_url"] in job_ids]
    else:
        targets = [j for j in mock_jobs if j["health_state"] != "FETCH_ERROR"]

    total = len(targets)

    def generate():
        start = time.time()

        for idx, job in enumerate(targets):
            yield _format_sse({
                "event_type": "job_metadata",
                "operation_id": operation_id,
                **job,
            })
            yield _format_sse({
                "event_type": "progress_update",
                "operation_id": operation_id,
                "completed": idx + 1,
                "total": total,
                "stage": "stage_1",
            })
            time.sleep(0.06)

        # Stage 2 for failed/unstable
        failed = [j for j in targets if j["health_state"] in ("FAILED", "UNSTABLE")]
        for idx, job in enumerate(failed):
            yield _format_sse({
                "event_type": "job_enriched",
                "operation_id": operation_id,
                **job,
            })
            yield _format_sse({
                "event_type": "progress_update",
                "operation_id": operation_id,
                "completed": idx + 1,
                "total": len(failed),
                "stage": "stage_2",
            })
            time.sleep(0.1)

        duration = time.time() - start
        # Refresh mode: minimal stats (matches real backend — no full stats)
        yield _format_sse({
            "event_type": "fetch_complete",
            "operation_id": operation_id,
            "total_jobs": total,
            "duration_seconds": round(duration, 1),
        })

    return Response(generate(), mimetype="text/event-stream")


@app.route("/api/console-log", methods=["POST"])
def console_log():
    """
    Two-mode console log endpoint with server-side caching.

    Mode 1 — CACHE HIT: Returns the full log as a single fast response with
    header X-CLV-Cached: true. The frontend can process all lines immediately
    and activate analysis features without waiting for streaming.

    Mode 2 — CACHE MISS (live fetch): Generates the log, caches it, and
    streams it as text/event-stream with progress events so the frontend can
    show a meaningful loading experience. Analysis features are gated until
    the 'complete' event fires.

    In-progress builds (is_running=true, no analysis_reference) are NEVER
    cached because their logs are still growing.

    Response headers (both modes):
        X-Total-Lines   — total line count (known in both modes)
        X-Build-Number  — the build being viewed
        X-Job-Name      — human-readable job name
        X-Build-Status  — FAILURE / UNSTABLE / SUCCESS / etc.
        X-CLV-Cached    — "true" if served from cache
        X-CLV-Source    — "cache" or "live"
    """
    data = request.get_json() or {}
    job_url = data.get("job_url", "")
    build_number = data.get("build_number", 0)

    # Find the job record to tailor the log
    target = None
    for j in mock_jobs:
        if j["job_url"] == job_url:
            target = j
            break

    job_name = target["job_name"] if target else job_url.rstrip("/").split("/")[-1]
    status = target["current_status"] if target else "FAILURE"

    # For IN_PROGRESS jobs referencing a prev build, use ref status
    is_running = target and target.get("is_running", False)
    if is_running and target.get("analysis_reference"):
        status = target["analysis_reference"].get("status", "FAILURE")
        build_number = build_number or (target.get("three_run_context", {}).get("previous", {}) or {}).get("build_number", build_number)

    effective_build = build_number or 99
    allow_cache = not is_running or (target and target.get("analysis_reference"))

    common_headers = {
        "X-Build-Number": str(effective_build),
        "X-Job-Name": job_name,
        "X-Build-Status": status,
    }

    # ── Mode 1: Cache hit → instant full response ──
    if allow_cache:
        cached = _cache_get(job_url, effective_build)
        if cached is not None:
            payload = "\n".join(cached) + "\n"
            return Response(payload, mimetype="text/plain", headers={
                **common_headers,
                "X-Total-Lines": str(len(cached)),
                "X-CLV-Cached": "true",
                "X-CLV-Source": "cache",
            })

    # ── Mode 2: Cache miss → generate, cache, stream with progress ──
    log_lines = _generate_console_log(job_name, effective_build, status, target)

    # Cache the log (unless it's a truly in-progress build with no reference)
    if allow_cache:
        _cache_put(job_url, effective_build, log_lines)

    total = len(log_lines)

    def stream():
        """
        SSE-style streaming:
          event: progress  → { loaded, total, pct }
          event: line      → raw log line (one per data field)
          event: complete  → { total_lines, cached }

        The frontend reads these events and transitions from loading → analysis
        only when 'complete' fires.
        """
        chunk_size = 40  # Lines per progress tick
        for i, line in enumerate(log_lines):
            yield f"data: {json.dumps({'type': 'line', 'text': line})}\n\n"

            # Emit progress event every chunk_size lines
            if (i + 1) % chunk_size == 0 or i == total - 1:
                pct = round((i + 1) / total * 100)
                yield f"data: {json.dumps({'type': 'progress', 'loaded': i + 1, 'total': total, 'pct': pct})}\n\n"
                # Simulate realistic Jenkins I/O latency (larger delays for bigger logs)
                time.sleep(0.08)

        # Completion signal — all lines delivered
        yield f"data: {json.dumps({'type': 'complete', 'total_lines': total, 'cached': False})}\n\n"

    return Response(stream(), mimetype="text/event-stream", headers={
        **common_headers,
        "X-Total-Lines": str(total),
        "X-CLV-Cached": "false",
        "X-CLV-Source": "live",
    })


def _generate_console_log(job_name, build_num, status, job_record):
    """Generate a realistic Jenkins console log with 800-3000 lines."""
    import random as rnd
    lines = []
    ts_base = "2026-03-25T09:"

    def ts(m, s):
        return f"{ts_base}{m:02d}:{s:02d}.{rnd.randint(100,999)}Z"

    # ── Jenkins Header ──
    lines.append(f"Started by user admin")
    lines.append(f"Running as SYSTEM")
    lines.append(f"Building in workspace /var/jenkins/workspace/{job_name}")
    lines.append(f"[Pipeline] {{")
    lines.append(f"[Pipeline] stage")
    lines.append(f"[Pipeline] {{ (Declarative: Checkout SCM)")
    lines.append(f"[{ts(10,1)}] [INFO] Checking out git repository...")
    lines.append(f"[{ts(10,2)}] [INFO] > git rev-parse --resolve-git-dir /var/jenkins/workspace/{job_name}/.git")
    lines.append(f"[{ts(10,3)}] [INFO] Fetching changes from the remote Git repository")
    lines.append(f"[{ts(10,5)}] [INFO] > git fetch --tags --force --progress origin +refs/heads/*:refs/remotes/origin/*")
    lines.append(f"[{ts(10,8)}] [INFO] Checking out Revision abc{rnd.randint(1000,9999)}def (refs/remotes/origin/main)")
    lines.append(f"[{ts(10,9)}] [INFO] > git checkout -f abc{rnd.randint(1000,9999)}def")
    lines.append(f"[Pipeline] }}")
    lines.append("")

    # ── Environment Setup ──
    lines.append(f"[Pipeline] stage")
    lines.append(f"[Pipeline] {{ (Environment Setup)")
    lines.append(f"[{ts(11,0)}] [INFO] Loading environment configuration from .env.test")
    lines.append(f"[{ts(11,1)}] [INFO] Java version: 17.0.9, vendor: Eclipse Adoptium")
    lines.append(f"[{ts(11,2)}] [INFO] Maven version: 3.9.6")
    lines.append(f"[{ts(11,3)}] [INFO] Node.js version: v20.11.1")
    lines.append(f"[{ts(11,4)}] [INFO] Setting up test database connection pool (max=20)")
    lines.append(f"[{ts(11,5)}] [WARN] Database connection pool startup took 3.2s (threshold: 2s)")
    lines.append(f"[{ts(11,6)}] [INFO] Initializing Redis cache at localhost:6379")
    lines.append(f"[{ts(11,7)}] [WARN] Redis health check responded in 450ms (expected < 100ms)")
    lines.append(f"[{ts(11,8)}] [INFO] Application context loaded in 4.8s")
    lines.append(f"[Pipeline] }}")
    lines.append("")

    # ── Dependency Resolution ──
    lines.append(f"[Pipeline] stage")
    lines.append(f"[Pipeline] {{ (Dependencies)")
    lines.append(f"[{ts(12,0)}] [INFO] Resolving Maven dependencies...")
    for i in range(12):
        group = rnd.choice(["org.springframework", "com.fasterxml.jackson", "org.apache.commons",
                           "io.cucumber", "org.seleniumhq.selenium", "com.google.guava",
                           "org.mockito", "junit", "org.assertj", "io.rest-assured",
                           "org.apache.httpcomponents", "com.zaxxer"])
        artifact = rnd.choice(["core", "databind", "lang3", "java", "chrome-driver",
                              "collections", "core", "jupiter", "assertj-core",
                              "rest-assured", "httpclient5", "HikariCP"])
        lines.append(f"[{ts(12,i+1)}] [INFO] Downloaded: {group}:{artifact}:jar:{rnd.randint(2,6)}.{rnd.randint(0,9)}.{rnd.randint(0,20)}")
    lines.append(f"[{ts(12,15)}] [INFO] Dependency resolution complete ({rnd.randint(85,150)} artifacts)")
    lines.append(f"[Pipeline] }}")
    lines.append("")

    # ── Compilation ──
    lines.append(f"[Pipeline] stage")
    lines.append(f"[Pipeline] {{ (Compile)")
    lines.append(f"[{ts(13,0)}] [INFO] --- maven-compiler-plugin:3.12.1:compile (default-compile) @ {job_name} ---")
    lines.append(f"[{ts(13,2)}] [INFO] Compiling {rnd.randint(120,400)} source files to /var/jenkins/workspace/{job_name}/target/classes")
    if rnd.random() < 0.3:
        lines.append(f"[{ts(13,3)}] [WARN] /src/main/java/com/example/service/LegacyHandler.java:[{rnd.randint(40,200)}] uses unchecked or unsafe operations")
    lines.append(f"[{ts(13,5)}] [INFO] Compilation successful")
    lines.append(f"[Pipeline] }}")
    lines.append("")

    # ── Test Execution (Cucumber-style with real ✔/✘/↷ markers) ──
    lines.append(f"[Pipeline] stage")
    lines.append(f"[Pipeline] {{ (Test Execution)")
    lines.append(f"[{ts(14,0)}] [INFO] --- maven-surefire-plugin:3.2.5:test (default-test) @ {job_name} ---")
    lines.append(f"[{ts(14,1)}] [INFO] Using configured provider org.apache.maven.surefire.junitplatform.JUnitPlatformProvider")
    lines.append(f"[{ts(14,2)}] [INFO] ")
    lines.append(f"[{ts(14,3)}] [INFO] -------------------------------------------------------")
    lines.append(f"[{ts(14,3)}] [INFO]  T E S T S")
    lines.append(f"[{ts(14,3)}] [INFO] -------------------------------------------------------")
    lines.append("")

    # Features and scenarios using real-world Cucumber BDD patterns
    features = [
        ("User Authentication", "@regression @user-auth @acceptApplicationUsesTestHarness", [
            ("Login with valid credentials", [
                ("Given", "the user service is running"),
                ("And", "a test user exists with valid credentials"),
                ("When", "the user submits login with valid credentials"),
                ("Then", "the login response status should be 200"),
                ("And", "the response body should contain an auth token"),
            ]),
            ("Login with invalid password", [
                ("Given", "the user service is running"),
                ("And", "a test user exists with valid credentials"),
                ("When", "the user submits login with an invalid password"),
                ("Then", "the login response status should be 401"),
                ("And", "the response body should contain error message"),
            ]),
            ("Password reset flow", [
                ("Given", "the user service is running"),
                ("And", "a test user exists with a verified email"),
                ("When", "the user requests a password reset"),
                ("Then", "a reset token should be generated"),
                ("And", "the confirmation email should be sent"),
            ]),
            ("Session timeout handling", [
                ("Given", "the user service is running"),
                ("And", "a user session is active"),
                ("When", "the session idle timeout expires"),
                ("Then", "the session should be invalidated"),
                ("And", "subsequent API calls should return 401"),
            ]),
            ("MFA verification", [
                ("Given", "the user service is running"),
                ("And", "a user has MFA enabled"),
                ("When", "the user submits a valid MFA code"),
                ("Then", "the MFA verification should succeed"),
                ("And", "a full-access token should be issued"),
            ]),
        ]),
        ("Shopping Cart", "@regression @shopping-cart @dynamic-pricing", [
            ("Add item to cart", [
                ("Given", "the cart service is running"),
                ("And", "the product catalog contains active items"),
                ("When", "the user adds item SKU-1234 to the cart"),
                ("Then", "the cart should contain 1 item"),
                ("And", "the cart total should reflect the item price"),
            ]),
            ("Remove item from cart", [
                ("Given", "the cart service is running"),
                ("And", "the cart contains item SKU-1234"),
                ("When", "the user removes item SKU-1234 from the cart"),
                ("Then", "the cart should be empty"),
                ("And", "the cart total should be zero"),
            ]),
            ("Update cart quantity", [
                ("Given", "the cart service is running"),
                ("And", "the cart contains item SKU-1234 with quantity 1"),
                ("When", "the user updates quantity to 3"),
                ("Then", "the cart quantity should be 3"),
                ("And", "the cart total should reflect the updated quantity"),
            ]),
            ("Apply discount code", [
                ("Given", "the cart service is running"),
                ("And", "the cart contains items totalling $100"),
                ("When", "the user applies discount code SAVE20"),
                ("Then", "a 20% discount should be applied"),
                ("And", "the new total should be $80"),
            ]),
            ("Cart persistence across sessions", [
                ("Given", "the cart service is running"),
                ("And", "the user has items in their cart"),
                ("When", "the user logs out and logs back in"),
                ("Then", "the cart should still contain the same items"),
                ("And", "the cart total should be unchanged"),
            ]),
        ]),
        ("Order Processing", "@regression @order-processing @dynamic-examiner", [
            ("Place new order", [
                ("Given", "the order service is running"),
                ("And", "the user has items in their cart"),
                ("When", "the user submits the order"),
                ("Then", "the order status should be CONFIRMED"),
                ("And", "an order confirmation email should be sent"),
            ]),
            ("Cancel pending order", [
                ("Given", "the order service is running"),
                ("And", "an order exists with status PENDING"),
                ("When", "the user requests cancellation"),
                ("Then", "the order status should be CANCELLED"),
                ("And", "a refund should be initiated"),
            ]),
            ("Order status tracking", [
                ("Given", "the order service is running"),
                ("And", "an order exists with status SHIPPED"),
                ("When", "the user checks order status"),
                ("Then", "the tracking information should be returned"),
                ("And", "the estimated delivery date should be present"),
            ]),
            ("Partial refund processing", [
                ("Given", "the order service is running"),
                ("And", "an order exists with multiple items"),
                ("When", "the user requests a partial refund for item SKU-5678"),
                ("Then", "only the specified item should be refunded"),
                ("And", "the order total should be updated"),
            ]),
            ("Bulk order submission", [
                ("Given", "the order service is running"),
                ("And", "the user has a bulk order CSV uploaded"),
                ("When", "the user submits the bulk order"),
                ("Then", "all individual orders should be created"),
                ("And", "a summary report should be generated"),
            ]),
        ]),
        ("Payment Gateway", "@regression @payment-gateway @receiveDocSeparate", [
            ("Credit card payment", [
                ("Given", "the payment gateway is connected"),
                ("And", "a valid credit card is on file"),
                ("When", "the user initiates payment of $50.00"),
                ("Then", "the payment should be authorized"),
                ("And", "a transaction receipt should be generated"),
            ]),
            ("PayPal integration", [
                ("Given", "the payment gateway is connected"),
                ("And", "the user has a linked PayPal account"),
                ("When", "the user pays via PayPal"),
                ("Then", "the PayPal redirect should complete successfully"),
                ("And", "the payment status should be COMPLETED"),
            ]),
            ("Failed payment retry", [
                ("Given", "the payment gateway is connected"),
                ("And", "a previous payment attempt has failed"),
                ("When", "the system retries the payment"),
                ("Then", "the retry should be attempted with exponential backoff"),
                ("And", "the final status should be recorded"),
            ]),
            ("Refund processing", [
                ("Given", "the payment gateway is connected"),
                ("And", "a completed transaction exists"),
                ("When", "the user requests a full refund"),
                ("Then", "the refund should be processed within 24 hours"),
                ("And", "the refund confirmation should be sent"),
            ]),
            ("Currency conversion", [
                ("Given", "the payment gateway is connected"),
                ("And", "the order currency is EUR"),
                ("When", "the payment is processed in USD"),
                ("Then", "the conversion rate should be applied"),
                ("And", "the converted amount should match the exchange rate"),
            ]),
        ]),
        ("API Integration", "@regression @api-integration @ChangeAppToDamageToLSRFrontendE2E", [
            ("REST endpoint validation", [
                ("Given", "the API gateway is running"),
                ("And", "authentication headers are set"),
                ("When", "I send a GET request to /api/v2/applications"),
                ("Then", "the response status should be 200"),
                ("And", "the response body should conform to the OpenAPI schema"),
            ]),
            ("GraphQL query handling", [
                ("Given", "the API gateway is running"),
                ("And", "the GraphQL endpoint is configured"),
                ("When", "I send a query for user profile data"),
                ("Then", "the response should contain the requested fields"),
                ("And", "no additional fields should be leaked"),
            ]),
            ("Webhook delivery", [
                ("Given", "the API gateway is running"),
                ("And", "a webhook endpoint is registered"),
                ("When", "an event triggers the webhook"),
                ("Then", "the webhook payload should be delivered"),
                ("And", "the delivery should be confirmed with a 200 response"),
            ]),
            ("Rate limiting enforcement", [
                ("Given", "the API gateway is running"),
                ("And", "rate limits are configured at 100 requests per minute"),
                ("When", "I send 150 requests within one minute"),
                ("Then", "the first 100 should succeed with status 200"),
                ("And", "the remaining 50 should return status 429"),
            ]),
            ("API versioning", [
                ("Given", "the API gateway is running"),
                ("And", "both v1 and v2 endpoints are active"),
                ("When", "I request the same resource on v1 and v2"),
                ("Then", "both should return valid responses"),
                ("And", "the v2 response should include the new fields"),
            ]),
        ]),
        ("Data Export", "@regression @data-export @service-status", [
            ("CSV export generation", [
                ("Given", "the export service is running"),
                ("And", "the database contains 10000 records"),
                ("When", "the user triggers a CSV export"),
                ("Then", "the CSV file should be generated"),
                ("And", "the row count should match the database"),
            ]),
            ("PDF report creation", [
                ("Given", "the export service is running"),
                ("And", "a report template is configured"),
                ("When", "the user generates a PDF report"),
                ("Then", "the PDF should contain all sections"),
                ("And", "charts and tables should render correctly"),
            ]),
            ("Email delivery of reports", [
                ("Given", "the export service is running"),
                ("And", "the email gateway is configured"),
                ("When", "the user requests email delivery of a report"),
                ("Then", "the email should be sent to the specified address"),
                ("And", "the attachment should be a valid PDF"),
            ]),
            ("Scheduled export trigger", [
                ("Given", "the export service is running"),
                ("And", "a nightly export schedule is configured"),
                ("When", "the scheduled trigger fires"),
                ("Then", "the export should execute automatically"),
                ("And", "the output should be stored in the archive bucket"),
            ]),
        ]),
    ]

    scenario_count = 0
    passed_count = 0
    failed_scenarios = []   # list of (scenario_name, feature_name, failing_step, error_msg)
    minute = 14
    second = 10

    # Error message templates matching real-world patterns
    error_templates = [
        ("org.junit.ComparisonFailure", "expected:<[{expected}]> but was:<[{actual}]>"),
        ("org.openqa.selenium.TimeoutException", "Expected condition failed: waiting for element to be clickable (tried for {wait}s with 500ms interval)"),
        ("java.lang.AssertionError", "Expected status code <{expected_code}> but was <{actual_code}>"),
        ("java.lang.NullPointerException", "Cannot invoke method on null object"),
        ("org.apache.http.conn.HttpHostConnectException", "Connect to localhost:{port} failed: Connection refused"),
    ]

    for feat_name, feat_tags, scenarios in features:
        lines.append(f"[{ts(minute, second)}] [INFO]  -")
        lines.append(f"[{ts(minute, second)}] [INFO]   _____   ___   ___   _____     ___   _____     _     ___   _____   ___   ___  ")
        lines.append(f"[{ts(minute, second)}] [INFO]  |_   _| | __| / __| |_   _|   / __| |_   _|   /_\\   | _ | |_   _| | __| |   \\ ")
        lines.append(f"[{ts(minute, second)}] [INFO]    | |   | _|  \\__ \\   | |     \\__ \\   | |    / _ \\  |   /   | |   | _|  | |) |")
        lines.append(f"[{ts(minute, second)}] [INFO]    |_|   |___| |___/   |_|     |___/   |_|   /_/ \\_\\ |_|_\\   |_|   |___| |___/ ")
        lines.append(f"[{ts(minute, second)}] [INFO]  {feat_name}")
        lines.append(f"[{ts(minute, second)}] [INFO]  " + "-" * len(feat_name))
        lines.append(f"[{ts(minute, second)}] [INFO]  {feat_tags}")
        lines.append("")

        for sc_name, steps in scenarios:
            scenario_count += 1
            second = (second + rnd.randint(2, 8)) % 60
            if second < 5:
                minute = min(minute + 1, 59)

            # Determine if this scenario fails
            will_fail = False
            if status in ("FAILURE", "UNSTABLE"):
                fail_rate = 0.25 if status == "FAILURE" else 0.10
                will_fail = rnd.random() < fail_rate

            # Scenario header line (matching real format)
            feat_file = feat_name.lower().replace(" ", "") + "/" + sc_name.replace(" ", "") + ".feature"
            lines.append(f"Scenario: {sc_name}                    # src/test/resources/features/{feat_file}:{rnd.randint(10,80)}")
            lines.append(f"[{ts(minute, second)}] [INFO] hooks.Hooks - Test Setup")

            # Pick which step will fail
            fail_step_idx = len(steps) - 2 if will_fail else -1

            for si, (keyword, step_text) in enumerate(steps):
                step_sec = (second + si + 1) % 60

                if will_fail and si == fail_step_idx:
                    # ✘ Failed step
                    step_def_class = feat_name.replace(' ', '') + "CukeSteps"
                    step_method = "i" + step_text.replace(" ", "_").replace("-", "_")[:40]
                    lines.append(f"[{ts(minute, step_sec)}] [INFO] s.s.s.{feat_name.replace(' ', '')}Steps - {step_text}")
                    lines.append(f"  \u2718 {keyword} {step_text}    # step_definitions.specifications.{step_def_class}.{step_method}(java.lang.String)")

                    # Error block matching real format
                    err_template = rnd.choice(error_templates)
                    exc_class = err_template[0]
                    if "ComparisonFailure" in exc_class:
                        err_msg = err_template[1].format(
                            expected=rnd.choice(["200", "CONFIRMED", "true", "active", "You're sending this application"]),
                            actual=rnd.choice(["422", "PENDING", "false", "inactive", "A task has been removed"]))
                    elif "TimeoutException" in exc_class:
                        err_msg = err_template[1].format(wait=rnd.randint(10, 30))
                    elif "AssertionError" in exc_class:
                        exp_code = "200"
                        act_code = rnd.choice(["500", "502", "503", "404", "422"])
                        err_msg = err_template[1].format(expected_code=exp_code, actual_code=act_code)
                    elif "NullPointerException" in exc_class:
                        err_msg = err_template[1]
                    else:
                        err_msg = err_template[1].format(port=rnd.choice([8080, 8443, 5432, 6379]))

                    lines.append(f"        {exc_class}: {err_msg}")
                    # Stack trace
                    lines.append(f"        \tat page_objects.{feat_name.replace(' ', '')}.ResultsPage.check{sc_name.replace(' ', '')}(ResultsPage.java:{rnd.randint(100,2000)})")
                    lines.append(f"        \tat step_definitions.specifications.serenity_steps.{feat_name.replace(' ', '')}Steps.{step_method}({feat_name.replace(' ', '')}Steps.java:{rnd.randint(100,2500)})")
                    lines.append(f"        \tat step_definitions.specifications.serenity_steps.{feat_name.replace(' ', '')}Steps$ByteBuddy$eXaIgRY3.{step_method}$accessor$kC7z2zLz(Unknown Source)")
                    lines.append(f"        \tat java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(DirectMethodHandleAccessor.java:103)")
                    lines.append(f"        \tat java.base/java.lang.reflect.Method.invoke(Method.java:580)")
                    lines.append(f"        \tat net.thucydides.core.steps.StepInterceptor.invokeMethod(StepInterceptor.java:{rnd.randint(500,550)})")
                    lines.append(f"        \tat net.thucydides.core.steps.StepInterceptor.runTestStep(StepInterceptor.java:{rnd.randint(470,490)})")
                    lines.append(f"        \tat io.cucumber.core.runner.TestStep.executeStep(TestStep.java:{rnd.randint(60,90)})")
                    lines.append(f"        \tat io.cucumber.core.runner.PickleStepDefinitionMatch.runStep(PickleStepDefinitionMatch.java:{rnd.randint(50,80)})")
                    lines.append(f"        \tat \u2735.{keyword} {step_text}(file:///var/jenkins_home/workspace/{job_name}/src/test/resources/features/{feat_file}:{rnd.randint(40,60)})")

                    failed_scenarios.append((sc_name, feat_name, f"{keyword} {step_text}", f"{exc_class}: {err_msg}"))

                    # Remaining steps are skipped with ↷ marker
                    for ri in range(si + 1, len(steps)):
                        rkw, rst = steps[ri]
                        lines.append(f"  \u21b7 {rkw} {rst}    # step_definitions.specifications.{step_def_class}.skipped()")
                    break
                elif will_fail and si > fail_step_idx:
                    break
                else:
                    # ✔ Passed step
                    duration_ms = rnd.randint(50, 2000)
                    step_def_class = feat_name.replace(' ', '') + "CukeSteps"
                    step_method = "i" + step_text.replace(" ", "_").replace("-", "_")[:40]
                    if rnd.random() < 0.3:
                        lines.append(f"[{ts(minute, step_sec)}] [INFO] s.s.s.{feat_name.replace(' ', '')}Steps - {step_text}")
                    lines.append(f"  \u2714 {keyword} {step_text}    # step_definitions.specifications.{step_def_class}.{step_method}(java.lang.String)")

            if not will_fail:
                passed_count += 1

            # Post-scenario hooks
            if will_fail:
                lines.append(f"[{ts(minute, second + 5)}] [INFO] hooks.Hooks - After hook: @dynamic-examiner")
                lines.append(f"[{ts(minute, second + 5)}] [INFO] hooks.Hooks - isFrontendTest() returned true")
                lines.append(f"[{ts(minute, second + 5)}] [ERROR]  -")
                lines.append(f"[{ts(minute, second + 5)}] [ERROR]   _____   ___   ___   _____     ___     _     ___   _      ___   ___  ")
                lines.append(f"[{ts(minute, second + 5)}] [ERROR]  |_   _| | __| / __| |_   _|   | __|   /_\\   |_ _| | |    | __| |   \\ ")
                lines.append(f"[{ts(minute, second + 5)}] [ERROR]    | |   | _|  \\__ \\   | |     | _|   / _ \\   | |  | |__  | _|  | |) |")
                lines.append(f"[{ts(minute, second + 5)}] [ERROR]    |_|   |___| |___/   |_|     |_|   /_/ \\_\\ |___| |____| |___| |___/ ")
                lines.append(f"[{ts(minute, second + 5)}] [ERROR]  {sc_name}")
                lines.append(f"[{ts(minute, second + 5)}] [ERROR]  " + "-" * len(sc_name))
                lines.append(f"[{ts(minute, second + 5)}] [ERROR]  Test failed at step: {failed_scenarios[-1][2]}")
                lines.append(f"[{ts(minute, second + 5)}] [ERROR]  {failed_scenarios[-1][3]}")
            else:
                lines.append(f"[{ts(minute, second + 3)}] [INFO] hooks.Hooks - After hook: cleanup")

            lines.append(f"[{ts(minute, second + 4)}] [INFO] hooks.Hooks - Serenity session size: {rnd.randint(20,80)}")
            lines.append(f"[{ts(minute, second + 4)}] [INFO] hooks.Hooks - Serenity session size after clear: 0")
            lines.append("")

    # Service health checks (matching real pattern)
    lines.append(f"[{ts(minute, 50)}] [INFO] u.g.h.d.d.s.SystemStatusService - Running service health checks (on {rnd.randint(10,25)} services)")
    if status in ("FAILURE", "UNSTABLE"):
        for svc in rnd.sample(["Print", "Reporting", "Timeline", "Notification", "Archive"], rnd.randint(2,4)):
            lines.append(f"[{ts(minute, 50)}] [WARN] u.g.h.d.d.s.SystemStatusService - ***** {svc} service health check failed *****")
    lines.append("")

    # ── Test Summary ──
    failed_count = scenario_count - passed_count
    total_steps = sum(len(steps) for _, _, scenarios in features for _, steps in scenarios)
    passed_steps = total_steps - failed_count - (failed_count * 2)
    lines.append(f"[{ts(minute, 50)}] [INFO] -------------------------------------------------------")
    lines.append(f"[{ts(minute, 50)}] [INFO]  TEST RESULTS SUMMARY")
    lines.append(f"[{ts(minute, 50)}] [INFO] -------------------------------------------------------")
    lines.append(f"[{ts(minute, 51)}] [INFO] Scenarios:  {scenario_count} total, {passed_count} passed, {failed_count} failed")
    lines.append(f"[{ts(minute, 51)}] [INFO] Steps:      {total_steps} total, {passed_steps} passed, {failed_count} failed, {failed_count * 2} skipped")
    lines.append(f"[{ts(minute, 52)}] [INFO] Duration:   {rnd.randint(2,8)}m {rnd.randint(0,59)}s")
    lines.append("")

    if failed_scenarios:
        lines.append(f"[{ts(minute, 53)}] [ERROR] ====================================================")
        lines.append(f"[{ts(minute, 53)}] [ERROR]  FAILED SCENARIOS ({len(failed_scenarios)})")
        lines.append(f"[{ts(minute, 53)}] [ERROR] ====================================================")
        for fs_name, fs_feat, fs_step, fs_err in failed_scenarios:
            lines.append(f"[{ts(minute, 54)}] [ERROR]   \u2717 {fs_name} ({fs_feat})")
            lines.append(f"[{ts(minute, 54)}] [ERROR]     Failed at: {fs_step}")
            lines.append(f"[{ts(minute, 54)}] [ERROR]     {fs_err}")
        lines.append("")

    # ── Post-test warnings ──
    if rnd.random() < 0.6:
        lines.append(f"[{ts(minute, 55)}] [WARN] Test database cleanup: {rnd.randint(5,30)} orphaned records removed")
    if rnd.random() < 0.4:
        lines.append(f"[{ts(minute, 56)}] [WARN] Slow test detected: '{rnd.choice(['Order status tracking', 'Payment retry', 'Bulk submission'])}' took {rnd.randint(15,60)}s (threshold: 10s)")
    if rnd.random() < 0.3:
        lines.append(f"[{ts(minute, 57)}] [WARN] Connection pool: {rnd.randint(1,5)} connections were not returned cleanly")
    lines.append("")

    # ── Pipeline Closure ──
    lines.append(f"[Pipeline] }}")
    lines.append(f"[Pipeline] stage")
    lines.append(f"[Pipeline] {{ (Post Actions)")
    lines.append(f"[{ts(minute + 1, 0)}] [INFO] Publishing test results to Jenkins")
    lines.append(f"[{ts(minute + 1, 1)}] [INFO] Archiving artifacts: **/target/surefire-reports/*.xml")
    lines.append(f"[{ts(minute + 1, 2)}] [INFO] Generating Cucumber HTML report")
    if status in ("FAILURE", "UNSTABLE"):
        lines.append(f"[{ts(minute + 1, 3)}] [WARN] Build result: {status} — notifying Slack channel #ci-alerts")
    lines.append(f"[Pipeline] }}")
    lines.append(f"[Pipeline] }}")
    lines.append("")
    lines.append(f"Finished: {status}")

    return lines


@app.route("/api/rerun", methods=["POST"])
def rerun_builds():
    """Mock rerun — always succeeds."""
    data = request.get_json() or {}
    job_urls = data.get("job_urls", [])
    time.sleep(0.5)

    results = []
    for url in job_urls:
        results.append({
            "job_url": url,
            "triggered": True,
            "error": None,
        })

    return jsonify({"results": results}), 200


@app.route("/api/refresh-single", methods=["POST"])
def refresh_single_job():
    """Mock single-job refresh — returns matching mock job with a small delay."""
    data = request.get_json() or {}
    job_url = data.get("job_url", "")

    time.sleep(0.8)  # Simulate network + analysis latency

    for job in mock_jobs:
        if job["job_url"] == job_url:
            return jsonify(job), 200

    # Fallback: generate a generic refreshed job matching to_dict() shape
    fallback_name = job_url.rstrip("/").split("/")[-1]
    return jsonify({
        "job_name": fallback_name,
        "job_url": job_url,
        "current_status": "SUCCESS",
        "health_state": "PASSED",
        "is_running": False,
        "last_execution_time": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "last_build_number": 1,
        "last_refreshed_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "stage": "STAGE_2",
        "data_completeness": "COMPLETE",
        "error_message": None,
        "three_run_context": {
            "latest": {"build_number": 1, "status": "SUCCESS", "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"), "duration_ms": 60000},
            "previous": None,
            "last_passed": None,
        },
        "test_metrics": {"metrics_unavailable": True, "metrics_source": None},
        "classification": None,
        "failure_evidence": None,
        "recent_builds": [],
    }), 200


@app.route("/api/analyze-on-demand", methods=["POST"])
def analyze_on_demand():
    """Mock on-demand analysis — returns matching mock job or a generated one."""
    data = request.get_json() or {}
    job_url = data.get("job_url", "")

    for job in mock_jobs:
        if job["job_url"] == job_url:
            return jsonify(job), 200

    # Fallback: generate a generic failed job matching to_dict() shape
    fallback_name = job_url.rstrip("/").split("/")[-1]
    return jsonify({
        "job_name": fallback_name,
        "job_url": job_url,
        "current_status": "FAILURE",
        "health_state": "FAILED",
        "is_running": False,
        "last_execution_time": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "last_build_number": 1,
        "last_refreshed_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "stage": "STAGE_2",
        "data_completeness": "COMPLETE",
        "error_message": None,
        "three_run_context": {
            "latest": {"build_number": 1, "status": "FAILURE", "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"), "duration_ms": 120000},
            "previous": None,
            "last_passed": None,
        },
        "test_metrics": {"metrics_unavailable": True, "metrics_source": None},
        "classification": {
            "primary_domain": "Unknown",
            "subcategory": "On-Demand Analysis",
            "impact": "Medium",
            "confidence": "Partial",
            "matched_rule_name": "",
            "matched_pattern": "",
            "evidence_snippet": "",
            "action": "Review console output for failure details",
            "label": "On-Demand Analysis",
            "all_labels": [{"label": "On-Demand Analysis", "domain": "Unknown", "action": "Review console output for failure details", "rule_name": ""}],
            "secondary_hint": None,
        },
        "failure_evidence": None,
        "recent_builds": [],
    }), 200


@app.route("/api/console-log/cache", methods=["GET"])
def console_log_cache_status():
    """Diagnostic endpoint — returns cache stats."""
    return jsonify(_cache_stats()), 200


@app.route("/api/config", methods=["GET"])
def get_config():
    """Return mock config."""
    return jsonify({
        "thread_pool_size": 15,
        "default_timeout": 30,
        "contexts": MOCK_CONTEXTS,
        "analysis_taxonomy": {
            "domain_colors": {
                "API / Backend Service": "blue",
                "Environment / Infrastructure": "orange",
                "Build / Configuration": "purple",
                "UI / Frontend": "teal",
                "Test Data": "amber",
                "Automation / Framework": "slate",
                "Browser / Driver": "indigo",
                "Unknown": "gray",
            },
            "fallback_labels": {
                "no_console_log": "No Console Data",
                "no_pattern_match": "Unclassified Failure",
                "success": "\u2014",
                "in_progress": "Build Running",
                "aborted": "Build Aborted",
            },
        },
    }), 200


# ============================================================================
# ENTRY POINT
# ============================================================================

if __name__ == "__main__":
    port = 5111
    print(f"\n{'='*60}")
    print(f"  MOCK Jenkins Failure Analysis Dashboard")
    print(f"  URL: http://localhost:{port}")
    print(f"{'='*60}")
    jobs = generate_mock_jobs()
    from collections import Counter
    hs = Counter(j['health_state'] for j in jobs)
    summary = ", ".join(f"{c} {h.lower()}" for h, c in sorted(hs.items(), key=lambda x: -x[1]))
    print(f"\n  Mock data: {len(jobs)} jobs ({summary})")
    print(f"  Contexts:  1 mock Jenkins instance with 2 predefined views")
    print(f"  Streaming: Simulated Stage 1 + Stage 2 with realistic delays")
    print(f"\n  To stop: Ctrl+C")
    print(f"  To remove: delete the mock/ folder\n")

    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
