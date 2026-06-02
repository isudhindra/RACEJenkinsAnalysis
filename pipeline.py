
import re
from typing import Callable, Dict, List, Optional, Tuple
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

import yaml

from models import (
    JobRecord,
    BuildInfo,
    BuildStatus,
    HealthState,
    TestMetrics,
    ThreeRunContext,
    SSEEvent,
    SSEEventType,
    StageCompletion,
    DataCompleteness,
    ConfidenceLevel,
    FailureEvidence,
    ErrorLogEntry,
    ClassificationResult,
    AnalysisLabel,
    RuleDefinition,
    SecondaryHint,
)
from jenkins_client import JenkinsClient, JenkinsClientError


# ============================================================================
# CLASSIFICATION ENGINE
# ============================================================================

class Classifier:
    """Deterministic rule-based classifier for Jenkins failure logs."""

    def __init__(self, rules_path: str = "rules.yaml") -> None:
        """
        Initialize the classifier.

        Args:
            rules_path: Path to the YAML file containing classification rules.

        Raises:
            FileNotFoundError: If rules file does not exist.
            ValueError: If rules file is invalid or contains missing required fields.
        """
        self.rules: List[RuleDefinition] = []
        self.fallback_labels: Dict[str, str] = {}
        self.domain_colors: Dict[str, str] = {}
        self._compiled_patterns: dict = {}

        self._load_rules_file(rules_path)

        # Pre-compile regex patterns for each rule
        for rule in self.rules:
            self._compiled_patterns[rule.name] = [
                re.compile(pattern) for pattern in rule.patterns
            ]

    def classify(self, console_text: str) -> ClassificationResult:
        """
        Classify a Jenkins failure using the deterministic pipeline.

        Step 1: Normalize log
        Step 2: Evaluate rules in priority order
        Step 3: Assign primary classification (first match)
        Step 4: Find secondary hint (first match with different domain)
        Step 5: Determine confidence level

        Args:
            console_text: Raw console log output from Jenkins.

        Returns:
            ClassificationResult with all fields populated.
            If no matches: confidence=UNKNOWN, domain="Unknown", action="Manual investigation needed".
        """
        # Handle empty/None input
        if not console_text or not console_text.strip():
            fallback_label = self.fallback_labels.get("no_console_log", "No Console Data")
            return ClassificationResult(
                primary_domain="Unknown",
                subcategory="No Data",
                impact="Inconclusive",
                confidence=ConfidenceLevel.UNKNOWN,
                matched_rule_name="",
                matched_pattern="",
                evidence_snippet="",
                action="Manual investigation needed — no console log available",
                label=fallback_label,
                all_labels=[AnalysisLabel(label=fallback_label, domain="Unknown", action="", rule_name="")],
            )

        # Step 1: Normalize log
        normalized = self._normalize_log(console_text)

        # Step 2: Evaluate rules
        matches = self._evaluate_rules(normalized)

        # If no matches, return UNKNOWN
        if not matches:
            fallback_label = self.fallback_labels.get("no_pattern_match", "Unclassified Failure")
            return ClassificationResult(
                primary_domain="Unknown",
                subcategory="No Pattern Match",
                impact="Inconclusive",
                confidence=ConfidenceLevel.UNKNOWN,
                matched_rule_name="",
                matched_pattern="",
                evidence_snippet="",
                action="Manual investigation needed — no rule pattern matched the failure",
                label=fallback_label,
                all_labels=[AnalysisLabel(label=fallback_label, domain="Unknown", action="", rule_name="")],
            )

        # Step 3: Primary classification (first match by priority)
        primary_rule, primary_pattern_str, primary_line_num = matches[0]

        # Step 4: Secondary hint (first match with different domain)
        secondary_hint: Optional[SecondaryHint] = None
        if len(matches) > 1:
            for rule, pattern_str, line_num in matches[1:]:
                if rule.domain != primary_rule.domain:
                    secondary_hint = SecondaryHint(
                        domain=rule.domain,
                        subcategory=rule.subcategory,
                        matched_rule_name=rule.name,
                    )
                    break

        # Step 5: Determine confidence
        confidence = self._determine_confidence(
            primary_rule, matches, primary_pattern_str
        )

        # Extract evidence snippet
        evidence = self._extract_evidence(normalized, primary_line_num, context_lines=5)

        # Step 6: Build multi-label aggregation from ALL matched rules.
        # Deduplicate by label text; exclude the generic catch-all rule
        # ("generic_exception") if more specific rules matched.
        all_labels: List[AnalysisLabel] = []
        seen_labels: set = set()
        has_specific = any(r.name != "generic_exception" for r, _, _ in matches)

        for rule, _, _ in matches:
            # Skip generic catch-all when specific matches exist
            if has_specific and rule.name == "generic_exception":
                continue
            lbl = rule.label or rule.subcategory
            if lbl not in seen_labels:
                seen_labels.add(lbl)
                all_labels.append(AnalysisLabel(
                    label=lbl,
                    domain=rule.domain,
                    action=rule.action,
                    rule_name=rule.name,
                ))

        return ClassificationResult(
            primary_domain=primary_rule.domain,
            subcategory=primary_rule.subcategory,
            impact=primary_rule.impact,
            confidence=confidence,
            matched_rule_name=primary_rule.name,
            matched_pattern=primary_pattern_str,
            evidence_snippet=evidence,
            action=primary_rule.action,
            label=primary_rule.label or primary_rule.subcategory,
            secondary_hint=secondary_hint,
            all_labels=all_labels,
        )

    def _normalize_log(self, raw_text: str) -> str:
        """
        Normalize log text by removing formatting artifacts.

        Sequential cleaning steps:
        1. Strip ANSI escape sequences
        2. Remove ISO 8601 timestamps
        3. Remove Unix epoch timestamps
        4. Remove thread identifiers
        5. Remove log level markers (case-insensitive)
        6. Collapse horizontal whitespace
        7. Strip leading/trailing whitespace

        Args:
            raw_text: Raw console output.

        Returns:
            Normalized text with semantic content preserved.
        """
        text = raw_text

        # Step 1: Strip ANSI escape sequences and color codes
        text = re.sub(r"\x1b\[[0-9;]*m|\x1b\(B", "", text)

        # Step 2: Remove ISO 8601 timestamps
        text = re.sub(
            r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?",
            "",
            text,
        )

        # Step 3: Remove Unix epoch timestamps (10 or 13 digit)
        text = re.sub(r"\b\d{10}\b|\b\d{13}\b", "", text)

        # Step 4: Remove thread identifiers [tid:xxx], [t:xxx], [thread:xxx], etc.
        text = re.sub(
            r"\[(?:tid|thread|t|thr)[:=]?[\w\-]+\]", "", text, flags=re.IGNORECASE
        )

        # Step 5: Remove log level markers (case-insensitive)
        text = re.sub(
            r"\[(DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL|TRACE)\]",
            "",
            text,
            flags=re.IGNORECASE,
        )

        # Step 6: Collapse horizontal whitespace (preserve newlines)
        text = re.sub(r"[ \t]+", " ", text)

        # Step 7: Strip leading/trailing whitespace
        text = text.strip()

        return text

    def _evaluate_rules(
        self, normalized_text: str
    ) -> List[Tuple[RuleDefinition, str, int]]:
        """
        Evaluate all rules in priority order.

        For each rule, test each pre-compiled pattern via pattern.search().
        On first match within a rule: record (rule, pattern_string, line_number), break to next rule.
        Collect ALL matching rules (not just first) for secondary hint detection.

        Args:
            normalized_text: Normalized log text.

        Returns:
            List of (RuleDefinition, matched_pattern_str, match_line_number) tuples,
            ordered by rule priority. Empty list if no matches.
        """
        matches: List[Tuple[RuleDefinition, str, int]] = []

        for rule in self.rules:
            patterns = self._compiled_patterns.get(rule.name, [])
            for compiled_pattern in patterns:
                match = compiled_pattern.search(normalized_text)
                if match:
                    # Determine line number of the match
                    line_num = normalized_text[: match.start()].count("\n")
                    # Record match and break to next rule
                    matches.append((rule, match.group(0), line_num))
                    break

        return matches

    def _extract_evidence(
        self, normalized_text: str, match_line: int, context_lines: int = 5
    ) -> str:
        """
        Extract evidence snippet around the matched line.

        Args:
            normalized_text: Normalized log text.
            match_line: Line number of the match.
            context_lines: Number of lines above and below to include.

        Returns:
            Evidence snippet as a string. Empty string if match_line is invalid.
        """
        lines = normalized_text.split("\n")

        if match_line < 0 or match_line >= len(lines):
            return ""

        start = max(0, match_line - context_lines)
        end = min(len(lines), match_line + context_lines + 1)

        evidence_lines = lines[start:end]
        return "\n".join(evidence_lines)

    def _determine_confidence(
        self, primary: RuleDefinition, all_matches: List, pattern: str
    ) -> ConfidenceLevel:
        """
        Determine confidence level for the classification.

        Rules:
        - No matches → UNKNOWN
        - Single domain matched AND len(pattern) > 15 → STRONG
        - Multiple domains matched OR len(pattern) <= 15 → PARTIAL
        - 3+ distinct domains matched → PARTIAL (forced)
        - 4+ rules spanning 3+ domains AND primary.priority > 50 → UNKNOWN

        Args:
            primary: The primary matched rule.
            all_matches: All matched rules.
            pattern: The matched pattern string.

        Returns:
            ConfidenceLevel.STRONG, PARTIAL, or UNKNOWN.
        """
        # No matches
        if not all_matches:
            return ConfidenceLevel.UNKNOWN

        # Count distinct domains in all matches
        domains = set(rule.domain for rule, _, _ in all_matches)
        num_domains = len(domains)

        # 3+ distinct domains matched → forced PARTIAL
        if num_domains >= 3:
            return ConfidenceLevel.PARTIAL

        # Single domain matched AND pattern is specific (> 15 chars) → STRONG
        if num_domains == 1 and len(pattern) > 15:
            return ConfidenceLevel.STRONG

        # Multiple domains OR generic pattern → PARTIAL
        return ConfidenceLevel.PARTIAL

    def _load_rules_file(self, rules_path: str) -> None:
        """
        Load and validate classification rules, fallback labels, and domain
        colors from the YAML rules file.  Populates self.rules,
        self.fallback_labels, and self.domain_colors.

        Args:
            rules_path: Path to the YAML rules file.

        Raises:
            FileNotFoundError: If rules file does not exist.
            ValueError: If YAML is invalid or rules have missing required fields.
        """
        try:
            with open(rules_path, "r") as f:
                data = yaml.safe_load(f)
        except FileNotFoundError:
            raise FileNotFoundError(f"Rules file not found: {rules_path}")
        except yaml.YAMLError as e:
            raise ValueError(f"Invalid YAML in rules file: {e}")

        if not data or "rules" not in data:
            raise ValueError("Rules file must contain a 'rules' key with a list value")

        # Load optional top-level configuration sections
        self.fallback_labels = data.get("fallback_labels", {})
        self.domain_colors = data.get("domain_colors", {})

        rules_data = data.get("rules", [])
        if not isinstance(rules_data, list):
            raise ValueError("'rules' key must contain a list")

        rules: List[RuleDefinition] = []

        for idx, rule_dict in enumerate(rules_data):
            # Validate required fields
            required_fields = [
                "name",
                "priority",
                "domain",
                "subcategory",
                "impact",
                "patterns",
                "action",
            ]
            for fld in required_fields:
                if fld not in rule_dict:
                    raise ValueError(
                        f"Rule at index {idx} missing required field: {fld}"
                    )

            # Validate field types and values
            if not isinstance(rule_dict["name"], str):
                raise ValueError(f"Rule {idx}: 'name' must be a string")
            if not isinstance(rule_dict["priority"], int) or rule_dict["priority"] < 0:
                raise ValueError(f"Rule {idx}: 'priority' must be a non-negative integer")
            if not isinstance(rule_dict["domain"], str):
                raise ValueError(f"Rule {idx}: 'domain' must be a string")
            if not isinstance(rule_dict["subcategory"], str):
                raise ValueError(f"Rule {idx}: 'subcategory' must be a string")
            if not isinstance(rule_dict["impact"], str):
                raise ValueError(f"Rule {idx}: 'impact' must be a string")
            if not isinstance(rule_dict["patterns"], list) or not rule_dict["patterns"]:
                raise ValueError(f"Rule {idx}: 'patterns' must be a non-empty list")
            if not isinstance(rule_dict["action"], str):
                raise ValueError(f"Rule {idx}: 'action' must be a string")

            # Validate patterns are strings and compile them to check for regex errors
            for pidx, pattern_str in enumerate(rule_dict["patterns"]):
                if not isinstance(pattern_str, str):
                    raise ValueError(
                        f"Rule {idx} pattern {pidx}: pattern must be a string"
                    )
                try:
                    re.compile(pattern_str)
                except re.error as e:
                    raise ValueError(
                        f"Rule {idx} pattern {pidx}: invalid regex: {e}"
                    )

            # Get optional fields
            scope = rule_dict.get("scope", "global")
            if not isinstance(scope, str):
                raise ValueError(f"Rule {idx}: 'scope' must be a string")

            label = rule_dict.get("label", "")
            if not isinstance(label, str):
                raise ValueError(f"Rule {idx}: 'label' must be a string")

            rule = RuleDefinition(
                name=rule_dict["name"],
                priority=rule_dict["priority"],
                domain=rule_dict["domain"],
                subcategory=rule_dict["subcategory"],
                impact=rule_dict["impact"],
                patterns=rule_dict["patterns"],
                action=rule_dict["action"],
                label=label,
                scope=scope,
            )
            rules.append(rule)

        # Sort by priority ascending (lower priority number = higher precedence)
        rules.sort(key=lambda r: r.priority)

        self.rules = rules


