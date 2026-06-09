// app.js — Top-level dashboard wiring: event listeners, single-job refresh, on-demand analysis, full reset.
'use strict';

// Populate the Jenkins instance dropdown from contexts data provided by the server.
function initializeContexts() {
    if (!appState.contextsData) return;
    const parsed = appState.contextsData;
    if (parsed.instances && Array.isArray(parsed.instances) && parsed.instances.length > 0) {
        const select = document.getElementById('cfg-jenkins-url');
        parsed.instances.forEach(inst => {
            const option = document.createElement('option');
            option.value = inst.jenkins_url;
            option.textContent = inst.display_name;
            option.dataset.instanceId = inst.id;
            select.appendChild(option);
        });
    }
}

// "+N more" inline expand/collapse on log-analysis chip rows.
// Delegated on document so SSE-inserted rows work without rebinding.
function _wireOverflowToggle() {
    document.addEventListener('click', function(e) {
        const btn = e.target.closest('.rec-chip-overflow[data-action="toggle-overflow"]');
        if (!btn) return;
        // Don't propagate to row selection.
        e.stopPropagation();
        const row = btn.closest('.rec-chip-row');
        if (!row) return;
        const expand = !row.classList.contains('is-expanded');
        row.classList.toggle('is-expanded', expand);
        btn.setAttribute('aria-expanded', expand ? 'true' : 'false');
        btn.textContent = expand
            ? (btn.dataset.countExpanded || '× less')
            : (btn.dataset.countCollapsed || btn.textContent);
    });
}


// Wire keyboard shortcuts and table action buttons (expand/refresh/rerun/select).
function setupEventListeners() {
    _wireOverflowToggle();
    // Escape priority: collapse expanded chip groups → close CLV overlay → collapse expanded rows → dismiss toasts.
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            const expandedRows = document.querySelectorAll('.rec-chip-row.is-expanded');
            if (expandedRows.length > 0) {
                expandedRows.forEach(row => {
                    row.classList.remove('is-expanded');
                    const btn = row.querySelector('.rec-chip-overflow[data-action="toggle-overflow"]');
                    if (btn) {
                        btn.setAttribute('aria-expanded', 'false');
                        if (btn.dataset.countCollapsed) btn.textContent = btn.dataset.countCollapsed;
                    }
                });
                return;
            }
            const overlay = $id('clv-overlay');
            if (overlay && overlay.classList.contains('active')) {
                clvClose();
                return;
            }
            if (appState.expandedRows.size > 0) {
                appState.expandedRows.forEach(jobId => toggleRowExpansion(jobId));
                return;
            }
            document.querySelectorAll('.toast').forEach(toast => toast.remove());
        }
    });

    // Delegate row-action clicks (expand, logs, rerun, refresh) and checkbox changes on tbody.
    const tbody = document.querySelector('#job-table tbody');
    if (tbody) {
        tbody.addEventListener('click', function(e) {
            const actionEl = e.target.closest('[data-action]');
            if (!actionEl) return;
            const row = actionEl.closest('tr[data-job-id]');
            if (!row) return;
            const jobId = row.getAttribute('data-job-id');
            switch (actionEl.dataset.action) {
                case 'expand':
                    toggleRowExpansion(jobId);
                    break;
                case 'error-logs':
                case 'console-log':
                    clvOpen(jobId);
                    break;
                case 'rerun': {
                    const job = appState.jobs.get(jobId);
                    if (job && (job.is_running || job.latest_status === 'IN_PROGRESS')) {
                        showToast('Cannot rerun — build is currently in progress', 'info');
                        break;
                    }
                    triggerRerun([jobId]);
                    break;
                }
                case 'refresh':
                    refreshSingleJob(jobId);
                    break;
            }
        });
        tbody.addEventListener('change', function(e) {
            const actionEl = e.target.closest('[data-action]');
            if (!actionEl) return;
            const row = actionEl.closest('tr[data-job-id]');
            if (!row) return;
            if (actionEl.dataset.action === 'select') {
                toggleJobSelection(row.getAttribute('data-job-id'));
            }
        });
    }
}


