"""Mock Jenkins dashboard — serves the real UI with realistic fake data.

Run as a standalone Flask app, on a different port from the real backend
(5001 by default) so both can coexist::

    python mock/mock_server.py

It impersonates every endpoint the frontend calls, returning canned data
designed to exercise every visible code path:

* All build statuses: SUCCESS, FAILURE, UNSTABLE, ABORTED, IN_PROGRESS,
  NOT_BUILT.
* Every classification label currently in ``config/rules.yaml`` (35 of
  them) — at least one job per label.
* All test-metrics shapes:
    - ``api_ok``           — full metrics from the testReport API
    - ``api_console_parsed`` — metrics parsed from the console
    - ``api_404,console_no_match`` — totally unavailable (dashes in UI)
    - ``api_ok`` with ``total=None`` and populated parts (regression
      coverage for the bug where the summary aggregated but the table
      didn't)
    - ``from_previous_build=true`` for IN_PROGRESS / ABORTED rows
* Release statuses: PASS, PENDING, FAIL, NA — wire-compatible with the
  real ``compute_release_status`` rule.
* A 50 000-line synthetic Cucumber console log so the Console Log Viewer
  can be stress-tested.
* Per-event SSE pacing so the UI fetch animation feels real.

The mock is self-contained — it does NOT import the ``jjat`` package,
so it can't accidentally regress real code paths.  It DOES share
``templates/`` and ``static/`` with the real server so the rendered
dashboard is identical.
"""

from __future__ import annotations

import json
import os
import random
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

from flask import Flask, Response, jsonify, render_template, request


# ============================================================================
# Paths — mock lives at <repo>/mock/, templates and static at <repo>/
# ============================================================================

PROJECT_ROOT = Path(__file__).resolve().parents[1]
TEMPLATES_DIR = PROJECT_ROOT / "templates"
STATIC_DIR = PROJECT_ROOT / "static"
CONFIG_DIR = PROJECT_ROOT / "config"


# ============================================================================
# Mock contexts — what the config panel sees
# ============================================================================

MOCK_CONTEXTS: Dict[str, Any] = {
    "instances": [
        {
            "id": "mock-jenkins",
            "display_name": "Mock Jenkins (Verification)",
            "jenkins_url": "http://jenkins-mock.example.com",
            "environment": "MOCK",
            "predefined_job_lists": [
                # The mock's /api/load-job-list ignores the file path and
                # always returns the full Mock Universe — these entries
                # exist so the Custom Job List dropdown is demo-able.
                {"name": "Mock Universe — All Jobs", "job_list_file": "mock-universe.json"},
                {"name": "Mock Universe — Smoke",    "job_list_file": "mock-smoke.json"},
            ],
        }
    ],
}

MOCK_VIEWS: List[Dict[str, str]] = [
    {"name": "PRP1 All Jobs", "url": "http://jenkins-mock.example.com/view/PRP1-All/"},
    {"name": "PRP1 Smoke", "url": "http://jenkins-mock.example.com/view/PRP1-Smoke/"},
    {"name": "SIT All Jobs", "url": "http://jenkins-mock.example.com/view/SIT-All/"},
    {"name": "SIT Regression", "url": "http://jenkins-mock.example.com/view/SIT-Regression/"},
]


# ============================================================================
# Classification taxonomy — keep in sync with config/rules.yaml.
#
# Each entry is (label, domain).  The mock fabricates ClassificationResult
# payloads using these — domain colors come from the real classifier via
# /api/config so the UI looks identical to a real fetch.
# ============================================================================