# ============================================================================
# CONSOLE PARSERS
# ============================================================================

# Regex for Maven/Surefire-style test summary lines:
# [INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 0
# [ERROR] Tests run: 5, Failures: 1, Errors: 1, Skipped: 1
# Also matches without log-level prefix (bare summary lines).
_TEST_SUMMARY_RE = re.compile(
    r"Tests\s+run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)",
    re.IGNORECASE,
)


def parse_console_test_metrics(console_text: str) -> Optional[TestMetrics]:
    """
    Parse console output for test summary metrics.

    Scans the full console text for Maven/Surefire-style test summary lines.
    If multiple matches exist, uses the LAST valid match (deterministic rule:
    the final summary is the aggregate).

    Args:
        console_text: Raw console log output from Jenkins.

    Returns:
        TestMetrics with extracted counts if a summary line is found;
        None if no summary line is detected.
    """
    if not console_text:
        return None

    matches = list(_TEST_SUMMARY_RE.finditer(console_text))
    if not matches:
        return None

    # Use the last match — in Maven output, the final summary is the aggregate
    last = matches[-1]
    tests_run = int(last.group(1))
    failures = int(last.group(2))
    errors = int(last.group(3))
    skipped = int(last.group(4))
    passed = max(0, tests_run - failures - errors - skipped)

    return TestMetrics(
        total=tests_run,
        passed=passed,
        failed=failures,
        errors=errors,
        skipped=skipped,
        duration_seconds=None,
        metrics_source="console",
        metrics_unavailable=False,
    )


