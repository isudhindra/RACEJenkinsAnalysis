'use strict';

// Map a backend ReleaseStatus enum value onto the legacy panel vocabulary.
function _releaseToRegression(releaseStatus, currentStatus) {
    switch (releaseStatus) {
        case 'PASS':    return 'passed';
        case 'FAIL':    return currentStatus === 'IN_PROGRESS' ? 'in_progress' : 'failed';
        case 'PENDING': return currentStatus === 'IN_PROGRESS' ? 'in_progress' : 'not_executed';
        case 'NA':      default: return 'not_executed';
    }
}

// Determine if a job has passed validation against a promotion baseline.
function deriveRegressionStatus(job, promotionTime) {
    if (!promotionTime || !job) return 'not_executed';

    // ---- Primary: trust the backend if it has spoken.
    if (typeof job.release_status === 'string' && job.release_status !== 'NA') {
        return _releaseToRegression(job.release_status, job.current_status);
    }

    // ---- Fallback: same rule, evaluated client-side.
    var seen = {};
    var pool = [];
    function consider(b) {
        if (!b || b.build_number == null || !b.timestamp) return;
        if (seen[b.build_number]) return;
        seen[b.build_number] = true;
        pool.push({
            status: b.status,
            timestamp: new Date(b.timestamp),
            buildNum: b.build_number,
        });
    }
    if (Array.isArray(job.recent_builds)) job.recent_builds.forEach(consider);
    var ctx = job.three_run_context || {};
    [ctx.latest, ctx.previous, ctx.last_passed].forEach(consider);

    var postRelease = pool.filter(function(b) {
        return !isNaN(b.timestamp.getTime()) && b.timestamp > promotionTime;
    });
    if (postRelease.length === 0) return 'not_executed';

    var hasPass = false, hasRunning = false;
    for (var i = 0; i < postRelease.length; i++) {
        if (postRelease[i].status === 'SUCCESS') { hasPass = true; break; }
        if (postRelease[i].status === 'IN_PROGRESS') hasRunning = true;
    }
    if (hasPass) return 'passed';
    if (hasRunning) return 'in_progress';
    return 'failed';
}

// Backwards-compatible no-ops so older call sites that reference the latch
// cache do not break.  Retire after the dashboard tree is cleaned up.
function clearValidationCache() { /* no-op: backend is now the source of truth */ }

// Generate HTML badge element for a regression status (validated, needs rerun, running, or not run)
function renderRegressionBadge(regressionStatus) {
    switch (regressionStatus) {
        case 'passed':
            return '<span class="regression-badge regression-badge-passed" title="Baseline validated \u2014 passed at least once since promotion"><span class="regression-badge-dot"></span>Validated</span>';
        case 'failed':
            return '<span class="regression-badge regression-badge-failed" title="Never passed since promotion \u2014 needs rerun"><span class="regression-badge-dot"></span>Needs Rerun</span>';
        case 'in_progress':
            return '<span class="regression-badge regression-badge-running" title="Currently running \u2014 no pass recorded yet for this baseline"><span class="regression-badge-dot"></span>Running</span>';
        case 'not_executed':
        default:
            return '<span class="regression-badge regression-badge-pending" title="No runs found after the promotion date"><span class="regression-badge-dot"></span>Not Run</span>';
    }
}

// Render a table cell containing the regression status badge for a job
function renderRegressionCell(job) {
    const pt = getPromotionTime();
    const status = deriveRegressionStatus(job, pt);
    return '<td class="cell-regression" data-regression="' + status + '">' + renderRegressionBadge(status) + '</td>';
}

// Promotion Time Accessors

const _PROMO_STORE_KEY = 'promotion_times';

function _currentEnv() {
    return (window.appState && appState._selectedEnvironment) ? appState._selectedEnvironment : '';
}

function _readPromoStore() {
    try { return JSON.parse(sessionStorage.getItem(_PROMO_STORE_KEY) || '{}') || {}; }
    catch (_) { return {}; }
}

function _writePromoStore(store) {
    try { sessionStorage.setItem(_PROMO_STORE_KEY, JSON.stringify(store)); }
    catch (_) { /* sessionStorage may be unavailable; ignore */ }
}

