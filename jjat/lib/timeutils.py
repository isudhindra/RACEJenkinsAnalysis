"""Time helpers shared between routes — kept here so the parsing rule has one home."""

from datetime import datetime
from typing import Optional


def parse_promotion_time(data: dict) -> Optional[datetime]:
    """Parse the request body's ISO-8601 ``promotion_time`` into a naive datetime.

    The browser sends ``Date.prototype.toISOString()``
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
        # astimezone() with no arg → system local timezone.
        dt = dt.astimezone().replace(tzinfo=None)
    return dt
