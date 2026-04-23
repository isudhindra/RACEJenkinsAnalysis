// kpi.js — KPI panels and summary-bar metrics.
// Owns the "Jobs Health" and "Release Validation" number panels,
// the degraded-mode indicator, the empty-state toggle, and toast notifications.
'use strict';

// ── Metric helpers ─────────────────────────────────────────────────────

// Safely read a numeric metric field; returns 0 for null, undefined, or negative values.
function safeMetric(m, field) {
    const v = m[field];
    return (typeof v === 'number' && v >= 0) ? v : 0;
}

// Return true when a test_metrics object contains real data (not unavailable/empty).
function hasUsableMetrics(m) {
    return m && !m.metrics_unavailable && m.total !== undefined && m.total !== null;
}

// Walk a list of jobs and sum up their test-case counts (passed, failed, skipped, errors).
// Uses effectiveRun = max(reported total, sum-of-parts) to handle inconsistent Jenkins data.
function aggregateTestMetrics(jobs) {
    let total = 0, passed = 0, failed = 0, skipped = 0, errors = 0, jobsWithTests = 0;
    for (const job of jobs) {
        const m = job.test_metrics;
        if (!m || m.metrics_unavailable) continue;
        const p = safeMetric(m, 'passed');
        const f = safeMetric(m, 'failed');
        const s = safeMetric(m, 'skipped');
        const e = safeMetric(m, 'errors');
        const partsSum = p + f + s + e;
        const effectiveRun = Math.max(safeMetric(m, 'total'), partsSum);
        if (effectiveRun === 0 && partsSum === 0) continue;
        jobsWithTests++;
        total += effectiveRun;
        passed += p;
        failed += f;
        skipped += s;
        errors += e;
    }
    // Final safety: ensure denominator >= sum-of-parts
    const gps = passed + failed + skipped + errors;
    if (total < gps) total = gps;
    return { total, passed, failed, skipped, errors, jobsWithTests };
}

// Convert raw counts into clamped [0, 100] percentages given a denominator.
function calcPercentages(denominator, parts) {
    const result = {};
    for (const [key, val] of Object.entries(parts)) {
        result[key] = denominator > 0 ? Math.min(val / denominator * 100, 100) : 0;
    }
    return result;
}

// Animate a batch of counter elements to their new numeric values.
// Accepts an array of [elementId, numericValue] pairs.
function updateCounters(updates) {
    for (const [id, val] of updates) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (el.textContent !== val.toLocaleString()) {
            animateCounterRoll(el, val);
        }
    }
}

// Set a batch of percentage label elements to their new values (e.g. "83.2%").
function updatePctLabels(updates) {
    for (const [id, pct] of updates) {
        const el = document.getElementById(id);
        if (el) el.textContent = pct.toFixed(1) + '%';
    }
}

// Reset every KPI counter and percentage label back to zero.
// Called when the dashboard state is cleared (e.g. before a new fetch).
function resetAllKPIDisplays() {
    for (const el of document.querySelectorAll('.kpi-metric-val')) {
        if (el._counterRafId) { cancelAnimationFrame(el._counterRafId); el._counterRafId = null; }
        el._counterTarget = 0;
        el.textContent = '0';
    }
    for (const el of document.querySelectorAll('.kpi-metric-pct')) {
        el.textContent = '0%';
    }
    // Named subtitle counters that sit outside .kpi-metric blocks
    for (const id of ['summary-total-tests', 'kpi-job-count', 'reg-total-jobs', 'reg-total-tests']) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (el._counterRafId) { cancelAnimationFrame(el._counterRafId); el._counterRafId = null; }
        el._counterTarget = 0;
        el.textContent = '0';
    }
}

// ── Summary bar ────────────────────────────────────────────────────────

// Recompute and display the top-level "Jobs Health" KPI panel
// by aggregating test metrics across all loaded jobs.
function updateSummaryBar() {
    const jobs = Array.from(appState.jobs.values());
    const agg = aggregateTestMetrics(jobs);
    const pct = calcPercentages(agg.total, {
        passed: agg.passed, failed: agg.failed, skipped: agg.skipped, errors: agg.errors
    });

    updateCounters([
        ['summary-total-tests', agg.total],
        ['summary-passed-tests', agg.passed],
        ['summary-failed-tests', agg.failed],
        ['summary-skipped-tests', agg.skipped],
        ['summary-errors-tests', agg.errors],
    ]);
    updatePctLabels([
        ['kpi-pct-passed',  pct.passed],
        ['kpi-pct-failed',  pct.failed],
        ['kpi-pct-skipped', pct.skipped],
        ['kpi-pct-errors',  pct.errors],
    ]);

    // Update job count in subtitle
    const jobCountEl = document.getElementById('kpi-job-count');
    if (jobCountEl) {
        const jc = appState.jobs.size;
        jobCountEl.textContent = jc > 0 ? jc : '0';
    }

    checkDegradedMode(jobs);
    updateToolbarActions();
    toggleKpiLayout();

    // Trigger KPI reveal animation when first meaningful data arrives
    motionRevealKPI();
}