// Persist the current input value under the active environment.
function _persistCurrentEnvValue(value) {
    const env = _currentEnv();
    if (!env) return;
    const store = _readPromoStore();
    if (value) store[env] = value;
    else delete store[env];
    _writePromoStore(store);
}

// Load the saved promotion value for the active environment into the input.
// Called by config.js after an environment switch.
function loadPromotionTimeForCurrentEnv() {
    const input = document.getElementById('promotion-datetime');
    if (!input) return;
    const env = _currentEnv();
    const stored = env ? (_readPromoStore()[env] || '') : '';
    input.value = stored;
    _appliedPromoValue = stored;
    _clearPromoPending();
    applyPromotionTime();
}

// Get the currently selected promotion datetime from the input field, or null if not set
function getPromotionTime() {
    const input = document.getElementById('promotion-datetime');
    if (!input || !input.value) return null;
    const d = new Date(input.value);
    return isNaN(d.getTime()) ? null : d;
}

// Serialize the currently selected promotion time as an ISO-8601 string for
// the backend.  Returns '' when no time is set.  Single seam used by every
// fetch payload constructor — keep this and the backend's _parse_promotion_time
// in lockstep.
function getPromotionTimeISO() {
    const d = getPromotionTime();
    return d ? d.toISOString() : '';
}

// Set promotion time to a quick preset (now minus minutesAgo) and apply immediately
function setPromoQuick(minutesAgo) {
    const d = new Date(Date.now() - minutesAgo * 60000);
    // Format as YYYY-MM-DDTHH:MM for datetime-local input
    const pad = n => String(n).padStart(2, '0');
    const val = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
        + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    document.getElementById('promotion-datetime').value = val;
    _clearPromoPending();
    applyPromotionTime();
}

// Pending-State Management for Manual Date-Time Edits

// Track the last-applied promotion value so we can detect if user has unsaved changes
var _appliedPromoValue = '';

// Mark the datetime input as having a pending (unapplied) change and show the Apply button
function markPromoPending() {
    var input = document.getElementById('promotion-datetime');
    var applyBtn = document.getElementById('promo-apply-btn');
    if (!input) return;
    var isPending = input.value !== _appliedPromoValue;
    if (isPending) {
        input.classList.add('promo-pending');
        if (applyBtn) applyBtn.classList.remove('hidden');
    } else {
        _clearPromoPending();
    }
}

// Clear the pending visual state (remove CSS class and hide Apply button)
function _clearPromoPending() {
    var input = document.getElementById('promotion-datetime');
    var applyBtn = document.getElementById('promo-apply-btn');
    if (input) input.classList.remove('promo-pending');
    if (applyBtn) applyBtn.classList.add('hidden');
}

// User clicked Apply button — confirm the datetime and trigger recalculation
function confirmPromoApply() {
    _clearPromoPending();
    applyPromotionTime();
}

// Core Promotion State Engine

// Evaluate all jobs and return categorized counts and lists for passed, failed, in-progress, and not-executed statuses
// Also returns aggregated test metrics (total, passed, failed, skipped, errors) for visualization
function evaluateRegressionCategories(promotionTime) {
    const _zeroTests = () => ({ total: 0, passed: 0, failed: 0, skipped: 0, errors: 0 });
    const result = {
        passed: [], failed: [], not_executed: [], in_progress: [],
        total: 0,
        tests: _zeroTests(),
        testsByCategory: {
            passed: _zeroTests(), failed: _zeroTests(),
            in_progress: _zeroTests(), not_executed: _zeroTests(),
        },
        jobsWithTests: 0,
    };
    if (!promotionTime) return result;

    appState.jobs.forEach((job, jobId) => {
        const rs = deriveRegressionStatus(job, promotionTime);
        result[rs].push(jobId);
        result.total++;

        // Only count test metrics from jobs that actually ran after the promotion time
        // Jobs classified as 'not_executed' have no qualifying runs in the validation window
        if (rs === 'not_executed') return;

        const m = job.test_metrics;
        if (!m || m.metrics_unavailable) return;
        const p = safeMetric(m, 'passed'), f = safeMetric(m, 'failed');
        const s = safeMetric(m, 'skipped'), e = safeMetric(m, 'errors');
        const partsSum = p + f + s + e;
        const effectiveRun = Math.max(safeMetric(m, 'total'), partsSum);
        if (effectiveRun === 0 && partsSum === 0) return;

        result.jobsWithTests++;
        // Add metrics to both global and per-category buckets
        for (const bucket of [result.tests, result.testsByCategory[rs]]) {
            bucket.total += effectiveRun;
            bucket.passed += p;
            bucket.failed += f;
            bucket.skipped += s;
            bucket.errors += e;
        }
    });

    // Safety check: total should never be less than sum of parts
    const gps = result.tests.passed + result.tests.failed + result.tests.skipped + result.tests.errors;
    if (result.tests.total < gps) result.tests.total = gps;

    return result;
}

