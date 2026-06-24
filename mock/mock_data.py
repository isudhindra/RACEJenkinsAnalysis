"""
Mock data factory — comprehensive scenario coverage for dashboard validation.

Generates 35+ JobRecord-like dicts covering every combination of:
- Job statuses: SUCCESS, FAILURE, UNSTABLE, ABORTED, IN_PROGRESS, UNKNOWN (fetch-error)
- Execution recency: just ran, hours ago, days ago (stale)
- Metrics: full, partial, console-sourced, unavailable, high-volume, error-heavy, skip-heavy
- Transitions: every meaningful prev→current status pair
- In Progress: prev-passed, prev-failed, prev-unstable, prev-aborted, no-prev (first run)
- Regression: post-promotion, pre-promotion, boundary, stale (days old)
- Completeness: COMPLETE, PARTIAL, MINIMAL, FETCH_ERROR
- Classifications: multiple domains and confidence levels
"""

import random
from datetime import datetime, timedelta

# ============================================================================
# BUILDER HELPERS
# ============================================================================

def _ts(minutes_ago=0):
    return (datetime.now() - timedelta(minutes=minutes_ago)).isoformat()


def _build_info(build_num, status, minutes_ago=5, duration_ms=120000):
    return {
        "build_number": build_num,
        "status": status,
        "timestamp": _ts(minutes_ago),
        "duration_ms": duration_ms,
    }


def _test_metrics(total, passed, failed, skipped=0, errors=0, source="api", unavailable=False):
    return {
        "total": total,
        "passed": passed,
        "failed": failed,
        "skipped": skipped,
        "errors": errors,
        "duration_seconds": round(random.uniform(30, 600), 1) if total > 0 else None,
        "metrics_source": source,
        "metrics_unavailable": unavailable,
    }


def _classification(domain, subcategory, impact, confidence, action, evidence="", pattern="", rule_name="", label="", all_labels=None):
    primary_label = label or subcategory
    primary_rule = rule_name or f"rule-{domain.lower().replace(' ', '-')}"
    # Default all_labels to a single-entry list matching the primary classification
    if all_labels is None:
        all_labels = [{"label": primary_label, "domain": domain, "action": action, "rule_name": primary_rule}]
    return {
        "primary_domain": domain,
        "subcategory": subcategory,
        "impact": impact,
        "confidence": confidence,
        "matched_rule_name": primary_rule,
        "matched_pattern": pattern or f".*{subcategory.lower().replace(' ', '.')}.*",
        "evidence_snippet": evidence,
        "action": action,
        "label": primary_label,
        "all_labels": all_labels,
        "secondary_hint": None,
    }


def _failure_evidence(error_count, context=None):
    logs = []
    messages = [
        "java.lang.NullPointerException: Cannot invoke method on null object",
        "org.openqa.selenium.TimeoutException: Expected condition failed",
        "Connection refused: connect to localhost:8080",
        "AssertionError: Expected <200> but was <500>",
        "java.sql.SQLException: ORA-12541: TNS:no listener",
        "com.fasterxml.jackson.databind.JsonMappingException: Unexpected token",
        "java.lang.OutOfMemoryError: Java heap space",
        "org.apache.http.conn.HttpHostConnectException: Connect timed out",
        "javax.net.ssl.SSLHandshakeException: Remote host terminated the handshake",
        "Build step 'Execute shell' marked build as failure",
    ]
    for i in range(min(error_count, len(messages))):
        logs.append({
            "line_number": random.randint(100, 3000),
            "message": messages[i],
            "level": random.choice(["ERROR", "FATAL", "SEVERE"]) if i < 3 else "ERROR",
            "context_before": f"[INFO] Running test suite phase {i+1}..." if i % 2 == 0 else None,
        })
    return {
        "error_logs": logs,
        "error_count": error_count,
        "failure_context": context,
    }


def _recent_builds(build_num, current_status, prev_status, exec_minutes_ago):
    """Generate a list of 3-5 recent builds for release validation.
    Each entry mirrors the real backend's BuildInfo.to_dict() format."""
    if prev_status == "__none__":
        # First-ever build — no history
        return [_build_info(build_num, current_status, minutes_ago=exec_minutes_ago or 5)]

    statuses_pool = ["SUCCESS", "FAILURE", "UNSTABLE", "SUCCESS", "SUCCESS", "ABORTED"]
    builds = []
    # Current build
    builds.append(_build_info(build_num, current_status, minutes_ago=exec_minutes_ago or 5))
    # Previous builds going back in time
    for i in range(1, random.randint(3, 5)):
        b_num = build_num - i
        if b_num < 1:
            break
        if i == 1 and prev_status and prev_status != "__none__":
            b_status = prev_status
        else:
            b_status = random.choice(statuses_pool)
        minutes_back = (exec_minutes_ago or 5) + (i * random.randint(60, 240))
        builds.append(_build_info(b_num, b_status, minutes_ago=minutes_back))
    return builds


