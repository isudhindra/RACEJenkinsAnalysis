// utils.js — Shared DOM helpers, formatters, and small utility functions.
// Every other module relies on these; keep them dependency-free.
'use strict';

// ── DOM shorthand helpers
// These keep repeated getElementById / classList calls concise across the codebase.
function $id(id) { return document.getElementById(id); }
function show(id) { const el = $id(id); if (el) el.classList.remove('hidden'); }
function hide(id) { const el = $id(id); if (el) el.classList.add('hidden'); }
function setText(id, text) { const el = $id(id); if (el) el.textContent = text; }
function setHtml(id, html) { const el = $id(id); if (el) el.innerHTML = html; }
function showError(id, msg) { const el = $id(id); if (el) { el.textContent = msg; el.style.display = 'block'; } }
function hideError(id) { const el = $id(id); if (el) el.style.display = 'none'; }

// Return an HTML snippet for a single test-metric cell value.
// Shows a muted "0" when the count is zero, or a coloured span otherwise.
function renderMetricValue(value, hasMetrics, colorClass) {
    if (!hasMetrics) return '—';
    if (value === 0) return '<span class="cell-metric-muted">0</span>';
    return '<span class="' + colorClass + '">' + value + '</span>';
}

// Turn an ISO timestamp into a human-readable "25 Mar 2026, 09:49:30" string
// with a relative-time tooltip (e.g. "3 hours ago").
function formatExecTime(isoString) {
    if (!isoString) return '—';
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '—';
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);
    const diffHrs = Math.floor(diffMin / 60);
    const diffDays = Math.floor(diffHrs / 24);

    // Build relative time string for tooltip
    let relativeStr;
    if (diffMin < 1) relativeStr = 'Just now';
    else if (diffMin < 60) relativeStr = diffMin + ' minute' + (diffMin !== 1 ? 's' : '') + ' ago';
    else if (diffHrs < 24) relativeStr = diffHrs + ' hour' + (diffHrs !== 1 ? 's' : '') + ' ago';
    else relativeStr = diffDays + ' day' + (diffDays !== 1 ? 's' : '') + ' ago';

    // Build full timestamp: "25 Mar 2026, 09:49:30"
    const day = d.getDate();
    const month = d.toLocaleString('en', { month: 'short' });
    const year = d.getFullYear();
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    const ss = d.getSeconds().toString().padStart(2, '0');
    const fullTimestamp = day + ' ' + month + ' ' + year + ', ' + hh + ':' + mm + ':' + ss;

    return '<span class="exec-time-full" title="' + relativeStr + '">' + fullTimestamp + '</span>';
}


// ── Badge renderers ────────────────────────────────────────────────────

// Return the coloured HTML badge for a build status (SUCCESS, FAILURE, etc.).
function renderStatusBadge(status) {
    const badges = {
        'SUCCESS': '<span class="badge badge-passed" aria-label="Passed">Passed</span>',
        'FAILURE': '<span class="badge badge-failed" aria-label="Failed">Failed</span>',
        'UNSTABLE': '<span class="badge badge-unstable" aria-label="Unstable">Unstable</span>',
        'ABORTED': '<span class="badge badge-aborted" aria-label="Aborted">Aborted</span>',
        'IN_PROGRESS': '<span class="badge badge-in-progress" aria-label="In Progress">In Progress</span>',
        'NOT_BUILT': '<span class="badge badge-grey" aria-label="Not Built">Not Built</span>',
        'UNKNOWN': '<span class="badge badge-grey" aria-label="Unknown">Unknown</span>'
    };
    return badges[status] || `<span class="badge badge-grey" aria-label="Unknown">${escapeHtml(status)}</span>`;
}

// Return the coloured confidence indicator (Strong , Partial , Unknown )
// for a log-analysis classification result.
function renderConfidenceBadge(confidence) {
    if (!confidence) return '<span class="confidence-badge confidence-unknown">Unknown</span>';

    const badges = {
        'Strong': '<span class="confidence-badge confidence-strong">Strong ✓</span>',
        'Partial': '<span class="confidence-badge confidence-partial">Partial ◐</span>',
        'Unknown': '<span class="confidence-badge confidence-unknown">Unknown ?</span>'
    };

    const tooltips = {
        'Strong': 'High confidence in the classification',
        'Partial': 'Moderate confidence, may need review',
        'Unknown': 'Classification confidence unknown'
    };

    const badge = badges[confidence] || badges['Unknown'];
    return badge.replace('>', ` title="${tooltips[confidence] || ''}">`);
}

// ── Counter animation 
function animateCounterRoll(el, target) {
    // Cancel any in-flight animation for this element to prevent
    // compounding race conditions where intermediate values become
    // the "current" baseline for the next animation.
    if (el._counterRafId) {
        cancelAnimationFrame(el._counterRafId);
        el._counterRafId = null;
    }

    // Read the authoritative target, not the animated intermediate
    const current = (typeof el._counterTarget === 'number') ? el._counterTarget : (parseInt(el.textContent.replace(/,/g, ''), 10) || 0);
    if (current === target) return;

    // Stamp the target so subsequent calls know the true destination
    el._counterTarget = target;

    const duration = 400;
    const startTime = performance.now();
    const diff = target - current;

    el.classList.remove('updating');
    void el.offsetWidth;
    el.classList.add('updating');

    function step(now) {
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        const val = Math.round(current + diff * eased);
        el.textContent = val.toLocaleString();
        if (progress < 1) {
            el._counterRafId = requestAnimationFrame(step);
        } else {
            el.textContent = target.toLocaleString();
            el._counterRafId = null;
        }
    }
    el._counterRafId = requestAnimationFrame(step);
}

// ── String / HTML helpers ──────────────────────────────────────────────

// Escape special HTML characters so user-supplied strings are safe to inject.
function escapeHtml(text) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return String(text).replace(/[&<>"']/g, m => map[m]);
}

// Turn plain-text URLs inside already-escaped HTML into clickable links.
// Used by the console-log viewer to make log URLs navigable.
const _clvUrlRe = /\b(?:https?:\/\/|ftp:\/\/|www\.)(?:&amp;|[^\s&<>"'()[\]{}]+|\([^\s&<>"']*\))+/gi;
function clvLinkifyHtml(escapedHtml) {
    return escapedHtml.replace(_clvUrlRe, function(url) {
        // Strip trailing punctuation that is unlikely part of the URL
        let clean = url.replace(/[.,;:!?)>\]]+$/, '');
        // Unescape &amp; back to & for the href attribute
        let href = clean.replace(/&amp;/g, '&');
        // For www.* matches, prepend https:// so the href is valid
        if (/^www\./i.test(href)) href = 'https://' + href;
        return '<a class="clv-link" href="' + href + '" target="_blank" rel="noopener noreferrer" title="Open in new tab">' + clean + '</a>';
    });
}

// ── Query helpers ──────────────────────────────────────────────────────

// Collect all job records whose table rows are currently visible (not hidden by filters).
function getVisibleJobs() {
    const visible = [];
    document.querySelectorAll('tbody tr[data-job-id]:not(.detail-row)').forEach(row => {
        if (row.style.display !== 'none') {
            const jobId = row.getAttribute('data-job-id');
            const job = appState.jobs.get(jobId);
            if (job) visible.push(job);
        }
    });
    return visible;
}
