// Promotion / release-validation: per-environment promotion time, regression
// status per job, summary panel, and Slack/Teams-ready release summary.
'use strict';

// Translate the backend ReleaseStatus enum into the panel's regression
// vocabulary. `currentStatus` should be `job.latest_status`.
function _releaseToRegression(releaseStatus, currentStatus) {
    switch (releaseStatus) {
        case 'PASS':    return 'passed';
        case 'FAIL':    return currentStatus === 'IN_PROGRESS' ? 'in_progress' : 'failed';
        case 'PENDING': return currentStatus === 'IN_PROGRESS' ? 'in_progress' : 'not_executed';
        case 'NA':      default: return 'not_executed';
    }
}

// Has this job passed validation against the promotion baseline?
// Trusts backend release_status when set; otherwise re-evaluates client-side.
function deriveRegressionStatus(job, promotionTime) {
    if (!promotionTime || !job) return 'not_executed';

    if (typeof job.release_status === 'string' && job.release_status !== 'NA') {
        return _releaseToRegression(job.release_status, job.latest_status);
    }

    // Fallback when backend hasn't yet computed release_status.
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

// Kept so legacy call sites don't break; backend is now the source of truth.
function clearValidationCache() { /* no-op */ }

// Render the regression status badge (Validated / Needs Rerun / Running / Not Run).
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

function renderRegressionCell(job) {
    const pt = getPromotionTime();
    const status = deriveRegressionStatus(job, pt);
    return '<td class="cell-regression" data-regression="' + status + '">' + renderRegressionBadge(status) + '</td>';
}

//  Promotion time accessors — persisted per environment in sessionStorage 

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
    catch (_) { /* sessionStorage may be unavailable. */ }
}

function _persistCurrentEnvValue(value) {
    const env = _currentEnv();
    if (!env) return;
    const store = _readPromoStore();
    if (value) store[env] = value;
    else delete store[env];
    _writePromoStore(store);
}

// Restore the per-env promotion value into the input. Called after env switch.
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

// Read the promotion datetime from the input. Returns null when blank or invalid.
function getPromotionTime() {
    const input = document.getElementById('promotion-datetime');
    if (!input || !input.value) return null;
    const d = new Date(input.value);
    return isNaN(d.getTime()) ? null : d;
}

// ISO-8601 serialiser for backend payloads. Single seam used by every
// fetch — keep this in lockstep with backend's _parse_promotion_time.
function getPromotionTimeISO() {
    const d = getPromotionTime();
    return d ? d.toISOString() : '';
}

// Quick-preset: set promotion to "now minus N minutes" and apply.
function setPromoQuick(minutesAgo) {
    const d = new Date(Date.now() - minutesAgo * 60000);
    const pad = n => String(n).padStart(2, '0');
    const val = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
        + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    document.getElementById('promotion-datetime').value = val;
    _clearPromoPending();
    applyPromotionTime();
}

//  Pending-state: track unapplied datetime edits so the Apply button shows 

var _appliedPromoValue = '';

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

function _clearPromoPending() {
    var input = document.getElementById('promotion-datetime');
    var applyBtn = document.getElementById('promo-apply-btn');
    if (input) input.classList.remove('promo-pending');
    if (applyBtn) applyBtn.classList.add('hidden');
}

function confirmPromoApply() {
    _clearPromoPending();
    applyPromotionTime();
}

//  Core promotion engine ─

// Bucket every job by regression status and aggregate test metrics
// per bucket. Buckets contain JOB-ID strings (not job objects) — callers
// resolve to records via appState.jobs.get(id).
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

        // Only count test metrics from jobs that ran after promotion.
        if (rs === 'not_executed') return;

        const snap = extractJobMetrics(job);
        if (!snap.hasMetrics) return;

        result.jobsWithTests++;
        addMetricsBucket(result.tests, snap);
        addMetricsBucket(result.testsByCategory[rs], snap);
    });

    // Defensive: total must be at least the sum of its parts.
    const gps = result.tests.passed + result.tests.failed + result.tests.skipped + result.tests.errors;
    if (result.tests.total < gps) result.tests.total = gps;

    return result;
}