// Stale-row detection — flag rows whose data is older than 15 minutes.
function startStaleRowDetection() {
    staleCheckInterval = setInterval(() => {
        document.querySelectorAll('tbody tr[data-job-id]').forEach(row => {
            const jobId = row.getAttribute('data-job-id');
            checkStaleRow(row, jobId);
        });
    }, 30000);
}

function checkStaleRow(row, jobId) {
    const lastRefresh = appState.lastRefreshTimes.get(jobId);
    if (!lastRefresh) return;

    const ageMinutes = (Date.now() - lastRefresh.getTime()) / (1000 * 60);
    if (ageMinutes > 15) {
        row.classList.add('stale');
        row.title = `Last refreshed: ${Math.round(ageMinutes)} minutes ago`;
    } else {
        row.classList.remove('stale');
        row.title = '';
    }
}

// Single-job refresh: update one row in place while preserving filters/sort/selection/scroll/expanded state.
const _refreshingJobs = new Set();

async function refreshSingleJob(jobId) {
    if (_refreshingJobs.has(jobId)) {
        showToast('Refresh already in progress for this job', 'info');
        return;
    }

    const creds = ensureCredentials('Credentials required');
    if (!creds) return;

    _refreshingJobs.add(jobId);

    const row = document.querySelector(`tr[data-job-id="${escapeHtml(jobId)}"]`);
    if (row) {
        row.classList.add('row-refreshing');
        // Disable the refresh icon to prevent double-clicks while in flight.
        const refreshIcon = row.querySelector('[data-action="refresh"]');
        if (refreshIcon) refreshIcon.style.pointerEvents = 'none';
    }

    const existingJob = appState.jobs.get(jobId);
    const jobName = existingJob ? existingJob.name : jobId.split('/').pop();

    try {
        const resp = await fetch('/api/refresh-single', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                job_url: jobId,
                job_name: jobName,
                jenkins_url: creds.jenkins_url,
                username: creds.username,
                api_token: creds.api_token,
                promotion_time: getPromotionTimeISO(),
            }),
        });

        if (!resp.ok) {
            const errData = await resp.json().catch(() => ({}));
            throw new Error(errData.error || `HTTP ${resp.status}`);
        }

        const data = await resp.json();

        // Guard: drop the result if the dashboard was reset mid-flight (avoid orphaned state).
        if (appState.jobs.size === 0 && !appState.jobs.has(jobId)) {
            showToast('Dashboard was reset during refresh — discarding stale result', 'info');
            return;
        }
        // Merge incoming fields into the existing job record — wholesale replace
        // would strip name/url and silently break search (regression #226).
        const job = appState.jobs.get(jobId) || {};
        if (data.current_status !== undefined) job.latest_status = data.current_status;
        if (data.health_state !== undefined) job.health_state = data.health_state;
        if (data.is_running !== undefined) job.is_running = data.is_running;
        if (data.job_name !== undefined) job.name = data.job_name;
        if (data.last_execution_time !== undefined) job.last_execution_time = data.last_execution_time;
        if (data.last_build_number !== undefined) job.last_build_number = data.last_build_number;

        mergeEnrichmentFields(job, data);
        if (data.console_log_url) job.console_log_url = data.console_log_url;

        appState.jobs.set(jobId, job);
        appState.lastRefreshTimes.set(jobId, new Date());

        if (appState.statusTransitions) {
            appState.statusTransitions.set(jobId, job.latest_status);
        }

        // Update only this row in the DOM.
        if (row) {
            row.classList.remove('row-refreshing');
            row.classList.add('row-just-enriched');
            setTimeout(() => row.classList.remove('row-just-enriched'), 800);
        }
        updateJobRow(jobId, job);

        if (appState.expandedRows.has(jobId)) {
            const detailRow = document.querySelector(`tr[data-job-id="${escapeHtml(jobId)}_detail"]`);
            if (detailRow) detailRow.replaceWith(renderExpandedDetail(job));
        }

        updateSummaryBar();
        rebuildLogAnalysisLabelCache();

        showToast(`Refreshed: ${job.name || jobId.split('/').pop()}`, 'success');
    } catch (err) {
        reportFetchError('Refresh', 'Single job refresh failed: ' + jobId, '/api/refresh-single', err, 'Refresh failed: ' + err.message);
        if (row) row.classList.remove('row-refreshing');
    } finally {
        _refreshingJobs.delete(jobId);
        // Re-query the row in case the DOM was replaced during the async call.
        const currentRow = document.querySelector(`tr[data-job-id="${escapeHtml(jobId)}"]`);
        if (currentRow) {
            currentRow.classList.remove('row-refreshing');
            const refreshIcon = currentRow.querySelector('[data-action="refresh"]');
            if (refreshIcon) refreshIcon.style.pointerEvents = '';
        }
    }
}

