"""Factory for :class:`JenkinsClient` instances from a request body.

Every Jenkins-talking route reads the same three fields; centralising
construction here means new defaults (timeouts, retries, etc.) take
effect everywhere at once.
"""

from typing import Optional

from jjat.jenkins_client import JenkinsClient

# Conservative default for routes that don't drive the orchestrator's thread pool.
_DEFAULT_POOL_SIZE = 32


def make_client(
    data: dict,
    *,
    timeout: int = 30,
    pool_size: Optional[int] = None,
) -> JenkinsClient:
    """Build a :class:`JenkinsClient` from a route's request-body dict.

    ``pool_size`` must be at least as large as the orchestrator's
    ``max_workers`` — urllib3's default (10) would otherwise serialise
    threads beyond that. Routes in the SSE fetch / refresh paths pass
    the configured worker count; lighter routes can leave it ``None``.
    """
    return JenkinsClient(
        base_url=data["jenkins_url"],
        username=data["username"],
        api_token=data["api_token"],
        timeout=timeout,
        pool_size=pool_size if pool_size is not None else _DEFAULT_POOL_SIZE,
    )
