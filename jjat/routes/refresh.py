"""Refresh-related endpoints.

* ``POST /api/refresh/stream`` — SSE stream that selectively re-analyses
  a subset of jobs (all / failed / unstable / selected).
* ``POST /api/poll-status`` — cheap polling endpoint used by the
  auto-refresh feature.  Returns just (build_number, status, timestamp)
  per job so the frontend can detect which ones need a full refresh.
"""

import os
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List

from flask import Blueprint, Response, current_app, jsonify, request

from jjat.lib import state
from jjat.lib.credentials import resolve_credentials, safe_err
from jjat.lib.jenkins_factory import make_client
from jjat.lib.sse import format_sse
from jjat.lib.timeutils import parse_promotion_time
from jjat.models import HealthState
from jjat.pipeline import AnalysisOrchestrator
from jjat.routes._streaming import stream_selective_refresh

bp = Blueprint("refresh", __name__)


# Bounded concurrency for /api/poll-status — a 50-job sweep shouldn't open
# 50 sockets at once.  Separate from the main JENKINS_MAX_WORKERS knob
# because polling is cheap (lastBuild-only, no console fetch) and
# benefits from a tighter cap to avoid drowning out user-triggered
# fetches.  Override via JENKINS_POLL_WORKERS in .env / shell; clamped
# to a sane 1..32.
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
    """Stream a selective refresh via SSE.

    Does NOT clear ``state.job_store`` — entries are updated in place.
    Supported scopes: ``all``, ``failed``, ``unstable``, ``selected``,
    ``single``.
    """
    data = resolve_credentials(request.get_json())
    operation_id = str(uuid.uuid4())
    state.active_operation_id = operation_id

    scope = data.get("scope", "all")
    job_ids = data.get("job_ids", [])
    # No per-request override — see fetch.py for the rationale.  Single
    # knob is JENKINS_MAX_WORKERS via .env / shell.
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

    # Pool sized to match worker count — same rationale as in /api/fetch/stream.
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

    # Translate URLs back into {"name": ..., "url": ...} dicts.
    jobs_for_refresh = []
    for job_url in target_jobs:
        existing = state.job_store.get(job_url)
        job_name = existing.job_name if existing else job_url.rstrip("/").split("/")[-1]
        jobs_for_refresh.append({"name": job_name, "url": job_url})

    def generator():
        yield from stream_selective_refresh(operation_id, orchestrator, jobs_for_refresh)

    return Response(generator(), mimetype="text/event-stream")


@bp.route("/api/poll-status", methods=["POST"])
def poll_status():
    """Cheap background-poll endpoint for the auto-refresh feature.

    Returns ONLY ``(build_number, status, timestamp)`` per requested job
    — no console, no metrics, no classification.  The frontend diffs the
    response against its last known state and fires a richer
    ``/api/refresh-single`` only for jobs whose status or build_number
    actually changed.

    Errors per-job are returned with ``status="ERROR"`` and a short
    message, so a single bad job never blows up the whole sweep.
    """
    data = resolve_credentials(request.get_json() or {})
    job_urls = data.get("job_urls", []) or []
    if not isinstance(job_urls, list) or not job_urls:
        return jsonify({"statuses": []}), 200

    # Pool size matches the worker count exactly — without this, urllib3's
    # default 10-socket pool serialises any thread beyond that and the
    # request-spreading effort here is wasted on the wire.
    client = make_client(
        data,
        timeout=current_app.config["default_timeout"],
        pool_size=_POLL_MAX_WORKERS,
    )

    def _one(url: str) -> dict:
        try:
            bi = client.fetch_build_info(url, "lastBuild")
            return {
                "job_url": url,
                "build_number": bi.build_number,
                "status": bi.status.value if hasattr(bi.status, "value") else str(bi.status),
                "timestamp": bi.timestamp.isoformat(),
            }
        except Exception as e:
            # Don't kill the whole sweep on one bad job.
            return {
                "job_url": url,
                "build_number": None,
                "status": "ERROR",
                "timestamp": None,
                "error": safe_err(e),
            }

    out: List[dict] = []
    workers = min(_POLL_MAX_WORKERS, max(1, len(job_urls)))
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = [ex.submit(_one, u) for u in job_urls]
        for fut in as_completed(futures):
            out.append(fut.result())
    return jsonify({"statuses": out}), 200


def _resolve_target_job_urls(scope: str, job_ids: List[str]) -> List[str]:
    """Return the list of job URLs to refresh for the given scope.

    Args:
        scope: ``"all"``, ``"failed"``, ``"unstable"``, ``"selected"``, or
            ``"single"``.
        job_ids: Explicit URLs (used for the ``"selected"`` / ``"single"``
            scopes only).
    """
    if scope == "all":
        return list(state.job_store.keys())
    if scope == "failed":
        return [u for u, r in state.job_store.items() if r.health_state == HealthState.FAILED]
    if scope == "unstable":
        return [u for u, r in state.job_store.items() if r.health_state == HealthState.UNSTABLE]
    if scope in ("selected", "single"):
        return job_ids if job_ids else []
    return []
