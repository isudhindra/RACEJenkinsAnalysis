// utils.js — Shared DOM helpers, formatters, and small utility functions used everywhere.
'use strict';

// Local API token. apiFetch() attaches X-RACE-Token to every /api/* call;
// SSE callers use sseUrl() with ?token= because EventSource can't add headers.
window.RACE_TOKEN = (function () {
    try {
        const m = document.querySelector('meta[name="race-token"]');
        return m ? (m.getAttribute('content') || '') : '';
    } catch (_) { return ''; }
})();

// Two distinct 401 banners.
let _race401LocalBannerShown = false;
let _race401JenkinsBannerShown = false;

function _renderBanner(id, bg, message) {
    if (document.getElementById(id)) return;
    try {
        const banner = document.createElement('div');
        banner.id = id;
        banner.setAttribute('role', 'alert');
        // Stack a second banner under the first if both ever fire.
        const existing = document.querySelector('#race-auth-expired-banner, #race-jenkins-auth-banner');
        const topPx = existing ? (existing.offsetHeight + 0) : 0;
        banner.style.cssText = [
            'position:fixed', 'top:' + topPx + 'px', 'left:0', 'right:0',
            'background:' + bg, 'color:#FFFFFF',
            'padding:10px 16px', 'font-size:14px', 'font-weight:600',
            'text-align:center', 'z-index:99999',
            'box-shadow:0 2px 6px rgba(0,0,0,0.25)',
            'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
        ].join(';');
        banner.textContent = message;
        document.body.appendChild(banner);
    } catch (_) {
        try { console.error('[RACE] ' + message); } catch (__) {}
    }
}

// Local RACE-token failure — hard-refresh fixes it (rotated under us).
function _showAuthExpiredBanner() {
    if (_race401LocalBannerShown) return;
    _race401LocalBannerShown = true;
    _renderBanner(
        'race-auth-expired-banner',
        '#7F1D1D',
        'RACE session expired (local token rotated). Hard-refresh the page (Cmd/Ctrl + Shift + R) to reconnect.'
    );
}

// Upstream Jenkins 401 — usually a stale JENKINS_TEST_API_KEY. Hard-refresh
// will NOT fix this; the user needs to update the credential and restart RACE.
function _showJenkinsAuthBanner() {
    if (_race401JenkinsBannerShown) return;
    _race401JenkinsBannerShown = true;
    _renderBanner(
        'race-jenkins-auth-banner',
        '#B45309',
        'Jenkins rejected the stored credentials (401). Update JENKINS_TEST_USERNAME / JENKINS_TEST_API_KEY (env var or .env), then restart RACE.'
    );
}

// Thin wrapper around fetch() that attaches the X-RACE-Token header
function apiFetch(url, opts) {
    opts = opts || {};
    const headers = Object.assign({}, opts.headers || {});
    if (window.RACE_TOKEN) headers['X-RACE-Token'] = window.RACE_TOKEN;
    if (opts.body && typeof opts.body === 'string' && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
    }
    opts.headers = headers;
    const p = fetch(url, opts);
    p.then(function (resp) {
        if (!resp || resp.status !== 401) return;
        let authKind = '';
        try { authKind = (resp.headers && resp.headers.get('X-RACE-Auth-Error')) || ''; } catch (_) {}
        if (authKind === 'local-token') {
            _showAuthExpiredBanner();
            try {
                if (typeof diagLog === 'function') {
                    diagLog('warning', 'Auth',
                        'API returned 401 — local RACE token rotated or invalid; hard-refresh required',
                        { url: url, status: 401, kind: 'local-token' });
                }
            } catch (_) { /* diagnostics not loaded yet — banner is enough */ }
        } else {
            _showJenkinsAuthBanner();
            try {
                if (typeof diagLog === 'function') {
                    diagLog('warning', 'Jenkins auth',
                        'Upstream Jenkins returned 401 — stored JENKINS_TEST credentials may be expired or invalid',
                        { url: url, status: 401, kind: 'upstream-jenkins' });
                }
            } catch (_) { /* diagnostics not loaded yet — banner is enough */ }
        }
    }, function () { /* network error — caller handles */ });
    return p;
}

// SSE / EventSource URL helper — appends 
function sseUrl(url) {
    if (!window.RACE_TOKEN) return url;
    const sep = url.indexOf('?') === -1 ? '?' : '&';
    return url + sep + 'token=' + encodeURIComponent(window.RACE_TOKEN);
}

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

//  Freshness chip helpers

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