# Regex for error-level log lines: [ERROR], [FATAL], [SEVERE], or ERROR: prefix
_ERROR_LINE_RE = re.compile(
    r"^\s*(?:\[(?:ERROR|FATAL|SEVERE)\]|ERROR:|FATAL:)\s*(.+)",
    re.MULTILINE | re.IGNORECASE,
)

# Patterns that hint at the build phase / step where the failure occurred
_FAILURE_PHASE_PATTERNS = [
    (re.compile(r"\[INFO\]\s+---\s+(\S+):(\S+)\s+\(([^)]+)\)", re.IGNORECASE), "maven_plugin"),
    (re.compile(r"(?:FAILURE|FAILED).*?in\s+(?:phase|step|stage)\s+['\"]?(\S+)", re.IGNORECASE), "phase_mention"),
    (re.compile(r"Build step '([^']+)' (?:marked|changed)", re.IGNORECASE), "build_step"),
    (re.compile(r"(?:Compilation|Compile)\s+(?:failure|error)", re.IGNORECASE), "compile"),
    (re.compile(r"(?:Test|Tests)\s+(?:failure|failed)", re.IGNORECASE), "test"),
    (re.compile(r"(?:Deploy|Deployment)\s+(?:failure|failed|error)", re.IGNORECASE), "deploy"),
    (re.compile(r"(?:Checkout|SCM|Git)\s+(?:failure|failed|error)", re.IGNORECASE), "scm"),
]


