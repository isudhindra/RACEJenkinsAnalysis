// KPI panels (Jobs Health + Release Validation), shared metric helpers,
// toast notifications, and degraded-data banner.
'use strict';

// Read a numeric metric field, clamping null/undefined/negatives to 0.
function safeMetric(m, field) {
    const v = m[field];
    return (typeof v === 'number' && v >= 0) ? v : 0;
}

// True when test_metrics has at least one real number (not unavailable/empty).
function hasUsableMetrics(m) {
    if (!m || m.metrics_unavailable) return false;
    const fields = ['total', 'passed', 'failed', 'skipped', 'errors'];
    for (let i = 0; i < fields.length; i++) {
        const v = m[fields[i]];
        if (typeof v === 'number' && v >= 0) return true;
    }
    return false;
}

// Best-effort total: max(reported total, sum of parts) — covers parsers that
// under-report `total` but report each part correctly.
function effectiveTotal(m) {
    if (!m) return 0;
    const partsSum = safeMetric(m, 'passed') + safeMetric(m, 'failed')
                   + safeMetric(m, 'skipped') + safeMetric(m, 'errors');
    return Math.max(safeMetric(m, 'total'), partsSum);
}

// Single source of truth for per-job test metric extraction — used by KPIs,
// table cells, and CSV export so numbers stay consistent across the UI.
function extractJobMetrics(job) {
    const m = job && job.test_metrics;
    if (!m || m.metrics_unavailable) {
        return { hasMetrics: false, total: 0, passed: 0, failed: 0, skipped: 0, errors: 0 };
    }
    const passed  = safeMetric(m, 'passed');
    const failed  = safeMetric(m, 'failed');
    const skipped = safeMetric(m, 'skipped');
    const errors  = safeMetric(m, 'errors');
    const partsSum = passed + failed + skipped + errors;
    const total = Math.max(safeMetric(m, 'total'), partsSum);
    const hasMetrics = total > 0 || partsSum > 0;
    return { hasMetrics, total, passed, failed, skipped, errors };
}

// Fold a per-job snapshot into a running totals bucket.
function addMetricsBucket(bucket, snap) {
    bucket.total   += snap.total;
    bucket.passed  += snap.passed;
    bucket.failed  += snap.failed;
    bucket.skipped += snap.skipped;
    bucket.errors  += snap.errors;
}

// Sum test-case counts across a job list.
function aggregateTestMetrics(jobs) {
    const bucket = { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0 };
    let jobsWithTests = 0;
    for (const job of jobs) {
        const snap = extractJobMetrics(job);
        if (!snap.hasMetrics) continue;
        addMetricsBucket(bucket, snap);
        jobsWithTests++;
    }
    // Defensive: denominator must be at least the sum of its parts.
    const gps = bucket.passed + bucket.failed + bucket.skipped + bucket.errors;
    if (bucket.total < gps) bucket.total = gps;
    return { ...bucket, jobsWithTests };
}

// Counts → [0, 100] percentages against a given denominator.
function calcPercentages(denominator, parts) {
    const result = {};
    for (const [key, val] of Object.entries(parts)) {
        result[key] = denominator > 0 ? Math.min(val / denominator * 100, 100) : 0;
    }
    return result;
}

// Animate a batch of counter elements to their new values. Accepts [id, value] pairs.
function updateCounters(updates) {
    for (const [id, val] of updates) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (el.textContent !== val.toLocaleString()) {
            animateCounterRoll(el, val);
        }
    }
}

function updatePctLabels(updates) {
    for (const [id, pct] of updates) {
        const el = document.getElementById(id);
        if (el) el.textContent = pct.toFixed(1) + '%';
    }
}