def _job_record(name, url, status, health, metrics=None, classification=None,
                evidence=None, prev_status=None, last_passed_build=None,
                build_num=None, error_message=None, stage="STAGE_2",
                completeness="COMPLETE", exec_minutes_ago=None,
                is_running=False, analysis_ref_status=None, analysis_ref_metrics=None):
    build_num = build_num or random.randint(100, 999)
    prev_build = build_num - 1

    if exec_minutes_ago is None:
        exec_minutes_ago = random.randint(2, 45)

    record = {
        "job_name": name,
        "job_url": url,
        "current_status": status,
        "health_state": health,
        "last_refreshed_at": _ts(0),
        "last_execution_time": _ts(exec_minutes_ago),
        "last_build_number": build_num,
        "stage": stage,
        "data_completeness": completeness,
        "error_message": error_message,
        "is_running": is_running,
        "three_run_context": {
            "latest": _build_info(build_num, status, minutes_ago=exec_minutes_ago),
            "previous": _build_info(prev_build, prev_status or status, minutes_ago=max(exec_minutes_ago + 60, 65)) if prev_status != "__none__" else None,
            "last_passed": _build_info(last_passed_build or (build_num - 3), "SUCCESS", minutes_ago=1440) if last_passed_build != "__none__" else None,
        },
        "test_metrics": metrics or {"metrics_unavailable": True, "metrics_source": None},
        "classification": classification,
        "failure_evidence": evidence,
        "recent_builds": _recent_builds(build_num, status, prev_status, exec_minutes_ago),
    }

    if is_running:
        record["current_status"] = "IN_PROGRESS"
        record["analysis_reference"] = {
            "status": analysis_ref_status,
            "metrics": analysis_ref_metrics or {"metrics_unavailable": True, "metrics_source": None},
            "source": "previous_completed_build" if analysis_ref_status else None,
        }
        if analysis_ref_metrics:
            record["test_metrics"] = analysis_ref_metrics

    return record


# ============================================================================
# COMPREHENSIVE SCENARIO JOBS
# ============================================================================

BASE = "https://jenkins-mock.example.com"

