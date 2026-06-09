"""Jenkins API integration — auth, discovery, fetch, trigger, retries."""

import time
from datetime import datetime
from typing import Any, Dict, List, Optional

import requests
from requests.adapters import HTTPAdapter
from requests.auth import HTTPBasicAuth

from jjat.models import BuildInfo, BuildStatus, TestMetrics


class JenkinsClientError(Exception):
    """Raised for unrecoverable Jenkins API errors."""

    def __init__(
        self,
        message: str,
        status_code: Optional[int] = None,
        job_url: Optional[str] = None,
    ) -> None:
        self.message = message
        self.status_code = status_code
        self.job_url = job_url
        super().__init__(self.message)


class JenkinsClient:
    """Jenkins API client with connection pooling, auth, and retry logic."""

    MAX_RETRIES = 3
    RETRY_DELAYS = [1, 2, 4]  # Exponential backoff (seconds).

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
        pool_size: int = 32,
    ) -> None:
        """Initialize JenkinsClient with a pooled, authenticated session."""
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

        self.session = requests.Session()
        self.session.auth = HTTPBasicAuth(username, api_token)
        self.session.headers.update({"Accept": "application/json"})
        adapter = HTTPAdapter(
            pool_connections=pool_size,
            pool_maxsize=pool_size,
            max_retries=0,  # Retries are handled in _request_with_retry.
        )
        self.session.mount("http://", adapter)
        self.session.mount("https://", adapter)

        # CSRF crumb cache, lazily populated on first POST.
        # None = not yet fetched; {} = server has CSRF disabled.
        self._crumb: Optional[Dict[str, str]] = None

    def validate_credentials(self) -> bool:
        """Return True if Jenkins accepts the supplied credentials.

        Uses /api/json — universally available across every Jenkins
        deployment. If the instance permits anonymous reads, validation
        will pass even with wrong creds, but downstream fetches still
        surface real auth errors with clear messages.
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
        """List the jobs in a Jenkins view as ``{"name", "url"}`` dicts."""
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
        """Fetch build metadata (number, status, timestamp, duration).

        ``build_identifier`` may be ``"lastBuild"``, ``"lastCompletedBuild"``,
        or a numeric build-number string.
        """
        url = (
            f"{job_url}/{build_identifier}/api/json?"
            "tree=number,result,timestamp,duration"
        )

        try:
            response = self._request_with_retry("GET", url)
            data = response.json()

            # Missing result means Jenkins is still running the build.
            result = data.get("result")
            if result is None:
                status = BuildStatus.IN_PROGRESS
            else:
                status = self._parse_build_status(result)

            timestamp_ms = data.get("timestamp", 0)
            timestamp = datetime.fromtimestamp(timestamp_ms / 1000.0)
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
        """Fetch test-report metrics for a build, or ``None`` when no report exists."""
        url = (
            f"{job_url}/{build_number}/testReport/api/json?"
            "tree=totalCount,passCount,failCount,skipCount,duration"
        )

        try:
            response = self._request_with_retry("GET", url)

            if response.status_code == 404:
                return None

            data = response.json()

            total = data.get("totalCount")
            passed = data.get("passCount") or 0
            failed = data.get("failCount") or 0
            skipped = data.get("skipCount") or 0
            # Some Jenkins versions omit totalCount; reconstruct from the parts.
            if total is None:
                parts_sum = passed + failed + skipped
                total = parts_sum if parts_sum > 0 else None

            return TestMetrics(
                total=total,
                passed=passed,
                failed=failed,
                skipped=skipped,
                duration_seconds=data.get("duration"),
            )

        except JenkinsClientError as e:
            if e.status_code == 404:
                return None
            raise
        except Exception as e:
            raise JenkinsClientError(
                f"Failed to fetch test metrics: {str(e)}",
                job_url=job_url,
            )

    # Hard cap protects workers from multi-GB pathological logs; the
    # classifier only ever looks at the tail anyway.
    _CONSOLE_MAX_BYTES = 10 * 1024 * 1024  # 10 MB

    def fetch_console_full(
        self,
        job_url: str,
        build_number: int,
    ) -> str:
        """Fetch the full console output, capped at 10MB to protect workers."""
        url = f"{job_url}/{build_number}/consoleText"

        try:
            response = self._request_with_retry("GET", url, stream=True)
            chunks = []
            total = 0
            for chunk in response.iter_content(chunk_size=64 * 1024, decode_unicode=False):
                if not chunk:
                    continue
                chunks.append(chunk)
                total += len(chunk)
                if total >= self._CONSOLE_MAX_BYTES:
                    break
            response.close()
            body = b"".join(chunks)
            # Jenkins consoles carry mixed encodings — best-effort decode.
            return body.decode("utf-8", errors="replace")
        except JenkinsClientError:
            raise
        except Exception as e:
            raise JenkinsClientError(
                f"Failed to fetch console output: {str(e)}",
                job_url=job_url,
            )

    # Rough bytes-per-line for Cucumber/Serenity logs — used to size the tail window.
    _AVG_BYTES_PER_LINE = 160

    def _fetch_console_progressive(
        self,
        job_url: str,
        build_number: int,
        start: int,
    ) -> tuple:
        """Hit ``logText/progressiveText`` and return ``(text, x_text_size)``.

        ``x_text_size`` (from the ``X-Text-Size`` response header) is the
        full console byte length, or ``None`` if absent. Single seam used
        by :meth:`fetch_console_tail`.
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
        """Return roughly the last ``lines`` lines of the console log.

        For large jobs this is much cheaper than ``fetch_console_full`` —
        it reads X-Text-Size on the first call, then issues a second
        offset request only if the log exceeds the tail window.
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

        # Bias the window large so we don't miss lines we wanted.
        tail_bytes = lines * self._AVG_BYTES_PER_LINE

        # Whole log already fits in the window — no second round-trip needed.
        if total_size is None or total_size <= tail_bytes:
            if not first_text:
                return ""
            return "\n".join(first_text.split("\n")[-lines:])

        offset = max(0, total_size - tail_bytes)
        try:
            tail_text, _ = self._fetch_console_progressive(
                job_url, build_number, start=offset,
            )
        except JenkinsClientError:
            # Fall back to the first-call body rather than failing entirely.
            tail_text = first_text

        if not tail_text:
            return ""

        # First line after a mid-stream offset is partial — drop it.
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
        """Fetch up to ``count`` builds for a job in one round-trip.

        ``field="builds"`` queries Jenkins' in-memory cache (cheap, ~30
        builds). ``field="allBuilds"`` walks the full history so older
        ``last_passed`` builds can be found.
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
        """Find the newest SUCCESS within ``depth`` builds via a single tree query.

        Much cheaper than :meth:`find_last_passed_build`, which costs one
        HTTP call per build.
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
        """Walk backward one-build-at-a-time looking for SUCCESS.

        Slower than :meth:`fetch_last_passed` (one HTTP call per build);
        kept for callers that need a precise stopping point. 404s are
        skipped silently — those build numbers simply don't exist.
        """
        for build_number in range(starting_from, starting_from - max_depth, -1):
            try:
                build_info = self.fetch_build_info(job_url, str(build_number))
                if build_info.status == BuildStatus.SUCCESS:
                    return build_info
            except JenkinsClientError as e:
                if e.status_code == 404:
                    continue
                raise

        return None

    def trigger_build(self, job_url: str) -> bool:
        """Queue a new build. Returns ``False`` for 403 (denied) / 409 (disabled)."""
        url = f"{job_url}/build"

        try:
            response = self._request_with_retry("POST", url)

            if response.status_code in (201, 202):
                return True

            # 403 = permission denied, 409 = job disabled.
            if response.status_code in (403, 409):
                return False

            if 200 <= response.status_code < 300:
                return True

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
        """Lazily fetch + cache the Jenkins CSRF crumb header.

        Modern Jenkins (>=2.176) rejects POSTs without a crumb. Returns
        ``{}`` when the server has CSRF disabled or we can't reach the
        issuer, so POSTs are never blocked by crumb-fetch failures.
        """
        if self._crumb is not None:
            return self._crumb

        try:
            url = f"{self.base_url}/crumbIssuer/api/json"
            # Direct call to avoid recursing through _request_with_retry.
            response = self.session.get(url, timeout=self.timeout)
            if response.status_code == 404:
                # CSRF disabled on this server.
                self._crumb = {}
                return self._crumb
            if response.status_code >= 400:
                # Proceed without a crumb — if the POST really needs one, it'll 403.
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
            # Don't block the POST on a network blip fetching the crumb.
            self._crumb = {}
            return self._crumb

    def _request_with_retry(
        self,
        method: str,
        url: str,
        **kwargs: Any,
    ) -> requests.Response:
        """HTTP request with exponential backoff on timeout / 5xx.

        Mutating methods get a CSRF crumb attached automatically. 4xx
        responses return immediately (never retried); 404 is returned as
        a response object so callers can handle it.
        """
        last_exception = None

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

                if 400 <= response.status_code < 500:
                    if response.status_code == 404:
                        # Return so the caller can treat "not found" as data, not error.
                        return response
                    if response.status_code == 401:
                        raise JenkinsClientError(
                            "Authentication failed",
                            status_code=401,
                        )
                    if response.status_code == 403:
                        raise JenkinsClientError(
                            "Permission denied",
                            status_code=403,
                        )
                    raise JenkinsClientError(
                        f"HTTP {response.status_code}: {response.reason}",
                        status_code=response.status_code,
                    )

                if response.status_code >= 500:
                    last_exception = JenkinsClientError(
                        f"HTTP {response.status_code}: {response.reason}",
                        status_code=response.status_code,
                    )
                    if attempt < self.MAX_RETRIES - 1:
                        time.sleep(self.RETRY_DELAYS[attempt])
                        continue
                    raise last_exception

                return response

            except requests.Timeout:
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
                raise JenkinsClientError(
                    f"Unexpected error: {str(e)}",
                )

        if last_exception:
            raise last_exception
        raise JenkinsClientError("Request failed after maximum retries")

    def _parse_build_status(self, result: str) -> BuildStatus:
        """Map a Jenkins result string to a :class:`BuildStatus`."""
        result = (result or "").strip().upper()

        return self._STATUS_MAP.get(result, BuildStatus.UNKNOWN)
