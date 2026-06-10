"""SSE pipeline shared by ``/api/fetch/stream`` and ``/api/refresh/stream``.

The two routes differ only in whether they clear ``state.job_store``
on entry and how rich the ``fetch_complete`` payload is. Everything
else — Stage 1 → Stage 2 orchestration, event queue, cancellation,
serialisation — lives here.
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


# Sentinel pushed onto the queue when the producer finishes, so the
# consumer never blocks waiting for events that will never come.
_STREAM_END = object()


def _run_producer_with_sentinel(target, args, event_queue: "queue.Queue") -> threading.Thread:
    """Spawn *target* on a daemon thread; always enqueue _STREAM_END afterwards.

    The try/finally guarantees the sentinel reaches the consumer even
    when the producer raises — otherwise the consumer would block on an
    empty queue indefinitely.
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
    """Full-fetch SSE generator — clears store, emits rich completion summary."""
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
    """Selective-refresh SSE generator — updates the store in place, minimal summary."""
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

    Prefer the orchestrator's stored record — reconstructing from the
    serialised payload loses typed fields Stage 2 still needs.
    """
    try:
        job_url = event.job_id
        if hasattr(orchestrator, "_records") and job_url in orchestrator._records:
            return orchestrator._records[job_url]

        # Fallback: rebuild a minimal record from the payload (no three_run_context).
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


def _stream_pipeline(
    operation_id: str,
    orchestrator: AnalysisOrchestrator,
    jobs: List[Dict[str, str]],
    clear_store: bool = False,
    compute_full_stats: bool = False,
):
    """Unified SSE generator backing both full-fetch and selective-refresh.

    ``operation_id`` is used to abandon work when a newer fetch
    supersedes this one. ``clear_store`` + ``compute_full_stats`` are
    the only knobs that distinguish the two callers.
    """
    if clear_store:
        state.job_store.clear()

    start_time = time.time()
    event_queue: queue.Queue = queue.Queue()

    def on_result(event: SSEEvent) -> None:
        """Enqueue events from orchestrator worker threads."""
        event_queue.put(event)

    _KEEPALIVE_TICKS = 20  # 20 × 0.5s = 10s between pings.
    _empty_ticks = 0

    #  Stage 1 --
    stage_1_thread = _run_producer_with_sentinel(
        target=orchestrator.run_stage_1,
        args=(jobs, operation_id, on_result),
        event_queue=event_queue,
    )

    stage_1_records: List[JobRecord] = []

    while True:
        if operation_id != state.active_operation_id:
            # A newer fetch superseded us — cancel the orchestrator so
            # workers exit on their next call and no further events fire.
            orchestrator.cancel()
            return

        try:
            event = event_queue.get(timeout=0.5)
        except queue.Empty:
            # No event yet — emit a wire-level keep-alive periodically
            # so a proxy doesn't see the link as idle.
            _empty_ticks += 1
            if _empty_ticks >= _KEEPALIVE_TICKS:
                _empty_ticks = 0
                yield ": ping\n\n"
            continue
        _empty_ticks = 0

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

    # Sentinel already drained — join just reaps the OS thread before Stage 2.
    stage_1_thread.join(timeout=5.0)

    #  Stage 2 --
    # Full fetch scans the whole store; refresh stays within this round's records.
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
                _empty_ticks += 1
                if _empty_ticks >= _KEEPALIVE_TICKS:
                    _empty_ticks = 0
                    yield ": ping\n\n"
                continue
            _empty_ticks = 0

            if event is _STREAM_END:
                break

            if event.event_type == SSEEventType.JOB_ENRICHED:
                # Re-serialise via to_dict so release_status reflects the in-place mutation.
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

        stage_2_thread.join(timeout=5.0)

    #  Completion summary ---
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