// Show a warning banner when more than 30% of jobs have incomplete data,
// indicating that Jenkins may have timed out or been rate-limited.
function checkDegradedMode(jobs) {
    const nonCompleteCount = jobs.filter(j => j.data_completeness && j.data_completeness !== 'COMPLETE').length;
    const pct = jobs.length > 0 ? (nonCompleteCount / jobs.length) * 100 : 0;

    const indicator = document.getElementById('degraded-mode-indicator');
    if (pct > 30) {
        indicator.innerHTML = `<div class="degraded-indicator">⚠ Degraded Mode: ${Math.round(pct)}% incomplete data</div>`;
        indicator.style.display = 'block';
    } else {
        indicator.style.display = 'none';
    }
}

// ── KPI layout toggle ──────────────────────────────────────────────────

// Switch between single-panel (Jobs Health only) and dual-panel
// (Jobs Health + Release Validation) layout depending on whether
// a promotion baseline datetime has been set.
function toggleKpiLayout() {
    const container = document.getElementById('kpi-container');
    const promotionTime = getPromotionTime();
    if (promotionTime) {
        container.classList.add('kpi-split');
        updateRegressionKPI(promotionTime);
    } else {
        container.classList.remove('kpi-split');
    }
}

// Compute and render the Release Validation KPI panel.
// Categorises each job as validated / needs-rerun / not-run relative to the
// promotion baseline, then updates the counters and percentages.
function updateRegressionKPI(promotionTime) {
    if (!promotionTime) return;
    const cats = evaluateRegressionCategories(promotionTime);

    // Test-case metrics (mirrors the Jobs Health panel)
    const t = cats.tests;
    const tPct = calcPercentages(t.total, {
        passed: t.passed, failed: t.failed, skipped: t.skipped, errors: t.errors
    });

    updateCounters([
        ['reg-total-tests',   t.total],
        ['reg-tests-passed',  t.passed],
        ['reg-tests-failed',  t.failed],
        ['reg-tests-skipped', t.skipped],
        ['reg-tests-errors',  t.errors],
    ]);
    updatePctLabels([
        ['reg-tests-pct-passed',  tPct.passed],
        ['reg-tests-pct-failed',  tPct.failed],
        ['reg-tests-pct-skipped', tPct.skipped],
        ['reg-tests-pct-errors',  tPct.errors],
    ]);

    // Job-level validation status (passed / failed / in-progress / not-run)
    const jPct = calcPercentages(cats.total, {
        passed: cats.passed.length, failed: cats.failed.length,
        inprog: cats.in_progress.length, notrun: cats.not_executed.length
    });

    updateCounters([
        ['reg-total-jobs',   cats.total],
        ['reg-passed-count', cats.passed.length],
        ['reg-failed-count', cats.failed.length],
        ['reg-inprog-count', cats.in_progress.length],
        ['reg-notrun-count', cats.not_executed.length],
    ]);
    updatePctLabels([
        ['reg-pct-passed', jPct.passed],
        ['reg-pct-failed', jPct.failed],
        ['reg-pct-inprog', jPct.inprog],
        ['reg-pct-notrun', jPct.notrun],
    ]);
}

// ── Empty state ────────────────────────────────────────────────────────

// Show or hide the "no jobs loaded" / "no results match filter" placeholders
// depending on whether jobs exist and whether any rows pass the active filters.
function updateEmptyState() {
    const hasJobs = appState.jobs.size > 0;
    const table = $id('job-table');
    const noResults = $id('no-results-state');
    if (hasJobs) {
        $id('empty-state').classList.add('hidden');
        table.classList.remove('hidden');
        table.style.display = 'table';
        // Check if all rows are filtered out
        const visibleRows = document.querySelectorAll('tbody tr[data-job-id]:not(.detail-row):not([style*="display: none"])');
        const allFiltered = visibleRows.length === 0;
        const hasActiveFilter = !!(appState.filters.status || appState.filters.searchText || appState.filters.logAnalysisLabel);
        if (noResults) noResults.classList.toggle('hidden', !(allFiltered && hasActiveFilter));
    } else {
        $id('empty-state').classList.remove('hidden');
        table.classList.add('hidden');
        if (noResults) noResults.classList.add('hidden');
    }
}

// ── Toast notifications ────────────────────────────────────────────────

// Display a temporary toast message at the bottom of the screen.
// Type can be 'info', 'success', 'error', or 'warning'.
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('toast-exit');
        toast.addEventListener('animationend', () => toast.remove(), { once: true });
        // Safety fallback if animationend doesn't fire
        setTimeout(() => { if (toast.parentNode) toast.remove(); }, 400);
    }, 5000);
}
