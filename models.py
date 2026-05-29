"""
Data models and enumerations for the Jenkins Failure Analysis Tool.
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional


# ============================================================================
# ENUMERATIONS
# ============================================================================

class BuildStatus(str, Enum):
    """Status of a Jenkins build."""
    SUCCESS = "SUCCESS"
    FAILURE = "FAILURE"
    UNSTABLE = "UNSTABLE"
    ABORTED = "ABORTED"
    NOT_BUILT = "NOT_BUILT"
    IN_PROGRESS = "IN_PROGRESS"
    UNKNOWN = "UNKNOWN"


class HealthState(str, Enum):
    """Health state of a Jenkins job."""
    PASSED = "PASSED"
    FAILED = "FAILED"
    UNSTABLE = "UNSTABLE"
    ABORTED = "ABORTED"
    UNKNOWN = "UNKNOWN"
    FETCH_ERROR = "FETCH_ERROR"


class ConfidenceLevel(str, Enum):
    """Confidence level for classification results."""
    STRONG = "Strong"
    PARTIAL = "Partial"
    UNKNOWN = "Unknown"


class SSEEventType(str, Enum):
    """Types of Server-Sent Events."""
    JOB_METADATA = "JOB_METADATA"
    JOB_ENRICHED = "JOB_ENRICHED"
    JOB_ERROR = "JOB_ERROR"
    PROGRESS_UPDATE = "PROGRESS_UPDATE"
    FETCH_COMPLETE = "FETCH_COMPLETE"


class StageCompletion(str, Enum):
    """Data completion stages."""
    STAGE_1 = "STAGE_1"
    STAGE_2 = "STAGE_2"


class DataCompleteness(str, Enum):
    """Level of data completeness for a job record."""
    COMPLETE = "COMPLETE"
    PARTIAL = "PARTIAL"
    MINIMAL = "MINIMAL"
    FETCH_ERROR = "FETCH_ERROR"


class ReleaseStatus(str, Enum):
    """
    Validation status of a job against a release promotion time.

    PASS    — at least one run after promotion_time succeeded. Latched —
              a later failure does not flip this back.
    PENDING — promotion_time is set but no run has occurred after it yet.
    FAIL    — runs occurred after promotion_time and none succeeded.
    NA      — no promotion_time was provided (release validation disabled).
    """
    PASS = "PASS"
    PENDING = "PENDING"
    FAIL = "FAIL"
    NA = "NA"


# ============================================================================
# DATACLASSES
# ============================================================================

@dataclass
class BuildInfo:
    """Information about a specific Jenkins build."""
    build_number: int
    status: BuildStatus
    timestamp: datetime
    duration_ms: int = 0


@dataclass
class TestMetrics:
    """Test metrics for a build."""
    total: Optional[int] = None
    passed: Optional[int] = None
    failed: Optional[int] = None
    skipped: Optional[int] = None
    errors: Optional[int] = None
    duration_seconds: Optional[float] = None
    metrics_source: str = "api"
    metrics_unavailable: bool = False


@dataclass
class ThreeRunContext:
    """Context of the latest three runs of a job."""
    latest: BuildInfo
    previous: Optional[BuildInfo] = None
    last_passed: Optional[BuildInfo] = None


@dataclass
class SecondaryHint:
    """Secondary classification hint for a job."""
    domain: str
    subcategory: str
    matched_rule_name: str


@dataclass
class AnalysisLabel:
    """A single analysis label from a matched classification rule."""
    label: str
    domain: str
    action: str
    rule_name: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "label": self.label,
            "domain": self.domain,
            "action": self.action,
            "rule_name": self.rule_name,
        }


@dataclass
class ClassificationResult:
    """Result of classifying a job failure."""
    primary_domain: str
    subcategory: str
    impact: str
    confidence: ConfidenceLevel
    matched_rule_name: str
    matched_pattern: str
    evidence_snippet: str
    action: str
    label: str = ""
    secondary_hint: Optional[SecondaryHint] = None
    all_labels: List["AnalysisLabel"] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to a dictionary suitable for JSON serialization."""
        result = {
            "primary_domain": self.primary_domain,
            "subcategory": self.subcategory,
            "impact": self.impact,
            "confidence": self.confidence.value if isinstance(self.confidence, ConfidenceLevel) else self.confidence,
            "matched_rule_name": self.matched_rule_name,
            "matched_pattern": self.matched_pattern,
            "evidence_snippet": self.evidence_snippet,
            "action": self.action,
            "label": self.label,
            "all_labels": [al.to_dict() for al in self.all_labels],
            "secondary_hint": None,
        }
        if self.secondary_hint is not None:
            result["secondary_hint"] = {
                "domain": self.secondary_hint.domain,
                "subcategory": self.secondary_hint.subcategory,
                "matched_rule_name": self.secondary_hint.matched_rule_name,
            }
        return result


