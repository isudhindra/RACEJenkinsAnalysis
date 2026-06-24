"""Refresh and auto-poll endpoints. ``/api/refresh/stream`` re-fetches a scope
of jobs over SSE; ``/api/poll-status`` is the cheap status-only check the
dashboard's auto-refresh calls every 30s.
"""

import os
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List

from flask import Blueprint, Response, current_app, jsonify, request

from race.lib import state
from race.lib.credentials import resolve_credentials, safe_err
from race.lib.jenkins_factory import make_client
from race.lib.security import require_local_origin, validate_jenkins_url
from race.lib.sse import format_sse
from race.lib.timeutils import parse_promotion_time
from race.models import HealthState
from race.pipeline import AnalysisOrchestrator
from race.routes._streaming import stream_selective_refresh

bp = Blueprint("refresh", __name__)


# Poll concurrency is capped separately from the main worker pool
def _resolve_poll_workers() -> int:
    raw = os.environ.get("JENKINS_POLL_WORKERS", "").strip()
    if raw:
        try:
            n = int(raw)
            if 1 <= n <= 32:
                return n
        except ValueError:
            pass
    return 15


_POLL_MAX_WORKERS = _resolve_poll_workers()


@bp.route("/api/refresh/stream", methods=["POST"])
def refresh_stream():
    """SSE selective refresh that updates the in-memory store in place.
    Scopes: all / failed / unstable / selected / single.
    """
    csrf = require_local_origin()
    if csrf is not None:
        return csrf
    body = request.get_json(silent=True) or {}
    is_env = body.get("api_token") == "•" * 8
    url_err = validate_jenkins_url(body.get("jenkins_url", ""), is_env_auth=is_env)
    if url_err:
        return jsonify({"error": url_err}), 400
    data = resolve_credentials(body)
    operation_id = str(uuid.uuid4())
    state.active_operation_id = operation_id

    scope = data.get("scope", "all")
    job_ids = data.get("job_ids", [])
    # No per-request override — JENKINS_MAX_WORKERS is the single knob.
    max_workers = current_app.config["thread_pool_size"]

    target_jobs = _resolve_target_job_urls(scope, job_ids)

    if not target_jobs:
        def empty_gen():
            yield format_sse({
                "event_type": "fetch_complete",
                "operation_id": operation_id,
                "total_jobs": 0,
                "duration_seconds": 0,
            })

        return Response(empty_gen(), mimetype="text/event-stream")

    # Pool size matches worker count — same rationale as /api/fetch/stream.
    client = make_client(
        data,
        timeout=current_app.config["default_timeout"],
        pool_size=max_workers,
    )
    orchestrator = AnalysisOrchestrator(
        client=client,
        classifier=current_app.classifier,  # type: ignore[attr-defined]
        max_workers=max_workers,
        promotion_time=parse_promotion_time(data),
    )

    # Rebuild {name, url} dicts from URLs, reusing names already in the store.
    jobs_for_refresh = []
    for job_url in target_jobs:
        existing = state.job_store.get(job_url)
        job_name = existing.job_name if existing else job_url.rstrip("/").split("/")[-1]
        jobs_for_refresh.append({"name": job_name, "url": job_url})

    def generator():
        yield from stream_selective_refresh(operation_id, orchestrator, jobs_for_refresh)

    return Response(generator(), mimetype="text/event-stream")


def _normalise_url(url: str) -> str:
    """Strip trailing slash for stable URL comparison since Jenkins is inconsistent
    about whether job URLs come back with or without one.
    """
    return (url or "").rstrip("/")


