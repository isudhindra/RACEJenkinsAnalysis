"""Time / datetime helpers shared between routes.

Single-purpose module — extracted so the parsing rule lives in exactly
one place and is unit-testable in isolation.
"""

from datetime import datetime
from typing import Optional


def parse_promotion_time(data: dict) -> Optional[datetime]:
    """Parse an ISO-8601 ``promotion_time`` from a request body.

    The frontend uses ``Date.prototype.toISOString()`` which always emits
    a trailing ``Z`` (UTC) and millisecond precision — e.g.
    ``"2026-05-28T08:00:00.000Z"``.  Python 3.10's ``fromisoformat`` does
    NOT accept ``Z`` natively (3.11+ does), so without normalization the
    backend would silently drop every browser-supplied promotion time
    and disable release validation across the board.

    The returned datetime is naive so it can be compared directly with
    Jenkins build timestamps (which are naive — from
    ``datetime.fromtimestamp``).

    Args:
        data: The raw JSON body of a request.  ``data["promotion_time"]``
            is read; missing or empty values produce ``None``.

    Returns:
        A naive ``datetime`` parsed from the field, or ``None`` if the
        value is missing, empty, or unparseable.
    """
    raw = (data.get("promotion_time") or "").strip()
    if not raw:
        return None

    # Strip trailing Z and convert to "+00:00" so 3.10 fromisoformat accepts it.
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"

    try:
        dt = datetime.fromisoformat(raw)
    except (TypeError, ValueError):
        return None

    # Drop tz info — all build timestamps are naive in this codebase.
    if dt.tzinfo is not None:
        dt = dt.replace(tzinfo=None)
    return dt