// Safe href — returns the URL ONLY if its scheme
function safeHref(url) {
    if (!url) return '#';
    try {
        const parsed = new URL(String(url), window.location.origin);
        return /^https?:$/.test(parsed.protocol) ? String(url) : '#';
    } catch (_) {
        // Malformed URL → safest possible value.
        return '#';
    }
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

// Priority-aware sort for auto-refresh enrichment ordering.
function sortJobUrlsByPriority(jobUrls) {
    const visibleList = (typeof getVisibleJobs === 'function') ? getVisibleJobs() : [];
    const visibleSet = new Set(visibleList.map(j => j.job_id || j.url));
    const selectedSet = (window.appState && appState.selectedJobs) || new Set();
    const jobs = (window.appState && appState.jobs) || new Map();
    function key(jobUrl) {
        const job = jobs.get(jobUrl);
        if (!job) return 5;
        if (job.is_running || job.latest_status === 'IN_PROGRESS') return 0;
        const visible = visibleSet.has(jobUrl);
        const selected = selectedSet.has(jobUrl);
        if (visible && selected) return 1;
        if (selected) return 2;
        if (visible && (job.latest_status === 'FAILURE' || job.latest_status === 'UNSTABLE')) return 3;
        if (visible) return 4;
        return 5;
    }
    return jobUrls.slice().sort((a, b) => key(a) - key(b));
}


function isAnyFilterActive() {
    const f = (window.appState && appState.filters) || {};
    if (f.status) return true;
    if (f.releaseStatus) return true;
    if (f.searchText && String(f.searchText).trim()) return true;
    if (Array.isArray(f.logAnalysisLabels) && f.logAnalysisLabels.length > 0) return true;
    // Promotion-time category chips (passed/failed/in-progress/not-run) live
    // in the DOM as checkboxes; treat any ticked one as an active filter.
    const promoCats = document.querySelectorAll('.promo-cat-chip input[type="checkbox"]:checked');
    if (promoCats.length > 0) return true;
    return false;
}

// Single source of truth for "which jobs does this action apply to?".
function getActionScope() {
    const totalCount = (window.appState && appState.jobs) ? appState.jobs.size : 0;

    // 1. Selection takes priority — explicit user intent.
    if (window.appState && appState.selectedJobs && appState.selectedJobs.size > 0) {
        const ids = Array.from(appState.selectedJobs);
        return { jobIds: ids, label: 'selected', count: ids.length, totalCount };
    }

    // 2. Any active filter scopes to currently-visible rows.
    if (isAnyFilterActive()) {
        const ids = getVisibleJobs().map(j => j.job_id);
        return { jobIds: ids, label: 'filtered', count: ids.length, totalCount };
    }

    // 3. Nothing narrowed — whole dataset.
    const all = (window.appState && appState.jobs) ? Array.from(appState.jobs.keys()) : [];
    return { jobIds: all, label: 'all', count: all.length, totalCount };
}

// Human-readable scope label for toasts. Example: "12 filtered jobs"
function describeScope(scope) {
    if (!scope || scope.count === 0) return 'no jobs';
    if (scope.label === 'selected') {
        return `${scope.count} selected job${scope.count === 1 ? '' : 's'}`;
    }
    if (scope.label === 'filtered') {
        return `${scope.count} filtered job${scope.count === 1 ? '' : 's'}`;
    }
    return `all ${scope.count} job${scope.count === 1 ? '' : 's'}`;
}

function updateScopeIndicator() {
    const stripEl = document.getElementById('scope-indicator');
    const headerEl = document.getElementById('header-job-count');
    const total = (window.appState && appState.jobs) ? appState.jobs.size : 0;

    if (headerEl) {
        if (total === 0) {
            headerEl.hidden = true;
            headerEl.innerHTML = '';
        } else {
            const visible = getVisibleJobs().length;
            const selected = (window.appState && appState.selectedJobs) ? appState.selectedJobs.size : 0;
            const filtered = isAnyFilterActive();
            let txt = filtered
                ? `Showing <strong>${visible}</strong> of <strong>${total}</strong> jobs`
                : `<strong>${total}</strong> job${total === 1 ? '' : 's'}`;
            if (selected > 0) {
                txt += ` <span class="scope-indicator-sep">·</span> <strong>${selected}</strong> selected`;
            }
            headerEl.innerHTML = txt;
            headerEl.hidden = false;
        }
    }

    const f = (window.appState && appState.filters) || {};
    const selected = (window.appState && appState.selectedJobs) ? appState.selectedJobs.size : 0;
    const filtered = isAnyFilterActive();


    const clearBtn = document.getElementById('toolbar-clear-filters');
    if (clearBtn) {
        clearBtn.hidden = !(filtered || selected > 0);
    }

    if (!stripEl) return;

    if (total === 0 || !filtered) {
        stripEl.classList.add('hidden');
        stripEl.innerHTML = '';
        return;
    }
    stripEl.classList.remove('hidden');


    const chips = [];
    if (f.status) {
        chips.push(_scopeChip('status: ' + String(f.status).toLowerCase(), 'status', 'status'));
    }
    if (f.releaseStatus) {
        chips.push(_scopeChip('release: ' + String(f.releaseStatus).toLowerCase().replace(/_/g, ' '), 'releaseStatus', 'release'));
    }
    if (f.searchText && String(f.searchText).trim()) {
        chips.push(_scopeChip('search: "' + String(f.searchText).trim().slice(0, 20) + '"', 'searchText', 'search'));
    }
    if (Array.isArray(f.logAnalysisLabels) && f.logAnalysisLabels.length > 0) {
        // Individual chip per label — × removes only that label.
        for (let i = 0; i < f.logAnalysisLabels.length; i++) {
            const label = f.logAnalysisLabels[i];
            chips.push(_scopeChipLabel(label));
        }
    }

    stripEl.innerHTML = chips.join(' ');
}

// Generic single-key chip. `category` selects the colour modifier
function _scopeChip(label, filterKey, category) {
    const modifier = category ? (' scope-filter-chip--' + category) : '';
    return '<span class="scope-filter-chip' + modifier + '">'
         + _escapeForAttr(label)
         + ' <button type="button" class="scope-filter-chip-x" '
         + 'data-action="remove-filter" '
         + 'data-filter-key="' + escapeHtml(filterKey) + '" '
         + 'aria-label="Remove this filter">×</button>'
         + '</span>';
}

// Per-label chip — × removes just that label from the array. Always
// styled as a log-analysis chip (sky-blue).
function _scopeChipLabel(label) {
    return '<span class="scope-filter-chip scope-filter-chip--label">'
         + _escapeForAttr(label)
         + ' <button type="button" class="scope-filter-chip-x" '
         + 'data-action="remove-label" '
         + 'data-label="' + escapeHtml(label) + '" '
         + 'aria-label="Remove label filter">×</button>'
         + '</span>';
}

// Document-level delegation so chip-x clicks survive every #scope-indicator repaint.
let _scopeChipDelegationInstalled = false;
function _installScopeChipDelegation() {
    if (_scopeChipDelegationInstalled) return;
    _scopeChipDelegationInstalled = true;
    document.addEventListener('click', function (e) {
        const btn = e.target && e.target.closest && e.target.closest('.scope-filter-chip-x');
        if (!btn) return;
        const action = btn.getAttribute('data-action');
        if (action === 'remove-filter') {
            const key = btn.getAttribute('data-filter-key') || '';
            if (typeof _scopeChipRemove === 'function') _scopeChipRemove(key);
        } else if (action === 'remove-label') {
            const label = btn.getAttribute('data-label') || '';
            if (typeof _scopeChipRemoveLabel === 'function') _scopeChipRemoveLabel(label);
        }
    });
}
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _installScopeChipDelegation);
    } else {
        _installScopeChipDelegation();
    }
}