def extract_error_logs(
    console_text: str,
    max_entries: int = 50,
    context_lines: int = 1,
) -> FailureEvidence:
    """
    Extract error-oriented log lines from console output.

    Scans the console for lines matching failure-oriented patterns ([ERROR],
    [FATAL], [SEVERE], ERROR:, FATAL:). Collects up to max_entries matched
    lines, each with optional preceding context line for additional clarity.
    Also infers the failure step/phase/context where possible.

    This function should ONLY be called for non-passing jobs. Passed jobs
    should not undergo failure-log extraction.

    Args:
        console_text: Raw console log output from Jenkins.
        max_entries: Maximum number of error log entries to extract (default: 50).
        context_lines: Number of lines before each error to capture as context (default: 1).

    Returns:
        FailureEvidence with error_logs, error_count, and failure_context populated.
    """
    if not console_text:
        return FailureEvidence(error_logs=[], error_count=0, failure_context=None)

    lines = console_text.split("\n")
    error_entries: list[ErrorLogEntry] = []

    for line_idx, line in enumerate(lines):
        match = _ERROR_LINE_RE.match(line)
        if match:
            message = match.group(1).strip()
            if not message:
                continue

            # Determine the log level from the prefix
            line_upper = line.strip().upper()
            if "[FATAL]" in line_upper or "FATAL:" in line_upper:
                level = "FATAL"
            elif "[SEVERE]" in line_upper or "SEVERE:" in line_upper:
                level = "SEVERE"
            else:
                level = "ERROR"

            # Capture preceding context line(s)
            ctx_start = max(0, line_idx - context_lines)
            context_before = None
            if ctx_start < line_idx:
                ctx_lines = lines[ctx_start:line_idx]
                context_before = "\n".join(ctx_lines).strip() or None

            entry = ErrorLogEntry(
                line_number=line_idx + 1,  # 1-indexed
                message=message,
                level=level,
                context_before=context_before,
            )
            error_entries.append(entry)

            if len(error_entries) >= max_entries:
                break

    # Infer failure context / step
    failure_context = _infer_failure_context(console_text)

    return FailureEvidence(
        error_logs=error_entries,
        error_count=len(error_entries),
        failure_context=failure_context,
    )