// Master state updater — called when promotion time changes or jobs refresh.
// Updates table visibility, summary strip, action buttons, and category checkboxes based on new regression status.
function applyPromotionTime() {
    const promotionTime = getPromotionTime();

    // Remember the applied value for pending-state detection
    var input = document.getElementById('promotion-datetime');
    _appliedPromoValue = input ? input.value : '';

    // Warn (non-blocking) if the user picked a future timestamp.  Backend
    // compute_release_status() correctly returns PENDING for every job in
    // that case, but the user just sees "all Not Run" with no explanation
    // — the toast tells them why.  Suppressed when clearing.
    if (promotionTime && promotionTime.getTime() > Date.now() && typeof showToast === 'function') {
        showToast('Promotion time is in the future — every job will show as Pending until a build runs after it.', 'warning');
    }

    // Persist under the current environment so switching contexts restores it.
    _persistCurrentEnvValue(_appliedPromoValue);

    appState.promotionTime = promotionTime;

    const table = document.getElementById('job-table');
    const clearBtn = document.getElementById('promotion-clear-btn');
    const summaryStrip = document.getElementById('promo-summary-strip');
    const actionRow = document.getElementById('promo-action-row');

    // Show/hide the Release Status filter dropdown alongside the column.
    var releaseFilter = document.getElementById('filter-release-status');
    if (promotionTime) {
        table.classList.add('promotion-active');
        clearBtn.classList.remove('hidden');
        if (releaseFilter) releaseFilter.classList.remove('hidden');
    } else {
        table.classList.remove('promotion-active');
        clearBtn.classList.add('hidden');
        summaryStrip.classList.add('hidden');
        actionRow.classList.add('hidden');
        clearValidationCache();
        if (releaseFilter) {
            releaseFilter.value = '';
            releaseFilter.classList.add('hidden');
        }
        // Drop any stored release-status filter so applyFilters() doesn't
        // continue suppressing rows after the column disappears.
        if (appState && appState.filters) appState.filters.releaseStatus = null;
        // Uncheck category filters when clearing promotion
        const cbNotRun = document.getElementById('promo-cat-notrun');
        const cbFailed = document.getElementById('promo-cat-failed');
        if (cbNotRun) cbNotRun.checked = false;
        if (cbFailed) cbFailed.checked = false;
    }

    // Refresh job.release_status in place using the data already loaded
    // in the browser — pure JS, no Jenkins round-trip.  Without this,
    // every job's release_status stays at whatever the original fetch
    // returned (typically "NA" when promotion wasn't yet set), the
    // Release-Status filter matches nothing, and the regression badges
    // and dual-panel KPI render stale values.
    _recomputeAllReleaseStatusInPlace(promotionTime);

    // Recalculate all regression status cells in the table
    recalculateAllRegressionCells(promotionTime);
    // Adjust colspan for detail rows when promotion column is visible
    updateDetailRowColspan();
    // Refresh the summary panel and action buttons
    updatePromotionPanel(promotionTime);
    // Switch KPI layout between single-column (Job Health) and two-column (with Release Validation)
    toggleKpiLayout();

    // Re-run filters so the Release-Status dropdown's visibility change is
    // reflected in the table.  Without this, clearing promotion (which sets
    // appState.filters.releaseStatus = null) leaves rows hidden by a
    // previously-set release filter; and setting promotion fresh keeps any
    // stale release filter from a saved view active without re-evaluating.
    if (typeof applyFilters === 'function') applyFilters();

}