function _scopeChipRemove(filterKey) {
    if (!window.appState || !appState.filters) return;
    if (filterKey === 'status') {
        appState.filters.status = null;
        var s = document.getElementById('filter-status'); if (s) s.value = '';
    } else if (filterKey === 'releaseStatus') {
        appState.filters.releaseStatus = null;
        var r = document.getElementById('filter-release-status'); if (r) r.value = '';
    } else if (filterKey === 'searchText') {
        appState.filters.searchText = '';
        var q = document.getElementById('filter-search'); if (q) q.value = '';
    } else if (filterKey === 'logAnalysisLabels') {
        appState.filters.logAnalysisLabels = [];
        if (typeof clearLogAnalysisFilter === 'function') clearLogAnalysisFilter();
    }
    if (typeof applyFilters === 'function') applyFilters();
    scrollTableToTop();
}

// Remove ONE label from the log-analysis array; preserve the rest.
function _scopeChipRemoveLabel(label) {
    if (!window.appState || !appState.filters) return;
    const arr = appState.filters.logAnalysisLabels;
    if (!Array.isArray(arr)) return;
    appState.filters.logAnalysisLabels = arr.filter(l => l !== label);
    // If the LA filter UI tracks selections itself, keep it in sync.
    if (typeof syncLogAnalysisFilterUI === 'function') {
        syncLogAnalysisFilterUI();
    }
    if (typeof applyFilters === 'function') applyFilters();
    scrollTableToTop();
}

// Snap the jobs table back to the top — used after filter/sort changes.
function scrollTableToTop() {
    var container = document.querySelector('.table-container');
    if (container && typeof container.scrollTo === 'function') {
        container.scrollTo({ top: 0, behavior: 'auto' });
    } else if (container) {
        container.scrollTop = 0;
    }
    // Also nudge the page itself so the table header is in view 
    var table = document.getElementById('job-table');
    if (table && typeof table.scrollIntoView === 'function') {
        // Use 'nearest' so we don't jump if it's already on-screen.
        try { table.scrollIntoView({ block: 'nearest', behavior: 'auto' }); } catch (_) {}
    }
}

// All 5 chars — safe for any HTML attribute context, not just text bodies.
function _escapeForAttr(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