@bp.route("/api/poll-status", methods=["POST"])
def poll_status():
    """Cheap status-only probe driving the dashboard's auto-refresh tick.
    Per-job errors carry status="ERROR" so one bad job can't fail the whole sweep.
    """
    csrf = require_local_origin()
    if csrf is not None:
        return csrf
    body = request.get_json(silent=True) or {}
    is_env = body.get("api_token") == "•" * 8
    url_err = validate_jenkins_url(body.get("jenkins_url", ""), is_env_auth=is_env)
    if url_err:
        return jsonify({"statuses": [], "error": url_err}), 400
    data = resolve_credentials(body)
    job_urls = data.get("job_urls", []) or []
    if not isinstance(job_urls, list) or not job_urls:
        return jsonify({"statuses": []}), 200
    if len(job_urls) > 1000:
        return jsonify({"statuses": [], "error": "Too many URLs in one poll"}), 400

    source_mode = (data.get("source_mode") or "").strip()
    view_url = (data.get("view_url") or "").strip()

    client = make_client(
        data,
        timeout=current_app.config["default_timeout"],
        pool_size=_POLL_MAX_WORKERS,
    )

    # ── Path 1: batched view poll (1 Jenkins call for N jobs) ─────────
    batched_map: dict = {}
    batched_used = False
    batched_error: str = ""
    if source_mode == "view" and view_url:
        try:
            batched_map = client.poll_view_lastbuilds(view_url)
            batched_used = True
        except Exception as e:
            # Never let a batched failure break the poll — fall through to per-job.
            batched_error = safe_err(e)

    out: List[dict] = []
    covered: set = set()
    if batched_used:
        # Match requested URLs to batched response by NORMALISED form.
        for url in job_urls:
            entry = batched_map.get(_normalise_url(url))
            if entry is None:
                continue
            out.append({
                "job_url": url,  # return the URL the caller asked for, verbatim
                "build_number": entry.get("build_number"),
                "status": entry.get("status"),
                "timestamp": entry.get("timestamp"),
                "is_running": bool(entry.get("is_running")),
            })
            covered.add(_normalise_url(url))

    # ── Path 2: per-job fallback for anything path 1 didn't cover ─────
    remaining = [u for u in job_urls if _normalise_url(u) not in covered]

    def _one(url: str) -> dict:
        try:
            bi = client.fetch_build_info(url, "lastBuild")
            status = bi.status.value if hasattr(bi.status, "value") else str(bi.status)
            return {
                "job_url": url,
                "build_number": bi.build_number,
                "status": status,
                "timestamp": bi.timestamp.isoformat(),
                "is_running": status == "IN_PROGRESS",
            }
        except Exception as e:
            return {
                "job_url": url,
                "build_number": None,
                "status": "ERROR",
                "timestamp": None,
                "is_running": False,
                "error": safe_err(e),
            }

    if remaining:
        workers = min(_POLL_MAX_WORKERS, max(1, len(remaining)))
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futures = [ex.submit(_one, u) for u in remaining]
            for fut in as_completed(futures):
                out.append(fut.result())

    # ── Summary diag — one line per tick (no per-job spam) ────────────
    jenkins_calls = (1 if batched_used else 0) + len(remaining)
    diag = {
        "requested": len(job_urls),
        "batched": len(covered),
        "per_job": len(remaining),
        "jenkins_calls": jenkins_calls,
    }
    if batched_error:
        diag["batched_error"] = batched_error
    # debug level so normal log streams stay quiet;
    current_app.logger.debug(
        "[poll-status] requested=%d batched=%d per_job=%d jenkins_calls=%d%s",
        diag["requested"], diag["batched"], diag["per_job"], diag["jenkins_calls"],
        (" batched_error=" + batched_error) if batched_error else "",
    )

    return jsonify({"statuses": out, "diag": diag}), 200


def _resolve_target_job_urls(scope: str, job_ids: List[str]) -> List[str]:
    """Return the job URLs to refresh for the given scope.
    job_ids is only consulted for the 'selected' and 'single' scopes.
    """
    if scope == "all":
        # Snapshot under lock — concurrent SSE writers would otherwise tear the iteration.
        return list(state.job_store_snapshot().keys())
    if scope == "failed":
        return [u for u, r in state.job_store_snapshot().items() if r.health_state == HealthState.FAILED]
    if scope == "unstable":
        return [u for u, r in state.job_store_snapshot().items() if r.health_state == HealthState.UNSTABLE]
    if scope in ("selected", "single"):
        return job_ids if job_ids else []
    return []
