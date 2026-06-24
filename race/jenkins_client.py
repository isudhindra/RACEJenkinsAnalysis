"""HTTP client wrapping the Jenkins REST API. Handles auth, CSRF crumbs,
retries with exponential backoff, and console-log streaming. Every route
that talks to Jenkins goes through this single seam.
"""

import time
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import requests
from requests.adapters import HTTPAdapter
from requests.auth import HTTPBasicAuth

from race.lib.build_cache import BUILD_CACHE, BatchedJobData
from race.models import BuildInfo, BuildStatus, TestMetrics


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
        # Refuse redirects — the Authorization header would leak to whatever Jenkins points us at.
        self.session.max_redirects = 0
        # Console logs and JSON are highly compressible
        self.session.headers.update({
            "Accept": "application/json",
            "Accept-Encoding": "gzip, deflate",
        })
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
        Anonymous-read instances pass even with wrong creds — real errors surface on later fetches.
        """
        try:
            url = f"{self.base_url}/api/json?tree=_class"
            response = self.session.get(url, timeout=self.timeout, allow_redirects=False)
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

    def fetch_view_jobs_batched(self, view_url: str) -> List[BatchedJobData]:
        """One deep ?tree= query that pulls every job's metadata in a single call —
        lets Stage 1 skip N×3 per-job HTTP hits. Raises JenkinsClientError on failure.
        """
        # Single query that pulls everything Stage 1 needs.
        tree = (
            "jobs["
            "name,url,"
            "lastBuild[number,result,timestamp,duration,"
            "actions[totalCount,failCount,skipCount]],"
            "lastSuccessfulBuild[number,result,timestamp,duration],"
            "builds[number,result,timestamp,duration]{0,5}"
            "]"
        )
        url = f"{view_url.rstrip('/')}/api/json?tree={tree}"

        try:
            response = self._request_with_retry("GET", url)
            data = response.json()
        except JenkinsClientError:
            raise
        except Exception as e:
            raise JenkinsClientError(
                f"Batched view fetch failed: {str(e)}",
                job_url=view_url,
            )

        out: List[BatchedJobData] = []
        for raw in data.get("jobs", []) or []:
            if not isinstance(raw, dict):
                continue
            job_url = raw.get("url") or ""
            if not job_url:
                continue
            name = raw.get("name") or ""
            last_build = self._build_from_dict(raw.get("lastBuild"))
            last_successful = self._build_from_dict(raw.get("lastSuccessfulBuild"))
            recent: List[BuildInfo] = []
            for rb in raw.get("builds", []) or []:
                bi = self._build_from_dict(rb)
                if bi is not None:
                    recent.append(bi)

            # Pre-warm BUILD_CACHE with everything we just learned 
            if last_build is not None:
                BUILD_CACHE.put(job_url, last_build)
            if last_successful is not None:
                BUILD_CACHE.put(job_url, last_successful)
            for bi in recent:
                BUILD_CACHE.put(job_url, bi)

            out.append(BatchedJobData(
                name=name,
                url=job_url,
                last_build=last_build,
                last_successful_build=last_successful,
                recent_builds=recent,
                test_counts=self._extract_test_counts(raw.get("lastBuild")),
            ))

        return out

    def poll_view_lastbuilds(self, view_url: str) -> Dict[str, dict]:
        """One-shot per-view lastBuild poll — replaces N per-job calls with a single ?tree= query.
        Returns a normalised {job_url: {build_number, status, timestamp, is_running}} map.
        """
        
        tree = "jobs[url,lastBuild[number,result,timestamp,building]]"
        url = f"{view_url.rstrip('/')}/api/json?tree={tree}"
        try:
            response = self._request_with_retry("GET", url)
            data = response.json()
        except JenkinsClientError:
            raise
        except Exception as e:
            raise JenkinsClientError(
                f"Batched view poll failed: {str(e)}",
                job_url=view_url,
            )

        out: Dict[str, dict] = {}
        for raw in data.get("jobs", []) or []:
            if not isinstance(raw, dict):
                continue
            job_url = raw.get("url") or ""
            if not job_url:
                continue
            key = job_url.rstrip("/")  # normalised match key
            lb = raw.get("lastBuild") or {}
            number = lb.get("number")
            if number is None:
                # Job exists in the view but has never built — stable marker
                # so the caller can still produce a row with no surprises.
                out[key] = {
                    "build_number": None,
                    "status": "NOT_BUILT",
                    "timestamp": None,
                    "is_running": False,
                }
                continue
            result = lb.get("result")
            building = lb.get("building")
            # Trust `building: true` first; fall back to "no result yet".
            is_running = (building is True) or (result is None)
            status = "IN_PROGRESS" if is_running else self._parse_build_status(result).value
            ts_ms = lb.get("timestamp", 0) or 0
            try:
                ts_iso = datetime.fromtimestamp(ts_ms / 1000.0).isoformat()
            except (TypeError, ValueError, OverflowError):
                ts_iso = None
            out[key] = {
                "build_number": int(number),
                "status": status,
                "timestamp": ts_iso,
                "is_running": is_running,
            }
        return out

    def _build_from_dict(self, raw: Optional[Dict[str, Any]]) -> Optional[BuildInfo]:
        """Translate a Jenkins-style build dict into a BuildInfo.
        Returns None when the dict has no build number (Jenkins returns {} for jobs that never passed).
        """
        if not isinstance(raw, dict):
            return None
        number = raw.get("number")
        if number is None:
            return None
        result = raw.get("result")
        if result is None:
            status = BuildStatus.IN_PROGRESS
        else:
            status = self._parse_build_status(result)
        timestamp_ms = raw.get("timestamp", 0) or 0
        try:
            timestamp = datetime.fromtimestamp(timestamp_ms / 1000.0)
        except (TypeError, ValueError, OverflowError):
            timestamp = datetime.fromtimestamp(0)
        duration_ms = raw.get("duration", 0) or 0
        return BuildInfo(
            build_number=int(number),
            status=status,
            timestamp=timestamp,
            duration_ms=int(duration_ms),
        )

    def _extract_test_counts(
        self,
        last_build_raw: Optional[Dict[str, Any]],
    ) -> Optional[Tuple[int, int, int]]:
        """Pull (total, fail, skip) from the first actions[] entry that has a non-null totalCount.
        Returns None when no JUnit action is present — Stage 1 then falls back to /testReport.
        """
        if not isinstance(last_build_raw, dict):
            return None
        for action in last_build_raw.get("actions", []) or []:
            if not isinstance(action, dict):
                continue
            total = action.get("totalCount")
            if total is None:
                continue
            fail = action.get("failCount") or 0
            skip = action.get("skipCount") or 0
            try:
                return (int(total), int(fail), int(skip))
            except (TypeError, ValueError):
                return None
        return None

    def fetch_build_info(
        self,
        job_url: str,
        build_identifier: str = "lastBuild",
    ) -> BuildInfo:
        """Fetch build metadata (number, status, timestamp, duration) for a job.
        Numeric build IDs hit BUILD_CACHE first since completed Jenkins builds are immutable.
        """
        # Cache lookup is only meaningful for numeric build IDs 
        cached_lookup: Optional[BuildInfo] = None
        if build_identifier.isdigit():
            cached_lookup = BUILD_CACHE.get(job_url, int(build_identifier))
            if cached_lookup is not None:
                return cached_lookup

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

            info = BuildInfo(
                build_number=data["number"],
                status=status,
                timestamp=timestamp,
                duration_ms=duration_ms,
            )

            # Memoise on completion so any later lookup by the same
            BUILD_CACHE.put(job_url, info)
            return info

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

    # Legacy in-memory cap
    _CONSOLE_MAX_BYTES = 10 * 1024 * 1024  # 10 MB

    def fetch_console_full(
        self,
        job_url: str,
        build_number: int,
    ) -> str:
        """Return the full console output as a string, capped at 10 MB.
        """
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

    def open_console_stream(
        self,
        job_url: str,
        build_number: int,
        chunk_size: int = 64 * 1024,
    ) -> tuple:
        """Return ``(response, iter_bytes)`` for the full console log.
        """
        url = f"{job_url}/{build_number}/consoleText"
        response = self._request_with_retry("GET", url, stream=True)

        def _iter():
            try:
                for chunk in response.iter_content(chunk_size=chunk_size, decode_unicode=False):
                    if chunk:
                        yield chunk
            except Exception as exc:
                # Stream began but the wire dropped — surface it as a
                # visible footer so the user knows the log is incomplete.
                msg = "\n\n[stream interrupted: {}]\n".format(str(exc) or type(exc).__name__)
                yield msg.encode("utf-8", errors="replace")
            finally:
                try:
                    response.close()
                except Exception:
                    pass

        return response, _iter()

    # Rough bytes-per-line for Cucumber/Serenity logs — used to size the tail window.
    _AVG_BYTES_PER_LINE = 160

    def _fetch_console_progressive(
        self,
        job_url: str,
        build_number: int,
        start: int,
    ) -> tuple:
        """Hit logText/progressiveText and return (text, x_text_size from header).
        Single seam used by fetch_console_tail.
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
        """Return roughly the last `lines` lines of the console log.
        Reads X-Text-Size on the first call and only issues a second offset request if needed.
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
        """Fetch up to `count` builds for a job in one round-trip.
        field="builds" is the cheap in-memory cache (~30); "allBuilds" walks full history.
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
        """Find the newest SUCCESS within `depth` builds via one ?tree=allBuilds query.
        Much cheaper than find_last_passed_build's per-build walk.
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
        """Walk backwards one build at a time looking for SUCCESS — slow but precise.
        Kept for callers needing an exact stopping point; 404s are skipped silently.
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
        """Lazily fetch and cache the Jenkins CSRF crumb header required by Jenkins >=2.176.
        Returns {} when CSRF is disabled or unreachable so POSTs aren't blocked by crumb failures.
        """
        if self._crumb is not None:
            return self._crumb

        try:
            url = f"{self.base_url}/crumbIssuer/api/json"
            # Direct call to avoid recursing through _request_with_retry.
            response = self.session.get(url, timeout=self.timeout, allow_redirects=False)
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
        """HTTP request with exponential backoff on timeouts / 5xx; 4xx returns immediately.
        Mutating methods get a CSRF crumb attached; redirects are never followed to protect creds.
        """
        last_exception = None

        if method.upper() in ("POST", "PUT", "DELETE", "PATCH"):
            crumb_headers = self._get_crumb()
            if crumb_headers:
                merged = dict(kwargs.get("headers") or {})
                merged.update(crumb_headers)
                kwargs["headers"] = merged

        # Caller cannot opt into redirect-follow on credentialed calls.
        kwargs["allow_redirects"] = False

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
