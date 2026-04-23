"""
Jenkins API Integration Layer

Encapsulates all Jenkins API interactions including authentication, job discovery,
build metadata fetching, test metrics retrieval, console log access, and build
triggering with exponential backoff retry logic.
"""

import time
from typing import Optional, List, Dict, Any
from datetime import datetime

import requests
from requests.auth import HTTPBasicAuth

from models import BuildInfo, BuildStatus, TestMetrics


# ============================================================================
# EXCEPTIONS
# ============================================================================

class JenkinsClientError(Exception):
    """Exception raised for unrecoverable Jenkins API errors."""

    def __init__(
        self,
        message: str,
        status_code: Optional[int] = None,
        job_url: Optional[str] = None,
    ) -> None:
        """
        Initialize JenkinsClientError.

        Args:
            message: Error description.
            status_code: HTTP status code if applicable.
            job_url: Job URL if applicable.
        """
        self.message = message
        self.status_code = status_code
        self.job_url = job_url
        super().__init__(self.message)


# ============================================================================
# JENKINS CLIENT
# ============================================================================

class JenkinsClient:
    """
    Jenkins API client with connection pooling, authentication, and retry logic.

    Manages all interactions with Jenkins API endpoints, including job discovery,
    build metadata fetching, test metrics retrieval, console access, and build
    triggering.
    """

    # Retry configuration
    MAX_RETRIES = 3
    RETRY_DELAYS = [1, 2, 4]  # Exponential backoff in seconds

    # Jenkins result → BuildStatus mapping (used by _parse_build_status)
    _STATUS_MAP = {
        "SUCCESS": BuildStatus.SUCCESS,
        "FAILURE": BuildStatus.FAILURE,
        "UNSTABLE": BuildStatus.UNSTABLE,
        "ABORTED": BuildStatus.ABORTED,
        "NOT_BUILT": BuildStatus.NOT_BUILT,
    }

    def __init__(
        self,
        base_url: str,
        username: str,
        api_token: str,
        timeout: int = 30,
    ) -> None:
        """
        Initialize JenkinsClient.

        Args:
            base_url: Base URL of Jenkins instance (e.g., https://jenkins.example.com).
            username: Jenkins username for authentication.
            api_token: Jenkins API token for authentication.
            timeout: Request timeout in seconds (default: 30).
        """
        # Strip trailing slash from base_url
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

        # Create session with HTTP Basic Auth and connection pooling
        self.session = requests.Session()
        self.session.auth = HTTPBasicAuth(username, api_token)
        self.session.headers.update({"Accept": "application/json"})

    def validate_credentials(self) -> bool:
        """
        Validate Jenkins credentials.

        Attempts to fetch Jenkins API info without raising exceptions.
        Used by app.py for credential validation on connection.

        Returns:
            True if credentials are valid (2xx response); False otherwise.
        """
        try:
            url = f"{self.base_url}/api/json?tree=_class"
            response = self.session.get(url, timeout=self.timeout)
            return response.status_code < 400
        except (requests.Timeout, requests.ConnectionError):
            return False
        except Exception:
            return False

    def discover_jobs_from_view(self, view_url: str) -> List[Dict[str, str]]:
        """
        Discover jobs from a Jenkins view.

        Fetches job list from a view URL using the Jenkins API.

        Args:
            view_url: Full URL to a Jenkins view (e.g., https://jenkins.example.com/view/MyView).

        Returns:
            List of dicts with keys "name" and "url". Empty list if view has no jobs.

        Raises:
            JenkinsClientError: On 404 (view not found), 401 (auth failed), timeout,
                or connection error.
        """
        url = f"{view_url}/api/json?tree=jobs[name,url]"

        try:
            response = self._request_with_retry("GET", url)
            data = response.json()

            if "jobs" not in data:
                return []

            return [{"name": job["name"], "url": job["url"]} for job in data["jobs"]]

        except JenkinsClientError:
            raise
        except Exception as e:
            raise JenkinsClientError(
                f"Failed to discover jobs from view: {str(e)}",
                job_url=view_url,
            )

    def fetch_build_info(
        self,
        job_url: str,
        build_identifier: str = "lastBuild",
    ) -> BuildInfo:
        """
        Fetch build information.

        Retrieves metadata about a specific build: number, result, timestamp, and
        duration.

        Args:
            job_url: Full URL to a Jenkins job (e.g., https://jenkins.example.com/job/MyJob).
            build_identifier: Build identifier - "lastBuild", "lastCompletedBuild", or
                a build number string (default: "lastBuild").

        Returns:
            BuildInfo object with build_number, status, timestamp, and duration_ms.

        Raises:
            JenkinsClientError: On 404 (build not found), 401 (auth failed), timeout,
                or connection error.
        """
        url = (
            f"{job_url}/{build_identifier}/api/json?"
            "tree=number,result,timestamp,duration"
        )

        try:
            response = self._request_with_retry("GET", url)
            data = response.json()

            # Map Jenkins build result to BuildStatus
            building = data.get("building", False)
            result = data.get("result")

            # If build is in progress and has no result yet, mark as IN_PROGRESS
            if building and result is None:
                status = BuildStatus.IN_PROGRESS
            else:
                status = self._parse_build_status(result or "UNKNOWN")

            # Parse timestamp (milliseconds since epoch)
            timestamp_ms = data.get("timestamp", 0)
            timestamp = datetime.fromtimestamp(timestamp_ms / 1000.0)

            # Duration in milliseconds
            duration_ms = data.get("duration", 0)

            return BuildInfo(
                build_number=data["number"],
                status=status,
                timestamp=timestamp,
                duration_ms=duration_ms,
            )

        except JenkinsClientError:
            raise
        except Exception as e:
            raise JenkinsClientError(
                f"Failed to fetch build info: {str(e)}",
                job_url=job_url,
            )

    def fetch_test_metrics(
        self,
        job_url: str,
        build_number: int,
    ) -> Optional[TestMetrics]:
        """
        Fetch test metrics from a build.

        Attempts to retrieve test report metrics (test counts, durations). Returns
        None if test report is not available (404).

        Args:
            job_url: Full URL to a Jenkins job.
            build_number: Build number (integer).

        Returns:
            TestMetrics object if test report exists; None on 404 (no test report).

        Raises:
            JenkinsClientError: On 401 (auth failed), timeout, or connection error.
        """
        url = (
            f"{job_url}/{build_number}/testReport/api/json?"
            "tree=totalCount,passCount,failCount,skipCount,duration"
        )

        try:
            response = self._request_with_retry("GET", url)

            # 404 means test report doesn't exist
            if response.status_code == 404:
                return None

            data = response.json()

            return TestMetrics(
                total=data.get("totalCount"),
                passed=data.get("passCount"),
                failed=data.get("failCount"),
                skipped=data.get("skipCount"),
                duration_seconds=data.get("duration"),
            )

        except JenkinsClientError as e:
            # Re-raise unless it's a 404
            if e.status_code == 404:
                return None
            raise
        except Exception as e:
            raise JenkinsClientError(
                f"Failed to fetch test metrics: {str(e)}",
                job_url=job_url,
            )

    def fetch_console_full(
        self,
        job_url: str,
        build_number: int,
    ) -> str:
        """
        Fetch the complete console output for a build.

        Args:
            job_url: Full URL to a Jenkins job.
            build_number: Build number (integer).

        Returns:
            Plain text string containing the full console output.
            Empty string if console has no content.

        Raises:
            JenkinsClientError: On 404, 401, timeout, or connection error.
        """
        url = f"{job_url}/{build_number}/consoleText"

        try:
            response = self._request_with_retry("GET", url)
            return response.text or ""
        except JenkinsClientError:
            raise
        except Exception as e:
            raise JenkinsClientError(
                f"Failed to fetch console output: {str(e)}",
                job_url=job_url,
            )

    def fetch_console_tail(
        self,
        job_url: str,
        build_number: int,
        lines: int = 500,
    ) -> str:
        """
        Fetch the last N lines of console output.

        Delegates to :meth:`fetch_console_full` and returns only the
        trailing *lines* lines.

        Args:
            job_url: Full URL to a Jenkins job.
            build_number: Build number (integer).
            lines: Number of lines to return from the end (default: 500).

        Returns:
            Plain text string containing last N lines. Empty string if console
            has no content.

        Raises:
            JenkinsClientError: On 404, 401, timeout, or connection error.
        """
        text = self.fetch_console_full(job_url, build_number)
        if not text:
            return ""
        return "\n".join(text.split("\n")[-lines:])

    def fetch_recent_builds(
        self,
        job_url: str,
        count: int = 5,
    ) -> list:
        """
        Fetch the most recent builds for a job in a single API call.

        Uses the Jenkins JSON API with a range selector to retrieve the last
        *count* builds efficiently (one HTTP round-trip).

        Args:
            job_url: Full URL to a Jenkins job.
            count: Maximum number of recent builds to retrieve (default: 5).

        Returns:
            List of BuildInfo objects, ordered newest-first.  May be shorter
            than *count* if the job has fewer builds.  Returns an empty list
            when the API response contains no builds array.

        Raises:
            JenkinsClientError: On 401 (auth failed), timeout, or connection
                error.  404 errors return an empty list (job has no builds).
        """
        url = (
            f"{job_url}/api/json?"
            f"tree=builds[number,result,timestamp,duration,building]"
            f"{{0,{count}}}"
        )

        try:
            response = self._request_with_retry("GET", url)

            if response.status_code == 404:
                return []

            data = response.json()
            builds_data = data.get("builds", [])
            results = []

            for b in builds_data:
                building = b.get("building", False)
                result = b.get("result")

                if building and result is None:
                    status = BuildStatus.IN_PROGRESS
                else:
                    status = self._parse_build_status(result or "UNKNOWN")

                timestamp_ms = b.get("timestamp", 0)
                timestamp = datetime.fromtimestamp(timestamp_ms / 1000.0)

                results.append(BuildInfo(
                    build_number=b["number"],
                    status=status,
                    timestamp=timestamp,
                    duration_ms=b.get("duration", 0),
                ))

            return results

        except JenkinsClientError as e:
            if e.status_code == 404:
                return []
            raise
        except Exception as e:
            raise JenkinsClientError(
                f"Failed to fetch recent builds: {str(e)}",
                job_url=job_url,
            )

    def find_last_passed_build(
        self,
        job_url: str,
        starting_from: int,
        max_depth: int = 20,
    ) -> Optional[BuildInfo]:
        """
        Find the last passing build.

        Iterates backward from starting_from down to starting_from - max_depth,
        checking each build for SUCCESS status. Silently skips 404 errors (builds
        that don't exist). Returns the first passing build found, or None if no
        passing build exists within max_depth.

        Args:
            job_url: Full URL to a Jenkins job.
            starting_from: Build number to start searching from (typically the
                current build number).
            max_depth: Maximum number of builds to check backward (default: 20).

        Returns:
            BuildInfo of first passing build found; None if no passing build
            within max_depth.

        Raises:
            JenkinsClientError: On 401, timeout, or connection error (404 errors
                are silently skipped).
        """
        for build_number in range(starting_from, starting_from - max_depth, -1):
            try:
                build_info = self.fetch_build_info(job_url, str(build_number))
                if build_info.status == BuildStatus.SUCCESS:
                    return build_info
            except JenkinsClientError as e:
                # Silently skip 404 errors (build doesn't exist)
                if e.status_code == 404:
                    continue
                # Propagate all other errors
                raise

        return None

    def trigger_build(self, job_url: str) -> bool:
        """
        Trigger a build.

        Attempts to queue a new build for a Jenkins job.

        Args:
            job_url: Full URL to a Jenkins job.

        Returns:
            True if build was successfully queued (201/202 response).
            False if permission denied (403) or job disabled (409).

        Raises:
            JenkinsClientError: On 401 (auth failed), 404 (job not found),
                timeout, or connection error.
        """
        url = f"{job_url}/build"

        try:
            response = self._request_with_retry("POST", url)

            # Success: 201 or 202 means queued
            if response.status_code in (201, 202):
                return True

            # 403: Permission denied, 409: Job disabled
            if response.status_code in (403, 409):
                return False

            # Other 2xx responses are also success
            if 200 <= response.status_code < 300:
                return True

            # Unexpected status
            raise JenkinsClientError(
                f"Unexpected response status: {response.status_code}",
                status_code=response.status_code,
                job_url=job_url,
            )

        except JenkinsClientError:
            raise
        except Exception as e:
            raise JenkinsClientError(
                f"Failed to trigger build: {str(e)}",
                job_url=job_url,
            )

    def _request_with_retry(
        self,
        method: str,
        url: str,
        **kwargs: Any,
    ) -> requests.Response:
        """
        Execute an HTTP request with exponential backoff retry logic.

        Retries on:
        - requests.Timeout
        - requests.ConnectionError
        - HTTP 5xx (server errors)

        Does not retry on:
        - HTTP 4xx (client errors) — returned immediately

        Args:
            method: HTTP method (GET, POST, etc.).
            url: Full URL to request.
            **kwargs: Additional arguments to pass to session.request().

        Returns:
            requests.Response object.

        Raises:
            JenkinsClientError: After MAX_RETRIES failed attempts or on 4xx
                with non-retryable error.
        """
        last_exception = None

        for attempt in range(self.MAX_RETRIES):
            try:
                response = self.session.request(
                    method,
                    url,
                    timeout=self.timeout,
                    **kwargs,
                )

                # Don't retry 4xx errors (immediate return or raise)
                if 400 <= response.status_code < 500:
                    if response.status_code == 404:
                        # 404 is special: return the response so caller can handle
                        return response
                    elif response.status_code == 401:
                        raise JenkinsClientError(
                            "Authentication failed",
                            status_code=401,
                        )
                    elif response.status_code == 403:
                        raise JenkinsClientError(
                            "Permission denied",
                            status_code=403,
                        )
                    else:
                        raise JenkinsClientError(
                            f"HTTP {response.status_code}: {response.reason}",
                            status_code=response.status_code,
                        )

                # 5xx errors: retry
                if response.status_code >= 500:
                    last_exception = JenkinsClientError(
                        f"HTTP {response.status_code}: {response.reason}",
                        status_code=response.status_code,
                    )
                    if attempt < self.MAX_RETRIES - 1:
                        time.sleep(self.RETRY_DELAYS[attempt])
                        continue
                    raise last_exception

                # Success (2xx, 3xx)
                return response

            except requests.Timeout as e:
                last_exception = JenkinsClientError(
                    f"Request timeout after {self.timeout}s",
                )
                if attempt < self.MAX_RETRIES - 1:
                    time.sleep(self.RETRY_DELAYS[attempt])
                    continue
                raise last_exception

            except requests.ConnectionError as e:
                last_exception = JenkinsClientError(
                    f"Connection error: {str(e)}",
                )
                if attempt < self.MAX_RETRIES - 1:
                    time.sleep(self.RETRY_DELAYS[attempt])
                    continue
                raise last_exception

            except JenkinsClientError:
                raise

            except Exception as e:
                # Unexpected error: don't retry
                raise JenkinsClientError(
                    f"Unexpected error: {str(e)}",
                )

        # Should not reach here, but just in case
        if last_exception:
            raise last_exception
        raise JenkinsClientError("Request failed after maximum retries")

    def _parse_build_status(self, result: str) -> BuildStatus:
        """
        Parse Jenkins build result string to BuildStatus enum.

        Args:
            result: Build result string from Jenkins API.

        Returns:
            BuildStatus enum value.
        """
        result = (result or "").strip().upper()

        return self._STATUS_MAP.get(result, BuildStatus.UNKNOWN)
