"""Process-wide mutable state for the dashboard.

Two pieces of shared state route handlers read or mutate together:
the in-memory ``job_store`` from the most recent fetch, and the UUID
of the currently-streaming operation. For a single-process local dev
tool a plain module is the simplest single source of truth.
"""

from typing import Dict

from jjat.models import JobRecord

# Reset on every full fetch; selectively updated on refresh.
job_store: Dict[str, JobRecord] = {}


# Empty when idle. Stale events whose operation_id doesn't match this are ignored.
active_operation_id: str = ""