// Request on-demand classification of a single job's logs and refresh its row.
async function requestOnDemandAnalysis(jobId, jobName) {
    const creds = ensureCredentials('Credentials required for on-demand analysis');
    if (!creds) return;

    try {
        const response = await fetch('/api/analyze-on-demand', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                job_url: jobId,
                job_name: jobName || jobId.split('/').pop(),
                jenkins_url: creds.jenkins_url,
                username: creds.username,
                api_token: creds.api_token,
                promotion_time: getPromotionTimeISO()
            })
        });

        const data = await response.json();
        if (data.error) {
            diagLog('error', 'Analysis', 'On-demand analysis error: ' + data.error, { extra: jobId });
            showToast('Analysis error: ' + data.error, 'error');
            return;
        }

        const job = appState.jobs.get(jobId);
        if (job && data.classification) {
            job.classification = data.classification;
            updateJobRow(jobId, job);

            if (appState.expandedRows.has(jobId)) {
                const detailRow = document.querySelector(`tr[data-job-id="${escapeHtml(jobId)}_detail"]`);
                if (detailRow) {
                    const newDetail = renderExpandedDetail(job);
                    detailRow.replaceWith(newDetail);
                }
            }

            updateSummaryBar();
            showToast('Analysis complete for ' + (job.name || jobId), 'success');
        }
    } catch (e) {
        reportFetchError('Analysis', 'On-demand analysis exception', '/api/analyze-on-demand', e, 'Error analyzing job: ' + e.message, jobId);
    }
}

// Reset every filter input and row selection in one shot, then re-apply filters.
// Each branch is wrapped defensively — a single failure (e.g. LA wrap not in DOM
// after a view-mode switch) must not silently abort the remaining resets.
function clearAllFilters() {
    try {
        const sel = document.getElementById('filter-status');
        if (sel) { sel.value = ''; sel.selectedIndex = 0; }
    } catch (_) { /* keep going */ }

    try {
        const inp = document.getElementById('filter-search');
        if (inp) inp.value = '';
    } catch (_) { /* keep going */ }

    // Release-status dropdown is hidden unless promotion is active; still reset it
    // so a later promotion-enable doesn't surface a stale value.
    try {
        const releaseSel = document.getElementById('filter-release-status');
        if (releaseSel) { releaseSel.value = ''; releaseSel.selectedIndex = 0; }
    } catch (_) { /* keep going */ }

    try {
        if (typeof clearLogAnalysisFilter === 'function') clearLogAnalysisFilter();
    } catch (_) { /* keep going */ }

    // Row selection counts as "something to clear". Inlined so we don't fire
    // selectByCategory's "Selection cleared" toast on top of a quiet filter reset.
    try {
        if (window.appState && appState.selectedJobs && appState.selectedJobs.size > 0) {
            appState.selectedJobs.clear();
            document.querySelectorAll(
                'tbody tr[data-job-id]:not(.detail-row) input[type="checkbox"][data-action="select"]'
            ).forEach(cb => { cb.checked = false; });
            document.querySelectorAll('tbody tr.row-selected').forEach(r => {
                r.classList.remove('row-selected');
            });
            const allCb = document.getElementById('select-all-checkbox');
            if (allCb) { allCb.checked = false; allCb.indeterminate = false; }
        }
    } catch (_) { /* keep going */ }

    // Reset in-memory filter state so matchesFilters() sees an empty set
    // even before _applyFiltersImpl re-reads the DOM inputs.
    if (window.appState) {
        appState.filters = {
            status: null,
            searchText: '',
            logAnalysisLabels: [],
            releaseStatus: null,
            _searchRe: null,
        };
    }

    // Re-read inputs, toggle row visibility, refresh the Clear button's count badge.
    if (typeof applyFilters === 'function') applyFilters();
}

