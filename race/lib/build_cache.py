"""In-memory cache of recent Jenkins build payloads, keyed by job URL and
build number. Lets the orchestrator skip repeat API hits during a fetch
and any follow-up refresh, keeping dashboard latency low on large views.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from race.models import BuildInfo, BuildStatus


# Hard cap on the LRU — bounded so memory stays predictable on big Jenkins
# instances with thousands of jobs. Each entry is a small dataclass (~5
# fields), so 5000 entries is well under 1 MB.
_DEFAULT_MAX_ENTRIES = 5000


def _normalise_url(url: str) -> str:
    """Strip trailing slash + lowercase for stable URL comparison."""
    return (url or "").rstrip("/").lower()


class BuildCache:
    """Thread-safe LRU of completed Jenkins BuildInfo entries. Only final
    statuses are cached so a transient in-progress state can't poison the cache.
    """

    def __init__(self, max_entries: int = _DEFAULT_MAX_ENTRIES) -> None:
        self._max = max(1, int(max_entries))
        self._store: "OrderedDict[Tuple[str, int], BuildInfo]" = OrderedDict()
        self._lock = threading.Lock()
        # Lightweight counters for the diag panel — observability without
        # forcing every call site to track hit/miss rates locally.
        self._hits = 0
        self._misses = 0

    @staticmethod
    def _is_cacheable(status: BuildStatus) -> bool:
        # SUCCESS / FAILURE / UNSTABLE / ABORTED / NOT_BUILT are all final
        # per Jenkins. IN_PROGRESS and UNKNOWN can still change.
        return status not in (BuildStatus.IN_PROGRESS, BuildStatus.UNKNOWN)

    def get(self, job_url: str, build_number: Optional[int]) -> Optional[BuildInfo]:
        """Return the cached build, or None on miss / bad inputs."""
        if not job_url or build_number is None:
            return None
        try:
            key = (_normalise_url(job_url), int(build_number))
        except (TypeError, ValueError):
            return None
        with self._lock:
            value = self._store.get(key)
            if value is not None:
                self._store.move_to_end(key)
                self._hits += 1
                return value
            self._misses += 1
            return None

    def put(self, job_url: str, build_info: Optional[BuildInfo]) -> None:
        """Store the build; silently no-op for IN_PROGRESS or missing inputs."""
        if (
            not job_url
            or build_info is None
            or build_info.build_number is None
            or not self._is_cacheable(build_info.status)
        ):
            return
        try:
            key = (_normalise_url(job_url), int(build_info.build_number))
        except (TypeError, ValueError):
            return
        with self._lock:
            self._store[key] = build_info
            self._store.move_to_end(key)
            # Trim the oldest entries when over capacity.
            while len(self._store) > self._max:
                self._store.popitem(last=False)

    def stats(self) -> Dict[str, int]:
        """Return hit/miss counters and current size for observability."""
        with self._lock:
            return {"hits": self._hits, "misses": self._misses, "size": len(self._store)}

    def clear(self) -> None:
        """Wipe the cache; used when the user picks a different Jenkins instance."""
        with self._lock:
            self._store.clear()
            self._hits = 0
            self._misses = 0


# Process-wide singleton so every JenkinsClient instance shares the same
# memoised view of completed builds. The cost of multiple JenkinsClient
# objects (one per request) is otherwise that each starts cold.
BUILD_CACHE = BuildCache()


@dataclass
class BatchedJobData:
    """Per-job data from a single batched view-level tree query, replacing three
    per-job HTTP calls. test_counts is opportunistic and may be None.
    """
    name: str
    url: str
    last_build: Optional[BuildInfo] = None
    last_successful_build: Optional[BuildInfo] = None
    recent_builds: List[BuildInfo] = field(default_factory=list)
    test_counts: Optional[Tuple[int, int, int]] = None


class ViewPrefetch:
    """Per-job data from a batched view fetch; Stage 1 consults this to skip
    redundant HTTP calls. Empty when not a view or when the batched call failed.
    """

    def __init__(self) -> None:
        self._data: Dict[str, BatchedJobData] = {}

    def populate(self, jobs: List[BatchedJobData]) -> None:
        """Replace existing entries with the new batched results."""
        self._data = {_normalise_url(j.url): j for j in jobs if j.url}

    def get(self, job_url: str) -> Optional[BatchedJobData]:
        """Return prefetched data for job_url, or None on miss."""
        return self._data.get(_normalise_url(job_url))

    def __len__(self) -> int:
        return len(self._data)

    def __bool__(self) -> bool:
        return bool(self._data)
