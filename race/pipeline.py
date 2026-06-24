"""The analysis brain of RACE. Loads classifier rules from YAML, fetches build
metadata and console logs in parallel, and turns each Jenkins job into a
labelled JobRecord the dashboard can render.
"""

from __future__ import annotations

import logging
import re
import regex as _regex
_USER_PATTERN_TIMEOUT = 2.0
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from typing import Callable, Dict, List, Optional, Tuple

import yaml

# Single source of truth for concurrent-fetch defaults 
DEFAULT_WORKERS = 24
MIN_WORKERS = 1
MAX_WORKERS = 64

_log = logging.getLogger("jenkins.metrics")
if not _log.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("[%(levelname)s] %(name)s: %(message)s"))
    _log.addHandler(_h)
    _log.setLevel(logging.INFO)
    _log.propagate = False

from race.jenkins_client import JenkinsClient, JenkinsClientError
from race.lib.build_cache import ViewPrefetch
from race.models import (
    AnalysisLabel,
    BuildStatus,
    ClassificationResult,
    ConfidenceLevel,
    DataCompleteness,
    ErrorLogEntry,
    FailureEvidence,
    HealthState,
    JobRecord,
    RuleDefinition,
    SecondaryHint,
    SSEEvent,
    SSEEventType,
    StageCompletion,
    TestMetrics,
    ThreeRunContext,
)


