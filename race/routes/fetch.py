"""The main SSE fetch endpoint (``/api/fetch/stream``). Clears the in-memory
store, builds an AnalysisOrchestrator, and streams Stage-1 / Stage-2 events
to the dashboard while jobs are loaded and classified.
"""

import uuid

from flask import Blueprint, Response, current_app, jsonify, request

from race.jenkins_client import JenkinsClientError
from race.lib import state
from race.lib.build_cache import ViewPrefetch
from race.lib.credentials import resolve_credentials, safe_err
from race.lib.jenkins_factory import make_client
from race.lib.jenkins_urls import resolve_view_url
from race.lib.security import limit, require_local_origin, url_belongs_to, validate_jenkins_url
from race.lib.sse import format_sse
from race.lib.timeutils import parse_promotion_time
from race.pipeline import AnalysisOrchestrator
from race.routes._streaming import stream_full_fetch

bp = Blueprint("fetch", __name__)


@bp.route("/api/fetch/stream", methods=["POST"])
@limit("10/minute")
def fetch_stream():
    """Stream a full fetch of jobs via SSE. Clears the in-memory store then runs Stage 1
    discovery followed by Stage 2 enrichment over the chosen source mode.
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
    state.job_store.clear()

    source_mode = data.get("source_mode")
    jenkins_url = data.get("jenkins_url")
    # Per-app source of truth — request-body overrides were dropped to
    # prevent arbitrary thread counts from untrusted callers.
    max_workers = current_app.config["thread_pool_size"]

    # Pool size matches worker count so concurrency actually reaches Jenkins.
    client = make_client(
        data,
        timeout=current_app.config["default_timeout"],
        pool_size=max_workers,
    )

    if source_mode == "view_url":
        view_url = data.get("view_url", "")
        view_path = data.get("view_path", "")

        if view_path:
            view_url = resolve_view_url(jenkins_url, view_path)
        elif view_url and not view_url.startswith("http"):
            # Legacy relative-path fallback.
            view_url = jenkins_url.rstrip("/") + "/" + view_url.lstrip("/")

        # Reject views that don't belong to the picked Jenkins instance.
        if not url_belongs_to(view_url, jenkins_url):
            err_msg = (
                f"View URL mismatch: '{view_url}' does not belong to "
                f"Jenkins instance '{jenkins_url}'. Views must be bound "
                f"to their parent Jenkins instance."
            )

            def mismatch_gen():
                yield format_sse({"event_type": "error", "message": err_msg, "operation_id": operation_id})

            return Response(mismatch_gen(), mimetype="text/event-stream")

        # Try the batched
        view_prefetch = None
        try:
            batched = client.fetch_view_jobs_batched(view_url)
            if batched:
                view_prefetch = ViewPrefetch()
                view_prefetch.populate(batched)
                jobs = [{"name": j.name, "url": j.url} for j in batched]
                current_app.logger.info(
                    f"view-batch: prefetched {len(batched)} jobs in one call"
                )
            else:
                # Empty batched response — fall through to discovery.
                raise JenkinsClientError("batched fetch returned no jobs")
        except JenkinsClientError:
            try:
                jobs = client.discover_jobs_from_view(view_url)
            except JenkinsClientError as exc:
                err_msg = safe_err(exc)

                def error_gen():
                    yield format_sse({"event_type": "error", "message": err_msg, "operation_id": operation_id})

                return Response(error_gen(), mimetype="text/event-stream")

    elif source_mode == "job_list":
        # Custom job-list mode — body carries plain names; we synthesise the URLs.
        view_prefetch = None
        job_names = data.get("job_names", [])
        base = jenkins_url.rstrip("/")
        jobs = [{"name": jn, "url": f"{base}/job/{jn}/"} for jn in job_names]

    else:
        # Caller passed an explicit ``jobs`` list of dicts.
        view_prefetch = None
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
        view_prefetch=view_prefetch,
    )

    def generator():
        yield from stream_full_fetch(operation_id, orchestrator, jobs)

    return Response(generator(), mimetype="text/event-stream")
