"""Promotion-time parsing for the release-readiness view. Accepts the
dashboard's ISO-8601 input (with or without `Z`) and returns a
timezone-aware datetime so comparisons match across environments.
"""

from datetime import datetime
from typing import Optional


def parse_promotion_time(data: dict) -> Optional[datetime]:
    """Parse the request body's ISO-8601 promotion_time into a naive local datetime.
    The browser sends Date.prototype.toISOString(), so a trailing Z is normalised.
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