@dataclass
class ErrorLogEntry:
    """A single extracted error-log line with optional context."""
    line_number: Optional[int] = None
    message: str = ""
    level: str = "ERROR"
    context_before: Optional[str] = None


@dataclass
class FailureEvidence:
    """
    Aggregated failure evidence extracted from console output.

    Only populated for non-passing jobs (FAILED, UNSTABLE, ABORTED, etc.).
    Passed jobs will have failure_evidence=None on their JobRecord.
    """
    error_logs: List[ErrorLogEntry] = field(default_factory=list)
    error_count: int = 0
    failure_context: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to a dictionary suitable for JSON serialization."""
        return {
            "error_logs": [
                {
                    "line_number": e.line_number,
                    "message": e.message,
                    "level": e.level,
                    "context_before": e.context_before,
                }
                for e in self.error_logs
            ],
            "error_count": self.error_count,
            "failure_context": self.failure_context,
        }


@dataclass
class JobRecord:
    """Record for a Jenkins job with analysis results."""
    job_name: str
    job_url: str
    current_status: BuildStatus = BuildStatus.UNKNOWN
    three_run_context: Optional[ThreeRunContext] = None
    test_metrics: Optional[TestMetrics] = None
    health_state: HealthState = HealthState.UNKNOWN
    last_refreshed_at: datetime = field(default_factory=datetime.now)
    stage: StageCompletion = StageCompletion.STAGE_1
    data_completeness: DataCompleteness = DataCompleteness.COMPLETE
    classification: Optional[ClassificationResult] = None
    failure_evidence: Optional[FailureEvidence] = None
    recent_builds: Optional[list] = field(default=None, repr=False)
    error_message: Optional[str] = None
    _console_text: Optional[str] = field(default=None, repr=False)

    def compute_release_status(
        self,
        promotion_time: Optional[datetime] = None,
    ) -> "ReleaseStatus":
        """Derive the release-validation status for this job.

        Single source of truth for the "passed after promotion" rule:

        * No ``promotion_time`` → ``NA`` (release validation disabled).
        * No build in ``recent_builds`` is newer than ``promotion_time``
          → ``PENDING`` (the release hasn't been validated yet for this job).
        * Any post-promotion build succeeded → ``PASS`` (latched — later
          failures intentionally do not flip this).
        * Post-promotion builds exist but none succeeded → ``FAIL``.

        Args:
            promotion_time: Cutoff datetime. Only builds with
                ``timestamp > promotion_time`` are considered.

        Returns:
            ReleaseStatus enum value.
        """
        if promotion_time is None:
            return ReleaseStatus.NA

        # Build timestamps in this codebase are always naive (constructed via
        # ``datetime.fromtimestamp(...)`` in jenkins_client).  If a caller
        # hands us a tz-aware ``promotion_time`` (e.g. from a browser that
        # sent an ISO-with-Z string), strip the tz so the comparison below
        # doesn't raise.  Both sides are then interpreted in the same naive
        # timezone — the caller's responsibility to keep them consistent.
        if promotion_time.tzinfo is not None:
            promotion_time = promotion_time.replace(tzinfo=None)

        # Pool every build we know about for this job and dedupe by number.
        # Sources: ``recent_builds`` (last 3) AND the three-run context
        # (latest / previous / last_passed).  ``last_passed`` is critical —
        # it may be older than the recent window but still newer than the
        # promotion cutoff, in which case the job has already passed
        # validation and must NOT be reported as FAIL.
        pool: Dict[int, "BuildInfo"] = {}
        for b in (self.recent_builds or []):
            pool[b.build_number] = b
        if self.three_run_context:
            for b in (self.three_run_context.latest,
                      self.three_run_context.previous,
                      self.three_run_context.last_passed):
                if b is not None:
                    pool.setdefault(b.build_number, b)

        post_promo = [b for b in pool.values() if b.timestamp > promotion_time]
        if not post_promo:
            return ReleaseStatus.PENDING
        if any(b.status == BuildStatus.SUCCESS for b in post_promo):
            return ReleaseStatus.PASS
        return ReleaseStatus.FAIL

    def to_dict(
        self,
        promotion_time: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        """Convert to a dictionary suitable for JSON serialization.

        Args:
            promotion_time: Optional release-promotion cutoff. When provided
                the response includes a ``release_status`` field derived via
                :meth:`compute_release_status`. The ``current_status`` field
                continues to reflect the latest build regardless.
        """
        result = {
            "job_name": self.job_name,
            "job_url": self.job_url,
            "current_status": self.current_status.value if isinstance(self.current_status, BuildStatus) else self.current_status,
            "release_status": self.compute_release_status(promotion_time).value,
            "health_state": self.health_state.value if isinstance(self.health_state, HealthState) else self.health_state,
            "last_refreshed_at": self.last_refreshed_at.isoformat(),
            "stage": self.stage.value if isinstance(self.stage, StageCompletion) else self.stage,
            "data_completeness": self.data_completeness.value if isinstance(self.data_completeness, DataCompleteness) else self.data_completeness,
            "three_run_context": None,
            "test_metrics": None,
            "classification": None,
            "error_message": self.error_message,
        }

        if self.three_run_context is not None:
            result["three_run_context"] = {
                "latest": {
                    "build_number": self.three_run_context.latest.build_number,
                    "status": self.three_run_context.latest.status.value if isinstance(self.three_run_context.latest.status, BuildStatus) else self.three_run_context.latest.status,
                    "timestamp": self.three_run_context.latest.timestamp.isoformat(),
                    "duration_ms": self.three_run_context.latest.duration_ms,
                },
                "previous": None,
                "last_passed": None,
            }
            if self.three_run_context.previous is not None:
                result["three_run_context"]["previous"] = {
                    "build_number": self.three_run_context.previous.build_number,
                    "status": self.three_run_context.previous.status.value if isinstance(self.three_run_context.previous.status, BuildStatus) else self.three_run_context.previous.status,
                    "timestamp": self.three_run_context.previous.timestamp.isoformat(),
                    "duration_ms": self.three_run_context.previous.duration_ms,
                }
            if self.three_run_context.last_passed is not None:
                result["three_run_context"]["last_passed"] = {
                    "build_number": self.three_run_context.last_passed.build_number,
                    "status": self.three_run_context.last_passed.status.value if isinstance(self.three_run_context.last_passed.status, BuildStatus) else self.three_run_context.last_passed.status,
                    "timestamp": self.three_run_context.last_passed.timestamp.isoformat(),
                    "duration_ms": self.three_run_context.last_passed.duration_ms,
                }

        if self.test_metrics is not None:
            result["test_metrics"] = {
                "total": self.test_metrics.total,
                "passed": self.test_metrics.passed,
                "failed": self.test_metrics.failed,
                "skipped": self.test_metrics.skipped,
                "errors": self.test_metrics.errors,
                "duration_seconds": self.test_metrics.duration_seconds,
                "metrics_source": self.test_metrics.metrics_source,
                "metrics_unavailable": self.test_metrics.metrics_unavailable,
            }
        else:
            result["test_metrics"] = {
                "metrics_unavailable": True,
                "metrics_source": None,
            }

        if self.classification is not None:
            result["classification"] = self.classification.to_dict()

        if self.failure_evidence is not None:
            result["failure_evidence"] = self.failure_evidence.to_dict()
        else:
            result["failure_evidence"] = None

        # recent_builds: compact list of the last N builds for release validation
        if self.recent_builds:
            result["recent_builds"] = [
                {
                    "build_number": rb.build_number,
                    "status": rb.status.value if isinstance(rb.status, BuildStatus) else rb.status,
                    "timestamp": rb.timestamp.isoformat(),
                    "duration_ms": rb.duration_ms,
                }
                for rb in self.recent_builds
            ]
        else:
            result["recent_builds"] = []

        return result


@dataclass
class RuleDefinition:
    """Definition of a classification rule."""
    name: str
    priority: int
    domain: str
    subcategory: str
    impact: str
    patterns: List[str]
    action: str
    label: str = ""
    scope: str = "global"


@dataclass
class SSEEvent:
    """Server-Sent Event for streaming analysis results."""
    event_type: SSEEventType
    job_id: str
    operation_id: str
    payload: Dict[str, Any]
