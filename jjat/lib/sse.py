"""Server-Sent Events formatting helper.

A single function — kept in its own module so the wire-format rule lives
in exactly one place.  If we ever need to support comment lines, named
events, or retry hints, they go here.
"""

import json


def format_sse(data: dict) -> str:
    """Format a dict as a complete SSE ``data:`` event.

    Every event ends with the required blank line (``\\n\\n``) so the
    browser's EventSource parser recognises the event boundary.

    Args:
        data: JSON-serialisable payload.  Will be serialised with default
            settings (no indentation, default separators).

    Returns:
        A string ready to be ``yield``-ed by a Flask streaming generator.
    """
    return f"data: {json.dumps(data)}\n\n"
