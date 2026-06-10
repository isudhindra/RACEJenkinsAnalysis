// utils.js — Shared DOM helpers, formatters, and small utility functions used everywhere.
'use strict';

// DOM shorthand helpers.
function $id(id) { return document.getElementById(id); }
function show(id) { const el = $id(id); if (el) el.classList.remove('hidden'); }
function hide(id) { const el = $id(id); if (el) el.classList.add('hidden'); }
function setText(id, text) { const el = $id(id); if (el) el.textContent = text; }
function setHtml(id, html) { const el = $id(id); if (el) el.innerHTML = html; }
function showError(id, msg) { const el = $id(id); if (el) { el.textContent = msg; el.classList.remove('hidden'); el.style.display = ''; } }
function hideError(id) { const el = $id(id); if (el) el.classList.add('hidden'); }

// Canonical visibility toggle — prefer this over inline style.display so the
// .hidden class and inline styles don't fight each other.
function setVisible(elOrId, visible) {
    const el = (typeof elOrId === 'string') ? $id(elOrId) : elOrId;
    if (!el) return;
    el.classList.toggle('hidden', !visible);
    if (visible && el.style.display === 'none') el.style.display = '';
}

// HTML snippet for a single test-metric cell; muted zero, coloured otherwise.
function renderMetricValue(value, hasMetrics, colorClass) {
    if (!hasMetrics) return '—';
    if (value === 0) return '<span class="cell-metric-muted">0</span>';
    return '<span class="' + colorClass + '">' + value + '</span>';
}

// Format ISO timestamp as "25 Mar 2026, 09:49:30" with a relative-time tooltip.
function formatExecTime(isoString) {
    if (!isoString) return '—';
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '—';
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);
    const diffHrs = Math.floor(diffMin / 60);
    const diffDays = Math.floor(diffHrs / 24);

    let relativeStr;
    if (diffMin < 1) relativeStr = 'Just now';
    else if (diffMin < 60) relativeStr = diffMin + ' minute' + (diffMin !== 1 ? 's' : '') + ' ago';
    else if (diffHrs < 24) relativeStr = diffHrs + ' hour' + (diffHrs !== 1 ? 's' : '') + ' ago';
    else relativeStr = diffDays + ' day' + (diffDays !== 1 ? 's' : '') + ' ago';

    const day = d.getDate();
    const month = d.toLocaleString('en', { month: 'short' });
    const year = d.getFullYear();
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    const ss = d.getSeconds().toString().padStart(2, '0');
    const fullTimestamp = day + ' ' + month + ' ' + year + ', ' + hh + ':' + mm + ':' + ss;

    return '<span class="exec-time-full" title="' + relativeStr + '">' + fullTimestamp + '</span>';
}


//  Badge renderers 

// Coloured HTML badge for a build status (SUCCESS, FAILURE, etc.).
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

// Coloured confidence indicator for a log-analysis classification result.
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

//  Counter animation 

// Animate a number element rolling from its current value to `target`.
function animateCounterRoll(el, target) {
    // Cancel any in-flight animation so racing calls don't compound off a stale intermediate.
    if (el._counterRafId) {
        cancelAnimationFrame(el._counterRafId);
        el._counterRafId = null;
    }


    const displayed = parseInt(el.textContent.replace(/,/g, ''), 10) || 0;
    const cached = (typeof el._counterTarget === 'number') ? el._counterTarget : displayed;

    // Bail only when BOTH the cache AND the visible DOM are already correct.
    if (cached === target && displayed === target) return;

    // Animate from whatever is currently shown
    const current = displayed;

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

//  Freshness chip helpers ─
// The header "Data as of HH:MM:SS" pill tells release managers how current
// the dashboard data is. Call markDataFresh() after a successful poll, or
// markDataStale() when one fails.

function markDataFresh() {
    const chip = $id('header-freshness-chip');
    const lbl = $id('header-freshness-label');
    if (!chip || !lbl) return;
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    lbl.textContent = `Data as of ${hh}:${mm}:${ss}`;
    chip.classList.remove('is-stale');
    chip.hidden = false;
    chip.title = `Most recent successful data refresh at ${hh}:${mm}:${ss}`;
}

function markDataStale(reason) {
    const chip = $id('header-freshness-chip');
    const lbl = $id('header-freshness-label');
    if (!chip || !lbl) return;
    chip.classList.add('is-stale');
    chip.hidden = false;
    // Keep the last-good timestamp visible so the user sees both when the data
    // was last fresh and that the latest refresh attempt failed.
    if (lbl.textContent && !lbl.textContent.includes('stale')) {
        lbl.textContent = lbl.textContent + ' · stale';
    } else if (!lbl.textContent) {
        lbl.textContent = 'Stale — no recent data';
    }
    chip.title = reason
        ? `Last refresh attempt failed: ${reason}`
        : 'Most recent refresh attempt failed — data may be out of date.';
}

//  Row lookup helpers ─

// O(1) primary-row lookup via the rowEls perf cache populated by renderJobRow.
// Falls back to a DOM query if a row was inserted outside that path.
function getJobRowEl(jobId) {
    if (window.appState && appState.rowEls) {
        const cached = appState.rowEls.get(jobId);
        if (cached && cached.isConnected) return cached;
    }
    return document.querySelector(`tr[data-job-id="${escapeHtml(jobId)}"]:not(.detail-row)`);
}

// Detail rows follow the convention data-job-id="<jobId>_detail".
function getJobDetailRowEl(jobId) {
    if (window.appState && appState.detailRowEls) {
        const cached = appState.detailRowEls.get(jobId);
        if (cached && cached.isConnected) return cached;
    }
    return document.querySelector(`tr[data-job-id="${escapeHtml(jobId)}_detail"]`);
}

//  String / HTML helpers 

// Escape HTML so user-supplied strings are safe to inject.
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
        let clean = url.replace(/[.,;:!?)>\]]+$/, '');
        let href = clean.replace(/&amp;/g, '&');
        if (/^www\./i.test(href)) href = 'https://' + href;
        return '<a class="clv-link" href="' + href + '" target="_blank" rel="noopener noreferrer" title="Open in new tab">' + clean + '</a>';
    });
}

//  Query helpers 

// Job records whose table rows are currently visible (not hidden by filters).
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