CLASSIFICATIONS = [
    # Timeout family
    ("Wait Timeout",                  "Timeout"),
    ("Element Wait Timeout",          "Timeout"),
    ("Page Load Timeout",             "Timeout"),
    ("Step Timeout",                  "Timeout"),
    # UI / Locator
    ("Element Not Found",             "UI / Locator"),
    ("Element Not Interactable",      "UI / Locator"),
    ("Click Intercepted",             "UI / Locator"),
    ("Stale Element",                 "UI / Locator"),
    ("Timeline Event Missing",        "UI / Locator"),
    # Browser / Session
    ("Browser Crashed",               "Browser / Session"),
    ("Session Not Created",           "Browser / Session"),
    ("Driver Disconnected",           "Browser / Session"),
    # API / Backend
    ("Service Error (5xx)",           "API / Backend Service"),
    ("Auth Failure (401/403)",        "API / Backend Service"),
    ("Resource Not Found (404)",      "API / Backend Service"),
    ("Service Unreachable",           "API / Backend Service"),
    # Environment / Infra
    ("DNS Resolution Failure",        "Environment / Infrastructure"),
    ("SSL/TLS Error",                 "Environment / Infrastructure"),
    ("DB Connection Issue",           "Environment / Infrastructure"),
    ("Out of Memory",                 "Environment / Infrastructure"),
    ("Permission Denied",             "Environment / Infrastructure"),
    # Assertion
    ("Assertion Failed",              "Assertion"),
    ("Hamcrest Mismatch",             "Assertion"),
    ("AssertJ Failure",               "Assertion"),
    # Test Data
    ("Missing Test Data",             "Test Data"),
    ("Null Test Data",                "Test Data"),
    # Automation / Framework
    ("Cucumber Step Failed",          "Automation / Framework"),
    ("Undefined Step",                "Automation / Framework"),
    ("Pending Step",                  "Automation / Framework"),
    ("Ambiguous Step",                "Automation / Framework"),
    ("NullPointerException",          "Automation / Framework"),
    ("Unhandled Exception",           "Automation / Framework"),
    ("No Tests Executed",             "Automation / Framework"),
    # Build / Config
    ("Compilation Failure",           "Build / Configuration"),
    ("Dependency Failure",            "Build / Configuration"),
]


# ============================================================================
# Date helpers — every timestamp is anchored on "now" so the dashboard's
# release-status logic and "last run" rendering produce sensible output.
# ============================================================================

NOW = datetime.now()


def _ts(days_ago: float, *, jitter_minutes: int = 30) -> datetime:
    """Return a datetime ``days_ago`` days before now, with jitter."""
    base = NOW - timedelta(days=days_ago)
    return base - timedelta(minutes=random.randint(-jitter_minutes, jitter_minutes))


# ============================================================================
# JobRecord builders — produce the EXACT shape JobRecord.to_dict emits,
# so the frontend can't tell a mock job from a real one.
# ============================================================================

def _build_info(build_number: int, status: str, days_ago: float, duration_s: int = 90) -> Dict[str, Any]:
    return {
        "build_number": build_number,
        "status": status,
        "timestamp": _ts(days_ago).isoformat(),
        "duration_ms": duration_s * 1000,
    }


def _passed_metrics(*, total: int, source: str = "api", from_prev: bool = False) -> Dict[str, Any]:
    """All-pass test metrics — total tests, all green."""
    return {
        "total": total,
        "passed": total,
        "failed": 0,
        "skipped": 0,
        "errors": 0,
        "duration_seconds": total * 1.2,
        "metrics_source": source,
        "metrics_unavailable": False,
        "from_previous_build": from_prev,
        "metrics_diagnostic": "api_ok" if source == "api" else "api_404,console_parsed",
    }


def _mixed_metrics(*, total: int, passed: int, failed: int = 0, skipped: int = 0, errors: int = 0) -> Dict[str, Any]:
    return {
        "total": total,
        "passed": passed,
        "failed": failed,
        "skipped": skipped,
        "errors": errors,
        "duration_seconds": total * 1.5,
        "metrics_source": "api",
        "metrics_unavailable": False,
        "from_previous_build": False,
        "metrics_diagnostic": "api_ok",
    }


def _missing_metrics(diagnostic: str = "api_404,console_no_match") -> Dict[str, Any]:
    """Renders as dashes in every cell, with a hover-tooltip diagnostic."""
    return {
        "total": None,
        "passed": None,
        "failed": None,
        "skipped": None,
        "errors": None,
        "duration_seconds": None,
        "metrics_source": None,
        "metrics_unavailable": True,
        "from_previous_build": False,
        "metrics_diagnostic": diagnostic,
    }