// Full reset called before Fetch Jobs or Full Refresh — starts with a clean slate.
function resetDashboardState() {
    // Abort any in-flight fetch so stale SSE events can't reach a wiped table.
    if (appState._fetchAbortController) {
        appState._fetchAbortController.abort();
        appState._fetchAbortController = null;
    }
    appState.activeOperationId = null;
    appState._fetchErrorCount = 0;

    resetRowBatch();
    motionReset();

    appState.jobs.clear();
    appState.statusTransitions.clear();
    appState.rerunStates.clear();
    appState.lastRefreshTimes.clear();
    // Drop cached row references — the tbody wipe below detaches all elements,
    // so stale Map entries would point at detached nodes.
    if (appState.rowEls) appState.rowEls.clear();
    if (appState.detailRowEls) appState.detailRowEls.clear();

    const tbody = document.querySelector('#job-table tbody');
    if (tbody) tbody.innerHTML = '';

    var filterStatus = document.getElementById('filter-status');
    if (filterStatus) filterStatus.value = '';
    var filterSearch = document.getElementById('filter-search');
    if (filterSearch) filterSearch.value = '';
    var filterRelease = document.getElementById('filter-release-status');
    if (filterRelease) filterRelease.value = '';
    appState.filters = { status: null, searchText: '', logAnalysisLabels: [], releaseStatus: null };
    if (typeof clearLogAnalysisFilter === 'function') clearLogAnalysisFilter();

    currentSortKey = null;
    currentSortDir = null;
    syncSortHeaders();

    appState.selectedJobs.clear();
    var allCheckbox = document.getElementById('select-all-checkbox');
    if (allCheckbox) allCheckbox.checked = false;

    appState.expandedRows.clear();

    // Drop promotion/release validation state.
    var promoInput = document.getElementById('promotion-datetime');
    if (promoInput) promoInput.value = '';
    appState.promotionTime = null;
    if (typeof clearValidationCache === 'function') clearValidationCache();
    applyPromotionTime();

    // Cancel pending debounce/RAF timers so they don't fire against the wiped state.
    if (_searchDebounce) {
        clearTimeout(_searchDebounce);
        _searchDebounce = null;
    }
    if (_filterSortRaf) {
        cancelAnimationFrame(_filterSortRaf);
        _filterSortRaf = null;
    }

    if (typeof rebuildLogAnalysisLabelCache === 'function') rebuildLogAnalysisLabelCache();

    // Zero KPI counters so stale animated values don't linger.
    resetAllKPIDisplays();

    if (_failureViewActive) {
        _failureViewActive = false;
        const fv = document.getElementById('failure-view');
        if (fv) fv.classList.add('hidden');
        const jt = document.getElementById('job-table');
        if (jt) jt.style.display = '';
        const btnLabel = document.getElementById('ops-failure-view-label');
        if (btnLabel) btnLabel.textContent = 'Failures';
        const fvTbody = document.getElementById('fv-tbody');
        if (fvTbody) fvTbody.innerHTML = '';
    }

    if (typeof clvClose === 'function') {
        const clvOverlay = document.getElementById('clv-overlay');
        if (clvOverlay && clvOverlay.classList.contains('active')) clvClose();
    }

    const noResults = $id('no-results-state');
    if (noResults) noResults.classList.add('hidden');

    updateToolbarActions();
    updateSummaryBar();
    updateEmptyState();
}

