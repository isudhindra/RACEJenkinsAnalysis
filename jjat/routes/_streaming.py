"""Server-Sent Events pipeline shared by /api/fetch/stream and
/api/refresh/stream.

The two route handlers differ only in:
* whether they clear :data:`jjat.lib.state.job_store` at start, and
* how rich the ``fetch_complete`` summary payload is.

Everything else — the Stage 1 → Stage 2 orchestration, event queue,
operation-cancellation check, JSON-event serialisation — is identical
and lives here.  Routes use :func:`stream_full_fetch` /
:func:`stream_selective_refresh` as their generator function.

This module is named with a leading underscore because nothing outside
the :mod:`jjat.routes` package should import from it.
"""

import queue
import threading
import time
from typing import Dict, List, Optional

from jjat.jenkins_client import JenkinsClient  # noqa: F401  (re-exported for type hints)
from jjat.lib import state
from jjat.lib.sse import format_sse
from jjat.models import (
    BuildStatus,
    DataCompleteness,
    HealthState,
    JobRecord,
    SSEEvent,
    SSEEventType,
    StageCompletion,
)
from jjat.pipeline import AnalysisOrchestrator


# Sentinel value enqueued by the producer thread after it finishes (success
# or exception).  The consumer treats this as the authoritative
# stream-complete signal — replaces the previous
# ``while thread.is_alive() or not queue.empty()`` pattern, which had a
# race: a thread could exit between the timeout-blocked get() and the
# is_alive() re-check, causing the final batch of events to be dropped.
_STREAM_END = object()


def _run_producer_with_sentinel(target, args, event_queue: "queue.Queue") -> threading.Thread:
    """Spawn *target* on a daemon thread; guarantee *_STREAM_END* enqueued.

    The wrapping try/finally ensures the sentinel is queued even if the
    producer raises — without it, an unhandled exception would leave the
    consumer waiting indefinitely on an empty queue.
    """
    def _runner():
        try:
            target(*args)
        finally:
            event_queue.put(_STREAM_END)

    t = threading.Thread(target=_runner, daemon=True)
    t.start()
    return t


def stream_full_fetch(
    operation_id: str,
    orchestrator: AnalysisOrchestrator,
    jobs: List[Dict[str, str]],
):
    """Generator for the full-fetch SSE stream (``/api/fetch/stream``).

    Clears :data:`state.job_store` before Stage 1 and emits a rich
    ``fetch_complete`` payload with total / failed / unstable /
    classified counts at the end.
    """
    yield from _stream_pipeline(
        operation_id,
        orchestrator,
        jobs,
        clear_store=True,
        compute_full_stats=True,
    )


def stream_selective_refresh(
    operation_id: str,
    orchestrator: AnalysisOrchestrator,
    jobs: List[Dict[str, str]],
):
    """Generator for the selective-refresh SSE stream
    (``/api/refresh/stream``).

    Does NOT clear :data:`state.job_store` — entries are updated in
    place.  Emits a minimal ``fetch_complete`` payload (total + duration
    only).
    """
    yield from _stream_pipeline(
        operation_id,
        orchestrator,
        jobs,
        clear_store=False,
        compute_full_stats=False,
    )


def create_error_record(event: SSEEvent) -> JobRecord:
    """Build an error :class:`JobRecord` from a ``JOB_ERROR`` event."""
    return JobRecord(
        job_name=event.payload.get("job_name", "Unknown"),
        job_url=event.job_id,
        health_state=HealthState.FETCH_ERROR,
        error_message=event.payload.get("error_message", "Unknown error"),
        data_completeness=DataCompleteness.FETCH_ERROR,
    )


def find_record_from_event(
    event: SSEEvent,
    orchestrator: AnalysisOrchestrator,
) -> Optional[JobRecord]:
    """Retrieve the full :class:`JobRecord` from the orchestrator.

    The orchestrator's ``run_stage_1`` stores complete records (with
    three_run_context, test_metrics, etc.) in its ``_records`` dict.
    We prefer that over reconstructing from the serialised payload —
    reconstruction loses typed fields Stage 2 still needs.
    """
    try:
        job_url = event.job_id
        if hasattr(orchestrator, "_records") and job_url in orchestrator._records:
            return orchestrator._records[job_url]

        # Fallback: reconstruct from payload (without three_run_context).
        payload = event.payload
        status_str = payload.get("current_status", "UNKNOWN")
        status = BuildStatus(status_str) if status_str in BuildStatus.__members__ else BuildStatus.UNKNOWN

        health_str = payload.get("health_state", "UNKNOWN")
        health = HealthState(health_str) if health_str in HealthState.__members__ else HealthState.UNKNOWN

        dc_str = payload.get("data_completeness", "COMPLETE")
        dc = DataCompleteness(dc_str) if dc_str in DataCompleteness.__members__ else DataCompleteness.COMPLETE

        return JobRecord(
            job_name=payload.get("job_name", "Unknown"),
            job_url=payload.get("job_url", event.job_id),
            current_status=status,
            health_state=health,
            data_completeness=dc,
            stage=StageCompletion.STAGE_1,
            error_message=payload.get("error_message"),
        )
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Internal: the unified Stage-1 → Stage-2 pipeline driver.
# ---------------------------------------------------------------------------