def _total_null_metrics(passed: int, failed: int = 0, skipped: int = 0) -> Dict[str, Any]:
    """Regression case — total is null but parts are populated."""
    return {
        "total": None,
        "passed": passed,
        "failed": failed,
        "skipped": skipped,
        "errors": 0,
        "duration_seconds": None,
        "metrics_source": "api",
        "metrics_unavailable": False,
        "from_previous_build": False,
        "metrics_diagnostic": "api_ok",
    }


def _classification(label: str, domain: str) -> Dict[str, Any]:
    """Fabricate a plausible ClassificationResult payload for the given label."""
    return {
        "primary_domain": domain,
        "subcategory": label,
        "impact": "High",
        "confidence": "Strong",
        "matched_rule_name": label.lower().replace(" ", "_"),
        "matched_pattern": f"(?i){label.split()[0]}",
        "evidence_snippet": f"  ... at FeatureSteps.scenario:42 — {label} reproduced in the step.",
        "action": f"Investigate {label.lower()} pattern in the failing step.",
        "label": label,
        "all_labels": [{"label": label, "domain": domain, "action": "", "rule_name": ""}],
        "secondary_hint": None,
    }


def _failure_evidence(label: str) -> Dict[str, Any]:
    return {
        "error_logs": [
            {
                "line_number": 4128,
                "message": f"{label}: see scenario context",
                "level": "ERROR",
                "context_before": "[INFO]   At step: Then the timeline shows the expected event",
            },
            {
                "line_number": 4129,
                "message": f"Caused by: {label}",
                "level": "ERROR",
                "context_before": None,
            },
        ],
        "error_count": 2,
        "failure_context": f"Cucumber step — {label}",
    }


def _job_url(name: str) -> str:
    return f"http://jenkins-mock.example.com/job/{name}/"


def _release_status_for(latest_status: str, latest_timestamp_iso: str, promotion_time: Optional[datetime]) -> str:
    """Mirror JobRecord.compute_release_status's rule."""
    if promotion_time is None:
        return "NA"
    ts = datetime.fromisoformat(latest_timestamp_iso.replace("Z", "+00:00"))
    if ts.tzinfo is not None:
        ts = ts.replace(tzinfo=None)
    if ts < promotion_time:
        return "PENDING"
    if latest_status == "SUCCESS":
        return "PASS"
    if latest_status in ("FAILURE", "UNSTABLE"):
        return "FAIL"
    return "PENDING"


# ============================================================================
# Build the universe of 60+ jobs — one entry per scenario.
# ============================================================================

def _make_record(
    *,
    name: str,
    latest_status: str,
    health_state: str,
    metrics: Dict[str, Any],
    classification: Optional[Dict[str, Any]] = None,
    failure_evidence: Optional[Dict[str, Any]] = None,
    latest_days_ago: float = 0.5,
    previous_status: Optional[str] = None,
    last_passed_days_ago: Optional[float] = 7.0,
    is_running: bool = False,
) -> Dict[str, Any]:
    """Build a JobRecord-shaped dict for ONE mock job."""
    build_n = random.randint(50, 500)
    latest = _build_info(build_n, latest_status, latest_days_ago)
    previous = _build_info(build_n - 1, previous_status or "SUCCESS", latest_days_ago + 1)
    last_passed = (
        _build_info(build_n - 5, "SUCCESS", last_passed_days_ago)
        if last_passed_days_ago is not None
        else None
    )

    three_run = {"latest": latest, "previous": previous, "last_passed": last_passed}

    # Fabricate 5 recent builds for the sparkline column.  Slot 0 is the
    # latest build; slots 1-4 are walked back with mostly-passing status
    # but with a sprinkle of failures so the trend looks real.
    recent_window = [latest, previous]
    for i in range(3):
        s = random.choices(
            ["SUCCESS", "SUCCESS", "SUCCESS", "FAILURE", "UNSTABLE"],
            weights=[60, 15, 10, 10, 5],
            k=1,
        )[0]
        recent_window.append(_build_info(build_n - 2 - i, s, latest_days_ago + 2 + i))

    return {
        "job_name": name,
        "job_url": _job_url(name),
        "current_status": latest_status,
        "health_state": health_state,
        "data_completeness": "COMPLETE" if metrics["metrics_unavailable"] is False else "PARTIAL",
        "stage": "STAGE_2" if classification else "STAGE_1",
        "last_refreshed_at": NOW.isoformat(),
        "three_run_context": three_run,
        "test_metrics": metrics,
        "classification": classification,
        "failure_evidence": failure_evidence,
        "recent_builds": recent_window,
        "is_running": is_running,
        "previous_status": previous["status"],
        "last_execution_time": latest["timestamp"],
        # populated below per request, since it depends on promotion_time:
        "release_status": "NA",
    }