# Log-normalisation regex table
_NORMALIZATION_REGEXES: List[Tuple["re.Pattern", str]] = [
    # ANSI escape sequences and colour codes.
    (re.compile(r"\x1b\[[0-9;]*m|\x1b\(B"), ""),
    # ISO 8601 timestamps.
    (re.compile(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?"), ""),
    # Unix epoch timestamps (10 or 13 digits).
    (re.compile(r"\b\d{10}\b|\b\d{13}\b"), ""),
    # Thread identifiers — [tid:xxx], [thread:xxx], etc.
    (re.compile(r"\[(?:tid|thread|t|thr)[:=]?[\w\-]+\]", re.IGNORECASE), ""),
    # Log level markers.
    (re.compile(r"\[(DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL|TRACE)\]", re.IGNORECASE), ""),
    # Collapse horizontal whitespace but keep newlines.
    (re.compile(r"[ \t]+"), " "),
]


class Classifier:
    """Deterministic rule-based classifier for Jenkins failure logs."""

    def __init__(self, rules_path: str = "rules.yaml") -> None:
        """Load classifier rules from a YAML file or directory and pre-compile every pattern.
        Directory mode merges all *.yaml files; underscore-prefixed files carry meta-only data.
        """
        self.rules: List[RuleDefinition] = []
        self.fallback_labels: Dict[str, str] = {}
        self.domain_colors: Dict[str, str] = {}
        self._compiled_patterns: dict = {}
        # Compiled extract_pattern 
        self._compiled_extractors: Dict[str, "re.Pattern"] = {}

        import os
        if os.path.isdir(rules_path):
            self._load_rules_dir(rules_path)
        else:
            self._load_rules_file(rules_path)

        for rule in self.rules:
            self._compiled_patterns[rule.name] = [
                _regex.compile(pattern) for pattern in rule.patterns
            ]
            if rule.extract_pattern:
                self._compiled_extractors[rule.name] = _regex.compile(rule.extract_pattern)

    def classify(self, console_text: str) -> ClassificationResult:
        """Classify a Jenkins failure log into a ClassificationResult.
        Empty input and no-match cases yield an Unknown result with the appropriate fallback label.
        """
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

        normalized = self._normalize_log(console_text)
        matches = self._evaluate_rules(normalized)

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

        # Primary = highest-priority match; secondary = first match from a different domain.
        primary_rule, primary_pattern_str, primary_line_num = matches[0]

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

        confidence = self._determine_confidence(
            primary_rule, matches, primary_pattern_str
        )

        evidence = self._extract_evidence(normalized, primary_line_num, context_lines=5)

        # Aggregate labels
        CATCHALL_PRIORITY = 500
        has_specific = any(r.priority < CATCHALL_PRIORITY for r, _, _ in matches)

        all_labels: List[AnalysisLabel] = []
        seen_labels: set = set()
        seen_domains: set = set()

        for rule, _, _ in matches:
            
            if has_specific and rule.priority >= CATCHALL_PRIORITY:
                continue
            if rule.domain in seen_domains:
                continue
            lbl = rule.label or rule.subcategory
            if lbl in seen_labels:
                continue
            seen_labels.add(lbl)
            seen_domains.add(rule.domain)
            all_labels.append(AnalysisLabel(
                label=lbl,
                domain=rule.domain,
                action=rule.action,
                rule_name=rule.name,
            ))

        # If the primary rule defines an extract_pattern
        evidence_detail = self._extract_detail(primary_rule, normalized)

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
            evidence_detail=evidence_detail,
        )

    def _extract_detail(self, rule: RuleDefinition, normalized: str) -> Optional[str]:
        """Run the rule's optional extract_pattern and return the first non-empty named capture.
        Result is trimmed and capped at 400 chars to keep tooltips usable.
        """
        if not rule.extract_pattern:
            return None
        # Use the load-time-cached compiled regex
        compiled = self._compiled_extractors.get(rule.name)
        if compiled is None:
            return None
        try:
            m = compiled.search(normalized, timeout=_USER_PATTERN_TIMEOUT)
        except (_regex.error, TimeoutError, re.error):
            return None
        if not m:
            return None
        for group_name, value in (m.groupdict() or {}).items():
            if value and value.strip():
                # Trim and cap — keeps tooltips readable for composite captures.
                v = value.strip()
                return v if len(v) <= 400 else (v[:397] + "...")
        return None

    def _normalize_log(self, raw_text: str) -> str:
        """Strip log noise (ANSI codes, timestamps, thread ids, levels) for pattern matching.
        Uses the module-level _NORMALIZATION_REGEXES table compiled once at import time.
        """
        text = raw_text
        for pattern, replacement in _NORMALIZATION_REGEXES:
            text = pattern.sub(replacement, text)
        return text.strip()

    def _evaluate_rules(
        self, normalized_text: str
    ) -> List[Tuple[RuleDefinition, str, int]]:
        """Walk every rule in priority order and record the first pattern hit per rule.
        Skips remaining rules in a domain once that domain has produced its winning hit.
        """
        matches: List[Tuple[RuleDefinition, str, int]] = []
        domains_with_hit: set = set()

        for rule in self.rules:
            if rule.domain in domains_with_hit:
                continue
            patterns = self._compiled_patterns.get(rule.name, [])
            for compiled_pattern in patterns:
                try:
                    match = compiled_pattern.search(normalized_text, timeout=_USER_PATTERN_TIMEOUT)
                except (_regex.error, TimeoutError):
                    match = None
                if match:
                    line_num = normalized_text[: match.start()].count("\n")
                    matches.append((rule, match.group(0), line_num))
                    domains_with_hit.add(rule.domain)
                    break

        return matches

    def _extract_evidence(
        self, normalized_text: str, match_line: int, context_lines: int = 5
    ) -> str:
        """Return ``context_lines`` lines surrounding ``match_line``."""
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
        """Score the classification's confidence: STRONG (single domain, specific pattern),
        PARTIAL (multi-domain or short pattern), or UNKNOWN (no matches).
        """
        if not all_matches:
            return ConfidenceLevel.UNKNOWN

        domains = set(rule.domain for rule, _, _ in all_matches)
        num_domains = len(domains)

        # Three or more domains hit — too noisy to be confident in any one.
        if num_domains >= 3:
            return ConfidenceLevel.PARTIAL

        # Single-domain hit on a specific pattern is the only STRONG case.
        if num_domains == 1 and len(pattern) > 15:
            return ConfidenceLevel.STRONG

        return ConfidenceLevel.PARTIAL

    def _parse_rules_list(self, rules_data: list, *, source: str) -> List[RuleDefinition]:
        """Validate and construct RuleDefinition objects from a YAML list.
        Shared by single-file and multi-file loaders; `source` is used only in error messages.
        """
        out: List[RuleDefinition] = []
        required = ["name", "priority", "domain", "subcategory", "impact", "patterns", "action"]

        for idx, rule_dict in enumerate(rules_data):
            for fld in required:
                if fld not in rule_dict:
                    raise ValueError(
                        f"{source}: rule at index {idx} missing required field '{fld}'"
                    )

            if not isinstance(rule_dict["name"], str):
                raise ValueError(f"{source}: rule {idx} 'name' must be a string")
            if not isinstance(rule_dict["priority"], int) or rule_dict["priority"] < 0:
                raise ValueError(f"{source}: rule {idx} 'priority' must be a non-negative integer")
            if not isinstance(rule_dict["domain"], str):
                raise ValueError(f"{source}: rule {idx} 'domain' must be a string")
            if not isinstance(rule_dict["subcategory"], str):
                raise ValueError(f"{source}: rule {idx} 'subcategory' must be a string")
            if not isinstance(rule_dict["impact"], str):
                raise ValueError(f"{source}: rule {idx} 'impact' must be a string")
            if not isinstance(rule_dict["patterns"], list) or not rule_dict["patterns"]:
                raise ValueError(f"{source}: rule {idx} 'patterns' must be a non-empty list")
            if not isinstance(rule_dict["action"], str):
                raise ValueError(f"{source}: rule {idx} 'action' must be a string")

            for pidx, pattern_str in enumerate(rule_dict["patterns"]):
                if not isinstance(pattern_str, str):
                    raise ValueError(
                        f"{source}: rule {idx} pattern {pidx} must be a string"
                    )
                try:
                    re.compile(pattern_str)
                except re.error as e:
                    raise ValueError(
                        f"{source}: rule {idx} pattern {pidx} invalid regex: {e}"
                    )

            scope = rule_dict.get("scope", "global")
            if not isinstance(scope, str):
                raise ValueError(f"{source}: rule {idx} 'scope' must be a string")

            label = rule_dict.get("label", "")
            if not isinstance(label, str):
                raise ValueError(f"{source}: rule {idx} 'label' must be a string")

            extract_pattern = rule_dict.get("extract_pattern")
            if extract_pattern is not None and not isinstance(extract_pattern, str):
                raise ValueError(f"{source}: rule {idx} 'extract_pattern' must be a string when set")
            # Pre-compile so a broken regex fails at load time, not on first match.
            if extract_pattern:
                try:
                    re.compile(extract_pattern)
                except re.error as e:
                    raise ValueError(f"{source}: rule {idx} extract_pattern is invalid regex: {e}")

            out.append(RuleDefinition(
                name=rule_dict["name"],
                priority=rule_dict["priority"],
                domain=rule_dict["domain"],
                subcategory=rule_dict["subcategory"],
                impact=rule_dict["impact"],
                patterns=rule_dict["patterns"],
                action=rule_dict["action"],
                label=label,
                scope=scope,
                extract_pattern=extract_pattern,
            ))
        return out

    def _load_rules_dir(self, rules_dir: str) -> None:
        """Load every YAML file in rules_dir and merge them into self.rules.
        Underscore-prefixed files carry fallback_labels / domain_colors; rule names must be globally unique.
        """
        import glob
        import os

        files = sorted(glob.glob(os.path.join(rules_dir, "*.yaml")))
        if not files:
            raise FileNotFoundError(f"No YAML files found in rules directory: {rules_dir}")

        all_rules: List[RuleDefinition] = []
        seen_names: Dict[str, str] = {}  # rule name → file that defined it
        meta_loaded = False

        for path in files:
            basename = os.path.basename(path)
            try:
                with open(path) as f:
                    data = yaml.safe_load(f) or {}
            except yaml.YAMLError as e:
                raise ValueError(f"Invalid YAML in {path}: {e}")

            if not isinstance(data, dict):
                raise ValueError(f"{path}: top level must be a YAML mapping")

            if "fallback_labels" in data:
                self.fallback_labels.update(data["fallback_labels"])
            if "domain_colors" in data:
                self.domain_colors.update(data["domain_colors"])
            if basename.startswith("_"):
                meta_loaded = True
                continue

            rules_data = data.get("rules", [])
            if not isinstance(rules_data, list):
                raise ValueError(f"{path}: 'rules' must be a list")

            file_rules = self._parse_rules_list(rules_data, source=basename)
            for r in file_rules:
                if r.name in seen_names:
                    raise ValueError(
                        f"Duplicate rule name '{r.name}' — defined in "
                        f"both {seen_names[r.name]} and {basename}"
                    )
                seen_names[r.name] = basename
            all_rules.extend(file_rules)

        if not all_rules:
            raise ValueError(f"No rules found in any file under {rules_dir}")

        # Lower priority number = higher precedence.
        all_rules.sort(key=lambda r: r.priority)
        self.rules = all_rules

        if not meta_loaded:
            print(f"[INFO] No _meta.yaml in {rules_dir}; fallback_labels / domain_colors empty")

    def _load_rules_file(self, rules_path: str) -> None:
        """Single-file loader — read one YAML file and populate rules / labels / colors."""
        try:
            with open(rules_path) as f:
                data = yaml.safe_load(f)
        except FileNotFoundError:
            raise FileNotFoundError(f"Rules file not found: {rules_path}")
        except yaml.YAMLError as e:
            raise ValueError(f"Invalid YAML in rules file: {e}")

        if not data or "rules" not in data:
            raise ValueError("Rules file must contain a 'rules' key with a list value")

        self.fallback_labels = data.get("fallback_labels", {})
        self.domain_colors = data.get("domain_colors", {})

        rules_data = data.get("rules", [])
        if not isinstance(rules_data, list):
            raise ValueError("'rules' key must contain a list")

        rules = self._parse_rules_list(rules_data, source=rules_path)

        # Lower priority number = higher precedence.
        rules.sort(key=lambda r: r.priority)

        self.rules = rules


# Maven/Surefire test summary lines, with or without a log-level prefix:
#   [INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 0
_TEST_SUMMARY_RE = re.compile(
    r"Tests\s+run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)",
    re.IGNORECASE,
)


def parse_console_test_metrics(console_text: str) -> Optional[TestMetrics]:
    """Pull Maven/Surefire test-summary counts from console text.
    Returns the LAST summary line (Maven's final aggregate), or None when no summary is found.
    """
    if not console_text:
        return None

    matches = list(_TEST_SUMMARY_RE.finditer(console_text))
    if not matches:
        return None

    # Maven prints intermediate per-module summaries; the last is the aggregate.
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


# Error-level log lines: [ERROR] / [FATAL] / [SEVERE] / ERROR: / FATAL:.
_ERROR_LINE_RE = re.compile(
    r"^\s*(?:\[(?:ERROR|FATAL|SEVERE)\]|ERROR:|FATAL:)\s*(.+)",
    re.MULTILINE | re.IGNORECASE,
)

# Hints at the build phase / step where the failure occurred.
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
    """Extract error / fatal / severe lines from console output.
    Only meaningful for non-passing jobs — callers should gate this behind a health-state check.
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

            line_upper = line.strip().upper()
            if "[FATAL]" in line_upper or "FATAL:" in line_upper:
                level = "FATAL"
            elif "[SEVERE]" in line_upper or "SEVERE:" in line_upper:
                level = "SEVERE"
            else:
                level = "ERROR"

            ctx_start = max(0, line_idx - context_lines)
            context_before = None
            if ctx_start < line_idx:
                ctx_lines = lines[ctx_start:line_idx]
                context_before = "\n".join(ctx_lines).strip() or None

            entry = ErrorLogEntry(
                line_number=line_idx + 1,
                message=message,
                level=level,
                context_before=context_before,
            )
            error_entries.append(entry)

            if len(error_entries) >= max_entries:
                break

    failure_context = _infer_failure_context(console_text)

    return FailureEvidence(
        error_logs=error_entries,
        error_count=len(error_entries),
        failure_context=failure_context,
    )


def _infer_failure_context(console_text: str) -> Optional[str]:
    """Best-effort guess at the build phase where the failure happened.
    Uses the LAST phase marker found — the one closest to the failure point in the log.
    """
    last_match_text = None

    for pattern, phase_type in _FAILURE_PHASE_PATTERNS:
        matches = list(pattern.finditer(console_text))
        if not matches:
            continue

        m = matches[-1]

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

        # Keep scanning — later patterns may give a more specific hint.

    return last_match_text


class AnalysisOrchestrator:
    """Two-stage parallel analysis pipeline: Stage 1 fetches metadata for every job,
    Stage 2 does deep classification only for FAILED / UNSTABLE jobs; results stream via SSE callbacks.
    """

    def __init__(
        self,
        client: JenkinsClient,
        classifier: Classifier,
        max_workers: int = DEFAULT_WORKERS,
        promotion_time: Optional[datetime] = None,
        view_prefetch: Optional["ViewPrefetch"] = None,
    ) -> None:
        """Initialise the orchestrator with shared client, classifier and worker pool.
        Optional view_prefetch lets Stage 1 skip per-job metadata calls; promotion_time threads release-validation through every to_dict().
        """
        self.client = client
        self.classifier = classifier
        self.max_workers = max_workers
        self.promotion_time = promotion_time
        self.view_prefetch = view_prefetch
        # job_url → JobRecord, populated during Stage 1 for Stage 2 reuse.
        self._records: Dict[str, JobRecord] = {}
        # Set when a newer operation supersedes us — workers exit, the
        # as_completed loops break, and no further events fire. In-flight
        # Jenkins calls still finish naturally (no atomic future cancel).
        self._cancel_flag = threading.Event()

    def cancel(self) -> None:
        """Signal workers and loops to stop; idempotent.
        Called by the SSE driver when a newer fetch supersedes this one.
        """
        self._cancel_flag.set()

    def run_stage_1(
        self,
        jobs: List[dict],
        operation_id: str,
        on_result: Callable[[SSEEvent], None],
    ) -> List[JobRecord]:
        """Parallel Stage 1 metadata fetch across every supplied job.
        Streams JOB_METADATA / JOB_ERROR / PROGRESS_UPDATE events; failures become FETCH_ERROR records.
        """
        results: List[JobRecord] = []

        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            futures = {
                executor.submit(self._stage_1_worker, job): job
                for job in jobs
            }

            completed_count = 0
            total_count = len(jobs)

            for future in as_completed(futures):
                # Superseded by a newer operation — stop emitting events.
                if self._cancel_flag.is_set():
                    break

                job = futures[future]

                try:
                    record = future.result()
                    if record is None:
                        # Worker bailed on the cancel flag.
                        continue
                    results.append(record)
                    self._records[record.job_url] = record

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
        """Parallel deep analysis for FAILED / UNSTABLE jobs only; mutates records in-place.
        Other statuses are returned unchanged.
        """
        failed_records = [
            r for r in records
            if r.health_state in (HealthState.FAILED, HealthState.UNSTABLE)
        ]

        if not failed_records:
            return records

        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            futures = {
                executor.submit(self._stage_2_worker, record): record
                for record in failed_records
            }

            completed_count = 0
            total_count = len(failed_records)

            for future in as_completed(futures):
                if self._cancel_flag.is_set():
                    break
                record = futures[future]

                try:
                    future.result()
                except Exception as e:
                    # Leave classification empty; surface the error to the UI.
                    record.classification = None
                    record.error_message = f"Stage 2 classification failed: {str(e)}"

                enriched_event = SSEEvent(
                    event_type=SSEEventType.JOB_ENRICHED,
                    job_id=record.job_url,
                    operation_id=operation_id,
                    payload=record.to_dict(promotion_time=self.promotion_time),
                )
                on_result(enriched_event)

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
        """Synchronously run Stage 1 (and Stage 2 if needed) for one job."""
        job = {"name": job_name, "url": job_url}
        record = self._process_stage_1_job(job)

        if record.health_state in (HealthState.FAILED, HealthState.UNSTABLE):
            self._process_stage_2_job(record)

        return record

    # Worker wrappers — keep the cancellation check out of per-job business logic.
    # Returning None when the flag is set before a worker starts lets the
    # consumer loop skip the future cleanly.

    def _stage_1_worker(self, job: dict):
        if self._cancel_flag.is_set():
            return None
        return self._process_stage_1_job(job)

    def _stage_2_worker(self, record: JobRecord):
        if self._cancel_flag.is_set():
            return None
        return self._process_stage_2_job(record)

    def _process_stage_1_job(self, job: dict) -> JobRecord:
        """Stage 1 worker — fetch metadata and best-effort test metrics for one job.
        Tries /testReport first, falls back to parsing Maven summary lines from the console tail.
        """
        job_name = job.get("name", "Unknown")
        job_url = job.get("url", "")

        # When the view-level batched fetch ran
        prefetched = (
            self.view_prefetch.get(job_url) if self.view_prefetch else None
        )

        # Latest build is required — propagate failure to the orchestrator.
        if prefetched is not None and prefetched.last_build is not None:
            latest = prefetched.last_build
        else:
            latest = self.client.fetch_build_info(job_url, "lastBuild")

        # Window of 5: three_run_context uses the first three; the rest power the sparkline.
        recent_builds = []
        if prefetched is not None and prefetched.recent_builds:
            recent_builds = prefetched.recent_builds
        else:
            try:
                recent_builds = self.client.fetch_recent_builds(job_url, count=5)
            except JenkinsClientError:
                pass  # Partial context is fine.

        # First non-latest entry — used as "previous" for the three-run view.
        previous = None
        for rb in recent_builds:
            if rb.build_number == latest.build_number:
                continue
            previous = rb
            break

        # First completed previous build — used as the metrics source when latest is still running.
        previous_completed = None
        for rb in recent_builds:
            if rb.build_number == latest.build_number:
                continue
            if rb.status == BuildStatus.IN_PROGRESS:
                continue
            previous_completed = rb
            break

        # Fetch test metrics — diag breadcrumbs explain misses for operators.
        test_metrics = None
        diag: List[str] = []
        metrics_build_number = latest.build_number
        is_in_flight_or_aborted = latest.status in (
            BuildStatus.IN_PROGRESS, BuildStatus.ABORTED,
        )
        # In-flight builds don't have metrics yet; fall back to the previous completed run.
        if is_in_flight_or_aborted and previous_completed is not None:
            metrics_build_number = previous_completed.build_number
            try:
                test_metrics = self.client.fetch_test_metrics(
                    job_url, previous_completed.build_number,
                )
                if test_metrics is not None:
                    test_metrics.from_previous_build = True
                    diag.append("api_prev_ok")
                else:
                    diag.append("api_prev_404")
            except JenkinsClientError as e:
                diag.append("api_prev_err:%s" % (e.status_code or "x"))
        console_text = ""
        if test_metrics is None and not is_in_flight_or_aborted:
            try:
                test_metrics = self.client.fetch_test_metrics(
                    job_url, latest.build_number,
                )
                if test_metrics is not None:
                    diag.append("api_ok")
                else:
                    diag.append("api_404")  # /testReport not published
            except JenkinsClientError as e:
                diag.append("api_err:%s" % (e.status_code or "x"))

        # API said no — try parsing test counts out of the console tail.
        if test_metrics is None and not is_in_flight_or_aborted:
            try:
                console_text = self.client.fetch_console_tail(
                    job_url, latest.build_number, lines=500,
                )
                diag.append("console_fetched:%dB" % len(console_text))
            except JenkinsClientError as e:
                console_text = ""
                diag.append("console_err:%s" % (e.status_code or "x"))

            if console_text:
                console_metrics = parse_console_test_metrics(console_text)
                if console_metrics is not None:
                    test_metrics = console_metrics
                    diag.append("console_parsed")
                else:
                    diag.append("console_no_match")
                    test_metrics = TestMetrics(
                        metrics_source=None,
                        metrics_unavailable=True,
                    )
            else:
                diag.append("console_empty")
                test_metrics = TestMetrics(
                    metrics_source=None,
                    metrics_unavailable=True,
                )
        elif test_metrics is None:
            # In-flight or aborted with no completed predecessor.
            diag.append("inflight_no_prev")
            test_metrics = TestMetrics(
                metrics_source=None,
                metrics_unavailable=True,
            )

        # Cap diag size — retries against a slow Jenkins can otherwise balloon
        # this into KB per record across a large fetch universe.
        diag_str = ",".join(diag[-10:])
        if len(diag_str) > 500:
            diag_str = diag_str[:497] + "..."
        test_metrics.metrics_diagnostic = diag_str
        if test_metrics.metrics_unavailable:
            _log.warning(
                "MISSING [%s] build#%s status=%s diag=%s",
                job_name, latest.build_number, latest.status.value, test_metrics.metrics_diagnostic,
            )
        else:
            _log.info(
                "OK [%s] build#%s status=%s totals=%s/%s/%s/%s diag=%s",
                job_name, latest.build_number, latest.status.value,
                test_metrics.total, test_metrics.passed,
                test_metrics.failed, test_metrics.skipped,
                test_metrics.metrics_diagnostic,
            )

        # Resolve last_passed: latest if green; else recent window;
        # else the batched view's lastSuccessfulBuild (free — already
        # fetched); else fall back to a depth-50 allBuilds query for
        # the per-job path so older greens still resolve.
        last_passed = None
        if latest.status == BuildStatus.SUCCESS:
            last_passed = latest
        else:
            for rb in recent_builds:
                if rb.status == BuildStatus.SUCCESS:
                    last_passed = rb
                    break
            if last_passed is None and prefetched is not None and prefetched.last_successful_build is not None:
                last_passed = prefetched.last_successful_build
            if last_passed is None:
                try:
                    last_passed = self.client.fetch_last_passed(job_url, depth=50)
                except JenkinsClientError:
                    pass

        context = ThreeRunContext(
            latest=latest,
            previous=previous,
            last_passed=last_passed,
        )

        health_state = self._determine_health_state(context)

        data_completeness = self._determine_data_completeness(
            test_metrics=test_metrics,
            previous=previous,
            last_passed=last_passed,
        )

        # failure_evidence stays None — Stage 2 fills it in for non-passing jobs.
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

        # Stash console text so Stage 2 can reuse it without a second fetch.
        record._console_text = console_text

        return record

    def _process_stage_2_job(self, record: JobRecord) -> JobRecord:
        """Stage 2 worker — classify failure, extract error lines, top up missing test metrics.
        Reuses Stage 1's console text when available; mutates record in place.
        """
        try:
            # Reuse Stage 1's console fetch if it landed; otherwise fetch fresh.
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
                    if record.data_completeness == DataCompleteness.COMPLETE:
                        record.data_completeness = DataCompleteness.PARTIAL

            try:
                classification_result = self.classifier.classify(console_text)
                record.classification = classification_result
            except Exception:
                record.classification = None

            if console_text:
                record.failure_evidence = extract_error_logs(console_text)
            else:
                record.failure_evidence = FailureEvidence(
                    error_logs=[], error_count=0, failure_context=None,
                )

            # Top up missing metrics from the console as a last resort.
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

            record.stage = StageCompletion.STAGE_2

        except Exception as e:
            record.error_message = f"Stage 2 processing failed: {str(e)}"

        return record

    def _determine_health_state(self, context: ThreeRunContext) -> HealthState:
        """Map the latest build's BuildStatus to a HealthState."""
        status = context.latest.status

        if status == BuildStatus.SUCCESS:
            return HealthState.PASSED
        if status == BuildStatus.FAILURE:
            return HealthState.FAILED
        if status == BuildStatus.UNSTABLE:
            return HealthState.UNSTABLE
        if status == BuildStatus.ABORTED:
            return HealthState.ABORTED
        return HealthState.UNKNOWN

    def _determine_data_completeness(
        self,
        test_metrics=None,
        previous=None,
        last_passed=None,
    ) -> DataCompleteness:
        """Score how complete the record is based on populated fields."""
        if test_metrics is not None and previous is not None and last_passed is not None:
            return DataCompleteness.COMPLETE
        if test_metrics is not None or previous is not None or last_passed is not None:
            return DataCompleteness.PARTIAL
        return DataCompleteness.MINIMAL
