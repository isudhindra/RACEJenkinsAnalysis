"""Time helpers shared between routes — kept here so the parsing rule has one home."""

from datetime import datetime
from typing import Optional


def parse_promotion_time(data: dict) -> Optional[datetime]:
    """Parse the request body's ISO-8601 ``promotion_time`` into a naive datetime.

    The browser sends ``Date.prototype.toISOString()`` output (always
    trailing ``Z``); Python 3.10's ``fromisoformat`` doesn't accept ``Z``
    directly, so we rewrite it to ``+00:00`` first. The result is
    returned naive so it lines up with Jenkins build timestamps, which
    are themselves naive ``datetime.fromtimestamp`` values.
    """
    raw = (data.get("promotion_time") or "").strip()
    if not raw:
        return None

    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"

    try:
        dt = datetime.fromisoformat(raw)
    except (TypeError, ValueError):
        return None

    if dt.tzinfo is not None:
        dt = dt.replace(tzinfo=None)
    return dt
