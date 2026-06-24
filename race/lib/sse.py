"""Tiny helper that formats a dict as a Server-Sent Events frame
(`data: <json>\\n\\n`). Used by every streaming endpoint so the wire
format stays consistent across fetch, refresh, and poll routes.
"""

import json


def format_sse(data: dict) -> str:
    """Format a dict as a complete SSE data: event with the required blank line."""
    return f"data: {json.dumps(data)}\n\n"