// Reset every KPI counter + percentage back to zero. Called before a fresh fetch.
function resetAllKPIDisplays() {
    for (const el of document.querySelectorAll('.kpi-metric-val')) {
        if (el._counterRafId) { cancelAnimationFrame(el._counterRafId); el._counterRafId = null; }
        el._counterTarget = 0;
        el.textContent = '0';
    }
    for (const el of document.querySelectorAll('.kpi-metric-pct')) {
        el.textContent = '0%';
    }
    // Subtitle counters live outside .kpi-metric blocks — reset them too.
    for (const id of ['summary-total-tests', 'kpi-job-count', 'reg-total-jobs', 'reg-total-tests']) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (el._counterRafId) { cancelAnimationFrame(el._counterRafId); el._counterRafId = null; }
        el._counterTarget = 0;
        el.textContent = '0';
    }
}


// Recompute the "Jobs Health" KPI panel from all loaded jobs.
function updateSummaryBar() {
    const jobs = Array.from(appState.jobs.values());
    const agg = aggregateTestMetrics(jobs);
    const pct = calcPercentages(agg.total, {
        passed: agg.passed, failed: agg.failed, skipped: agg.skipped, errors: agg.errors
    });

    // Diagnostic
    if (typeof diagLog === 'function') {
        const sampleJob = jobs.find(j => j && j.test_metrics);
        diagLog('info', 'KPI',
            `updateSummaryBar — jobs=${jobs.length} jobsWithTests=${agg.jobsWithTests} ` +
            `total=${agg.total} P=${agg.passed} F=${agg.failed} S=${agg.skipped} E=${agg.errors}`,
            sampleJob ? { raw: 'sample test_metrics: ' + JSON.stringify(sampleJob.test_metrics).slice(0, 200) } : undefined
        );
    }

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

    const jobCountEl = document.getElementById('kpi-job-count');
    if (jobCountEl) {
        const jc = appState.jobs.size;
        jobCountEl.textContent = jc > 0 ? jc : '0';
    }

    // Transparency line
    const noTestsCount = jobs.length - agg.jobsWithTests;
    const noTestsWrap = document.getElementById('kpi-jobs-no-tests-wrap');
    const noTestsEl = document.getElementById('kpi-jobs-no-tests');
    if (noTestsWrap && noTestsEl) {
        noTestsEl.textContent = noTestsCount;
        noTestsWrap.classList.toggle('hidden', noTestsCount <= 0);
    }

    checkDegradedMode(jobs);
    updateToolbarActions();
    toggleKpiLayout();

    // KPI reveal animation — first paint of meaningful data.
    motionRevealKPI();
}


// Surface a warning banner when >30% of jobs have incomplete data.
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



// Toggle between single-panel (Jobs Health) and two-panel (+ Release Validation)
// layouts depending on whether a promotion time is active.
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

// Render the Release Validation KPI panel.
function updateRegressionKPI(promotionTime) {
    if (!promotionTime) return;
    const cats = evaluateRegressionCategories(promotionTime);

    // Test-case totals (mirrors the Jobs Health panel layout).
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

    // Job-level validation buckets (passed / failed / in-progress / not-run).
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


// Toggle the "no jobs loaded" / "no results match filter" placeholders.
function updateEmptyState() {
    const hasJobs = appState.jobs.size > 0;
    const table = $id('job-table');
    const noResults = $id('no-results-state');
    if (hasJobs) {
        $id('empty-state').classList.add('hidden');
        table.classList.remove('hidden');
        table.style.display = 'table';
        const visibleRows = document.querySelectorAll('tbody tr[data-job-id]:not(.detail-row):not([style*="display: none"])');
        const allFiltered = visibleRows.length === 0;
        const labels = appState.filters.logAnalysisLabels;
        const hasActiveFilter = !!(appState.filters.status || appState.filters.searchText || (labels && labels.length > 0) || appState.filters.releaseStatus);
        if (noResults) noResults.classList.toggle('hidden', !(allFiltered && hasActiveFilter));
    } else {
        $id('empty-state').classList.remove('hidden');
        table.classList.add('hidden');
        if (noResults) noResults.classList.add('hidden');
    }
}

//  Toast notifications 

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('toast-exit');
        toast.addEventListener('animationend', () => toast.remove(), { once: true });
        // Belt-and-braces in case animationend never fires.
        setTimeout(() => { if (toast.parentNode) toast.remove(); }, 400);
    }, 5000);
}