// Top-level updater: re-derives release_status, repaints table, KPIs, and panel.
// Called when promotion time changes or after jobs refresh.
function applyPromotionTime() {
    const promotionTime = getPromotionTime();

    var input = document.getElementById('promotion-datetime');
    _appliedPromoValue = input ? input.value : '';

    if (promotionTime && promotionTime.getTime() > Date.now() && typeof showToast === 'function') {
        showToast('Promotion time is in the future — every job will show as Pending until a build runs after it.', 'warning');
    }

    _persistCurrentEnvValue(_appliedPromoValue);

    appState.promotionTime = promotionTime;

    const table = document.getElementById('job-table');
    const clearBtn = document.getElementById('promotion-clear-btn');
    const summaryStrip = document.getElementById('promo-summary-strip');
    const actionRow = document.getElementById('promo-action-row');

    // Release Status filter dropdown visibility tracks the column.
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
        // Drop any stored release-status filter so applyFilters() stops
        // suppressing rows after the column disappears.
        if (appState && appState.filters) appState.filters.releaseStatus = null;
        const cbNotRun = document.getElementById('promo-cat-notrun');
        const cbFailed = document.getElementById('promo-cat-failed');
        if (cbNotRun) cbNotRun.checked = false;
        if (cbFailed) cbFailed.checked = false;
    }

    _recomputeAllReleaseStatusInPlace(promotionTime);
    recalculateAllRegressionCells(promotionTime);
    updateDetailRowColspan();
    updatePromotionPanel(promotionTime);
    toggleKpiLayout();

    // Distinct release_status values may have changed — repopulate the filter
    // dropdown so it only offers values that exist in the table.
    if (typeof populateReleaseStatusFilter === 'function') populateReleaseStatusFilter();

    if (typeof applyFilters === 'function') applyFilters();
}


//  Client-side release_status recompute (mirrors backend logic) 

function _recomputeReleaseStatusForJob(job, promotionTime) {
    if (!promotionTime) return 'NA';

    // Build a deduped pool of all known builds for this job.
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
    // Fast path when promotion was cleared — saves ~10ms on 500-job dashboards.
    if (!promotionTime) {
        appState.jobs.forEach(job => { job.release_status = 'NA'; });
        return;
    }
    appState.jobs.forEach(job => {
        job.release_status = _recomputeReleaseStatusForJob(job, promotionTime);
    });
}

function clearPromotionTime() {
    document.getElementById('promotion-datetime').value = '';
    _clearPromoPending();
    applyPromotionTime();
}