def build_universe() -> List[Dict[str, Any]]:
    """Generate the full mock job list — one job per scenario in the matrix."""
    jobs: List[Dict[str, Any]] = []

    # Group A — 15 PASSED with API metrics (the happy path)
    for i in range(1, 16):
        total = random.choice([3, 5, 8, 12, 25, 47, 120])
        jobs.append(_make_record(
            name=f"prp1-passing-api-{i:02d}",
            latest_status="SUCCESS",
            health_state="PASSED",
            metrics=_passed_metrics(total=total, source="api"),
            latest_days_ago=random.uniform(0.1, 2.0),
        ))

    # Group B — 5 PASSED with console-parsed metrics
    for i in range(1, 6):
        jobs.append(_make_record(
            name=f"prp1-passing-console-{i}",
            latest_status="SUCCESS",
            health_state="PASSED",
            metrics=_passed_metrics(total=random.choice([6, 8, 15]), source="console"),
            latest_days_ago=random.uniform(0.5, 3.0),
        ))

    # Group C — 5 PASSED but metrics unavailable (dashes everywhere)
    for i in range(1, 6):
        jobs.append(_make_record(
            name=f"prp1-passing-no-metrics-{i}",
            latest_status="SUCCESS",
            health_state="PASSED",
            metrics=_missing_metrics("api_404,console_fetched:0B,console_empty"),
            latest_days_ago=random.uniform(1.0, 5.0),
        ))

    # Group D — 3 PASSED with total=null but parts populated (regression case)
    for i, parts in enumerate([(8, 0), (12, 1), (5, 0)], start=1):
        jobs.append(_make_record(
            name=f"prp1-passing-derived-{i}",
            latest_status="SUCCESS",
            health_state="PASSED",
            metrics=_total_null_metrics(passed=parts[0], skipped=parts[1]),
            latest_days_ago=random.uniform(0.5, 2.5),
        ))

    # Group E — one FAILED job per classification label (35 jobs cover the whole taxonomy)
    for i, (label, domain) in enumerate(CLASSIFICATIONS, start=1):
        total = random.choice([3, 5, 8, 15])
        failed = random.randint(1, max(1, total // 2))
        passed = max(0, total - failed)
        jobs.append(_make_record(
            name=f"prp1-fail-{label.lower().replace(' ', '-').replace('(', '').replace(')', '').replace('/', '-')[:30]}-{i:02d}",
            latest_status="FAILURE",
            health_state="FAILED",
            metrics=_mixed_metrics(total=total, passed=passed, failed=failed),
            classification=_classification(label, domain),
            failure_evidence=_failure_evidence(label),
            latest_days_ago=random.uniform(0.1, 1.5),
            previous_status=random.choice(["SUCCESS", "FAILURE", "UNSTABLE"]),
            last_passed_days_ago=random.uniform(1.0, 20.0),
        ))

    # Group F — 5 UNSTABLE (tests ran but some failed) with classification
    for i in range(1, 6):
        total = random.choice([10, 15, 20])
        failed = random.randint(1, 3)
        skipped = random.randint(0, 2)
        passed = total - failed - skipped
        label, domain = random.choice(CLASSIFICATIONS[:10])  # likely UI/Timeout
        jobs.append(_make_record(
            name=f"prp1-unstable-{i:02d}",
            latest_status="UNSTABLE",
            health_state="UNSTABLE",
            metrics=_mixed_metrics(total=total, passed=passed, failed=failed, skipped=skipped),
            classification=_classification(label, domain),
            failure_evidence=_failure_evidence(label),
            latest_days_ago=random.uniform(0.2, 2.0),
        ))

    # Group G — 5 ABORTED with metrics-from-previous (real-time previous-run feature)
    for i in range(1, 6):
        prev_total = random.choice([8, 12, 20])
        # Borrowed metrics — from_previous_build=true
        m = _passed_metrics(total=prev_total, source="api", from_prev=True)
        jobs.append(_make_record(
            name=f"prp1-aborted-{i:02d}",
            latest_status="ABORTED",
            health_state="ABORTED",
            metrics=m,
            latest_days_ago=random.uniform(0.1, 1.0),
            previous_status="SUCCESS",
        ))

    # Group H — 5 IN_PROGRESS borrowing previous-run metrics
    for i in range(1, 6):
        prev_total = random.choice([6, 10, 18])
        m = _passed_metrics(total=prev_total, source="api", from_prev=True)
        jobs.append(_make_record(
            name=f"prp1-running-{i:02d}",
            latest_status="IN_PROGRESS",
            health_state="UNKNOWN",
            metrics=m,
            latest_days_ago=0.005,  # ~7 minutes ago — actively running
            previous_status="SUCCESS",
            is_running=True,
        ))

    # Group I — 2 NOT_BUILT (never run — empty cells, no last_passed)
    for i in range(1, 3):
        jobs.append(_make_record(
            name=f"prp1-new-job-{i}",
            latest_status="NOT_BUILT",
            health_state="UNKNOWN",
            metrics=_missing_metrics("never_built"),
            latest_days_ago=random.uniform(15.0, 30.0),
            last_passed_days_ago=None,
        ))

    # Group J — long-name and edge-case jobs for UI overflow testing
    jobs.append(_make_record(
        name="prp1-very-long-job-name-that-tests-ui-overflow-handling-in-the-table-cell-and-breadcrumb",
        latest_status="SUCCESS",
        health_state="PASSED",
        metrics=_passed_metrics(total=8),
    ))
    jobs.append(_make_record(
        name="x",  # tiniest job name
        latest_status="FAILURE",
        health_state="FAILED",
        metrics=_mixed_metrics(total=2, passed=1, failed=1),
        classification=_classification("Generic Exception", "Automation / Framework"),
    ))

    return jobs


UNIVERSE: List[Dict[str, Any]] = build_universe()


# ============================================================================
# Synthetic 50 000-line Cucumber console log for CLV stress-testing.
#
# Mix of [INFO] step output, [DEBUG] lines, scenario / step markers, error
# blocks, and a few embedded URLs (to test the linkifier).
# ============================================================================

def _build_synthetic_log() -> str:
    rng = random.Random(42)
    lines: List[str] = []
    lines.append("Started by user mock")
    lines.append("Running as SYSTEM")
    lines.append("[INFO] Scanning for projects...")
    lines.append("[INFO] -----< gov.dap.tests:dap-specs >------")
    lines.append("[INFO] Building dap-specs 4.2.0")
    lines.append("[INFO] --- maven-failsafe-plugin:3.5.3:integration-test (default) @ dap-specs ---")

    base_ts = NOW - timedelta(minutes=45)
    scenarios = [
        "Citizen submits a new passport application",
        "Officer reviews submitted application",
        "Application moves to digital-documents-retained",
        "Premium service appointment booked",
        "Renewal application updates personal details",
    ]
    steps = [
        "Given the user is on the application landing page",
        "When the citizen enters valid personal details",
        "And the address lookup returns a valid postcode",
        "Then the application is saved as a draft",
        "And the timeline shows APPLICATION_DELIVERED event",
    ]

    for i in range(50_000):
        ts = (base_ts + timedelta(seconds=i * 0.04)).isoformat()
        roll = rng.random()
        if roll < 0.002:
            lines.append(f"  Scenario: {rng.choice(scenarios)}  # features/passport.feature:42")
        elif roll < 0.05:
            lines.append(f"    {rng.choice(steps)}  # ApplicationSteps.java:120")
        elif roll < 0.06:
            lines.append(f"[INFO] {ts} - Visit https://kibana-mock.example.com/s/dap/app/discover#/?_g=foo&_a=bar for the dashboard.")
        elif roll < 0.0605:
            lines.append("[ERROR] Unable to find timeline event APPLICATION_DELIVERED within 30s wait")
        elif roll < 0.061:
            lines.append("[ERROR] org.openqa.selenium.TimeoutException: Expected condition failed")
        elif roll < 0.55:
            lines.append(f"[INFO] {ts} - request processed")
        elif roll < 0.85:
            lines.append(f"[DEBUG] thread-{rng.randint(1, 20)} stepped through state CHECK_INTEGRITY")
        else:
            lines.append(f"[INFO] - PASSPORT_APPLICATION_DELIVERED for ref={uuid.uuid4().hex[:10]}")

    # Surefire-style summary near the end so the parser sees it
    lines.append("")
    lines.append("Results :")
    lines.append("")
    lines.append("Tests run: 38, Failures: 0, Errors: 0, Skipped: 0")
    lines.append("")
    lines.append("[INFO] BUILD SUCCESS")
    lines.append("[INFO] Total time:  4:32 min")
    lines.append("[INFO] Finished at: " + NOW.isoformat())
    return "\n".join(lines)


SYNTHETIC_LOG = _build_synthetic_log()


# ============================================================================
# Flask app
# ============================================================================

def create_mock_app() -> Flask:
    app = Flask(
        __name__,
        template_folder=str(TEMPLATES_DIR),
        static_folder=str(STATIC_DIR),
    )

    # Cache-buster bound to mock startup time so the browser refreshes
    # static assets between mock launches.
    asset_v = str(int(time.time()))

    @app.context_processor
    def _inject_asset_version() -> Dict[str, str]:
        return {"asset_v": asset_v}

    # Load the real classifier taxonomy via rules.yaml so domain colours and
    # fallback labels match the production palette.  We only need the
    # metadata, not the matching engine — read the YAML directly.
    try:
        import yaml
        with open(CONFIG_DIR / "rules.yaml") as f:
            rules_data = yaml.safe_load(f)
        taxonomy = {
            "domain_colors": rules_data.get("domain_colors", {}),
            "fallback_labels": rules_data.get("fallback_labels", {}),
        }
    except Exception:
        taxonomy = {"domain_colors": {}, "fallback_labels": {}}

    # ---------------------------------------------------------------- dashboard
    @app.route("/", methods=["GET"])
    def dashboard():
        return render_template(
            "dashboard.html",
            contexts=json.dumps(MOCK_CONTEXTS),
            analysis_taxonomy=json.dumps(taxonomy),
        )

    @app.route("/api/config", methods=["GET"])
    def api_config():
        return jsonify({
            "thread_pool_size": 24,
            "default_timeout": 30,
            "contexts": MOCK_CONTEXTS,
            "analysis_taxonomy": taxonomy,
        }), 200

    # ---------------------------------------------------------------- auth
    @app.route("/api/validate", methods=["POST"])
    def api_validate():
        return jsonify({"valid": True, "message": "Mock credentials accepted"}), 200

    @app.route("/api/env-credentials-check", methods=["GET"])
    def api_env_check():
        return jsonify({
            "available": True,
            "username_var": "JENKINS_TEST_USERNAME",
            "api_key_var": "JENKINS_TEST_API_KEY",
        }), 200

    @app.route("/api/env-validate", methods=["POST"])
    def api_env_validate():
        return jsonify({"valid": True, "message": "Mock env creds accepted", "username": "mock@user"}), 200

    # ---------------------------------------------------------------- views
    @app.route("/api/discover-views", methods=["POST"])
    def api_discover_views():
        time.sleep(0.15)
        return jsonify({"views": MOCK_VIEWS}), 200

    @app.route("/api/discover-view-jobs-count", methods=["POST"])
    def api_view_count():
        time.sleep(0.20)
        return jsonify({"count": len(UNIVERSE), "view_name": "PRP1 All Jobs"}), 200

    @app.route("/api/load-job-list", methods=["POST"])
    def api_load_job_list():
        return jsonify({
            "jobs": [j["job_name"] for j in UNIVERSE],
            "name": "Mock Universe",
            "description": "All scenarios",
            "count": len(UNIVERSE),
        }), 200

    # ---------------------------------------------------------------- fetch SSE
    @app.route("/api/fetch/stream", methods=["POST"])
    def api_fetch_stream():
        data = request.get_json() or {}
        promotion_iso = (data.get("promotion_time") or "").strip()
        promotion_time = _parse_promotion_iso(promotion_iso)
        operation_id = str(uuid.uuid4())
        jobs = list(UNIVERSE)
        return Response(
            _stream_jobs(jobs, operation_id, promotion_time, full_stats=True),
            mimetype="text/event-stream",
        )

    # ---------------------------------------------------------------- refresh SSE
    @app.route("/api/refresh/stream", methods=["POST"])
    def api_refresh_stream():
        data = request.get_json() or {}
        promotion_time = _parse_promotion_iso((data.get("promotion_time") or "").strip())
        scope = data.get("scope", "all")
        job_ids = data.get("job_ids", [])
        operation_id = str(uuid.uuid4())
        jobs = _filter_universe_by_scope(scope, job_ids)
        return Response(
            _stream_jobs(jobs, operation_id, promotion_time, full_stats=False),
            mimetype="text/event-stream",
        )

    # ---------------------------------------------------------------- poll
    @app.route("/api/poll-status", methods=["POST"])
    def api_poll_status():
        data = request.get_json() or {}
        urls = data.get("job_urls", []) or []
        out = []
        for url in urls:
            rec = _find_by_url(url)
            if not rec:
                out.append({"job_url": url, "status": "ERROR", "build_number": None, "timestamp": None})
                continue
            latest = rec["three_run_context"]["latest"]
            out.append({
                "job_url": url,
                "build_number": latest["build_number"],
                "status": latest["status"],
                "timestamp": latest["timestamp"],
            })
        return jsonify({"statuses": out}), 200

    # ---------------------------------------------------------------- refresh-single
    @app.route("/api/refresh-single", methods=["POST"])
    def api_refresh_single():
        return _serve_single_job_response(request)

    @app.route("/api/analyze-on-demand", methods=["POST"])
    def api_analyze():
        return _serve_single_job_response(request)

    # ---------------------------------------------------------------- console-log
    @app.route("/api/console-log", methods=["POST"])
    def api_console_log():
        time.sleep(0.5)
        return Response(SYNTHETIC_LOG, mimetype="text/plain", headers={"X-CLV-Cached": "true", "X-CLV-Source": "mock"})

    # ---------------------------------------------------------------- rerun
    @app.route("/api/rerun", methods=["POST"])
    def api_rerun():
        data = request.get_json() or {}
        urls = data.get("job_urls", []) or []
        results = [{"job_url": u, "triggered": True, "error": None} for u in urls]
        return jsonify({"results": results}), 200

    return app


# ============================================================================
# Helpers used inside route handlers
# ============================================================================

def _parse_promotion_iso(raw: str) -> Optional[datetime]:
    if not raw:
        return None
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is not None:
        dt = dt.replace(tzinfo=None)
    return dt


def _find_by_url(url: str) -> Optional[Dict[str, Any]]:
    for j in UNIVERSE:
        if j["job_url"] == url:
            return j
    return None


def _filter_universe_by_scope(scope: str, ids: List[str]) -> List[Dict[str, Any]]:
    if scope == "all":
        return list(UNIVERSE)
    if scope == "failed":
        return [j for j in UNIVERSE if j["health_state"] == "FAILED"]
    if scope == "unstable":
        return [j for j in UNIVERSE if j["health_state"] == "UNSTABLE"]
    if scope in ("selected", "single"):
        return [j for j in UNIVERSE if j["job_url"] in ids]
    return []


def _serve_single_job_response(req) -> Any:
    data = req.get_json() or {}
    url = (data.get("job_url") or "").strip()
    promotion_time = _parse_promotion_iso((data.get("promotion_time") or "").strip())
    rec = _find_by_url(url) or random.choice(UNIVERSE)
    payload = _stamp_release_status(dict(rec), promotion_time)
    return jsonify(payload), 200


def _stamp_release_status(rec: Dict[str, Any], promotion_time: Optional[datetime]) -> Dict[str, Any]:
    latest = rec["three_run_context"]["latest"]
    rec["release_status"] = _release_status_for(latest["status"], latest["timestamp"], promotion_time)
    return rec


def _sse(payload: Dict[str, Any]) -> str:
    return f"data: {json.dumps(payload)}\n\n"


def _stream_jobs(
    jobs: List[Dict[str, Any]],
    operation_id: str,
    promotion_time: Optional[datetime],
    *,
    full_stats: bool,
):
    """Generator that streams the mock fetch as SSE events.

    Order matches the real backend:
        N × JOB_METADATA  →  M × JOB_ENRICHED (for failed/unstable)  →  fetch_complete
    """
    start = time.time()
    total = len(jobs)

    # Stage 1 — metadata for every job
    for idx, job in enumerate(jobs):
        time.sleep(0.012)  # ~12ms per job — matches real-Jenkins-fast feel
        payload = _stamp_release_status(dict(job), promotion_time)
        # Strip Stage 2 fields that arrive separately
        payload_stage1 = dict(payload)
        payload_stage1["classification"] = None
        payload_stage1["failure_evidence"] = None
        payload_stage1["stage"] = "STAGE_1"
        yield _sse({
            "event_type": "job_metadata",
            "operation_id": operation_id,
            **payload_stage1,
        })
        if (idx + 1) % 10 == 0 or idx + 1 == total:
            yield _sse({
                "event_type": "progress_update",
                "operation_id": operation_id,
                "stage": "stage_1",
                "completed": idx + 1,
                "total": total,
            })

    # Stage 2 — enrichment for failed / unstable only
    enrich_targets = [j for j in jobs if j["health_state"] in ("FAILED", "UNSTABLE")]
    enrich_total = len(enrich_targets)
    for idx, job in enumerate(enrich_targets):
        time.sleep(0.025)
        yield _sse({
            "event_type": "job_enriched",
            "operation_id": operation_id,
            **_stamp_release_status(dict(job), promotion_time),
        })
        if (idx + 1) % 5 == 0 or idx + 1 == enrich_total:
            yield _sse({
                "event_type": "progress_update",
                "operation_id": operation_id,
                "stage": "stage_2",
                "completed": idx + 1,
                "total": enrich_total,
            })

    # fetch_complete
    duration = round(time.time() - start, 1)
    if full_stats:
        failed = sum(1 for j in jobs if j["health_state"] == "FAILED")
        unstable = sum(1 for j in jobs if j["health_state"] == "UNSTABLE")
        classified = sum(1 for j in jobs if j.get("classification"))
        yield _sse({
            "event_type": "fetch_complete",
            "operation_id": operation_id,
            "total_jobs": total,
            "failed_count": failed,
            "unstable_count": unstable,
            "classified_count": classified,
            "duration_seconds": duration,
        })
    else:
        yield _sse({
            "event_type": "fetch_complete",
            "operation_id": operation_id,
            "total_jobs": total,
            "duration_seconds": duration,
        })


# ============================================================================
# Entry point
# ============================================================================

if __name__ == "__main__":
    port = int(os.environ.get("MOCK_PORT", "5001"))
    print(f"  Mock universe loaded: {len(UNIVERSE)} jobs")
    print(f"  Synthetic console log: {len(SYNTHETIC_LOG):,} bytes / {SYNTHETIC_LOG.count(chr(10)):,} lines")
    print(f"  Open http://127.0.0.1:{port}/ in a browser to test the dashboard.")
    print()
    app = create_mock_app()
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