def _infer_failure_context(console_text: str) -> Optional[str]:
    """
    Best-effort identification of the build phase or step where the failure occurred.

    Scans the console for phase/step markers. Uses the LAST match (closest to
    the failure point in log output) as the most relevant context.

    Args:
        console_text: Raw console log output.

    Returns:
        A human-readable string identifying the failure phase/step, or None
        if no phase markers are detected.
    """
    last_match_text = None

    for pattern, phase_type in _FAILURE_PHASE_PATTERNS:
        matches = list(pattern.finditer(console_text))
        if not matches:
            continue

        m = matches[-1]  # Last match is closest to the failure

        if phase_type == "maven_plugin":
            plugin = m.group(1)
            goal = m.group(2)
            execution = m.group(3)
            last_match_text = f"Maven plugin {plugin}:{goal} ({execution})"
        elif phase_type == "build_step":
            last_match_text = f"Build step: {m.group(1)}"
        elif phase_type == "phase_mention":
            last_match_text = f"Phase: {m.group(1)}"
        elif phase_type == "compile":
            last_match_text = "Compilation phase"
        elif phase_type == "test":
            last_match_text = "Test execution phase"
        elif phase_type == "deploy":
            last_match_text = "Deployment phase"
        elif phase_type == "scm":
            last_match_text = "SCM / Checkout phase"

        # Don't break — keep scanning for later patterns that may be more specific

    return last_match_text


# ============================================================================
# ANALYSIS ORCHESTRATOR
# ============================================================================