// ── Client-side release_status recompute on promotion change ───────────
//
// The backend computes release_status server-side when promotion_time
// is in the request body, but we don't want to re-pull every job from
// Jenkins just because the user picked a different baseline.  This
// helper recomputes release_status purely from data already in the
// browser (recent_builds + three_run_context) using the *exact* same
// rule as jjat/models.py compute_release_status.  Pure JS, no network,
// sub-10ms for 500 jobs.
//
// Authoritative server values continue to win whenever they arrive
// (Fetch / Refresh / auto-refresh enrichment all carry promotion_time
// and overwrite the field via mergeEnrichmentFields).

function _recomputeReleaseStatusForJob(job, promotionTime) {
    if (!promotionTime) return 'NA';

    // Pool every build we know about for this job, deduped by build_number.
    // Sources: recent_builds + three_run_context's latest/previous/last_passed.
    // last_passed is critical — it may be older than the recent window
    // but still newer than the promotion cutoff, in which case the job
    // has already passed validation and must NOT report as FAIL.
    const pool = new Map();
    function consider(b) {
        if (!b || b.build_number == null || !b.timestamp) return;
        if (pool.has(b.build_number)) return;
        const ts = new Date(b.timestamp);
        if (isNaN(ts.getTime())) return;
        pool.set(b.build_number, { status: b.status, timestamp: ts });
    }
    if (Array.isArray(job.recent_builds)) job.recent_builds.forEach(consider);
    const ctx = job.three_run_context;
    if (ctx) {
        consider(ctx.latest);
        consider(ctx.previous);
        consider(ctx.last_passed);
    }

    let hasPostPromo = false;
    let hasPass = false;
    pool.forEach(b => {
        if (b.timestamp <= promotionTime) return;
        hasPostPromo = true;
        if (b.status === 'SUCCESS') hasPass = true;
    });

    if (!hasPostPromo) return 'PENDING';
    return hasPass ? 'PASS' : 'FAIL';
}

function _recomputeAllReleaseStatusInPlace(promotionTime) {
    if (!window.appState || !appState.jobs) return;
    appState.jobs.forEach(job => {
        job.release_status = _recomputeReleaseStatusForJob(job, promotionTime);
    });
}

// Clear the promotion datetime and reset the dashboard
function clearPromotionTime() {
    document.getElementById('promotion-datetime').value = '';
    _clearPromoPending();
    applyPromotionTime();
}

// Refresh regression status badges in all visible table rows
function recalculateAllRegressionCells(promotionTime) {
    const rows = document.querySelectorAll('tbody tr[data-job-id]:not(.detail-row)');
    rows.forEach(row => {
        const jobId = row.getAttribute('data-job-id');
        const job = appState.jobs.get(jobId);
        const cell = row.querySelector('.cell-regression');
        if (cell && job) {
            const status = deriveRegressionStatus(job, promotionTime);
            cell.setAttribute('data-regression', status);
            cell.innerHTML = renderRegressionBadge(status);
        }
    });
}

// Update colspan for detail rows when regression column is added/removed
function updateDetailRowColspan() {
    const promotionActive = document.getElementById('job-table').classList.contains('promotion-active');
    const detailRows = document.querySelectorAll('tbody tr.detail-row td[colspan]');
    detailRows.forEach(td => {
        td.setAttribute('colspan', promotionActive ? '16' : '15');
    });
}

