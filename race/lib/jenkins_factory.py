"""Builds a configured JenkinsClient from a resolved credentials dict.
Single place where timeout and connection-pool size are wired so route
files don't repeat the boilerplate.
"""

from typing import Optional

from race.jenkins_client import JenkinsClient

# Conservative default for routes that don't drive the orchestrator's thread pool.
_DEFAULT_POOL_SIZE = 32


def make_client(
    data: dict,
    *,
    timeout: int = 30,
    pool_size: Optional[int] = None,
) -> JenkinsClient:
    """Build a JenkinsClient from a route's request-body dict. pool_size must
    match the orchestrator's worker count so urllib3 doesn't serialise threads.
    """
    return JenkinsClient(
        base_url=data["jenkins_url"],
        username=data["username"],
        api_token=data["api_token"],
        timeout=timeout,
        pool_size=pool_size if pool_size is not None else _DEFAULT_POOL_SIZE,
    )