class AnalysisOrchestrator:
    """
    Orchestrates the two-stage analysis pipeline for Jenkins jobs.

    Manages concurrent job processing via ThreadPoolExecutor and streams
    results via callback events (SSE).

    Stage 1: Parallel metadata fetch for ALL jobs.
    Stage 2: Parallel deep analysis (console fetch + classification) for FAILED/UNSTABLE only.
    """

    def __init__(
        self,
        client: JenkinsClient,
        classifier: Classifier,
        max_workers: int = 15,
        promotion_time: Optional[datetime] = None,
    ) -> None:
        """
        Initialize the AnalysisOrchestrator.

        Args:
            client: JenkinsClient instance for API interactions.
            classifier: Classifier instance for failure classification.
            max_workers: Maximum number of worker threads (default: 15).
            promotion_time: Optional release-promotion cutoff. When set, every
                JobRecord serialized by this orchestrator's SSE callbacks will
                include a ``release_status`` field derived from this time.
                Threaded through ``to_dict(promotion_time=...)`` so there is
                exactly one place that knows the release-validation rule.
        """
        self.client = client
        self.classifier = classifier
        self.max_workers = max_workers
        self.promotion_time = promotion_time
        # Internal record store — maps job_url to JobRecord for Stage 2 access
        self._records: Dict[str, JobRecord] = {}

    def run_stage_1(
        self,
        jobs: List[dict],
        operation_id: str,
        on_result: Callable[[SSEEvent], None],
    ) -> List[JobRecord]:
        """
        Parallel metadata fetch for all jobs.

        Executes Stage 1 (metadata collection) for all provided jobs concurrently.
        Streams results via SSE callbacks.

        Args:
            jobs: List of {"name": str, "url": str} dicts from Mode A or B.
            operation_id: Unique operation ID for this fetch batch.
            on_result: Callback invoked with JOB_METADATA, JOB_ERROR, and
                       PROGRESS_UPDATE events.

        Returns:
            List of JobRecord objects in completion order. Error records included
            with health_state=FETCH_ERROR.
        """
        results: List[JobRecord] = []

        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            futures = {
                executor.submit(self._process_stage_1_job, job): job
                for job in jobs
            }

            completed_count = 0
            total_count = len(jobs)

            for future in as_completed(futures):
                job = futures[future]

                try:
                    record = future.result()
                    results.append(record)
                    self._records[record.job_url] = record

                    # Emit JOB_METADATA event
                    metadata_event = SSEEvent(
                        event_type=SSEEventType.JOB_METADATA,
                        job_id=record.job_url,
                        operation_id=operation_id,
                        payload=record.to_dict(promotion_time=self.promotion_time),
                    )
                    on_result(metadata_event)

                except Exception as e:
                    error_record = JobRecord(
                        job_name=job.get("name", "Unknown"),
                        job_url=job.get("url", ""),
                        health_state=HealthState.FETCH_ERROR,
                        error_message=f"Stage 1 fetch failed: {str(e)}",
                        last_refreshed_at=datetime.now(),
                        data_completeness=DataCompleteness.FETCH_ERROR,
                    )
                    results.append(error_record)
                    self._records[error_record.job_url] = error_record

                    # Emit JOB_ERROR event
                    error_event = SSEEvent(
                        event_type=SSEEventType.JOB_ERROR,
                        job_id=error_record.job_url,
                        operation_id=operation_id,
                        payload={
                            "job_name": error_record.job_name,
                            "job_url": error_record.job_url,
                            "error_message": error_record.error_message,
                        },
                    )
                    on_result(error_event)

                # Emit PROGRESS_UPDATE event after each job completes
                completed_count += 1
                progress_event = SSEEvent(
                    event_type=SSEEventType.PROGRESS_UPDATE,
                    job_id="",
                    operation_id=operation_id,
                    payload={
                        "completed": completed_count,
                        "total": total_count,
                        "stage": "stage_1",
                    },
                )
                on_result(progress_event)

        return results

    def run_stage_2(
        self,
        records: List[JobRecord],
        operation_id: str,
        on_result: Callable[[SSEEvent], None],
    ) -> List[JobRecord]:
        """
        Parallel deep analysis for FAILED/UNSTABLE jobs only.

        Executes Stage 2 (console fetch + classification) for jobs with
        failed/unstable status. Mutates records in-place.

        Args:
            records: List of JobRecord objects to analyze. Only FAILED/UNSTABLE
                     records are processed; others are returned unchanged.
            operation_id: Unique operation ID for this refresh batch.
            on_result: Callback invoked with JOB_ENRICHED and PROGRESS_UPDATE events.

        Returns:
            Updated JobRecord objects (mutated in-place).
        """
        # Filter to FAILED/UNSTABLE jobs only
        failed_records = [
            r for r in records
            if r.health_state in (HealthState.FAILED, HealthState.UNSTABLE)
        ]

        if not failed_records:
            return records

        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            futures = {
                executor.submit(self._process_stage_2_job, record): record
                for record in failed_records
            }

            completed_count = 0
            total_count = len(failed_records)

            for future in as_completed(futures):
                record = futures[future]

                try:
                    # _process_stage_2_job mutates record in-place
                    future.result()
                except Exception as e:
                    # On error, keep classification as None
                    record.classification = None
                    record.error_message = f"Stage 2 classification failed: {str(e)}"

                # Emit JOB_ENRICHED event
                enriched_event = SSEEvent(
                    event_type=SSEEventType.JOB_ENRICHED,
                    job_id=record.job_url,
                    operation_id=operation_id,
                    payload=record.to_dict(promotion_time=self.promotion_time),
                )
                on_result(enriched_event)

                # Emit PROGRESS_UPDATE event
                completed_count += 1
                progress_event = SSEEvent(
                    event_type=SSEEventType.PROGRESS_UPDATE,
                    job_id="",
                    operation_id=operation_id,
                    payload={
                        "completed": completed_count,
                        "total": total_count,
                        "stage": "stage_2",
                    },
                )
                on_result(progress_event)

        return records

    def analyze_single_job(
        self,
        job_url: str,
        job_name: str,
    ) -> JobRecord:
        """
        Synchronous Stage 1 + Stage 2 for a single job.

        Used for on-demand analysis. Blocks caller until both stages complete.

        Args:
            job_url: Full URL to the Jenkins job.
            job_name: Name of the Jenkins job.

        Returns:
            Complete JobRecord with classification (if failed/unstable).

        Raises:
            JenkinsClientError: On unrecoverable fetch errors.
        """
        # Stage 1: Fetch metadata
        job = {"name": job_name, "url": job_url}
        record = self._process_stage_1_job(job)

        # Stage 2: Classify if failed/unstable
        if record.health_state in (HealthState.FAILED, HealthState.UNSTABLE):
            self._process_stage_2_job(record)

        return record

    def _process_stage_1_job(self, job: dict) -> JobRecord:
        """
        Per-job Stage 1 logic (metadata collection + console metric extraction).

        Runs in ThreadPoolExecutor worker. Fetches latest build info, test metrics
        (API first, then console fallback), previous build info, and last passing
        build. For EVERY job, if the Jenkins test report API does not provide
        metrics, the console output is fetched and parsed for Maven/Surefire-style
        test summary lines to extract tests_run, failures, errors, skipped, and
        derived passed count.

        IMPORTANT: Failure-specific console analysis (error-log extraction,
        failure-context inference) is NOT performed here. That processing is
        deferred to Stage 2, which runs only for non-passing jobs (FAILED,
        UNSTABLE, etc.). Passed jobs never undergo failure-log extraction.

        Args:
            job: Dict with "name" and "url" keys.

        Returns:
            JobRecord with Stage 1 fields populated, including enriched
            test_metrics from either the API or console parsing.
            failure_evidence is always None at this stage.

        Raises:
            JenkinsClientError: If fetch_build_info("lastBuild") fails.
        """
        job_name = job.get("name", "Unknown")
        job_url = job.get("url", "")

        # 1. Fetch latest build info (required — propagate error)
        latest = self.client.fetch_build_info(job_url, "lastBuild")

        # 2. Fetch the recent build window UP-FRONT 
        recent_builds = []
        try:
            recent_builds = self.client.fetch_recent_builds(job_url, count=3)
        except JenkinsClientError:
            pass  # Silently skip — context will be partial

        # Derive ``previous`` from the recent window — first non-latest entry.
        previous = None
        for rb in recent_builds:
            if rb.build_number == latest.build_number:
                continue
            previous = rb
            break

        # First COMPLETED previous build
        previous_completed = None
        for rb in recent_builds:
            if rb.build_number == latest.build_number:
                continue
            if rb.status == BuildStatus.IN_PROGRESS:
                continue
            previous_completed = rb
            break

        # 3. Fetch test metrics.  Branch on latest.status:
        test_metrics = None
        metrics_build_number = latest.build_number
        is_in_flight_or_aborted = latest.status in (
            BuildStatus.IN_PROGRESS, BuildStatus.ABORTED,
        )
        if is_in_flight_or_aborted and previous_completed is not None:
            metrics_build_number = previous_completed.build_number
            try:
                test_metrics = self.client.fetch_test_metrics(
                    job_url, previous_completed.build_number,
                )
                if test_metrics is not None:
                    test_metrics.from_previous_build = True
            except JenkinsClientError:
                pass
        console_text = ""
        if test_metrics is None:
            try:
                test_metrics = self.client.fetch_test_metrics(
                    job_url, latest.build_number,
                )
            except JenkinsClientError:
                pass  # Test metrics may not exist

        # Console-fallback parsing (only for terminal builds
        if test_metrics is None and not is_in_flight_or_aborted:
            try:
                console_text = self.client.fetch_console_tail(
                    job_url, latest.build_number, lines=500,
                )
            except JenkinsClientError:
                console_text = ""

            if console_text:
                console_metrics = parse_console_test_metrics(console_text)
                if console_metrics is not None:
                    test_metrics = console_metrics
                else:
                    test_metrics = TestMetrics(
                        metrics_source=None,
                        metrics_unavailable=True,
                    )
            else:
                test_metrics = TestMetrics(
                    metrics_source=None,
                    metrics_unavailable=True,
                )
        elif test_metrics is None:
            # In-progress / aborted with no previous completed build
            test_metrics = TestMetrics(
                metrics_source=None,
                metrics_unavailable=True,
            )

        # Find ``last_passed`` deterministically: if the latest run is itself
        # a SUCCESS, that's it; otherwise scan the recent window first (cheap)
        # and fall back to a single allBuilds{0,50} query so jobs whose last
        # green is older than the 3-run window still resolve correctly.
        last_passed = None
        if latest.status == BuildStatus.SUCCESS:
            last_passed = latest
        else:
            for rb in recent_builds:
                if rb.status == BuildStatus.SUCCESS:
                    last_passed = rb
                    break
            if last_passed is None:
                try:
                    last_passed = self.client.fetch_last_passed(job_url, depth=50)
                except JenkinsClientError:
                    pass  # Silently skip — last_passed stays None

        # 5. Construct ThreeRunContext (backwards-compatible)
        context = ThreeRunContext(
            latest=latest,
            previous=previous,
            last_passed=last_passed,
        )

        # 7. Determine health state
        health_state = self._determine_health_state(context)

        # 8. Determine data completeness
        data_completeness = self._determine_data_completeness(
            test_metrics=test_metrics,
            previous=previous,
            last_passed=last_passed,
        )

        # 9. Create JobRecord with enriched test_metrics
        #    failure_evidence is intentionally None — it will only be populated
        #    in Stage 2 for non-passing jobs.
        record = JobRecord(
            job_name=job_name,
            job_url=job_url,
            current_status=latest.status,
            three_run_context=context,
            test_metrics=test_metrics,
            health_state=health_state,
            last_refreshed_at=datetime.now(),
            stage=StageCompletion.STAGE_1,
            data_completeness=data_completeness,
            failure_evidence=None,
            recent_builds=recent_builds,
        )

        # Store console text on record for potential Stage 2 reuse
        record._console_text = console_text

        return record

    def _process_stage_2_job(self, record: JobRecord) -> JobRecord:
        """
        Per-job Stage 2 logic (console fetch + classification + error-log
        extraction + console metrics enrichment).

        Runs in ThreadPoolExecutor worker. Only invoked for non-passing jobs
        (FAILED, UNSTABLE, etc.). Fetches console output (or reuses console
        text cached by Stage 1), classifies the failure, extracts [ERROR]
        log lines with context, infers the failure step/phase, and enriches
        test metrics from console if Stage 1 did not already provide them.

        Passed jobs never reach this method — they are filtered out by
        run_stage_2(). Mutates record in-place.

        Args:
            record: JobRecord from Stage 1 (mutated in-place).

        Returns:
            Mutated record with classification, failure_evidence, and
            console-derived metrics populated.
        """
        try:
            # 1. Reuse console text from Stage 1 if available, otherwise fetch
            console_text = getattr(record, '_console_text', None) or ""
            if not console_text:
                try:
                    console_text = self.client.fetch_console_tail(
                        record.job_url,
                        record.three_run_context.latest.build_number,
                        lines=500,
                    )
                except JenkinsClientError:
                    console_text = ""
                    # Update data_completeness to reflect missing console
                    if record.data_completeness == DataCompleteness.COMPLETE:
                        record.data_completeness = DataCompleteness.PARTIAL

            # 2. Classify
            try:
                classification_result = self.classifier.classify(console_text)
                record.classification = classification_result
            except Exception:
                record.classification = None

            # 3. Extract error logs and failure context (failure-specific analysis)
            #    This ONLY runs for non-passing jobs — passed jobs never enter
            #    _process_stage_2_job, so no wasted overhead.
            if console_text:
                record.failure_evidence = extract_error_logs(console_text)
            else:
                record.failure_evidence = FailureEvidence(
                    error_logs=[], error_count=0, failure_context=None,
                )

            # 4. Enrich test metrics from console if Stage 1 didn't already
            #    provide real metrics (i.e. metrics_unavailable is True or
            #    test_metrics is still None)
            needs_console_metrics = (
                record.test_metrics is None
                or record.test_metrics.metrics_unavailable
            )
            if needs_console_metrics and console_text:
                console_metrics = parse_console_test_metrics(console_text)
                if console_metrics is not None:
                    record.test_metrics = console_metrics
                elif record.test_metrics is None:
                    record.test_metrics = TestMetrics(
                        metrics_source=None,
                        metrics_unavailable=True,
                    )
            elif record.test_metrics is None:
                record.test_metrics = TestMetrics(
                    metrics_source=None,
                    metrics_unavailable=True,
                )

            # 5. Update stage
            record.stage = StageCompletion.STAGE_2

        except Exception as e:
            record.error_message = f"Stage 2 processing failed: {str(e)}"

        return record

    def _determine_health_state(self, context: ThreeRunContext) -> HealthState:
        """
        Map build status to health state.

        Args:
            context: ThreeRunContext containing latest build info.

        Returns:
            HealthState enum value.
        """
        status = context.latest.status

        if status == BuildStatus.SUCCESS:
            return HealthState.PASSED
        elif status == BuildStatus.FAILURE:
            return HealthState.FAILED
        elif status == BuildStatus.UNSTABLE:
            return HealthState.UNSTABLE
        elif status == BuildStatus.ABORTED:
            return HealthState.ABORTED
        else:
            return HealthState.UNKNOWN

    def _determine_data_completeness(
        self,
        test_metrics=None,
        previous=None,
        last_passed=None,
    ) -> DataCompleteness:
        """
        Determine data completeness level based on available fields.

        Returns:
            DataCompleteness enum value.
        """
        if test_metrics is not None and previous is not None and last_passed is not None:
            return DataCompleteness.COMPLETE
        if test_metrics is not None or previous is not None or last_passed is not None:
            return DataCompleteness.PARTIAL
        return DataCompleteness.MINIMAL