def _stream_pipeline(
    operation_id: str,
    orchestrator: AnalysisOrchestrator,
    jobs: List[Dict[str, str]],
    clear_store: bool = False,
    compute_full_stats: bool = False,
):
    """SSE generator unifying full-fetch and selective-refresh flows.

    Args:
        operation_id: UUID for this stream — used to abandon work if a
            newer operation supersedes this one mid-flight.
        orchestrator: Pre-configured :class:`AnalysisOrchestrator`.
        jobs: List of ``{"name": str, "url": str}`` dicts.
        clear_store: ``True`` for full fetch — clears ``state.job_store``
            before Stage 1 begins.
        compute_full_stats: ``True`` for full fetch — computes richer
            counters for the ``fetch_complete`` event.
    """
    if clear_store:
        state.job_store.clear()

    start_time = time.time()
    event_queue: queue.Queue = queue.Queue()

    def on_result(event: SSEEvent) -> None:
        """Callback: enqueue SSE events from orchestrator worker threads."""
        event_queue.put(event)

    # ------------------------------------------------------------------ Stage 1
    stage_1_thread = _run_producer_with_sentinel(
        target=orchestrator.run_stage_1,
        args=(jobs, operation_id, on_result),
        event_queue=event_queue,
    )

    stage_1_records: List[JobRecord] = []

    while True:
        if operation_id != state.active_operation_id:
            # Abandoned operation — a newer fetch superseded us.  Signal
            # the orchestrator to stop consuming new futures (in-flight
            # workers will exit on their next call).  This stops thread
            # leakage that used to happen because the executor's context
            # manager kept blocking on already-submitted futures.
            orchestrator.cancel()
            return

        try:
            event = event_queue.get(timeout=0.5)
        except queue.Empty:
            # Just a heartbeat for the cancellation check — the sentinel
            # is the real terminator, never the timeout.
            continue

        if event is _STREAM_END:
            break

        if event.event_type == SSEEventType.JOB_METADATA:
            record = find_record_from_event(event, orchestrator)
            if record:
                state.job_store[event.job_id] = record
                stage_1_records.append(record)
            yield format_sse({
                "event_type": "job_metadata",
                "operation_id": event.operation_id,
                **event.payload,
            })

        elif event.event_type == SSEEventType.JOB_ERROR:
            error_record = create_error_record(event)
            state.job_store[event.job_id] = error_record
            yield format_sse({
                "event_type": "job_error",
                "operation_id": event.operation_id,
                **event.payload,
            })

        elif event.event_type == SSEEventType.PROGRESS_UPDATE:
            yield format_sse({
                "event_type": "progress_update",
                "operation_id": event.operation_id,
                **event.payload,
            })

    # Sentinel already drained — the join is a safety net to ensure the
    # OS thread is fully reaped before Stage 2 starts.
    stage_1_thread.join(timeout=5.0)

    # ------------------------------------------------------------------ Stage 2
    # For full fetch: analyse all failed/unstable in state.job_store.
    # For refresh:    analyse only among records refreshed this round.
    if compute_full_stats:
        failed_records = [
            r for r in state.job_store.values()
            if r.health_state in (HealthState.FAILED, HealthState.UNSTABLE)
        ]
    else:
        failed_records = [
            r for r in stage_1_records
            if r.health_state in (HealthState.FAILED, HealthState.UNSTABLE)
        ]

    if failed_records:
        stage_2_thread = _run_producer_with_sentinel(
            target=orchestrator.run_stage_2,
            args=(failed_records, operation_id, on_result),
            event_queue=event_queue,
        )

        while True:
            if operation_id != state.active_operation_id:
                orchestrator.cancel()
                return

            try:
                event = event_queue.get(timeout=0.5)
            except queue.Empty:
                continue

            if event is _STREAM_END:
                break

            if event.event_type == SSEEventType.JOB_ENRICHED:
                # The orchestrator mutated the record in place — re-serialise
                # via to_dict so release_status stays consistent.
                if event.job_id in state.job_store:
                    yield format_sse({
                        "event_type": "job_enriched",
                        "operation_id": event.operation_id,
                        **state.job_store[event.job_id].to_dict(
                            promotion_time=orchestrator.promotion_time,
                        ),
                    })
                else:
                    yield format_sse({
                        "event_type": "job_enriched",
                        "operation_id": event.operation_id,
                        **event.payload,
                    })

            elif event.event_type == SSEEventType.PROGRESS_UPDATE:
                yield format_sse({
                    "event_type": "progress_update",
                    "operation_id": event.operation_id,
                    **event.payload,
                })

        # Sentinel already drained — join is just a safety reap.
        stage_2_thread.join(timeout=5.0)

    # -------------------------------------------------------------- Complete
    duration = time.time() - start_time

    if compute_full_stats:
        total = len(state.job_store)
        failed = sum(1 for r in state.job_store.values() if r.health_state == HealthState.FAILED)
        unstable = sum(1 for r in state.job_store.values() if r.health_state == HealthState.UNSTABLE)
        classified = sum(1 for r in state.job_store.values() if r.classification is not None)
        yield format_sse({
            "event_type": "fetch_complete",
            "operation_id": operation_id,
            "total_jobs": total,
            "failed_count": failed,
            "unstable_count": unstable,
            "classified_count": classified,
            "duration_seconds": round(duration, 1),
        })
    else:
        yield format_sse({
            "event_type": "fetch_complete",
            "operation_id": operation_id,
            "total_jobs": len(jobs),
            "duration_seconds": round(duration, 1),
        })
