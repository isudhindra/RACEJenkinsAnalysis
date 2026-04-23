#!/usr/bin/env python3
"""
rules-bootstrap: One-time rule generation utility for Jenkins log-analysis onboarding.

Reads raw error samples from sample.json and generates a draft rules.yaml
compatible with the dashboard's Classifier (pipeline.py). The output provides
a strong starting point that the team can review and refine manually.

Usage:
    python bootstrap_rules.py                         # defaults: sample.json -> rules.yaml
    python bootstrap_rules.py -i errors.json -o draft.yaml
    python bootstrap_rules.py --min-samples 3         # require 3+ samples per group

No LLMs or external AI services are used. All logic is deterministic:
regex extraction, text normalization, frequency analysis, and rule templating.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import textwrap
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any


# ============================================================================
# Stage 1: Text normalization
# ============================================================================

# Patterns for unstable fragments that should be replaced with stable tokens
_NORMALIZERS: list[tuple[re.Pattern, str]] = [
    # ISO-8601 timestamps: 2026-03-31T14:22:01.443Z or with offset
    (re.compile(r'\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?'), '<TIMESTAMP>'),
    # Date-only: 31 Mar 2026 or 2026-03-31
    (re.compile(r'\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{4}'), '<DATE>'),
    (re.compile(r'\d{4}-\d{2}-\d{2}'), '<DATE>'),
    # Time-only with millis: 10:15:33.221
    (re.compile(r'\d{2}:\d{2}:\d{2}(?:\.\d+)?'), '<TIME>'),
    # IP addresses: 10.0.3.47
    (re.compile(r'\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b'), '<IP>'),
    # Port numbers in host:port context
    (re.compile(r'(?<=:)\d{2,5}(?=\b)'), '<PORT>'),
    # Hex memory addresses: 0xb7a940
    (re.compile(r'0x[0-9a-fA-F]+'), '<ADDR>'),
    # UUIDs / trace IDs: abc-def-123-456 or standard UUID
    (re.compile(r'\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b'), '<UUID>'),
    (re.compile(r'\b[a-z0-9]+-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+\b'), '<TRACE_ID>'),
    # Request/session/user IDs: req-abc123, U-9823741, etc.
    (re.compile(r'\b(?:req|session|user|id|U|S)-[A-Za-z0-9]+\b'), '<ID>'),
    # Build numbers, line numbers, large numerics
    (re.compile(r'(?<=:)\d+(?=\])'), '<LINE>'),    # [file:LINE]
    (re.compile(r'(?<=\.java:)\d+'), '<LINE>'),     # .java:LINE
    (re.compile(r'(?<=\.js:)\d+'), '<LINE>'),       # .js:LINE
    # URLs and file paths (keep protocol/extension, replace variable parts)
    (re.compile(r'https?://[^\s"\'>\)]+'), '<URL>'),
    # Absolute file paths
    (re.compile(r'/(?:[\w.-]+/){2,}[\w.-]+'), '<PATH>'),
    # Java stack trace noise (at package.Class.method lines)
    (re.compile(r'^\s+at\s+[\w.$]+\([\w.$]+:\d+\).*$', re.MULTILINE), ''),
    # ANSI escape codes
    (re.compile(r'\x1b\[[0-9;]*m'), ''),
    # Chrome/browser version strings
    (re.compile(r'(?:chrome|Chrome|firefox|Firefox|Safari)[/ ]\d+[\d.]+'), '<BROWSER_VER>'),
    # Selenium session info
    (re.compile(r'\(Session info:.*?\)'), ''),
    # Numeric values (standalone large numbers, but not HTTP status codes)
    (re.compile(r'\b\d{5,}\b'), '<NUM>'),
    # Whitespace collapse
    (re.compile(r'[ \t]+'), ' '),
    (re.compile(r'\n{3,}'), '\n\n'),
]


def normalize(text: str) -> str:
    """Replace unstable fragments with stable tokens for grouping."""
    result = text
    for pattern, replacement in _NORMALIZERS:
        result = pattern.sub(replacement, result)
    # Strip leading/trailing whitespace per line
    result = '\n'.join(line.strip() for line in result.strip().splitlines() if line.strip())
    return result


# ============================================================================
# Stage 2: Signature extraction — pull the "essence" of each error
# ============================================================================

# Known exception/error class names
_EXCEPTION_RE = re.compile(
    r'\b((?:[a-z]+\.)*[A-Z]\w*(?:Exception|Error|Failure|Fault))\b'
)

# HTTP status patterns
_HTTP_STATUS_RE = re.compile(
    r'\b(?:HTTP/?1?\.\d?\s+)?([45]\d{2})(?:\s+\w+)*'
)

# Key error phrases (order matters — first match wins for phrase extraction)
_KEY_PHRASES: list[tuple[re.Pattern, str]] = [
    (re.compile(r'no such element', re.I), 'no such element'),
    (re.compile(r'element not found', re.I), 'element not found'),
    (re.compile(r'stale element reference', re.I), 'stale element reference'),
    (re.compile(r'unable to locate element', re.I), 'unable to locate element'),
    (re.compile(r'session not created', re.I), 'session not created'),
    (re.compile(r'unable to create session', re.I), 'unable to create session'),
    (re.compile(r'connection refused', re.I), 'connection refused'),
    (re.compile(r'ECONNREFUSED', re.I), 'ECONNREFUSED'),
    (re.compile(r'ECONNRESET', re.I), 'ECONNRESET'),
    (re.compile(r'socket hang up', re.I), 'socket hang up'),
    (re.compile(r'connection reset', re.I), 'connection reset'),
    (re.compile(r'connection pool exhausted', re.I), 'connection pool exhausted'),
    (re.compile(r'too many connections', re.I), 'too many connections'),
    (re.compile(r'DNS resolution failed', re.I), 'DNS resolution failed'),
    (re.compile(r'Name or service not known', re.I), 'Name or service not known'),
    (re.compile(r'getaddrinfo\s+\w+', re.I), 'getaddrinfo failure'),
    (re.compile(r'timed?\s*out', re.I), 'timeout'),
    (re.compile(r'timeout\s+\w+', re.I), 'timeout'),
    (re.compile(r'Navigation timeout', re.I), 'Navigation timeout'),
    (re.compile(r'page load timed out', re.I), 'page load timed out'),
    (re.compile(r'OutOfMemoryError', re.I), 'OutOfMemoryError'),
    (re.compile(r'heap\s+(?:limit|out of memory|space)', re.I), 'heap out of memory'),
    (re.compile(r'Cannot allocate memory', re.I), 'Cannot allocate memory'),
    (re.compile(r'compilation?\s+(?:failed|failure|error)', re.I), 'compilation failure'),
    (re.compile(r'BUILD FAILURE', re.I), 'BUILD FAILURE'),
    (re.compile(r'cannot find symbol', re.I), 'cannot find symbol'),
    (re.compile(r'package\s+\S+\s+does not exist', re.I), 'package does not exist'),
    (re.compile(r'npm ERR!', re.I), 'npm ERR!'),
    (re.compile(r'ERESOLVE', re.I), 'ERESOLVE'),
    (re.compile(r'peer dep', re.I), 'peer dep'),
    (re.compile(r'401\s*Unauthorized', re.I), '401 Unauthorized'),
    (re.compile(r'token.?expired', re.I), 'token expired'),
    (re.compile(r'login failed', re.I), 'login failed'),
    (re.compile(r'invalid.?credentials', re.I), 'invalid credentials'),
    (re.compile(r'access.?denied', re.I), 'access denied'),
    (re.compile(r'permission denied', re.I), 'permission denied'),
    (re.compile(r'403 Forbidden', re.I), '403 Forbidden'),
    (re.compile(r'Internal Server Error', re.I), 'Internal Server Error'),
    (re.compile(r'Bad Gateway', re.I), 'Bad Gateway'),
    (re.compile(r'Service Unavailable', re.I), 'Service Unavailable'),
    (re.compile(r'HTTP/\d\.?\d?\s+5\d{2}', re.I), 'HTTP 5xx'),
    (re.compile(r'record not found', re.I), 'record not found'),
    (re.compile(r'no data returned', re.I), 'no data returned'),
    (re.compile(r'SSL.*certificate', re.I), 'SSL certificate error'),
    (re.compile(r'CERTIFICATE_VERIFY_FAILED', re.I), 'CERTIFICATE_VERIFY_FAILED'),
    (re.compile(r'SSLHandshakeException', re.I), 'SSL certificate error'),
    (re.compile(r'PKIX path building failed', re.I), 'SSL certificate error'),
    (re.compile(r'unable to (?:find valid )?certifi', re.I), 'SSL certificate error'),
    (re.compile(r'NullPointerException', re.I), 'NullPointerException'),
    (re.compile(r'(?:TypeError|Cannot read properties of)\s*(?:null|undefined)', re.I), 'null/undefined TypeError'),
    (re.compile(r'assertion\s*(?:failed|error)', re.I), 'assertion failure'),
    (re.compile(r'ComparisonFailure', re.I), 'assertion mismatch'),
    (re.compile(r'expected\s*.{1,60}\s*(?:to equal|but (?:got|was|received))', re.I), 'assertion mismatch'),
    (re.compile(r'expected:\s*<.+?>\s*but was:\s*<', re.I), 'assertion mismatch'),
    (re.compile(r'assert\.\w+\(', re.I), 'assertion call'),
    (re.compile(r'database.*unavailable', re.I), 'database unavailable'),
    (re.compile(r'could not connect to server', re.I), 'could not connect to server'),
    (re.compile(r'relation\s+"[^"]+"\s+does not exist', re.I), 'relation does not exist'),
]


@dataclass
class Signature:
    """Distilled identity of an error sample."""
    exception_class: str | None = None
    http_status: int | None = None
    key_phrases: list[str] = field(default_factory=list)
    first_meaningful_line: str = ''

    def fingerprint(self) -> str:
        """A hashable string that groups similar errors together."""
        parts: list[str] = []
        if self.exception_class:
            parts.append(f'exc:{self.exception_class}')
        if self.http_status:
            parts.append(f'http:{self.http_status}')
        for phrase in sorted(set(self.key_phrases[:3])):  # top 3
            parts.append(f'kp:{phrase.lower()}')
        if not parts:
            # Fallback: use first meaningful line (heavily normalized)
            parts.append(f'line:{self.first_meaningful_line[:80]}')
        return '|'.join(parts)


def extract_signature(raw_text: str) -> Signature:
    """Extract the stable signature from a raw error sample."""
    sig = Signature()

    # Exception class
    exc_match = _EXCEPTION_RE.search(raw_text)
    if exc_match:
        sig.exception_class = exc_match.group(1).split('.')[-1]  # short name

    # HTTP status
    http_match = _HTTP_STATUS_RE.search(raw_text)
    if http_match:
        sig.http_status = int(http_match.group(1))

    # Key phrases
    for pattern, phrase in _KEY_PHRASES:
        if pattern.search(raw_text):
            sig.key_phrases.append(phrase)

    # First meaningful line (skip timestamps, blank lines, stack traces)
    for line in raw_text.strip().splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith('at ') or stripped.startswith('at\t'):
            continue
        if re.match(r'^[\[\(]?\d{4}-\d{2}-\d{2}', stripped):
            # Timestamp-prefixed — take content after the timestamp
            stripped = re.sub(r'^[\[\(]?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\]]*[\]\)]?\s*', '', stripped)
        if len(stripped) > 10:
            sig.first_meaningful_line = stripped
            break

    return sig


# ============================================================================
# Stage 3: Grouping — cluster similar signatures
# ============================================================================

@dataclass
class ErrorGroup:
    """A cluster of similar error samples."""
    fingerprint: str
    samples: list[dict] = field(default_factory=list)
    signatures: list[Signature] = field(default_factory=list)

    @property
    def count(self) -> int:
        return len(self.samples)


def group_samples(samples: list[dict]) -> list[ErrorGroup]:
    """Group samples by signature fingerprint, then merge similar groups."""
    groups_by_fp: dict[str, ErrorGroup] = {}
    for sample in samples:
        raw = sample.get('error_text', '')
        sig = extract_signature(raw)
        fp = sig.fingerprint()
        if fp not in groups_by_fp:
            groups_by_fp[fp] = ErrorGroup(fingerprint=fp)
        groups_by_fp[fp].samples.append(sample)
        groups_by_fp[fp].signatures.append(sig)

    groups = list(groups_by_fp.values())

    # Pass 1: merge groups with overlapping key phrases (Jaccard)
    merged = _merge_similar_groups(groups, threshold=0.35)

    # Pass 2: merge groups that map to the same inferred subcategory
    merged = _merge_by_subcategory(merged)

    # Sort by count descending, then by fingerprint for stability
    merged.sort(key=lambda g: (-g.count, g.fingerprint))
    return merged


def _merge_similar_groups(groups: list[ErrorGroup], threshold: float) -> list[ErrorGroup]:
    """Merge groups whose key-phrase sets overlap above threshold (Jaccard)."""
    if len(groups) <= 1:
        return groups

    # Build phrase sets per group
    phrase_sets = []
    for g in groups:
        phrases = set()
        for sig in g.signatures:
            phrases.update(p.lower() for p in sig.key_phrases)
        # Also include exception class as a "phrase" for merging
        for sig in g.signatures:
            if sig.exception_class:
                phrases.add(f'_exc_{sig.exception_class.lower()}')
        phrase_sets.append(phrases)

    # Union-find merge
    parent = list(range(len(groups)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for i in range(len(groups)):
        for j in range(i + 1, len(groups)):
            si, sj = phrase_sets[i], phrase_sets[j]
            if not si or not sj:
                continue
            jaccard = len(si & sj) / len(si | sj)
            if jaccard >= threshold:
                union(i, j)

    # Collect merged groups
    merged_map: dict[int, ErrorGroup] = {}
    for i, g in enumerate(groups):
        root = find(i)
        if root not in merged_map:
            merged_map[root] = ErrorGroup(fingerprint=groups[root].fingerprint)
        merged_map[root].samples.extend(g.samples)
        merged_map[root].signatures.extend(g.signatures)

    return list(merged_map.values())


def _merge_by_subcategory(groups: list[ErrorGroup]) -> list[ErrorGroup]:
    """Merge groups that would map to the same (domain, subcategory) pair.

    This is the most aggressive merge pass. After key-phrase Jaccard merging,
    groups that infer to the same subcategory (e.g. multiple OOM variants,
    multiple timeout variants) are consolidated into a single rule.
    """
    from collections import defaultdict

    # For each group, infer what subcategory it would get
    buckets: dict[tuple[str, str], list[ErrorGroup]] = defaultdict(list)
    for g in groups:
        cat = infer_category(g)
        key = (cat.domain, cat.subcategory)
        buckets[key].append(g)

    merged: list[ErrorGroup] = []
    for (domain, subcat), bucket in buckets.items():
        if len(bucket) == 1:
            merged.append(bucket[0])
        else:
            # Merge all groups in this bucket into one
            combined = ErrorGroup(fingerprint=bucket[0].fingerprint)
            for g in bucket:
                combined.samples.extend(g.samples)
                combined.signatures.extend(g.signatures)
            merged.append(combined)

    return merged


# ============================================================================
# Stage 4: Category and domain inference
# ============================================================================

# Map key-phrase stems to (domain, subcategory, impact) tuples
_CATEGORY_MAP: dict[str, tuple[str, str, str]] = {
    # Connection / network issues
    'connection refused': ('Environment / Infrastructure', 'Connection Refused', 'Infrastructure Likely'),
    'econnrefused': ('Environment / Infrastructure', 'Connection Refused', 'Infrastructure Likely'),
    'econnreset': ('Environment / Infrastructure', 'Connection Reset', 'Infrastructure Likely'),
    'socket hang up': ('Environment / Infrastructure', 'Connection Reset', 'Infrastructure Likely'),
    'connection reset': ('Environment / Infrastructure', 'Connection Reset', 'Infrastructure Likely'),
    'connection pool exhausted': ('Environment / Infrastructure', 'Database Connection', 'Infrastructure Likely'),
    'too many connections': ('Environment / Infrastructure', 'Database Connection', 'Infrastructure Likely'),
    'could not connect to server': ('Environment / Infrastructure', 'Database Connection', 'Infrastructure Likely'),
    'database unavailable': ('Environment / Infrastructure', 'Database Connection', 'Infrastructure Likely'),

    # DNS
    'dns resolution failed': ('Environment / Infrastructure', 'DNS Resolution', 'Infrastructure Likely'),
    'name or service not known': ('Environment / Infrastructure', 'DNS Resolution', 'Infrastructure Likely'),
    'getaddrinfo failure': ('Environment / Infrastructure', 'DNS Resolution', 'Infrastructure Likely'),

    # Timeouts
    'timeout': ('Environment / Infrastructure', 'Timeout', 'Infrastructure Likely'),
    'navigation timeout': ('UI / Frontend', 'Page Load Timeout', 'Infrastructure Likely'),
    'page load timed out': ('UI / Frontend', 'Page Load Timeout', 'Infrastructure Likely'),

    # OOM
    'outofmemoryerror': ('Environment / Infrastructure', 'Out of Memory', 'Infrastructure Likely'),
    'heap out of memory': ('Environment / Infrastructure', 'Out of Memory', 'Infrastructure Likely'),
    'cannot allocate memory': ('Environment / Infrastructure', 'Out of Memory', 'Infrastructure Likely'),

    # SSL
    'ssl certificate error': ('Environment / Infrastructure', 'SSL/TLS Error', 'Infrastructure Likely'),
    'certificate_verify_failed': ('Environment / Infrastructure', 'SSL/TLS Error', 'Infrastructure Likely'),
    'pkix path building failed': ('Environment / Infrastructure', 'SSL/TLS Error', 'Infrastructure Likely'),

    # Permissions
    'permission denied': ('Environment / Infrastructure', 'Permission Denied', 'Infrastructure Likely'),
    'access denied': ('Environment / Infrastructure', 'Permission Denied', 'Infrastructure Likely'),
    '403 forbidden': ('API / Backend Service', 'Authorization Failure', 'Data Issue'),

    # UI / Elements
    'no such element': ('UI / Frontend', 'Locator Mismatch', 'Test Issue'),
    'element not found': ('UI / Frontend', 'Locator Mismatch', 'Test Issue'),
    'stale element reference': ('UI / Frontend', 'Locator Mismatch', 'Test Issue'),
    'unable to locate element': ('UI / Frontend', 'Locator Mismatch', 'Test Issue'),

    # WebDriver
    'session not created': ('Browser / Driver', 'WebDriver Session Failure', 'Infrastructure Likely'),
    'unable to create session': ('Browser / Driver', 'WebDriver Session Failure', 'Infrastructure Likely'),

    # Build / Compilation
    'compilation failure': ('Build / Configuration', 'Compilation Error', 'Product Regression Likely'),
    'build failure': ('Build / Configuration', 'Compilation Error', 'Product Regression Likely'),
    'cannot find symbol': ('Build / Configuration', 'Compilation Error', 'Product Regression Likely'),
    'package does not exist': ('Build / Configuration', 'Compilation Error', 'Product Regression Likely'),

    # NPM / Dependency
    'npm err!': ('Build / Configuration', 'Dependency Resolution', 'Test Issue'),
    'eresolve': ('Build / Configuration', 'Dependency Resolution', 'Test Issue'),
    'peer dep': ('Build / Configuration', 'Dependency Resolution', 'Test Issue'),

    # HTTP status errors
    'internal server error': ('API / Backend Service', 'HTTP 5xx', 'Product Regression Likely'),
    'bad gateway': ('API / Backend Service', 'HTTP 5xx', 'Product Regression Likely'),
    'service unavailable': ('API / Backend Service', 'HTTP 5xx', 'Product Regression Likely'),
    'http 5xx': ('API / Backend Service', 'HTTP 5xx', 'Product Regression Likely'),

    # Auth
    '401 unauthorized': ('API / Backend Service', 'Authentication Failure', 'Data Issue'),
    'token expired': ('API / Backend Service', 'Authentication Failure', 'Data Issue'),
    'login failed': ('API / Backend Service', 'Authentication Failure', 'Data Issue'),
    'invalid credentials': ('API / Backend Service', 'Authentication Failure', 'Data Issue'),

    # Data
    'record not found': ('Test Data', 'Missing Record', 'Data Issue'),
    'no data returned': ('Test Data', 'Missing Record', 'Data Issue'),
    'relation does not exist': ('Build / Configuration', 'Schema Mismatch', 'Product Regression Likely'),

    # Null references
    'nullpointerexception': ('Automation / Framework', 'Null Reference', 'Test Issue'),
    'null/undefined typeerror': ('Automation / Framework', 'Null Reference', 'Test Issue'),

    # Assertions
    'assertion failure': ('Automation / Framework', 'Assertion Logic Error', 'Test Issue'),
    'assertion mismatch': ('Automation / Framework', 'Assertion Logic Error', 'Test Issue'),
    'assertion call': ('Automation / Framework', 'Assertion Logic Error', 'Test Issue'),
}

# HTTP status code to domain/subcategory mapping
_HTTP_CATEGORY_MAP: dict[int, tuple[str, str, str]] = {
    401: ('API / Backend Service', 'Authentication Failure', 'Data Issue'),
    403: ('API / Backend Service', 'Authorization Failure', 'Data Issue'),
    404: ('API / Backend Service', 'Resource Not Found', 'Product Regression Likely'),
    500: ('API / Backend Service', 'HTTP 5xx', 'Product Regression Likely'),
    502: ('API / Backend Service', 'HTTP 5xx', 'Product Regression Likely'),
    503: ('API / Backend Service', 'HTTP 5xx', 'Product Regression Likely'),
    504: ('API / Backend Service', 'HTTP 5xx', 'Infrastructure Likely'),
}

# Domain to color
_DOMAIN_COLORS: dict[str, str] = {
    'API / Backend Service': 'blue',
    'Environment / Infrastructure': 'orange',
    'Build / Configuration': 'purple',
    'UI / Frontend': 'teal',
    'Test Data': 'amber',
    'Automation / Framework': 'slate',
    'Browser / Driver': 'indigo',
    'Unknown': 'gray',
}


@dataclass
class InferredCategory:
    """Inferred classification for a group."""
    domain: str = 'Unknown'
    subcategory: str = 'Unclassified'
    impact: str = 'Inconclusive'
    label: str = 'Unclassified Error'
    action: str = 'Manual investigation needed. Review full console output.'


def infer_category(group: ErrorGroup) -> InferredCategory:
    """Infer the best category for a group based on its signatures."""
    cat = InferredCategory()

    # Tally votes from all key phrases across all signatures
    domain_votes: Counter = Counter()
    subcategory_votes: Counter = Counter()
    impact_votes: Counter = Counter()

    for sig in group.signatures:
        for phrase in sig.key_phrases:
            key = phrase.lower()
            if key in _CATEGORY_MAP:
                d, s, i = _CATEGORY_MAP[key]
                domain_votes[d] += 1
                subcategory_votes[s] += 1
                impact_votes[i] += 1

        # HTTP status votes
        if sig.http_status and sig.http_status in _HTTP_CATEGORY_MAP:
            d, s, i = _HTTP_CATEGORY_MAP[sig.http_status]
            domain_votes[d] += 1
            subcategory_votes[s] += 1
            impact_votes[i] += 1

    if domain_votes:
        cat.domain = domain_votes.most_common(1)[0][0]
    if subcategory_votes:
        cat.subcategory = subcategory_votes.most_common(1)[0][0]
    if impact_votes:
        cat.impact = impact_votes.most_common(1)[0][0]

    # Generate label from subcategory
    cat.label = cat.subcategory
    cat.action = _generate_action(cat.domain, cat.subcategory)

    return cat


def _generate_action(domain: str, subcategory: str) -> str:
    """Generate a recommended action string based on domain/subcategory."""
    actions = {
        ('Environment / Infrastructure', 'Connection Refused'): 'Verify target service is running and accessible. Check firewall and network policies.',
        ('Environment / Infrastructure', 'Connection Reset'): 'Check network stability. Service may have crashed or forcibly closed the connection.',
        ('Environment / Infrastructure', 'Database Connection'): 'Verify database is running and accessible. Check connection pool settings.',
        ('Environment / Infrastructure', 'DNS Resolution'): 'Verify DNS configuration. Check network connectivity and resolver settings.',
        ('Environment / Infrastructure', 'Timeout'): 'Check infrastructure health and network connectivity. Review timeout thresholds.',
        ('Environment / Infrastructure', 'Out of Memory'): 'Increase heap size or memory allocation. Review memory leak possibilities.',
        ('Environment / Infrastructure', 'SSL/TLS Error'): 'Verify SSL certificate validity and chain. Check certificate expiration dates.',
        ('Environment / Infrastructure', 'Permission Denied'): 'Check file/directory permissions and user privileges. Verify access controls.',
        ('API / Backend Service', 'HTTP 5xx'): 'Check service deployment logs. Likely backend regression.',
        ('API / Backend Service', 'Authentication Failure'): 'Validate test credentials. Check token expiration and auth configuration.',
        ('API / Backend Service', 'Authorization Failure'): 'Review role-based access control. Verify user permissions for the resource.',
        ('UI / Frontend', 'Locator Mismatch'): 'Review locator strategy. Check if UI changed in recent deployment.',
        ('UI / Frontend', 'Page Load Timeout'): 'Review page load performance. Check network conditions and server response times.',
        ('Browser / Driver', 'WebDriver Session Failure'): 'Verify WebDriver and browser version compatibility.',
        ('Build / Configuration', 'Compilation Error'): 'Review code changes for syntax errors. Check build tool versions.',
        ('Build / Configuration', 'Dependency Resolution'): 'Verify dependencies in package.json/pom.xml. Check registry access.',
        ('Build / Configuration', 'Schema Mismatch'): 'Verify database schema matches expected state. Check migration scripts.',
        ('Automation / Framework', 'Null Reference'): 'Review code for null/undefined reference handling. Add defensive checks.',
        ('Automation / Framework', 'Assertion Logic Error'): 'Review assertion logic and expected values. Check test data setup.',
        ('Test Data', 'Missing Record'): 'Validate test data setup. Check data initialization scripts.',
    }
    return actions.get((domain, subcategory), 'Manual investigation needed. Review full console output.')


# ============================================================================
# Stage 5: Pattern generation — derive regex patterns from samples
# ============================================================================

def generate_patterns(group: ErrorGroup) -> list[str]:
    """Generate regex patterns that would match the samples in this group."""
    patterns: list[str] = []
    seen_phrases: set[str] = set()

    # Collect all key phrases from signatures
    all_phrases: Counter = Counter()
    for sig in group.signatures:
        for phrase in sig.key_phrases:
            all_phrases[phrase] += 1

    # Use the most frequent key phrases as pattern sources
    for phrase, count in all_phrases.most_common():
        lower = phrase.lower()
        if lower in seen_phrases:
            continue
        seen_phrases.add(lower)

        # Convert the phrase to a regex pattern
        pattern = _phrase_to_regex(phrase)
        if pattern and pattern not in patterns:
            patterns.append(pattern)

    # Add exception class pattern if consistent
    exc_classes: Counter = Counter()
    for sig in group.signatures:
        if sig.exception_class:
            exc_classes[sig.exception_class] += 1
    for exc, count in exc_classes.most_common():
        if count >= max(1, len(group.samples) * 0.3):
            pat = re.escape(exc).replace(r'\ ', r'\s+')
            if pat not in patterns:
                patterns.insert(0, pat)

    # Add HTTP status patterns only when HTTP status is the primary signal
    # (i.e. the inferred category is actually about HTTP errors, not when
    # an HTTP status just happens to appear in a timeout/connection error)
    http_statuses: Counter = Counter()
    for sig in group.signatures:
        if sig.http_status:
            http_statuses[sig.http_status] += 1
    # Only include HTTP patterns if they represent the majority of samples
    # and there aren't more specific key phrases driving the classification
    http_is_primary = all(
        not sig.key_phrases or
        any(p.lower() in ('401 unauthorized', '403 forbidden', 'token expired',
                          'login failed', 'invalid credentials', 'access denied')
            for p in sig.key_phrases)
        for sig in group.signatures
    )
    for status, count in http_statuses.most_common():
        if count >= max(1, len(group.samples) * 0.5):
            family = status // 100
            pat = f'HTTP/1.1 {family}\\d{{2}}'
            if pat not in patterns and family in (4, 5) and http_is_primary:
                patterns.insert(0, pat)
            status_texts = {
                500: 'Internal Server Error',
                502: 'Bad Gateway',
                503: 'Service Unavailable',
                401: '401 Unauthorized',
                403: '403 Forbidden',
            }
            if status in status_texts:
                text_pat = status_texts[status]
                if text_pat not in patterns:
                    patterns.append(text_pat)

    # Deduplicate patterns that are substrings of each other
    patterns = _deduplicate_patterns(patterns)

    # Ensure at least one pattern
    if not patterns:
        # Fallback: use the first meaningful line from the most representative sample
        for sig in group.signatures:
            if sig.first_meaningful_line:
                fallback = re.escape(sig.first_meaningful_line[:50])
                patterns.append(fallback)
                break

    return patterns[:6]  # Cap at 6 patterns per rule


def _phrase_to_regex(phrase: str) -> str:
    """Convert a key phrase to a suitable regex pattern string."""
    # Some phrases are already good as-is
    # Patterns are case-sensitive (the Classifier compiles without IGNORECASE).
    # Use exact casing from real logs, or (?i) prefix for case-insensitive needs.
    simple_phrases = {
        'no such element': '(?i)no such element',
        'element not found': '(?i)element not found',
        'stale element reference': '(?i)stale element reference',
        'unable to locate element': '(?i)unable to locate element',
        'connection refused': 'Connection refused',
        'econnrefused': 'ECONNREFUSED',
        'econnreset': 'ECONNRESET',
        'socket hang up': 'socket hang up',
        'connection reset': 'Connection reset',
        'connection pool exhausted': 'Connection pool exhausted',
        'too many connections': 'too many connections',
        'dns resolution failed': 'DNS resolution failed',
        'name or service not known': 'Name or service not known',
        'getaddrinfo failure': 'getaddrinfo.*(?:ENOTFOUND|failed)',
        'timeout': '(?i)timed? ?out',
        'navigation timeout': 'Navigation timeout',
        'page load timed out': '(?i)page load timed out',
        'timeout exceeded': '(?i)timeout.*exceeded',
        'outofmemoryerror': 'OutOfMemoryError',
        'heap out of memory': '(?i)heap.*out of memory',
        'cannot allocate memory': 'Cannot allocate memory',
        'ssl certificate error': '(?i)SSL.*certificate',
        'certificate_verify_failed': 'CERTIFICATE_VERIFY_FAILED',
        'pkix path building failed': 'PKIX path building failed',
        'permission denied': 'Permission denied',
        'access denied': 'Access denied',
        '403 forbidden': '403 Forbidden',
        'session not created': '(?i)session not created',
        'unable to create session': '(?i)unable to create session',
        'compilation failure': '(?i)compil(?:ation|e).*(?:failed|failure|error)',
        'build failure': 'BUILD FAILURE',
        'cannot find symbol': 'cannot find symbol',
        'package does not exist': 'package .+ does not exist',
        'npm err!': 'npm ERR!',
        'eresolve': 'ERESOLVE',
        'peer dep': 'peer dep',
        'internal server error': 'Internal Server Error',
        'bad gateway': 'Bad Gateway',
        'service unavailable': 'Service Unavailable',
        'http 5xx': 'HTTP/1\\.1 5\\d{2}',
        '401 unauthorized': '401 Unauthorized',
        'token expired': '(?i)token.?expired',
        'login failed': '(?i)login failed',
        'invalid credentials': '(?i)invalid.?credentials',
        'record not found': '(?i)record not found',
        'no data returned': '(?i)no data returned',
        'relation does not exist': 'relation .+ does not exist',
        'nullpointerexception': 'NullPointerException',
        'null/undefined typeerror': 'TypeError.*(?:null|undefined)',
        'assertion failure': '(?i)assert(?:ion)? (?:failed|error)',
        'assertion mismatch': '(?i)expected.+but (?:got|was|received)',
        'assertion call': 'assert\\.\\w+\\(',
        'database unavailable': '(?i)database.*unavailable',
        'could not connect to server': '(?i)could not connect to server',
    }
    return simple_phrases.get(phrase.lower(), '')


def _deduplicate_patterns(patterns: list[str]) -> list[str]:
    """Remove patterns that are substrings of another pattern."""
    if len(patterns) <= 1:
        return patterns
    result = []
    for i, p in enumerate(patterns):
        is_substring = False
        for j, q in enumerate(patterns):
            if i != j and p.lower() in q.lower() and len(q) > len(p):
                is_substring = True
                break
        if not is_substring:
            result.append(p)
    return result if result else patterns[:1]


# ============================================================================
# Stage 6: Rule name generation
# ============================================================================

def generate_rule_name(category: InferredCategory, index: int) -> str:
    """Generate a snake_case rule name from the subcategory."""
    base = category.subcategory.lower()
    base = re.sub(r'[^a-z0-9]+', '_', base).strip('_')
    if not base:
        base = f'rule_{index}'
    return base


# ============================================================================
# Stage 7: YAML output generation
# ============================================================================

def generate_rules_yaml(
    groups: list[ErrorGroup],
    categories: list[InferredCategory],
    patterns_per_group: list[list[str]],
    min_samples: int = 1,
) -> str:
    """Generate the final rules.yaml content."""
    lines: list[str] = []

    # Header
    lines.append('# ============================================================================')
    lines.append('# Auto-generated rules.yaml — bootstrap draft for log-analysis onboarding')
    lines.append(f'# Generated from {sum(g.count for g in groups)} error samples across {len(groups)} groups')
    lines.append('# Review and refine before production use.')
    lines.append('# ============================================================================')
    lines.append('')

    # Fallback labels
    lines.append('# Fallback labels for edge cases where no rule matches')
    lines.append('fallback_labels:')
    lines.append('  no_console_log: "No Console Data"')
    lines.append('  no_pattern_match: "Unclassified Failure"')
    lines.append('  success: "\\u2014"')
    lines.append('  in_progress: "Build Running"')
    lines.append('  aborted: "Build Aborted"')
    lines.append('')

    # Domain colors
    lines.append('# Domain color mapping for frontend display')
    lines.append('domain_colors:')
    # Collect all domains used
    used_domains = set(cat.domain for cat in categories)
    used_domains.add('Unknown')
    for domain in sorted(used_domains):
        color = _DOMAIN_COLORS.get(domain, 'gray')
        lines.append(f'  "{domain}": "{color}"')
    lines.append('')

    # Rules
    lines.append('rules:')

    # Assign priorities: tier 1 starts at 10, incrementing by 3
    priority = 10
    rule_names_seen: set[str] = set()
    current_tier = None
    tier_1_cutoff = 5   # groups with 3+ samples
    tier_2_cutoff = 2   # groups with 2 samples
    rule_count = 0

    for i, (group, cat, pats) in enumerate(zip(groups, categories, patterns_per_group)):
        if group.count < min_samples:
            continue
        if not pats:
            continue

        # Determine tier
        if group.count >= 3 and current_tier != 'TIER 1':
            current_tier = 'TIER 1'
            lines.append('')
            lines.append('  # ==========================================================================')
            lines.append('  # TIER 1: High-frequency patterns (3+ samples)')
            lines.append('  # ==========================================================================')
            priority = 10
        elif group.count == 2 and current_tier != 'TIER 2':
            current_tier = 'TIER 2'
            lines.append('')
            lines.append('  # ==========================================================================')
            lines.append('  # TIER 2: Moderate-frequency patterns (2 samples)')
            lines.append('  # ==========================================================================')
            priority = max(priority, 50)
        elif group.count == 1 and current_tier != 'TIER 3':
            current_tier = 'TIER 3'
            lines.append('')
            lines.append('  # ==========================================================================')
            lines.append('  # TIER 3: Single-occurrence patterns (review carefully)')
            lines.append('  # ==========================================================================')
            priority = max(priority, 100)

        # Generate unique rule name
        name = generate_rule_name(cat, i)
        if name in rule_names_seen:
            name = f'{name}_{i}'
        rule_names_seen.add(name)

        # Collect example job names
        job_names = list(set(s.get('job_name', '') for s in group.samples))[:3]

        lines.append('')
        lines.append(f'  - name: "{name}"')
        lines.append(f'    priority: {priority}')
        lines.append(f'    domain: "{cat.domain}"')
        lines.append(f'    subcategory: "{cat.subcategory}"')
        lines.append(f'    impact: "{cat.impact}"')
        lines.append(f'    label: "{cat.label}"')
        lines.append(f'    patterns:')
        for pat in pats:
            # In YAML double-quoted strings, backslashes must be doubled
            yaml_pat = pat.replace('\\', '\\\\').replace('"', '\\"')
            lines.append(f'      - "{yaml_pat}"')
        lines.append(f'    action: "{cat.action}"')
        lines.append(f'    scope: "global"')
        lines.append(f'    # match_count: {group.count} | jobs: {", ".join(job_names)}')

        priority += 3
        rule_count += 1

    # Generic catch-all
    lines.append('')
    lines.append('  # ==========================================================================')
    lines.append('  # TIER 5: Generic catch-all fallbacks')
    lines.append('  # ==========================================================================')
    lines.append('')
    lines.append('  - name: "generic_exception"')
    lines.append('    priority: 900')
    lines.append('    domain: "Automation / Framework"')
    lines.append('    subcategory: "Unhandled Exception"')
    lines.append('    impact: "Inconclusive"')
    lines.append('    label: "Unhandled Exception"')
    lines.append('    patterns:')
    lines.append('      - "Exception"')
    lines.append('      - "Error"')
    lines.append('    action: "Manual investigation needed. Review full console output."')
    lines.append('    scope: "global"')
    lines.append('')

    return '\n'.join(lines) + '\n'


# ============================================================================
# Stage 8: Report generation — summary for human review
# ============================================================================

def generate_report(
    groups: list[ErrorGroup],
    categories: list[InferredCategory],
    patterns_per_group: list[list[str]],
) -> str:
    """Generate a human-readable summary report of what was found."""
    lines: list[str] = []
    lines.append('=' * 72)
    lines.append('  RULES BOOTSTRAP — ANALYSIS REPORT')
    lines.append('=' * 72)
    lines.append('')
    lines.append(f'  Total samples analyzed:  {sum(g.count for g in groups)}')
    lines.append(f'  Error groups found:      {len(groups)}')
    lines.append(f'  Rules generated:         {len([g for g in groups if g.count >= 1])}')
    lines.append('')

    # Domain distribution
    domain_counts: Counter = Counter()
    for cat in categories:
        domain_counts[cat.domain] += 1
    lines.append('  Domain distribution:')
    for domain, count in domain_counts.most_common():
        lines.append(f'    {domain:35s}  {count} rule(s)')
    lines.append('')

    lines.append('-' * 72)
    lines.append('')

    for i, (group, cat, pats) in enumerate(zip(groups, categories, patterns_per_group)):
        lines.append(f'  GROUP {i + 1}: {cat.label}')
        lines.append(f'  Domain:      {cat.domain}')
        lines.append(f'  Subcategory: {cat.subcategory}')
        lines.append(f'  Samples:     {group.count}')
        lines.append(f'  Patterns:    {len(pats)}')

        # Show sample job names
        job_names = set(s.get('job_name', '') for s in group.samples)
        lines.append(f'  Affected jobs: {", ".join(sorted(job_names))}')

        # Show first pattern
        if pats:
            lines.append(f'  Primary pattern: {pats[0]}')

        # Show a sample snippet
        if group.samples:
            snippet = group.samples[0].get('error_text', '')[:120].replace('\n', ' ')
            lines.append(f'  Sample: {snippet}...')

        lines.append('')

    lines.append('=' * 72)
    lines.append('  Review the generated rules.yaml and adjust as needed.')
    lines.append('=' * 72)
    return '\n'.join(lines) + '\n'


# ============================================================================
# Main pipeline
# ============================================================================

def run_bootstrap(input_path: str, output_path: str, min_samples: int = 1) -> None:
    """Execute the full bootstrap pipeline."""
    input_file = Path(input_path)
    if not input_file.exists():
        print(f'Error: Input file not found: {input_path}', file=sys.stderr)
        sys.exit(1)

    # Load samples
    with open(input_file, 'r', encoding='utf-8') as f:
        samples = json.load(f)

    if not isinstance(samples, list):
        print('Error: sample.json must contain a JSON array of objects.', file=sys.stderr)
        sys.exit(1)

    print(f'Loaded {len(samples)} error samples from {input_path}')

    # Stage 1-2: Extract signatures
    print('Extracting signatures...')

    # Stage 3: Group
    print('Grouping similar errors...')
    groups = group_samples(samples)
    print(f'Found {len(groups)} distinct error groups')

    # Stage 4: Categorize
    print('Inferring categories...')
    categories = [infer_category(g) for g in groups]

    # Stage 5: Generate patterns
    print('Generating regex patterns...')
    patterns_per_group = [generate_patterns(g) for g in groups]

    # Stage 7: Output YAML
    print('Generating rules.yaml...')
    yaml_content = generate_rules_yaml(groups, categories, patterns_per_group, min_samples)

    output_file = Path(output_path)
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(yaml_content)
    print(f'Wrote {output_file} ({len(yaml_content)} bytes)')

    # Stage 8: Report
    report = generate_report(groups, categories, patterns_per_group)
    report_path = output_file.with_suffix('.report.txt')
    with open(report_path, 'w', encoding='utf-8') as f:
        f.write(report)
    print(f'Wrote analysis report to {report_path}')

    # Print summary to console
    print()
    print(report)


def main():
    parser = argparse.ArgumentParser(
        description='Bootstrap rules.yaml from real error samples (one-time onboarding utility).',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""\
            Workflow:
              1. Collect representative error samples into sample.json
              2. Run:  python bootstrap_rules.py
              3. Review the generated rules.yaml
              4. Refine rules manually as needed
              5. Copy to config/rules.yaml for production use

            No LLMs or external AI services are used. All logic is deterministic.
        """),
    )
    parser.add_argument(
        '-i', '--input',
        default='sample.json',
        help='Path to JSON file containing error samples (default: sample.json)',
    )
    parser.add_argument(
        '-o', '--output',
        default='rules.yaml',
        help='Path for generated rules YAML file (default: rules.yaml)',
    )
    parser.add_argument(
        '--min-samples',
        type=int,
        default=1,
        help='Minimum number of samples required to generate a rule (default: 1)',
    )
    args = parser.parse_args()
    run_bootstrap(args.input, args.output, args.min_samples)


if __name__ == '__main__':
    main()
