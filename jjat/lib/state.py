"""Process-wide mutable state for the dashboard.

There are exactly two pieces of shared state that several route handlers
need to read or mutate together:

* ``job_store`` — the in-memory map of ``job_url → JobRecord`` produced by
  the most recent fetch.  Selective-refresh and rerun routes read it;
  the fetch route resets it.
* ``active_operation_id`` — the operation UUID of the currently-streaming
  fetch / refresh.  Used by the SSE handlers to ignore stale events from
  a previous, aborted operation.

A future cleanup could move this onto ``flask.g`` or an app extension,
but for a single-process local dev tool a plain module is the simplest
single source of truth.  Routes import these names directly::

    from jjat.lib import state
    state.job_store[url] = record
"""

from typing import Dict

from jjat.models import JobRecord

# job_url → JobRecord.  Reset on every full fetch; selectively updated
# on refresh.  Routes mutate this through the module attribute so all
# importers see the same object.
job_store: Dict[str, JobRecord] = {}


# UUID of the SSE stream currently in flight.  Empty string when idle.
# The streaming reader on the frontend ignores events whose
# ``operation_id`` doesn't match this; the route handlers set it on
# start of a new fetch / refresh.
active_operation_id: str = ""
