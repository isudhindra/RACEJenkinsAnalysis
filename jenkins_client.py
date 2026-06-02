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

        # CSRF crumb cache. Lazy-initialised on the first POST.
        #   None             → not yet fetched
        #   {"header": ..., "value": ...} → crumb is in use
        #   {}               → server has CSRF disabled (issuer returned 404)
        self._crumb: Optional[Dict[str, str]] = None

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

            # Map Jenkins build result to BuildStatus.
            result = data.get("result")
            if result is None:
                status = BuildStatus.IN_PROGRESS
            else:
                status = self._parse_build_status(result)

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

    # Approximate bytes-per-line for Cucumber/Serenity console output.
    # Used to size the tail window when fetching progressiveText.
    _AVG_BYTES_PER_LINE = 160

    def _fetch_console_progressive(
        self,
        job_url: str,
        build_number: int,
        start: int,
    ) -> tuple:
        """
        Low-level progressiveText fetch.

        Returns the tuple ``(text, x_text_size)`` where ``x_text_size`` is the
        total console size in bytes (from the ``X-Text-Size`` response header)
        or ``None`` if the header is absent.

        This is the single seam used by :meth:`fetch_console_tail` and any
        future incremental-tail callers.  Do not duplicate the URL or header
        parsing logic elsewhere.

        Args:
            job_url: Full URL to a Jenkins job.
            build_number: Build number (integer).
            start: Byte offset to start fetching from.

        Returns:
            Tuple of (response_text, x_text_size_or_None).

        Raises:
            JenkinsClientError: On 404, 401, timeout, or connection error.
        """
        url = f"{job_url}/{build_number}/logText/progressiveText?start={start}"
        response = self._request_with_retry("GET", url)
        try:
            x_text_size = int(response.headers.get("X-Text-Size", "")) \
                if response.headers.get("X-Text-Size") else None
        except (TypeError, ValueError):
            x_text_size = None
        return response.text or "", x_text_size

    def fetch_console_tail(
        self,
        job_url: str,
        build_number: int,
        lines: int = 500,
    ) -> str:
        """
        Fetch approximately the last N lines of console output.

        Uses Jenkins' ``logText/progressiveText`` endpoint with a byte-offset
        ``start`` parameter so only the trailing portion of the log is
        transferred — much cheaper than downloading the full console for
        large jobs.

        Strategy:
          1. Issue a ``start=0`` request with a minimal body just to read the
             ``X-Text-Size`` response header (Jenkins always returns the full
             body for this endpoint, but on small logs that *is* the whole
             log and we are done in one round-trip).
          2. If the log is larger than the estimated tail window, issue a
             second request with ``start=<size - window>`` and discard the
             first (possibly partial) line.

        Args:
            job_url: Full URL to a Jenkins job.
            build_number: Build number (integer).
            lines: Number of lines to return from the end (default: 500).

        Returns:
            Plain text containing roughly the last ``lines`` lines.  May be
            slightly shorter than ``lines`` for very short logs, or exactly
            ``lines`` for long ones.

        Raises:
            JenkinsClientError: On 404, 401, timeout, or connection error.
        """
        try:
            first_text, total_size = self._fetch_console_progressive(
                job_url, build_number, start=0,
            )
        except JenkinsClientError:
            raise
        except Exception as e:
            raise JenkinsClientError(
                f"Failed to fetch console tail: {str(e)}",
                job_url=job_url,
            )

        # Size the tail window — bias high so we don't miss lines.
        tail_bytes = lines * self._AVG_BYTES_PER_LINE

        # If X-Text-Size is missing or the whole log already fits in the tail
        # window, we're done — return the last `lines` from what we have.
        if total_size is None or total_size <= tail_bytes:
            if not first_text:
                return ""
            return "\n".join(first_text.split("\n")[-lines:])

        # Log is larger than the tail window — fetch from the offset.
        offset = max(0, total_size - tail_bytes)
        try:
            tail_text, _ = self._fetch_console_progressive(
                job_url, build_number, start=offset,
            )
        except JenkinsClientError:
            # Fall back to whatever we got on the first call.
            tail_text = first_text

        if not tail_text:
            return ""

        # Drop the first (possibly partial) line introduced by mid-stream
        # offset, then return the trailing `lines` lines.
        parts = tail_text.split("\n")
        if len(parts) > 1:
            parts = parts[1:]
        return "\n".join(parts[-lines:])

    def fetch_recent_builds(
        self,
        job_url: str,
        count: int = 5,
        field: str = "builds",
    ) -> list:
        """
        Fetch a window of builds for a job in a single API call.

        Uses the Jenkins JSON API with a range selector to retrieve up to
        *count* builds efficiently (one HTTP round-trip).

        The ``field`` argument selects which Jenkins collection to query:

        * ``"builds"`` (default) — the recent-builds cache Jenkins keeps in
          memory.  Fast but bounded; typically the last ~30 builds.  Use this
          for the "latest pass + 2 recent" view.
        * ``"allBuilds"`` — the complete build history.  Slightly more
          expensive on the Jenkins side but lets us walk back through many
          builds to find an older ``last_passed`` reliably.

        Args:
            job_url: Full URL to a Jenkins job.
            count: Maximum number of builds to retrieve (default: 5).
            field: Jenkins collection name — ``"builds"`` or ``"allBuilds"``.

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
            f"tree={field}[number,result,timestamp,duration,building]"
            f"{{0,{count}}}"
        )

        try:
            response = self._request_with_retry("GET", url)

            if response.status_code == 404:
                return []

            data = response.json()
            builds_data = data.get(field, [])
            results = []

            for b in builds_data:
                result = b.get("result")
                if result is None:
                    status = BuildStatus.IN_PROGRESS
                else:
                    status = self._parse_build_status(result)

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

    def fetch_last_passed(
        self,
        job_url: str,
        depth: int = 50,
    ) -> Optional[BuildInfo]:
        """
        Find the most recent SUCCESS build by walking back through history.

        Uses a single ``allBuilds{0,depth}`` tree query and scans for the
        newest SUCCESS — much cheaper than calling :meth:`find_last_passed_build`
        which issues one HTTP request per build.

        Args:
            job_url: Full URL to a Jenkins job.
            depth: Maximum number of historical builds to scan (default: 50).

        Returns:
            BuildInfo of the newest SUCCESS in the window, or ``None`` if no
            SUCCESS exists within ``depth`` builds.

        Raises:
            JenkinsClientError: On 401, timeout, or connection error.
        """
        builds = self.fetch_recent_builds(job_url, count=depth, field="allBuilds")
        for b in builds:
            if b.status == BuildStatus.SUCCESS:
                return b
        return None

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

    def _get_crumb(self) -> Dict[str, str]:
        """
        Lazily fetch the Jenkins CSRF crumb and cache it on the session.

        Modern Jenkins (≥2.176) rejects POST requests without a valid crumb.
        Older instances may have CSRF disabled, in which case the issuer
        endpoint returns 404 — we cache an empty mapping and never re-fetch.

        Returns:
            A header mapping suitable for merging into a POST request.
            ``{}`` when CSRF is disabled on the server.
        """
        if self._crumb is not None:
            return self._crumb

        try:
            url = f"{self.base_url}/crumbIssuer/api/json"
            # Direct session.get — avoid recursing through _request_with_retry
            # (which would call back into _get_crumb for POSTs).
            response = self.session.get(url, timeout=self.timeout)
            if response.status_code == 404:
                # CSRF disabled on this server.
                self._crumb = {}
                return self._crumb
            if response.status_code >= 400:
                # Couldn't fetch crumb for some other reason — proceed without
                # one. If the POST genuinely needs a crumb it will fail with
                # 403 and the caller will see that.
                self._crumb = {}
                return self._crumb

            data = response.json()
            field = data.get("crumbRequestField") or "Jenkins-Crumb"
            value = data.get("crumb", "")
            if not value:
                self._crumb = {}
            else:
                self._crumb = {field: value}
            return self._crumb

        except Exception:
            # Network error fetching the crumb — don't block the POST.
            self._crumb = {}
            return self._crumb

    def _request_with_retry(
        self,
        method: str,
        url: str,
        **kwargs: Any,
    ) -> requests.Response:
        """
        Execute an HTTP request with exponential backoff retry logic.

        For mutating requests (POST/PUT/DELETE) the Jenkins CSRF crumb is
        attached automatically via :meth:`_get_crumb`.

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

        # Inject CSRF crumb for mutating requests. One-shot lazy fetch; if
        # the server doesn't use crumbs the call is a no-op after the first
        # attempt.
        if method.upper() in ("POST", "PUT", "DELETE", "PATCH"):
            crumb_headers = self._get_crumb()
            if crumb_headers:
                merged = dict(kwargs.get("headers") or {})
                merged.update(crumb_headers)
                kwargs["headers"] = merged

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