def generate_mock_jobs():
    """Generate 35 mock jobs covering every dashboard validation scenario."""
    jobs = []

    # ====================================================================
    #  PASSED JOBS (8) — various metric shapes, recency, transitions
    # ====================================================================

    # P1: Clean pass, full metrics, recent run, prev was also SUCCESS
    jobs.append(_job_record(
        "payment-api-unit-tests", f"{BASE}/job/payment-api-unit-tests/",
        "SUCCESS", "PASSED",
        metrics=_test_metrics(342, 342, 0, 0, 0),
        prev_status="SUCCESS",
        build_num=456,
        exec_minutes_ago=8,
    ))

    # P2: Pass with skips, prev was FAILURE → recovery transition
    jobs.append(_job_record(
        "checkout-integration-tests", f"{BASE}/job/checkout-integration-tests/",
        "SUCCESS", "PASSED",
        metrics=_test_metrics(128, 115, 0, 13, 0),
        prev_status="FAILURE",
        build_num=312,
        exec_minutes_ago=12,
    ))

    # P3: Pass, console-sourced metrics, prev was SUCCESS
    jobs.append(_job_record(
        "inventory-service-smoke", f"{BASE}/job/inventory-service-smoke/",
        "SUCCESS", "PASSED",
        metrics=_test_metrics(45, 42, 0, 3, 0, source="console"),
        prev_status="SUCCESS",
        build_num=789,
        exec_minutes_ago=18,
    ))

    # P4: Pass but metrics unavailable (deploy job), PARTIAL completeness
    jobs.append(_job_record(
        "user-auth-e2e", f"{BASE}/job/user-auth-e2e/",
        "SUCCESS", "PASSED",
        metrics=_test_metrics(0, 0, 0, 0, 0, unavailable=True),
        prev_status="SUCCESS",
        build_num=201,
        completeness="PARTIAL",
        exec_minutes_ago=25,
    ))

    # P5: Pass with high-volume test suite (stress KPI large numbers)
    jobs.append(_job_record(
        "platform-full-regression", f"{BASE}/job/platform-full-regression/",
        "SUCCESS", "PASSED",
        metrics=_test_metrics(4250, 4210, 0, 38, 2),
        prev_status="SUCCESS",
        build_num=1045,
        exec_minutes_ago=35,
    ))

    # P6: Pass, prev was UNSTABLE → stabilization transition
    jobs.append(_job_record(
        "cdn-cache-validation", f"{BASE}/job/cdn-cache-validation/",
        "SUCCESS", "PASSED",
        metrics=_test_metrics(56, 56, 0, 0, 0),
        prev_status="UNSTABLE",
        build_num=423,
        exec_minutes_ago=22,
    ))

    # P7: Pass, ran 3 days ago → stale for regression "Not Run Since Promotion" testing
    jobs.append(_job_record(
        "weekly-compliance-scan", f"{BASE}/job/weekly-compliance-scan/",
        "SUCCESS", "PASSED",
        metrics=_test_metrics(180, 178, 0, 2, 0),
        prev_status="SUCCESS",
        build_num=67,
        exec_minutes_ago=4320,  # 3 days ago
    ))

    # P8: Pass, ran 5 days ago → very stale, should always be "Not Run" post-promotion
    jobs.append(_job_record(
        "nightly-data-integrity", f"{BASE}/job/nightly-data-integrity/",
        "SUCCESS", "PASSED",
        metrics=_test_metrics(95, 95, 0, 0, 0),
        prev_status="SUCCESS",
        build_num=203,
        exec_minutes_ago=7200,  # 5 days ago
    ))

    # ====================================================================
    #  FAILED JOBS (7) — various failure domains, metric shapes, recency
    # ====================================================================

    # F1: Multi-label — assertion failure + DB connection issue + service timeout
    jobs.append(_job_record(
        "order-processing-e2e", f"{BASE}/job/order-processing-e2e/",
        "FAILURE", "FAILED",
        metrics=_test_metrics(180, 145, 28, 5, 2),
        classification=_classification(
            "Automation / Framework", "Assertion Error", "High", "Strong",
            "Review failing assertions in OrderProcessingTest — likely a backend API contract change",
            evidence="AssertionError: Expected HTTP 200 but received 500\n  at OrderProcessingTest.testCheckout(OrderProcessingTest.java:142)",
            pattern="AssertionError.*Expected.*but.*received",
            label="Assertion Failure",
            all_labels=[
                {"label": "Assertion Failure", "domain": "Automation / Framework", "action": "Review assertion logic and expected values.", "rule_name": "assertion_error"},
                {"label": "DB Connection Issue", "domain": "Environment / Infrastructure", "action": "Verify database is running and accessible. Check connection pool settings.", "rule_name": "db_connection"},
                {"label": "Service Timeout", "domain": "Environment / Infrastructure", "action": "Check infrastructure health and network connectivity.", "rule_name": "service_timeout"},
            ],
        ),
        evidence=_failure_evidence(8, "Test execution phase"),
        prev_status="FAILURE",
        build_num=678,
        exec_minutes_ago=6,
    ))

    # F2: Infra failure (DB), prev was SUCCESS → new breakage
    jobs.append(_job_record(
        "database-migration-check", f"{BASE}/job/database-migration-check/",
        "FAILURE", "FAILED",
        metrics=_test_metrics(30, 12, 15, 0, 3),
        classification=_classification(
            "Environment / Infrastructure", "Database Connectivity", "Critical", "Strong",
            "Investigate DB connection pool exhaustion — ORA-12541 indicates listener is down",
            evidence="java.sql.SQLException: ORA-12541: TNS:no listener\n  at oracle.jdbc.driver.T4CConnection.logon",
            pattern="ORA-12541.*TNS.*no listener",
            label="DB Connection Issue",
        ),
        evidence=_failure_evidence(15, "Database initialization phase"),
        prev_status="SUCCESS",
        build_num=245,
        exec_minutes_ago=14,
    ))

    # F3: Multi-label — UI timeout + element not found + null reference
    jobs.append(_job_record(
        "frontend-selenium-suite", f"{BASE}/job/frontend-selenium-suite/",
        "FAILURE", "FAILED",
        metrics=_test_metrics(520, 380, 112, 18, 10),
        classification=_classification(
            "UI / Frontend", "Element Timeout", "Medium", "Partial",
            "Multiple Selenium timeouts — check if frontend deploy completed before test execution",
            evidence="org.openqa.selenium.TimeoutException: Expected condition failed\n  waiting for element: #checkout-button",
            pattern="TimeoutException.*Expected condition failed",
            label="UI Timeout",
            all_labels=[
                {"label": "UI Timeout", "domain": "UI / Frontend", "action": "Review page load performance. Check network conditions and server response times.", "rule_name": "page_timeout"},
                {"label": "Element Not Found", "domain": "UI / Frontend", "action": "Review locator strategy. Check if UI changed in recent deployment.", "rule_name": "element_not_found"},
                {"label": "Null Reference", "domain": "Automation / Framework", "action": "Review code for null/undefined reference handling. Add defensive checks.", "rule_name": "null_pointer"},
            ],
        ),
        evidence=_failure_evidence(10, "Test execution phase"),
        prev_status="FAILURE",
        build_num=891,
        exec_minutes_ago=10,
    ))

    # F4: Multi-label — schema mismatch + auth failure
    jobs.append(_job_record(
        "api-contract-validation", f"{BASE}/job/api-contract-validation/",
        "FAILURE", "FAILED",
        metrics=_test_metrics(75, 60, 12, 3, 0),
        classification=_classification(
            "API / Backend Service", "Schema Mismatch", "High", "Strong",
            "API response schema changed — update contract tests to match new endpoint spec",
            evidence="JsonMappingException: Unexpected token END_OBJECT\n  Expected field 'discount_code' not found",
            pattern="JsonMappingException.*Unexpected token",
            label="Schema Mismatch",
            all_labels=[
                {"label": "Schema Mismatch", "domain": "API / Backend Service", "action": "API response schema changed — update contract tests to match new endpoint spec", "rule_name": "api_schema"},
                {"label": "Auth Failure", "domain": "API / Backend Service", "action": "Validate test credentials. Check token expiration.", "rule_name": "auth_failure"},
            ],
        ),
        evidence=_failure_evidence(5, "Test execution phase"),
        prev_status="SUCCESS",
        build_num=156,
        exec_minutes_ago=20,
    ))

    # F5: Deploy failure, no test metrics, MINIMAL completeness
    jobs.append(_job_record(
        "deploy-staging-pipeline", f"{BASE}/job/deploy-staging-pipeline/",
        "FAILURE", "FAILED",
        metrics=_test_metrics(0, 0, 0, 0, 0, unavailable=True),
        classification=_classification(
            "Environment / Infrastructure", "Connection Refused", "Critical", "Strong",
            "Staging deployment target unreachable — verify VPN and firewall rules",
            evidence="HttpHostConnectException: Connect to staging-app01:8443 timed out",
            pattern="HttpHostConnectException.*Connect.*timed out",
            label="Service Unreachable",
        ),
        evidence=_failure_evidence(3, "Deployment phase"),
        prev_status="SUCCESS",
        build_num=34,
        completeness="MINIMAL",
        exec_minutes_ago=45,
    ))

    # F6: OOM failure, prev also FAILURE → repeat offender
    jobs.append(_job_record(
        "memory-stress-tests", f"{BASE}/job/memory-stress-tests/",
        "FAILURE", "FAILED",
        metrics=_test_metrics(15, 8, 5, 0, 2),
        classification=_classification(
            "Environment / Infrastructure", "Out of Memory", "Critical", "Strong",
            "JVM heap exhausted during stress test — increase -Xmx or optimize test data volume",
            evidence="java.lang.OutOfMemoryError: Java heap space\n  at java.util.Arrays.copyOf(Arrays.java:3210)",
            pattern="OutOfMemoryError.*Java heap space",
            label="Out of Memory",
        ),
        evidence=_failure_evidence(6, "Test execution phase"),
        prev_status="FAILURE",
        build_num=88,
        exec_minutes_ago=30,
    ))

    # F7: Failed, ran 2 days ago → stale failure, should be "Not Run" in recent promotion
    jobs.append(_job_record(
        "batch-etl-validation", f"{BASE}/job/batch-etl-validation/",
        "FAILURE", "FAILED",
        metrics=_test_metrics(60, 42, 14, 2, 2),
        classification=_classification(
            "Data Pipeline", "ETL Transform Error", "High", "Strong",
            "ETL transformation failed on currency conversion step — null exchange rate for JPY",
            evidence="TransformException: Null exchange rate for currency code JPY",
            pattern="TransformException.*Null.*rate",
        ),
        evidence=_failure_evidence(4, "ETL transform phase"),
        prev_status="SUCCESS",
        build_num=145,
        exec_minutes_ago=2880,  # 2 days ago
    ))

    # ====================================================================
    #  UNSTABLE JOBS (4) — various instability patterns
    # ====================================================================

    # U1: Flaky tests, prev also UNSTABLE → persistent flake
    jobs.append(_job_record(
        "flaky-ui-tests", f"{BASE}/job/flaky-ui-tests/",
        "UNSTABLE", "UNSTABLE",
        metrics=_test_metrics(200, 185, 8, 7, 0),
        classification=_classification(
            "Test Instability", "Flaky Test", "Low", "Partial",
            "Known flaky tests — intermittent Selenium waits. Consider retry-on-failure plugin",
            evidence="TimeoutException: Timed out after 10 seconds waiting for visibility of element",
            pattern="TimeoutException.*Timed out.*waiting",
        ),
        evidence=_failure_evidence(4, "Test execution phase"),
        prev_status="UNSTABLE",
        build_num=445,
        exec_minutes_ago=15,
    ))

    # U2: Perf threshold breach, console metrics, prev SUCCESS → new degradation
    jobs.append(_job_record(
        "perf-benchmark-nightly", f"{BASE}/job/perf-benchmark-nightly/",
        "UNSTABLE", "UNSTABLE",
        metrics=_test_metrics(50, 44, 2, 4, 0, source="console"),
        classification=_classification(
            "Performance", "Threshold Breach", "Medium", "Partial",
            "Response time regression detected — p95 latency exceeds 500ms threshold",
            evidence="WARN: p95 latency 823ms exceeds threshold of 500ms",
            pattern="p95 latency.*exceeds threshold",
        ),
        evidence=_failure_evidence(2, "Performance validation phase"),
        prev_status="SUCCESS",
        build_num=77,
        exec_minutes_ago=55,
    ))

    # U3: SSL warning, low test count, prev SUCCESS
    jobs.append(_job_record(
        "ssl-cert-check", f"{BASE}/job/ssl-cert-check/",
        "UNSTABLE", "UNSTABLE",
        metrics=_test_metrics(10, 8, 0, 2, 0),
        classification=_classification(
            "Security", "SSL Warning", "Low", "Partial",
            "SSL certificate expires in 14 days — schedule renewal",
            evidence="SSLHandshakeException: Certificate will expire on 2026-04-07",
            pattern="SSLHandshakeException.*Certificate.*expire",
        ),
        evidence=_failure_evidence(1, None),
        prev_status="SUCCESS",
        build_num=112,
        exec_minutes_ago=40,
    ))

    # U4: Unstable with high error count (errors not failures), prev FAILURE → partial recovery
    jobs.append(_job_record(
        "data-sync-health-check", f"{BASE}/job/data-sync-health-check/",
        "UNSTABLE", "UNSTABLE",
        metrics=_test_metrics(120, 98, 4, 6, 12),
        classification=_classification(
            "Data Sync", "Replication Lag", "Medium", "Partial",
            "Replication lag exceeded threshold on 3 of 8 shards — monitor for auto-recovery",
            evidence="WARN: Shard-3 replication lag 45s exceeds 10s threshold",
            pattern="replication lag.*exceeds.*threshold",
        ),
        evidence=_failure_evidence(3, "Health check phase"),
        prev_status="FAILURE",
        build_num=334,
        exec_minutes_ago=28,
    ))

    # ====================================================================
    #  ABORTED JOBS (3) — various abort scenarios
    # ====================================================================

    # A1: Aborted, no metrics, prev SUCCESS → user-cancelled long run
    jobs.append(_job_record(
        "long-running-soak-test", f"{BASE}/job/long-running-soak-test/",
        "ABORTED", "ABORTED",
        metrics=_test_metrics(0, 0, 0, 0, 0, unavailable=True),
        prev_status="SUCCESS",
        build_num=22,
        completeness="MINIMAL",
        exec_minutes_ago=90,
    ))

    # A2: Aborted with partial metrics (ran some tests before abort), prev ABORTED → repeat
    jobs.append(_job_record(
        "overnight-load-test", f"{BASE}/job/overnight-load-test/",
        "ABORTED", "ABORTED",
        metrics=_test_metrics(300, 210, 15, 75, 0),
        prev_status="ABORTED",
        build_num=55,
        completeness="PARTIAL",
        exec_minutes_ago=180,  # 3 hours ago
    ))

    # A3: Aborted, ran 4 days ago → stale abort
    jobs.append(_job_record(
        "monthly-security-audit", f"{BASE}/job/monthly-security-audit/",
        "ABORTED", "ABORTED",
        metrics=_test_metrics(0, 0, 0, 0, 0, unavailable=True),
        prev_status="SUCCESS",
        build_num=12,
        completeness="MINIMAL",
        exec_minutes_ago=5760,  # 4 days ago
    ))

    # ====================================================================
    #  IN PROGRESS JOBS (5) — all baseline combinations
    # ====================================================================

    # IP1: In Progress, previous completed build was SUCCESS (most common safe case)
    jobs.append(_job_record(
        "cart-service-regression", f"{BASE}/job/cart-service-regression/",
        "IN_PROGRESS", "UNKNOWN",
        prev_status="SUCCESS",
        build_num=510,
        exec_minutes_ago=2,
        is_running=True,
        analysis_ref_status="SUCCESS",
        analysis_ref_metrics=_test_metrics(160, 158, 0, 2, 0),
    ))

    # IP2: In Progress, previous completed build was FAILURE → re-executing after failure
    #      Includes failure_evidence from previous build so error-log action is available
    jobs.append(_job_record(
        "shipping-api-integration", f"{BASE}/job/shipping-api-integration/",
        "IN_PROGRESS", "UNKNOWN",
        prev_status="FAILURE",
        build_num=267,
        exec_minutes_ago=5,
        is_running=True,
        analysis_ref_status="FAILURE",
        analysis_ref_metrics=_test_metrics(95, 70, 20, 3, 2),
        evidence=_failure_evidence(4, "Previous build #266 failed with API contract violations"),
        classification=_classification(
            "API Contract", "Response Schema Mismatch", "High", "Strong",
            "Review API contract changes and fix schema drift",
            evidence="Expected field 'shipping_rate' not found in response",
            pattern=".*schema.*mismatch.*",
        ),
    ))

    # IP3: In Progress, previous completed build was UNSTABLE → retry after instability
    #      Includes failure_evidence from previous build so error-log action is available
    jobs.append(_job_record(
        "email-notification-suite", f"{BASE}/job/email-notification-suite/",
        "IN_PROGRESS", "UNKNOWN",
        prev_status="UNSTABLE",
        build_num=189,
        exec_minutes_ago=3,
        is_running=True,
        analysis_ref_status="UNSTABLE",
        analysis_ref_metrics=_test_metrics(72, 65, 3, 4, 0),
        evidence=_failure_evidence(2, "Previous build #188 unstable due to flaky email delivery assertions"),
        classification=_classification(
            "Test Instability", "Flaky Assertions", "Medium", "Partial",
            "Stabilize email delivery timing assertions",
            evidence="Expected delivery within 5s but took 8.2s",
            pattern=".*flaky.*assertion.*",
        ),
    ))

    # IP4: In Progress, previous completed build was ABORTED → re-run after cancelled build
    jobs.append(_job_record(
        "migration-rollback-test", f"{BASE}/job/migration-rollback-test/",
        "IN_PROGRESS", "UNKNOWN",
        prev_status="ABORTED",
        build_num=44,
        exec_minutes_ago=8,
        is_running=True,
        analysis_ref_status="ABORTED",
        analysis_ref_metrics=_test_metrics(0, 0, 0, 0, 0, unavailable=True),
    ))

    # IP5: In Progress, no previous completed build → first-ever run
    jobs.append(_job_record(
        "new-feature-smoke-tests", f"{BASE}/job/new-feature-smoke-tests/",
        "IN_PROGRESS", "UNKNOWN",
        prev_status="__none__",
        last_passed_build="__none__",
        build_num=1,
        exec_minutes_ago=1,
        is_running=True,
        analysis_ref_status=None,
        analysis_ref_metrics=None,
    ))

    # ====================================================================
    #  FETCH ERROR JOBS (2) — unreachable or missing
    # ====================================================================

    # FE1: Connection error
    jobs.append(_job_record(
        "legacy-build-pipeline", f"{BASE}/job/legacy-build-pipeline/",
        "UNKNOWN", "FETCH_ERROR",
        error_message="Stage 1 fetch failed: HTTPSConnectionPool — Max retries exceeded",
        build_num=999,
        prev_status="__none__",
        last_passed_build="__none__",
        stage="STAGE_1",
        completeness="FETCH_ERROR",
    ))

    # FE2: 404 not found
    jobs.append(_job_record(
        "deprecated-smoke-tests", f"{BASE}/job/deprecated-smoke-tests/",
        "UNKNOWN", "FETCH_ERROR",
        error_message="Stage 1 fetch failed: 404 Client Error — Job not found",
        build_num=1,
        prev_status="__none__",
        last_passed_build="__none__",
        stage="STAGE_1",
        completeness="FETCH_ERROR",
    ))

    # ====================================================================
    #  EDGE-CASE METRIC JOBS (4) — unusual metric distributions
    # ====================================================================

    # E1: Passed but nearly all tests skipped (high skip ratio)
    jobs.append(_job_record(
        "feature-flag-gated-tests", f"{BASE}/job/feature-flag-gated-tests/",
        "SUCCESS", "PASSED",
        metrics=_test_metrics(250, 12, 0, 238, 0),
        prev_status="SUCCESS",
        build_num=678,
        exec_minutes_ago=50,
    ))

    # E2: Failed with zero test failures but build failure (compile/setup error, all tests skipped)
    jobs.append(_job_record(
        "microservice-build-verify", f"{BASE}/job/microservice-build-verify/",
        "FAILURE", "FAILED",
        metrics=_test_metrics(100, 0, 0, 100, 0),
        classification=_classification(
            "Build", "Compilation Error", "Critical", "Strong",
            "Build failed before test execution — Maven compilation error in PaymentService.java",
            evidence="[ERROR] COMPILATION FAILURE: PaymentService.java:[45,12] cannot find symbol",
            pattern="COMPILATION FAILURE",
        ),
        evidence=_failure_evidence(2, "Compilation phase"),
        prev_status="SUCCESS",
        build_num=502,
        exec_minutes_ago=38,
    ))

    # E3: Passed with high error count (errors are non-fatal warnings counted as errors)
    jobs.append(_job_record(
        "api-deprecation-scanner", f"{BASE}/job/api-deprecation-scanner/",
        "SUCCESS", "PASSED",
        metrics=_test_metrics(400, 370, 0, 5, 25),
        prev_status="SUCCESS",
        build_num=890,
        exec_minutes_ago=65,
    ))

    # E4: Unstable, console metrics, very small test count
    jobs.append(_job_record(
        "config-drift-detector", f"{BASE}/job/config-drift-detector/",
        "UNSTABLE", "UNSTABLE",
        metrics=_test_metrics(3, 1, 1, 0, 1, source="console"),
        classification=_classification(
            "Configuration", "Drift Detected", "Medium", "Partial",
            "Configuration drift detected on 2 of 5 nodes — review infrastructure-as-code sync",
            evidence="WARN: Node prod-app-03 config hash mismatch: expected abc123, got def456",
            pattern="config hash mismatch",
        ),
        evidence=_failure_evidence(1, "Config validation phase"),
        prev_status="SUCCESS",
        build_num=19,
        exec_minutes_ago=110,
    ))

    # ====================================================================
    #  PROMOTION BOUNDARY TESTING JOBS (3) — for regression status edge cases
    # ====================================================================

    # PB1: Passed, executed exactly 60 minutes ago → boundary for "1h ago" promotion preset
    jobs.append(_job_record(
        "notification-service-tests", f"{BASE}/job/notification-service-tests/",
        "SUCCESS", "PASSED",
        metrics=_test_metrics(89, 89, 0, 0, 0),
        prev_status="SUCCESS",
        build_num=567,
        exec_minutes_ago=60,
    ))

    # PB2: Failed, executed exactly 30 min ago → boundary for "30m ago" promotion preset
    jobs.append(_job_record(
        "search-api-regression", f"{BASE}/job/search-api-regression/",
        "FAILURE", "FAILED",
        metrics=_test_metrics(210, 190, 16, 2, 2),
        classification=_classification(
            "Search", "Index Stale", "High", "Strong",
            "Search index out of date — reindex required after schema migration",
            evidence="SearchException: Index version mismatch — expected v42, found v41",
            pattern="Index version mismatch",
        ),
        evidence=_failure_evidence(3, "Search validation phase"),
        prev_status="SUCCESS",
        build_num=134,
        exec_minutes_ago=30,
    ))

    # PB3: Passed, executed 16 minutes ago → just inside "15m ago" promotion window
    jobs.append(_job_record(
        "cache-invalidation-tests", f"{BASE}/job/cache-invalidation-tests/",
        "SUCCESS", "PASSED",
        metrics=_test_metrics(35, 34, 0, 1, 0),
        prev_status="FAILURE",
        build_num=256,
        exec_minutes_ago=16,
    ))

    # ====================================================================
    # ----- Extended scenarios (added 2026-06) -----
    # 15 additional jobs exercising new classifier rules, edge-case
    # rendering paths (HTML escaping, truncation, unicode, overflow),
    # promotion-time boundaries, and metric/completeness corner cases.
    # ====================================================================

    # X1: Awaitility condition timeout — Stage-2 evidence quotes the real exception class
    jobs.append(_job_record(
        "application-event-await-tests", f"{BASE}/job/application-event-await-tests/",
        "FAILURE", "FAILED",
        metrics=_test_metrics(64, 51, 11, 2, 0),
        classification=_classification(
            "Timeout", "Awaitility Condition Timeout", "Product Regression Likely", "Strong",
            "An Awaitility wait expired before the backend returned the expected response. Check the downstream service (ARD / test harness) for slowness or a regression in the response shape.",
            evidence="org.awaitility.core.ConditionTimeoutException: Lambda expression in com.passport.tests.ApplicationFlow expected the predicate to return <true> but it returned <false> within 30 seconds.",
            pattern="org\\.awaitility\\.core\\.ConditionTimeoutException",
            rule_name="awaitility_condition_timeout",
            label="Awaitility Timeout",
        ),
        evidence=_failure_evidence(5, "Awaitility wait phase — backend never satisfied predicate"),
        prev_status="SUCCESS",
        build_num=312,
        exec_minutes_ago=18,
    ))

    # X2: Reviewable element not found — exercises the reviewable_not_found rule
    # (domain matches the real YAML rule definition in 07-test-data.yaml)
    jobs.append(_job_record(
        "reviewable-presence-suite", f"{BASE}/job/reviewable-presence-suite/",
        "FAILURE", "FAILED",
        metrics=_test_metrics(48, 39, 8, 1, 0),
        classification=_classification(
            "Test Data", "Reviewable Element Not Found", "Test Issue", "Strong",
            "Could not find reviewable element on the application — verify upstream check produced the reviewable or update locator strategy.",
            evidence="AssertionError: Could not find reviewable element for selector [data-test='reviewable-photo-check'] on application APP-44219",
            pattern="Could not find reviewable element for selector",
            rule_name="reviewable_not_found",
            label="Reviewable Not Found",
        ),
        evidence=_failure_evidence(3, "Reviewable lookup phase"),
        prev_status="FAILURE",
        build_num=205,
        exec_minutes_ago=22,
    ))

    # X3: Selenium click-wait timeout — exercises the selenium_click_wait_timeout rule
    jobs.append(_job_record(
        "checkout-click-flow-tests", f"{BASE}/job/checkout-click-flow-tests/",
        "FAILURE", "FAILED",
        metrics=_test_metrics(140, 122, 15, 3, 0),
        classification=_classification(
            "UI / Locator", "Selenium Click Wait Timeout", "Test Issue", "Strong",
            "Element appeared but didn't become clickable in time. Look for blocking overlays, disabled states, or animations that delay interactability — fixing the locator usually won't help.",
            evidence="org.openqa.selenium.TimeoutException: Expected condition failed: waiting for element to be clickable: By.cssSelector: button#submit-checkout (tried for 20 seconds with 500 milliseconds interval)",
            pattern="Expected condition failed: waiting for element to be clickable",
            rule_name="selenium_click_wait_timeout",
            label="Click Wait Timeout",
        ),
        evidence=_failure_evidence(4, "Checkout click sequence — submit button never became interactable"),
        prev_status="SUCCESS",
        build_num=487,
        exec_minutes_ago=11,
    ))

    # X4: Timeline event not found — populates evidence_detail with the extracted event name
    timeline_classification = _classification(
        "API / Backend Service", "Timeline Event Not Found", "Product Regression Likely", "Strong",
        "Backend did not emit the expected event in time. Check the producing service (application, payment, document) and the event bus for delays, dropped messages, or a regression in the event publication flow.",
        evidence="Unable to find timeline event 'APPLICATION_DOCUMENT_VERIFIED' for application APP-99812 within 45 seconds",
        pattern="Unable to find timeline event '(?P<event_single>[^']+)'",
        rule_name="timeline_event_not_found",
        label="Timeline Event Missing",
    )
    timeline_classification["evidence_detail"] = {"event_single": "APPLICATION_DOCUMENT_VERIFIED"}
    jobs.append(_job_record(
        "timeline-event-validation", f"{BASE}/job/timeline-event-validation/",
        "FAILURE", "FAILED",
        metrics=_test_metrics(85, 70, 13, 2, 0),
        classification=timeline_classification,
        evidence=_failure_evidence(4, "Timeline polling phase — event never emitted by document service"),
        prev_status="SUCCESS",
        build_num=178,
        exec_minutes_ago=14,
    ))

    # X5: Job name with HTML-sensitive chars — verifies escapeHtml on every render path
    jobs.append(_job_record(
        'PRP1 <Beta> & "Edge" Tests', f"{BASE}/job/prp1-beta-edge-tests/",
        "FAILURE", "FAILED",
        metrics=_test_metrics(50, 40, 8, 2, 0),
        classification=_classification(
            "Automation / Framework", "Assertion Error", "High", "Strong",
            "Review failing assertions",
            evidence="AssertionError: Expected <200> but was <500>",
            pattern="AssertionError",
            rule_name="assertion_error",
            label="Assertion Failure",
        ),
        evidence=_failure_evidence(2, "Test execution phase"),
        prev_status="SUCCESS",
        build_num=88,
        exec_minutes_ago=24,
    ))

    # X6: Very long job name (140 chars) — verifies truncation / tooltip
    jobs.append(_job_record(
        "passport-domain-prp1-end-to-end-customer-onboarding-flow-with-fraud-checks-and-document-verification-extended-regression-suite-v2",
        f"{BASE}/job/passport-domain-prp1-extended-regression-suite-v2/",
        "SUCCESS", "PASSED",
        metrics=_test_metrics(420, 418, 0, 2, 0),
        prev_status="SUCCESS",
        build_num=233,
        exec_minutes_ago=17,
    ))

    # X7: Unicode job name — verifies font fallback + escape paths
    jobs.append(_job_record(
        "passport-体検-flow-αβγ-✓", f"{BASE}/job/passport-unicode-flow/",
        "SUCCESS", "PASSED",
        metrics=_test_metrics(72, 72, 0, 0, 0),
        prev_status="SUCCESS",
        build_num=156,
        exec_minutes_ago=9,
    ))

    # X8: Seven classification labels — verifies overflow chip "+N more" expansion
    jobs.append(_job_record(
        "multi-label-mega-suite", f"{BASE}/job/multi-label-mega-suite/",
        "FAILURE", "FAILED",
        metrics=_test_metrics(310, 240, 55, 10, 5),
        classification=_classification(
            "Timeout", "Awaitility Condition Timeout", "Product Regression Likely", "Strong",
            "Multiple failure signatures detected across the run — triage by dominant domain first.",
            evidence="org.awaitility.core.ConditionTimeoutException: predicate did not return true within 30 seconds",
            pattern="org\\.awaitility\\.core\\.ConditionTimeoutException",
            rule_name="awaitility_condition_timeout",
            label="Awaitility Timeout",
            all_labels=[
                {"label": "Awaitility Timeout", "domain": "Timeout", "action": "Backend wait expired — inspect downstream service latency.", "rule_name": "awaitility_condition_timeout"},
                {"label": "Click Wait Timeout", "domain": "UI / Locator", "action": "Element never became clickable — check overlays/animations.", "rule_name": "selenium_click_wait_timeout"},
                {"label": "Reviewable Not Found", "domain": "Test Data", "action": "Reviewable element absent — verify upstream check fired.", "rule_name": "reviewable_not_found"},
                {"label": "Timeline Event Missing", "domain": "API / Backend Service", "action": "Backend did not emit expected event in time.", "rule_name": "timeline_event_not_found"},
                {"label": "Service Error (5xx)", "domain": "API / Backend Service", "action": "Backend returned 5xx — check service deploy logs.", "rule_name": "api_5xx"},
                {"label": "DB Connection Issue", "domain": "Environment / Infrastructure", "action": "Verify database is reachable.", "rule_name": "db_connection"},
                {"label": "Null Reference", "domain": "Automation / Framework", "action": "Add defensive null checks in test code.", "rule_name": "null_pointer"},
            ],
        ),
        evidence=_failure_evidence(9, "Multiple failure signatures across the suite"),
        prev_status="FAILURE",
        build_num=412,
        exec_minutes_ago=19,
    ))

    # X9: Promotion-time exact boundary — exec exactly 60 min ago, treat as PASS at promo=60
    jobs.append(_job_record(
        "promo-boundary-exact-60m", f"{BASE}/job/promo-boundary-exact-60m/",
        "SUCCESS", "PASSED",
        metrics=_test_metrics(120, 120, 0, 0, 0),
        prev_status="SUCCESS",
        build_num=301,
        exec_minutes_ago=60,
    ))
    jobs[-1]["release_status"] = "PASS"

    # X10: Future-promo intent — exec 10 min ago, but if promo_time is +30m (future)
    #      this job should render as PRE_PROMO (ran before the promotion window opened).
    jobs.append(_job_record(
        "promo-future-pre-promo", f"{BASE}/job/promo-future-pre-promo/",
        "FAILURE", "FAILED",
        metrics=_test_metrics(80, 65, 13, 2, 0),
        classification=_classification(
            "Automation / Framework", "Assertion Error", "High", "Strong",
            "Review failing assertions",
            evidence="AssertionError: Expected <true> but was <false>",
            pattern="AssertionError",
            rule_name="assertion_error",
            label="Assertion Failure",
        ),
        evidence=_failure_evidence(3, "Test execution phase"),
        prev_status="SUCCESS",
        build_num=145,
        exec_minutes_ago=10,
    ))
    jobs[-1]["release_status"] = "PRE_PROMO"

    # X11: Long-running stuck build (>24h) — stress-tests the "overdue" visual treatment
    jobs.append(_job_record(
        "stuck-overnight-soak", f"{BASE}/job/stuck-overnight-soak/",
        "IN_PROGRESS", "UNKNOWN",
        prev_status="__none__",
        last_passed_build="__none__",
        build_num=7,
        exec_minutes_ago=1500,  # 25h — overdue
        is_running=True,
        analysis_ref_status=None,
        analysis_ref_metrics=None,
    ))

    # X12: Alternating SUCCESS/FAILURE across last 5 builds — tests sparkline rendering
    alt_build_num = 520
    alt_exec = 13
    alternating_recent = [
        _build_info(alt_build_num,     "UNSTABLE", minutes_ago=alt_exec),
        _build_info(alt_build_num - 1, "SUCCESS",  minutes_ago=alt_exec + 120),
        _build_info(alt_build_num - 2, "FAILURE",  minutes_ago=alt_exec + 240),
        _build_info(alt_build_num - 3, "SUCCESS",  minutes_ago=alt_exec + 360),
        _build_info(alt_build_num - 4, "FAILURE",  minutes_ago=alt_exec + 480),
    ]
    jobs.append(_job_record(
        "volatile-flaky-suite", f"{BASE}/job/volatile-flaky-suite/",
        "UNSTABLE", "UNSTABLE",
        metrics=_test_metrics(150, 138, 8, 4, 0),
        classification=_classification(
            "Test Instability", "Flaky Test", "Low", "Partial",
            "Known flaky tests — last 5 builds alternate pass/fail. Quarantine candidates.",
            evidence="TimeoutException: intermittent visibility wait",
            pattern="TimeoutException.*waiting",
            rule_name="flaky_test",
            label="Flaky Test",
        ),
        evidence=_failure_evidence(2, "Test execution phase — intermittent waits"),
        prev_status="SUCCESS",
        build_num=alt_build_num,
        exec_minutes_ago=alt_exec,
    ))
    jobs[-1]["recent_builds"] = alternating_recent
    jobs[-1]["recent_volatility"] = "HIGH"

    # X13: Huge test counts (50k+) — verifies KPI counter formatting for large numbers
    jobs.append(_job_record(
        "platform-mega-regression", f"{BASE}/job/platform-mega-regression/",
        "SUCCESS", "PASSED",
        metrics=_test_metrics(52341, 52338, 3, 0, 0),
        prev_status="SUCCESS",
        build_num=2048,
        exec_minutes_ago=42,
    ))

    # X14: Console-sourced metrics on a FAILURE — verifies the console-sourced indicator
    jobs.append(_job_record(
        "legacy-parser-derived-suite", f"{BASE}/job/legacy-parser-derived-suite/",
        "FAILURE", "FAILED",
        metrics=_test_metrics(120, 110, 10, 0, 0, source="console"),
        classification=_classification(
            "Automation / Framework", "Assertion Error", "High", "Partial",
            "Review failing assertions — metrics parsed from console (no JUnit XML).",
            evidence="AssertionError: Expected HTTP 200 but received 503",
            pattern="AssertionError",
            rule_name="assertion_error",
            label="Assertion Failure",
        ),
        evidence=_failure_evidence(3, "Test execution phase"),
        prev_status="FAILURE",
        build_num=64,
        exec_minutes_ago=27,
    ))

    # X15: FETCH_ERROR completeness — simulates a Jenkins 502/timeout during enrichment
    jobs.append(_job_record(
        "enrichment-fetch-error-job", f"{BASE}/job/enrichment-fetch-error-job/",
        "UNKNOWN", "FETCH_ERROR",
        error_message="Stage 2 enrichment failed: 502 Bad Gateway from Jenkins after 3 retries",
        build_num=311,
        prev_status="__none__",
        last_passed_build="__none__",
        stage="STAGE_2",
        completeness="FETCH_ERROR",
    ))

    return jobs


# ============================================================================
# CONTEXTS (mock contexts.json equivalent)
# ============================================================================

MOCK_CONTEXTS = {
    "instances": [
        {
            "id": "mock-jenkins",
            "display_name": "Mock Jenkins (Demo)",
            "jenkins_url": "https://jenkins-mock.example.com",
            "environment": "DEMO",
            "predefined_job_lists": [
                {
                    "id": "critical-checkout-demo",
                    "name": "Critical Checkout Jobs",
                    "job_list_file": "/mock/job_lists/critical-checkout.json",
                    "environment": "DEMO",
                    "source_mode": "job_list",
                },
                {
                    "id": "payments-regression-demo",
                    "name": "Payments Regression Pack",
                    "job_list_file": "/mock/job_lists/payments-regression.json",
                    "environment": "DEMO",
                    "source_mode": "job_list",
                },
            ],
        }
    ],
    "defaults": {
        "max_workers": 15,
        "timeout": 30,
    },
}
