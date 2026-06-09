"""Server-Sent Events formatting helper.

Kept in its own module so the wire-format rule lives in exactly one place.
"""

import json


def format_sse(data: dict) -> str:
    """Format a dict as a complete SSE ``data:`` event with the required blank line."""
    return f"data: {json.dumps(data)}\n\n"