// Update the promotion panel: summary counts, category checkboxes, and rerun button state
function updatePromotionPanel(promotionTime) {
    const summaryStrip = document.getElementById('promo-summary-strip');
    const actionRow = document.getElementById('promo-action-row');
    const allPassedBadge = document.getElementById('promo-all-passed-badge');
    const rerunBtn = document.getElementById('promo-rerun-btn');
    const actionLabel = actionRow.querySelector('.promo-action-label');

    if (!promotionTime || appState.jobs.size === 0) {
        summaryStrip.classList.add('hidden');
        actionRow.classList.add('hidden');
        return;
    }

    const cats = evaluateRegressionCategories(promotionTime);

    // Update summary strip with counts for each category
    document.getElementById('promo-count-passed').textContent = cats.passed.length;
    document.getElementById('promo-count-failed').textContent = cats.failed.length;
    document.getElementById('promo-count-notrun').textContent = cats.not_executed.length;
    // Show in-progress chip only if there are running jobs
    const inProgChip = document.getElementById('promo-chip-inprog');
    const hasInProg = cats.in_progress.length > 0;
    if (inProgChip) {
        inProgChip.style.display = hasInProg ? '' : 'none';
        document.getElementById('promo-count-inprog').textContent = cats.in_progress.length;
    }
    summaryStrip.classList.remove('hidden');

    // Show action row with category filters
    actionRow.classList.remove('hidden');

    const hasNotRun = cats.not_executed.length > 0;
    const hasFailed = cats.failed.length > 0;
    const allPassed = !hasNotRun && !hasFailed && !hasInProg;

    // Show/hide category checkboxes based on whether jobs exist in those categories
    const notRunWrap = document.getElementById('promo-cat-notrun-wrap');
    const failedWrap = document.getElementById('promo-cat-failed-wrap');
    const notRunCount = document.getElementById('promo-cat-notrun-count');
    const failedCount = document.getElementById('promo-cat-failed-count');

    notRunWrap.style.display = hasNotRun ? '' : 'none';
    failedWrap.style.display = hasFailed ? '' : 'none';
    notRunCount.textContent = hasNotRun ? '(' + cats.not_executed.length + ')' : '';
    failedCount.textContent = hasFailed ? '(' + cats.failed.length + ')' : '';

    // If all jobs passed, show success badge instead of rerun controls
    if (allPassed) {
        if (actionLabel) actionLabel.style.display = 'none';
        notRunWrap.style.display = 'none';
        failedWrap.style.display = 'none';
        rerunBtn.style.display = 'none';
        allPassedBadge.classList.remove('hidden');
    } else {
        if (actionLabel) actionLabel.style.display = '';
        rerunBtn.style.display = '';
        allPassedBadge.classList.add('hidden');
    }

    // Enable/disable rerun button based on selected categories
    updatePromoRerunState();
}

// Enable/disable rerun button based on which category checkboxes are selected
function updatePromoRerunState() {
    const cbNotRun = document.getElementById('promo-cat-notrun');
    const cbFailed = document.getElementById('promo-cat-failed');
    const btn = document.getElementById('promo-rerun-btn');
    const anySelected = (cbNotRun && cbNotRun.checked) || (cbFailed && cbFailed.checked);
    btn.disabled = !anySelected;

    // Update button label with count of jobs that will be rerun
    if (anySelected) {
        const pt = getPromotionTime();
        const cats = evaluateRegressionCategories(pt);
        let count = 0;
        if (cbNotRun && cbNotRun.checked) count += cats.not_executed.length;
        if (cbFailed && cbFailed.checked) count += cats.failed.length;
        btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>'
            + 'Rerun ' + count + ' Job' + (count !== 1 ? 's' : '');
    } else {
        btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>'
            + 'Rerun Pending Jobs';
    }
}

// Trigger reruns for jobs in the selected regression categories (not-run and/or failed)
function triggerRegressionRerun() {
    const pt = getPromotionTime();
    if (!pt) return;

    const cats = evaluateRegressionCategories(pt);
    const cbNotRun = document.getElementById('promo-cat-notrun');
    const cbFailed = document.getElementById('promo-cat-failed');
    const jobIds = [];

    if (cbNotRun && cbNotRun.checked) jobIds.push(...cats.not_executed);
    if (cbFailed && cbFailed.checked) jobIds.push(...cats.failed);

    if (jobIds.length === 0) {
        showToast('No jobs selected for rerun', 'info');
        return;
    }

    showToast('Triggering rerun for ' + jobIds.length + ' pending job' + (jobIds.length !== 1 ? 's' : '') + '...', 'info');
    triggerRerun(jobIds);
}

// Sub-functions for renderJobRow (JS item 12)

