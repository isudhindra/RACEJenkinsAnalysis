// Jenkins Dashboard app module — main initialization and event handling for the job table UI.
// This file contains functions for initializing the dashboard, setting up event listeners,
// and managing job state updates including refresh, analysis, and filter operations.

'use strict';

// INITIALIZATION — DOMContentLoaded and Jinja2 data injection happen in dashboard.html's inline script.
// This file provides the setup functions that the bootstrap script calls after page load.

// Populate the Jenkins instance dropdown from parsed contexts data provided by the server.
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

// Attach event listeners for keyboard shortcuts, table actions (expand/refresh/rerun), and checkbox selection.
function setupEventListeners() {
    // Escape key prioritization: close overlay, collapse expanded rows, or dismiss toasts.
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
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

    // Event delegation on table body for action buttons (expand, logs, rerun, refresh) and checkboxes.
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


// STALE ROW DETECTION — periodically check if job data is old and mark rows as stale.

// Start a background interval to check all rows for staleness every 30 seconds.
function startStaleRowDetection() {
    staleCheckInterval = setInterval(() => {
        document.querySelectorAll('tbody tr[data-job-id]').forEach(row => {
            const jobId = row.getAttribute('data-job-id');
            checkStaleRow(row, jobId);
        });
    }, 30000);
}

// Mark a row as stale if its job data hasn't been refreshed within the last 15 minutes.
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

// ROW-LEVEL SINGLE-JOB REFRESH — update one job's row in place without touching the rest of the table.
// This preserves filters, sort, selections, and expanded rows while fetching fresh data from the API.

const _refreshingJobs = new Set();

// Fetch and update a single job without affecting other table state (filters, sort, scroll, selections).
async function refreshSingleJob(jobId) {
    if (_refreshingJobs.has(jobId)) {
        showToast('Refresh already in progress for this job', 'info');
        return;
    }

    const creds = ensureCredentials('Credentials required');
    if (!creds) return;

    _refreshingJobs.add(jobId);

    // Find the row and put it in a refreshing state
    const row = document.querySelector(`tr[data-job-id="${escapeHtml(jobId)}"]`);
    if (row) {
        row.classList.add('row-refreshing');
        // Disable the refresh icon within this row to prevent double-clicks
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
            }),
        });

        if (!resp.ok) {
            const errData = await resp.json().catch(() => ({}));
            throw new Error(errData.error || `HTTP ${resp.status}`);
        }

        const data = await resp.json();

        // Guard: if dashboard was reset during the async call, don't create orphaned state
        if (appState.jobs.size === 0 && !appState.jobs.has(jobId)) {
            showToast('Dashboard was reset during refresh — discarding stale result', 'info');
            return;
        }
        const job = appState.jobs.get(jobId) || {};
        // Core fields from refresh response
        if (data.current_status !== undefined) job.latest_status = data.current_status;
        if (data.health_state !== undefined) job.health_state = data.health_state;
        if (data.is_running !== undefined) job.is_running = data.is_running;
        if (data.job_name !== undefined) job.name = data.job_name;
        if (data.last_execution_time !== undefined) job.last_execution_time = data.last_execution_time;
        if (data.last_build_number !== undefined) job.last_build_number = data.last_build_number;

        // Enrichment data (shared with handleJobEnriched)
        mergeEnrichmentFields(job, data);
        if (data.console_log_url) job.console_log_url = data.console_log_url;

        appState.jobs.set(jobId, job);
        appState.lastRefreshTimes.set(jobId, new Date());

        // Track status transition for visual feedback
        if (appState.statusTransitions) {
            const prevStatus = appState.statusTransitions.get(jobId);
            if (prevStatus && prevStatus !== job.latest_status) {
                // Status changed — the row-just-enriched animation will fire
            }
            appState.statusTransitions.set(jobId, job.latest_status);
        }

        // Update ONLY this row in the DOM
        if (row) {
            row.classList.remove('row-refreshing');
            row.classList.add('row-just-enriched');
            setTimeout(() => row.classList.remove('row-just-enriched'), 800);
        }
        updateJobRow(jobId, job);

        // Re-render expanded detail row if open
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
        // Re-query row in case DOM was replaced during async refresh (F9)
        const currentRow = document.querySelector(`tr[data-job-id="${escapeHtml(jobId)}"]`);
        if (currentRow) {
            currentRow.classList.remove('row-refreshing');
            const refreshIcon = currentRow.querySelector('[data-action="refresh"]');
            if (refreshIcon) refreshIcon.style.pointerEvents = '';
        }
    }
}