//  Release summary export 
//
// Returns { text, html } describing the current release state, suitable
// for both plain-text and rich-text clipboard targets. Solves the daily
// "open dashboard, retype it into Slack" workflow for release managers.
//
function buildReleaseSummary() {
    const promo = appState.promotionTime;
    if (!promo) return null;

    // Buckets contain JOB-ID strings — resolve to job records via appState.jobs.
    const cats = (typeof evaluateRegressionCategories === 'function')
        ? evaluateRegressionCategories(new Date(promo))
        : null;
    if (!cats) return null;

    const passedIds = cats.passed || [];
    const failedIds = cats.failed || [];
    const inProgressIds = cats.in_progress || [];
    const notRunIds = cats.not_executed || [];
    const total = passedIds.length + failedIds.length + inProgressIds.length + notRunIds.length;
    if (total === 0) return null;
    const pct = Math.round((passedIds.length / total) * 100);

    const d = new Date(promo);
    const pad = n => String(n).padStart(2, '0');
    const promoStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

    // Resolve a job ID to its display name + URL with defensive fallbacks
    // so jobs whose metadata is still streaming never produce blank entries.
    function resolveJob(id) {
        return appState.jobs.get(id) || { job_id: id };
    }
    function jobName(j) {
        if (!j) return '';
        if (j.name && String(j.name).trim()) return String(j.name).trim();
        if (j.job_name && String(j.job_name).trim()) return String(j.job_name).trim();
        const idLike = j.job_id || j.url || j.job_url || '';
        if (idLike) {
            const parts = String(idLike).split('/').filter(Boolean);
            return parts[parts.length - 1] || idLike;
        }
        return '';
    }
    function jobUrl(j) {
        return (j && (j.url || j.job_url || j.job_id)) || '';
    }

    const LINK_CAP_PER_GROUP = 25;

    // Plain-text (Slack mrkdwn) version — used when paste target rejects HTML.
    function renderGroupText(heading, ids) {
        const out = [];
        if (!ids.length) return out;
        out.push(`*${heading}* (${ids.length})`);
        const shown = ids.slice(0, LINK_CAP_PER_GROUP);
        shown.forEach(id => {
            const job  = resolveJob(id);
            const name = jobName(job);
            const url  = jobUrl(job);
            if (!name) return;
            if (url) {
                out.push(`• <${url}|${name}>`);
            } else {
                out.push(`• ${name}`);
            }
        });
        if (ids.length > LINK_CAP_PER_GROUP) {
            out.push(`• … and ${ids.length - LINK_CAP_PER_GROUP} more`);
        }
        return out;
    }

    const text = [];
    text.push(`*Release Summary - ${promoStr}*`);
    text.push(`${pct}% ready (${passedIds.length} of ${total} jobs)`);
    text.push('');
    text.push('*Status*');
    text.push(`• Passed: ${passedIds.length}`);
    text.push(`• Failed: ${failedIds.length}`);
    text.push(`• Running: ${inProgressIds.length}`);
    text.push(`• Awaiting re-run: ${notRunIds.length}`);

    const failedLinesT   = renderGroupText('Failed',          failedIds);
    const runningLinesT  = renderGroupText('Running',         inProgressIds);
    const awaitingLinesT = renderGroupText('Awaiting re-run', notRunIds);
    if (failedLinesT.length)   { text.push(''); text.push(...failedLinesT); }
    if (runningLinesT.length)  { text.push(''); text.push(...runningLinesT); }
    if (awaitingLinesT.length) { text.push(''); text.push(...awaitingLinesT); }

    // HTML version — Slack/Teams/email rich-text composers turn <a href> into
    // proper named hyperlinks. Escape every user-derived string against injection.
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
    function renderGroupHtml(heading, ids) {
        if (!ids.length) return '';
        const items = [];
        const shown = ids.slice(0, LINK_CAP_PER_GROUP);
        shown.forEach(id => {
            const job  = resolveJob(id);
            const name = jobName(job);
            const url  = jobUrl(job);
            if (!name) return;
            if (url) {
                items.push(`<li><a href="${esc(url)}">${esc(name)}</a></li>`);
            } else {
                items.push(`<li>${esc(name)}</li>`);
            }
        });
        if (ids.length > LINK_CAP_PER_GROUP) {
            items.push(`<li>… and ${ids.length - LINK_CAP_PER_GROUP} more</li>`);
        }
        return `<p><strong>${esc(heading)}</strong> (${ids.length})</p><ul>${items.join('')}</ul>`;
    }

    // <h2> heading + readiness on its own line so it formats as a title
    // in Slack/Teams/email composers.
    const html =
        `<h2>Release Summary - ${esc(promoStr)}</h2>` +
        `<p>${pct}% ready (${passedIds.length} of ${total} jobs)</p>` +
        `<p><strong>Status</strong></p>` +
        `<ul>` +
            `<li>Passed: ${passedIds.length}</li>` +
            `<li>Failed: ${failedIds.length}</li>` +
            `<li>Running: ${inProgressIds.length}</li>` +
            `<li>Awaiting re-run: ${notRunIds.length}</li>` +
        `</ul>` +
        renderGroupHtml('Failed',          failedIds) +
        renderGroupHtml('Running',         inProgressIds) +
        renderGroupHtml('Awaiting re-run', notRunIds);

    return { text: text.join('\n'), html: html };
}

