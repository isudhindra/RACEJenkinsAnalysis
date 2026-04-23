// Jenkins Dashboard — promotion module for managing code promotion validation and regression testing.
// Handles promotion datetime selection, regression status tracking for jobs, and UI updates for release validation.
'use strict';

// PROMOTION BASELINE VALIDATION

// Cache to prevent a job from reverting from 'passed' back to 'failed' for the same promotion baseline
// Key: jobId, Value: { promoKey, status: 'passed', validatedAt: Date }
// promoKey is based on promotion time so cache auto-invalidates when user selects a different datetime
var _validationCache = new Map();

// Convert promotion time to a unique key string for cache comparison
function _promoKey(promotionTime) {
    return promotionTime ? promotionTime.getTime().toString() : '';
}

// Clear the validation cache when needed (e.g., when resetting dashboard)
function clearValidationCache() {
    _validationCache.clear();
}

// Determine if a job has passed validation against a promotion baseline.
// Returns one of: 'passed' (job ran successfully at least once after promotion),
// 'failed' (no success since promotion), 'in_progress', or 'not_executed' (no runs after promotion).
// Result is latched — once validated, it stays validated for the same promotion time.
function deriveRegressionStatus(job, promotionTime) {
    if (!promotionTime || !job) return 'not_executed';

    var jobId = job.job_id || job.url || job.name || job.job_name || '';
    var pk = _promoKey(promotionTime);

    // Check the validation latch first — once passed, stays passed for this promotion baseline
    var cached = _validationCache.get(jobId);
    if (cached && cached.promoKey === pk && cached.status === 'passed') {
        return 'passed';
    }

    // Collect all available builds from recent_builds and three_run_context
    var builds = [];
    var seen = {};  // deduplicate by build_number

    if (Array.isArray(job.recent_builds) && job.recent_builds.length > 0) {
        for (var i = 0; i < job.recent_builds.length; i++) {
            var rb = job.recent_builds[i];
            if (rb && rb.timestamp && rb.build_number != null) {
                seen[rb.build_number] = true;
                builds.push({
                    status: rb.status,
                    timestamp: new Date(rb.timestamp),
                    buildNum: rb.build_number,
                });
            }
        }
    }

    // Fallback: add builds from three_run_context (latest, previous, last_passed) if not already seen
    var ctx = job.three_run_context || {};
    var ctxEntries = [ctx.latest, ctx.previous, ctx.last_passed];
    for (var j = 0; j < ctxEntries.length; j++) {
        var entry = ctxEntries[j];
        if (entry && entry.timestamp && entry.build_number != null && !seen[entry.build_number]) {
            seen[entry.build_number] = true;
            builds.push({
                status: entry.status,
                timestamp: new Date(entry.timestamp),
                buildNum: entry.build_number,
            });
        }
    }

    // Keep only builds that happened after the promotion time
    var postRelease = builds.filter(function(b) {
        return !isNaN(b.timestamp.getTime()) && b.timestamp > promotionTime;
    });

    if (postRelease.length === 0) return 'not_executed';

    // Check if at least one build succeeded (validation = passed) or if any are running
    var hasPass = false;
    var hasRunning = false;
    for (var k = 0; k < postRelease.length; k++) {
        if (postRelease[k].status === 'SUCCESS') { hasPass = true; break; }
        if (postRelease[k].status === 'IN_PROGRESS') hasRunning = true;
    }

    if (hasPass) {
        // Cache the validated state so it persists even if the passing build leaves the recent_builds window
        _validationCache.set(jobId, {
            promoKey: pk,
            status: 'passed',
            validatedAt: new Date()
        });
        return 'passed';
    }
    if (hasRunning) return 'in_progress';
    return 'failed';
}

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

// Get the currently selected promotion datetime from the input field, or null if not set
function getPromotionTime() {
    const input = document.getElementById('promotion-datetime');
    if (!input || !input.value) return null;
    const d = new Date(input.value);
    return isNaN(d.getTime()) ? null : d;
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

    // If promotion time changed, clear validation cache so jobs are re-evaluated fresh
    var oldKey = appState.promotionTime ? _promoKey(appState.promotionTime) : '';
    var newKey = promotionTime ? _promoKey(promotionTime) : '';
    if (oldKey !== newKey) clearValidationCache();

    appState.promotionTime = promotionTime;

    const table = document.getElementById('job-table');
    const clearBtn = document.getElementById('promotion-clear-btn');
    const summaryStrip = document.getElementById('promo-summary-strip');
    const actionRow = document.getElementById('promo-action-row');

    if (promotionTime) {
        table.classList.add('promotion-active');
        clearBtn.classList.remove('hidden');
    } else {
        table.classList.remove('promotion-active');
        clearBtn.classList.add('hidden');
        summaryStrip.classList.add('hidden');
        actionRow.classList.add('hidden');
        clearValidationCache();
        // Uncheck category filters when clearing promotion
        const cbNotRun = document.getElementById('promo-cat-notrun');
        const cbFailed = document.getElementById('promo-cat-failed');
        if (cbNotRun) cbNotRun.checked = false;
        if (cbFailed) cbFailed.checked = false;
    }

    // Recalculate all regression status cells in the table
    recalculateAllRegressionCells(promotionTime);
    // Adjust colspan for detail rows when promotion column is visible
    updateDetailRowColspan();
    // Refresh the summary panel and action buttons
    updatePromotionPanel(promotionTime);
    // Switch KPI layout between single-column (Job Health) and two-column (with Release Validation)
    toggleKpiLayout();
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

