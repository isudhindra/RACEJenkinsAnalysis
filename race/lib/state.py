"""Process-wide in-memory state for the dashboard — the latest fetch's
`job_store` and the UUID of the SSE operation currently streaming.
Snapshot helpers keep concurrent SSE writers and refresh readers from
tearing the dict.
"""

from typing import Dict

from race.models import JobRecord

# Reset on every full fetch; selectively updated on refresh.
job_store: Dict[str, JobRecord] = {}


# Empty when idle. Stale events whose operation_id doesn't match this are ignored.
active_operation_id: str = ""