function copyReleaseSummary() {
    const summary = buildReleaseSummary();
    if (!summary) {
        if (typeof showToast === 'function') {
            showToast('Set a promotion time and fetch jobs first.', 'warning');
        }
        return;
    }

    const success = (msg) => {
        if (typeof showToast === 'function') showToast(msg, 'success');
    };
    const failure = (err) => {
        if (typeof showToast === 'function') {
            showToast('Could not copy — clipboard access blocked. Check console.', 'error');
        }
        if (typeof diagLog === 'function') diagLog('warning', 'ReleaseSummary', 'Clipboard error: ' + (err && err.message));
    };

    // Write both text/html and text/plain. Slack/Teams pick HTML and render
    // real named hyperlinks; plain-text-only targets fall back to mrkdwn syntax.
    if (navigator.clipboard && window.ClipboardItem && window.isSecureContext) {
        try {
            const item = new ClipboardItem({
                'text/html':  new Blob([summary.html], { type: 'text/html' }),
                'text/plain': new Blob([summary.text], { type: 'text/plain' }),
            });
            navigator.clipboard.write([item])
                .then(() => success('Release summary copied (with named hyperlinks)'))
                .catch(failure);
            return;
        } catch (err) {
            // Fall through to text-only path.
        }
    }

    // Older browsers without ClipboardItem.
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(summary.text)
            .then(() => success('Release summary copied to clipboard'))
            .catch(failure);
        return;
    }

    // Last-resort fallback: hidden textarea + execCommand('copy'). Plain-text only.
    try {
        const ta = document.createElement('textarea');
        ta.value = summary.text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) success('Release summary copied to clipboard');
        else failure(new Error('execCommand returned false'));
    } catch (err) {
        failure(err);
    }
}

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

// Keep detail-row colspan in sync with the optional regression column.
function updateDetailRowColspan() {
    const promotionActive = document.getElementById('job-table').classList.contains('promotion-active');
    const detailRows = document.querySelectorAll('tbody tr.detail-row td[colspan]');
    detailRows.forEach(td => {
        td.setAttribute('colspan', promotionActive ? '16' : '15');
    });
}

// Refresh the promotion panel: counts, category checkboxes, rerun button state.
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

    document.getElementById('promo-count-passed').textContent = cats.passed.length;
    document.getElementById('promo-count-failed').textContent = cats.failed.length;
    document.getElementById('promo-count-notrun').textContent = cats.not_executed.length;
    // In-progress chip only shows when something is running.
    const inProgChip = document.getElementById('promo-chip-inprog');
    const hasInProg = cats.in_progress.length > 0;
    if (inProgChip) {
        inProgChip.style.display = hasInProg ? '' : 'none';
        document.getElementById('promo-count-inprog').textContent = cats.in_progress.length;
    }
    summaryStrip.classList.remove('hidden');
    actionRow.classList.remove('hidden');

    const hasNotRun = cats.not_executed.length > 0;
    const hasFailed = cats.failed.length > 0;
    const allPassed = !hasNotRun && !hasFailed && !hasInProg;

    const notRunWrap = document.getElementById('promo-cat-notrun-wrap');
    const failedWrap = document.getElementById('promo-cat-failed-wrap');
    const notRunCount = document.getElementById('promo-cat-notrun-count');
    const failedCount = document.getElementById('promo-cat-failed-count');

    notRunWrap.style.display = hasNotRun ? '' : 'none';
    failedWrap.style.display = hasFailed ? '' : 'none';
    notRunCount.textContent = hasNotRun ? '(' + cats.not_executed.length + ')' : '';
    failedCount.textContent = hasFailed ? '(' + cats.failed.length + ')' : '';

    // All passed → swap rerun controls for the success badge.
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

    updatePromoRerunState();
}

// Enable/disable + relabel the rerun button based on selected category checkboxes.
function updatePromoRerunState() {
    const cbNotRun = document.getElementById('promo-cat-notrun');
    const cbFailed = document.getElementById('promo-cat-failed');
    const btn = document.getElementById('promo-rerun-btn');
    const anySelected = (cbNotRun && cbNotRun.checked) || (cbFailed && cbFailed.checked);
    btn.disabled = !anySelected;

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

// Rerun jobs in the selected regression buckets (not-run and/or failed).
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

