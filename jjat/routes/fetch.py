"""Full-fetch SSE endpoint.

Single route — ``POST /api/fetch/stream`` — but the most involved one in
the app.  Validates the source mode (view URL, job list, or raw list),
resolves the Jenkins view URL when needed, builds an
:class:`AnalysisOrchestrator`, and yields the SSE pipeline.
"""

import uuid

from flask import Blueprint, Response, current_app, request

from jjat.jenkins_client import JenkinsClientError
from jjat.lib import state
from jjat.lib.credentials import resolve_credentials, safe_err
from jjat.lib.jenkins_factory import make_client
from jjat.lib.jenkins_urls import resolve_view_url
from jjat.lib.sse import format_sse
from jjat.lib.timeutils import parse_promotion_time
from jjat.pipeline import AnalysisOrchestrator
from jjat.routes._streaming import stream_full_fetch

bp = Blueprint("fetch", __name__)


@bp.route("/api/fetch/stream", methods=["POST"])
def fetch_stream():
    """Stream a full fetch of jobs via SSE.

    Clears ``state.job_store``, generates a new operation ID, runs the
    Stage 1 → Stage 2 pipeline (see :mod:`jjat.routes._streaming`).
    """
    data = resolve_credentials(request.get_json())
    operation_id = str(uuid.uuid4())
    state.active_operation_id = operation_id
    state.job_store.clear()

    source_mode = data.get("source_mode")
    jenkins_url = data.get("jenkins_url")
    # The only per-app source of truth.  Previous code accepted an
    # override in the request body — no frontend ever sent one, and the
    # path was a silent security smell (any caller could ask for an
    # arbitrary thread count).  Dropped.
    max_workers = current_app.config["thread_pool_size"]

    # Size the HTTP pool to match the worker count so the full parallelism
    # actually reaches Jenkins instead of queuing behind a small default pool.
    client = make_client(
        data,
        timeout=current_app.config["default_timeout"],
        pool_size=max_workers,
    )

    # Determine the job list based on source mode.
    if source_mode == "view_url":
        view_url = data.get("view_url", "")
        view_path = data.get("view_path", "")

        if view_path:
            view_url = resolve_view_url(jenkins_url, view_path)
        elif view_url and not view_url.startswith("http"):
            # Legacy relative-path fallback.
            view_url = jenkins_url.rstrip("/") + "/" + view_url.lstrip("/")

        # Defence-in-depth: the view must belong to the Jenkins instance
        # the user picked.  Prevents accidental cross-tenant calls if the
        # frontend hands us a stale URL.
        normalized_base = jenkins_url.rstrip("/").lower()
        normalized_view = view_url.rstrip("/").lower()
        if not normalized_view.startswith(normalized_base):
            err_msg = (
                f"View URL mismatch: '{view_url}' does not belong to "
                f"Jenkins instance '{jenkins_url}'. Views must be bound "
                f"to their parent Jenkins instance."
            )

            def mismatch_gen():
                yield format_sse({"event_type": "error", "message": err_msg, "operation_id": operation_id})

            return Response(mismatch_gen(), mimetype="text/event-stream")

        try:
            jobs = client.discover_jobs_from_view(view_url)
        except JenkinsClientError as exc:
            err_msg = safe_err(exc)

            def error_gen():
                yield format_sse({"event_type": "error", "message": err_msg, "operation_id": operation_id})

            return Response(error_gen(), mimetype="text/event-stream")

    elif source_mode == "job_list":
        # Custom job-list mode: ``job_names`` is a list of plain names.
        job_names = data.get("job_names", [])
        base = jenkins_url.rstrip("/")
        jobs = [{"name": jn, "url": f"{base}/job/{jn}/"} for jn in job_names]

    else:
        # Fallback: caller passed an explicit ``jobs`` list of dicts.
        jobs = data.get("jobs", [])

    if not jobs:
        def empty_gen():
            yield format_sse({
                "event_type": "fetch_complete",
                "operation_id": operation_id,
                "total_jobs": 0,
                "duration_seconds": 0,
            })

        return Response(empty_gen(), mimetype="text/event-stream")

    orchestrator = AnalysisOrchestrator(
        client=client,
        classifier=current_app.classifier,  # type: ignore[attr-defined]
        max_workers=max_workers,
        promotion_time=parse_promotion_time(data),
    )

    def generator():
        yield from stream_full_fetch(operation_id, orchestrator, jobs)

    return Response(generator(), mimetype="text/event-stream")