// ON-DEMAND ANALYSIS — request AI/heuristic analysis of a job's failure or logs.
// Sends the job to the backend, receives classification, and updates the UI.
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
                api_token: creds.api_token
            })
        });

        const data = await response.json();
        if (data.error) {
            diagLog('error', 'Analysis', 'On-demand analysis error: ' + data.error, { extra: jobId });
            showToast('Analysis error: ' + data.error, 'error');
            return;
        }

        // Update job in state
        const job = appState.jobs.get(jobId);
        if (job && data.classification) {
            job.classification = data.classification;
            updateJobRow(jobId, job);

            // Re-render expanded detail if open
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

// CLEAR FILTERS — reset all filter inputs and reapply the empty filter set.
function clearAllFilters() {
    document.getElementById('filter-status').value = '';
    document.getElementById('filter-search').value = '';
    clearLogAnalysisFilter();
    appState.filters = {
        status: null,
        searchText: '',
        logAnalysisLabel: null
    };
    applyFilters();
}

// Full dashboard reset called before Fetch Jobs or Full Refresh to start with a clean slate.
// Clears all table state: filters, search, sort, selections, expanded rows, timers, and UI state.
// Does NOT clear auth credentials or configuration settings.
function resetDashboardState() {
    // Abort any in-flight fetch so stale SSE events cannot arrive
    if (appState._fetchAbortController) {
        appState._fetchAbortController.abort();
        appState._fetchAbortController = null;
    }
    appState.activeOperationId = null;
    appState._fetchErrorCount = 0;

    // Reset progressive row-batch buffer
    resetRowBatch();

    // Reset the motion narrative strip back to idle
    motionReset();

    // Clear the core data store
    appState.jobs.clear();
    appState.statusTransitions.clear();
    appState.rerunStates.clear();
    appState.lastRefreshTimes.clear();

    // Wipe all table body rows (complete DOM teardown)
    const tbody = document.querySelector('#job-table tbody');
    if (tbody) tbody.innerHTML = '';

    // Reset filter dropdowns and search input
    var filterStatus = document.getElementById('filter-status');
    if (filterStatus) filterStatus.value = '';
    var filterSearch = document.getElementById('filter-search');
    if (filterSearch) filterSearch.value = '';
    appState.filters = { status: null, searchText: '', logAnalysisLabel: null };
    // Clear log analysis autocomplete filter if active
    if (typeof clearLogAnalysisFilter === 'function') clearLogAnalysisFilter();

    // Clear sort state and column header indicators
    currentSortKey = null;
    currentSortDir = null;
    syncSortHeaders();

    // Clear row selections and uncheck all checkboxes
    appState.selectedJobs.clear();
    var allCheckbox = document.getElementById('select-all-checkbox');
    if (allCheckbox) allCheckbox.checked = false;

    // Clear expanded detail rows (DOM already wiped above)
    appState.expandedRows.clear();

    // Clear promotion/release validation datetime and downstream state
    var promoInput = document.getElementById('promotion-datetime');
    if (promoInput) promoInput.value = '';
    appState.promotionTime = null;
    if (typeof clearValidationCache === 'function') clearValidationCache();
    applyPromotionTime();

    // Cancel pending debounce/RAF timers
    if (_searchDebounce) {
        clearTimeout(_searchDebounce);
        _searchDebounce = null;
    }
    if (_filterSortRaf) {
        cancelAnimationFrame(_filterSortRaf);
        _filterSortRaf = null;
    }

    // Rebuild log analysis label cache (now empty)
    if (typeof rebuildLogAnalysisLabelCache === 'function') rebuildLogAnalysisLabelCache();

    // Zero-out KPI counters and percentages to prevent stale animated values from lingering
    resetAllKPIDisplays();

    // Dismiss failure consolidation view if open
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

    // Close console log viewer if open
    if (typeof clvClose === 'function') {
        const clvOverlay = document.getElementById('clv-overlay');
        if (clvOverlay && clvOverlay.classList.contains('active')) clvClose();
    }

    // Hide no-results state
    const noResults = $id('no-results-state');
    if (noResults) noResults.classList.add('hidden');

    // Update derived UI to reflect empty state
    updateToolbarActions();
    updateSummaryBar();
    updateEmptyState();
}

