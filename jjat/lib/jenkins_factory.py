"""Factory for :class:`JenkinsClient` instances from a request body.

Every route handler that needs to talk to Jenkins extracts the same
three fields (``jenkins_url``, ``username``, ``api_token``) and passes
the same ``timeout`` / ``pool_size`` choices.  Centralising the
construction here removes ten near-identical call sites and ensures
new defaults (e.g. retry policy) take effect everywhere at once.
"""

from typing import Optional

from jjat.jenkins_client import JenkinsClient

# Safe default pool size when a caller doesn't specify.  Routes that
# drive the orchestrator's thread pool (fetch / refresh streams) pass a
# pool_size matching ``max_workers`` so HTTP concurrency keeps pace with
# Python thread concurrency; everyone else gets this conservative cap.
_DEFAULT_POOL_SIZE = 32


def make_client(
    data: dict,
    *,
    timeout: int = 30,
    pool_size: Optional[int] = None,
) -> JenkinsClient:
    """Build a :class:`JenkinsClient` from a route's request-body dict.

    ``pool_size`` should be at least as large as the orchestrator's
    ``max_workers`` — otherwise requests' urllib3 pool (default 10)
    will silently serialise threads beyond that limit.  Callers in the
    SSE fetch / refresh paths pass the configured worker count; lighter
    routes can leave it ``None`` and get the safe default.

    Args:
        data: Request body containing ``jenkins_url``, ``username``,
            ``api_token``.  Already passed through
            :func:`jjat.lib.credentials.resolve_credentials`.
        timeout: Per-request HTTP timeout in seconds.
        pool_size: Maximum concurrent HTTP connections.

    Returns:
        A configured :class:`JenkinsClient` ready to use.
    """
    return JenkinsClient(
        base_url=data["jenkins_url"],
        username=data["username"],
        api_token=data["api_token"],
        timeout=timeout,
        pool_size=pool_size if pool_size is not None else _DEFAULT_POOL_SIZE,
    )
