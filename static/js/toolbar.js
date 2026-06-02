// Jenkins Dashboard toolbar module
// Handles toolbar actions: job filtering, rerun operations, failure view consolidation, and CSV export.
'use strict';

// ========== RERUN OPERATIONS ==========

// Rerun all jobs with FAILURE status from the currently visible table.
async function triggerRerunAllFailed() {
    const failed = getVisibleJobs()
        .filter(job => job.latest_status === 'FAILURE')
        .map(job => job.job_id);

    if (failed.length === 0) {
        showToast('No failed jobs to rerun', 'info');
        return;
    }

    triggerRerun(failed);
}

// Rerun jobs that the user has selected via checkboxes.
function triggerRerunSelected() {
    if (appState.selectedJobs.size === 0) {
        showToast('No jobs selected', 'info');
        return;
    }

    triggerRerun(Array.from(appState.selectedJobs));
}

// Rerun jobs matching a specific status (FAILURE, UNSTABLE, ABORTED).
function triggerRerunByStatus(status) {
    const matching = getVisibleJobs()
        .filter(job => job.latest_status === status)
        .map(job => job.job_id);
    if (matching.length === 0) {
        showToast('No ' + status.toLowerCase() + ' jobs to rerun', 'info');
        return;
    }
    triggerRerun(matching);
}

// ========== DYNAMIC TOOLBAR ACTION VISIBILITY ==========

// Show/hide toolbar buttons and dropdowns based on the current filtered dataset.
// Enables "Rerun Failed" only if failed jobs exist, "Rerun Selected" only if jobs are selected, etc.
function updateToolbarActions() {
    const visibleJobs = getVisibleJobs();
    const hasFailed = visibleJobs.some(j => j.latest_status === 'FAILURE');
    const hasUnstable = visibleJobs.some(j => j.latest_status === 'UNSTABLE');
    const hasAborted = visibleJobs.some(j => j.latest_status === 'ABORTED');
    const selectedCount = appState.selectedJobs.size;
    const hasSelected = selectedCount > 0;

    // Helper to show/hide an element by ID based on a condition
    const showHide = (id, condition) => {
        const el = document.getElementById(id);
        if (el) el.style.display = condition ? '' : 'none';
    };
    showHide('ops-refresh-failed', hasFailed);
    showHide('ops-refresh-unstable', hasUnstable);
    showHide('ops-refresh-aborted', hasAborted);
    showHide('ops-refresh-selected', hasSelected);
    showHide('ops-refresh-sel-divider', hasSelected);

    // Update refresh selected count badge
    const refreshSelCount = document.getElementById('ops-refresh-sel-count');
    if (refreshSelCount) refreshSelCount.textContent = hasSelected ? selectedCount : '';

    showHide('ops-rerun-failed', hasFailed);
    showHide('ops-rerun-unstable', hasUnstable);
    showHide('ops-rerun-aborted', hasAborted);
    showHide('ops-rerun-selected', hasSelected);
    showHide('ops-rerun-sel-divider', hasSelected && (hasFailed || hasUnstable || hasAborted));

    // Update rerun selected count badge
    const countBadge = document.getElementById('ops-selected-count');
    if (countBadge) countBadge.textContent = hasSelected ? selectedCount : '';

    const anyRerun = hasFailed || hasUnstable || hasAborted || hasSelected;
    showHide('ops-rerun-dropdown', anyRerun);
    const sepRerun = document.getElementById('ops-sep-rerun');
    if (sepRerun) sepRerun.style.display = anyRerun ? '' : 'none';

    // Show/hide failure consolidation button if failures exist
    const anyFailures = hasFailed || hasUnstable;
    showHide('ops-failure-view', anyFailures);
    if (anyFailures) {
        const failCount = visibleJobs.filter(j => j.latest_status === 'FAILURE' || j.latest_status === 'UNSTABLE').length;
        const fcBadge = document.getElementById('ops-failure-count');
        if (fcBadge) fcBadge.textContent = failCount > 0 ? failCount : '';
    }
}

// Open a dropdown menu, closing any others that are open.
function toggleOpsDropdown(dropdownId) {
    const dropdown = document.getElementById(dropdownId);
    if (!dropdown) return;
    const wasOpen = dropdown.classList.contains('open');
    closeOpsDropdowns();
    if (!wasOpen) dropdown.classList.add('open');
}

// Close all open dropdown menus.
function closeOpsDropdowns() {
    document.querySelectorAll('.ops-dropdown.open').forEach(d => d.classList.remove('open'));
}

// Close dropdowns when user clicks outside of them
document.addEventListener('click', function(e) {
    if (!e.target.closest('.ops-dropdown')) closeOpsDropdowns();
});

// ========== FAILURE CONSOLIDATION VIEW ==========

let _fvSearchDebounce = null;
let _failureViewActive = false;

// Disable job-table-specific toolbar controls when switching to failure consolidation view.
// Re-enable them when switching back to the jobs view.
function setToolbarViewState(mode) {
    var isFailures = (mode === 'failures');
    var targets = document.querySelectorAll('[data-fv-disable]');
    targets.forEach(function(el) {
        if (isFailures) {
            el.classList.add('fv-toolbar-disabled');
            // Disable all buttons, selects, and inputs nested in this element
            el.querySelectorAll('button, select, input').forEach(function(ctrl) {
                ctrl.dataset.fvWasDisabled = ctrl.disabled ? '1' : '';
                ctrl.disabled = true;
            });
            // If the element itself is a control, disable it too
            if (el.matches('button, select, input')) {
                el.dataset.fvWasDisabled = el.disabled ? '1' : '';
                el.disabled = true;
            }
        } else {
            el.classList.remove('fv-toolbar-disabled');
            // Re-enable controls that weren't disabled before we touched them
            el.querySelectorAll('button, select, input').forEach(function(ctrl) {
                // Restore only if it wasn't already disabled before we touched it
                if (ctrl.dataset.fvWasDisabled !== '1') {
                    ctrl.disabled = false;
                }
                delete ctrl.dataset.fvWasDisabled;
            });
            if (el.matches('button, select, input')) {
                if (el.dataset.fvWasDisabled !== '1') {
                    el.disabled = false;
                }
                delete el.dataset.fvWasDisabled;
            }
        }
    });
    // Close any open dropdowns when switching to failures view
    if (isFailures && typeof closeOpsDropdowns === 'function') {
        closeOpsDropdowns();
    }
}

// Build an array of consolidated failure entries, one per failed/unstable job.
// Aggregates error logs for each job and deduplicates them for display.
function collectFailureEntries() {
    var entries = [];
    appState.jobs.forEach(function(job, jobId) {
        var st = job.latest_status;
        if (st !== 'FAILURE' && st !== 'UNSTABLE') return;

        var cls = job.classification || {};
        var fe = job.failure_evidence || {};
        var execTime = job.last_execution_time || '';
        var jobName = job.name || job.job_name || jobId;
        var jobUrl = job.url || job.job_url || jobId;

        // Collect individual error entries from logs
        var errorLogs = fe.error_logs || [];
        var errorItems = [];     // structured items for the detail panel
        var uniqueErrors = [];   // deduplicated short messages for summary
        var rawTextParts = [];   // all raw text for free-text search

        if (errorLogs.length > 0) {
            var seenMsg = {};
            errorLogs.forEach(function(errEntry) {
                var msg = errEntry.message || 'No message';
                var level = errEntry.level || 'ERROR';
                var lineNum = errEntry.line_number || null;
                var ctx = errEntry.context_before || '';

                // Build full detail string for this individual error
                var detail = '';
                if (ctx) detail += ctx + '\n';
                detail += (lineNum ? '[Line ' + lineNum + '] ' : '') + level + ': ' + msg;

                errorItems.push({ message: msg, level: level, lineNumber: lineNum, detail: detail });
                rawTextParts.push(detail);

                // Dedup for compact summary display
                var key = msg.substring(0, 80).toLowerCase();
                if (!seenMsg[key]) {
                    seenMsg[key] = { msg: msg, count: 1 };
                    uniqueErrors.push(seenMsg[key]);
                } else {
                    seenMsg[key].count++;
                }
            });
        } else {
            // Fallback text when no detailed error logs are available
            var snippet = cls.evidence_snippet || fe.failure_context || cls.action || 'No detailed error information available';
            errorItems.push({ message: snippet, level: 'INFO', lineNumber: null, detail: snippet });
            uniqueErrors.push({ msg: snippet, count: 1 });
            rawTextParts.push(snippet);
        }

        // Compact summary line (shown when row is collapsed)
        var errorSummary = uniqueErrors.map(function(e) {
            return e.count > 1 ? e.msg + ' (\u00d7' + e.count + ')' : e.msg;
        }).join('\n');

        // Full raw text for search — includes job name, error summary, and all error details
        var searchBlob = [jobName, errorSummary].concat(rawTextParts).join(' ').toLowerCase();

        entries.push({
            jobId: jobId,
            jobName: jobName,
            jobUrl: jobUrl,
            status: st,
            errorCount: errorLogs.length || 1,
            errorSummary: errorSummary,
            errorItems: errorItems,
            execTime: execTime,
            searchBlob: searchBlob
        });
    });

    // Sort: FAILURE first, then by error count (descending), then by job name alphabetically
    entries.sort(function(a, b) {
        if (a.status !== b.status) return a.status === 'FAILURE' ? -1 : 1;
        if (b.errorCount !== a.errorCount) return b.errorCount - a.errorCount;
        return a.jobName.localeCompare(b.jobName);
    });
    return entries;
}

// Render the failure consolidation table with one row per failed/unstable job.
// Error summaries are clickable to expand detailed error information.
function renderFailureView() {
    var entries = collectFailureEntries();
    var tbody = document.getElementById('fv-tbody');
    if (!tbody) return;

    if (entries.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="fv-empty">No failures found in the current dataset.</td></tr>';
        var sub = document.getElementById('fv-subtitle');
        if (sub) sub.textContent = '0 failed jobs';
        return;
    }

    // Subtitle: "7 failed jobs · 52 errors"
    var totalErrors = entries.reduce(function(sum, e) { return sum + e.errorCount; }, 0);
    var sub = document.getElementById('fv-subtitle');
    if (sub) sub.textContent = entries.length + ' failed ' + (entries.length === 1 ? 'job' : 'jobs') + ' \u00B7 ' + totalErrors + ' ' + (totalErrors === 1 ? 'error' : 'errors');

    // Store entries for the expand/collapse handler
    window._fvEntries = {};

    var html = '';
    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        window._fvEntries[e.jobId] = e;

        // Show first 2 error lines in compact view; indicate if more exist
        var summaryLines = e.errorSummary.split('\n');
        var shortDisplay = summaryLines.slice(0, 2).map(function(l) { return escapeHtml(l); }).join('<br>');
        if (summaryLines.length > 2) {
            shortDisplay += '<span class="fv-error-more"> +' + (summaryLines.length - 2) + ' more</span>';
        }

        // Error count badge
        var countBadge = e.errorCount > 1
            ? '<span class="fv-error-count" title="' + e.errorCount + ' errors">' + e.errorCount + '</span>'
            : '';

        // Expand/collapse chevron
        var chevron = '<span class="fv-expand-icon" id="fv-chev-' + i + '">\u25B6</span>';

        html += '<tr data-fv-job="' + escapeHtml(e.jobId) + '" data-fv-search="' + escapeHtml(e.searchBlob) + '" data-fv-idx="' + i + '">'
            + '<td class="fv-col-job"><a class="fv-job-link" href="' + escapeHtml(e.jobUrl) + '" target="_blank" rel="noopener" title="Open in Jenkins">' + escapeHtml(e.jobName) + '</a>' + countBadge + '</td>'
            + '<td class="fv-col-message"><div class="fv-error-summary" onclick="toggleFvDetail(' + i + ')">' + chevron + '<span class="fv-error-msg">' + shortDisplay + '</span></div></td>'
            + '<td class="fv-col-time"><span class="fv-time">' + formatExecTime(e.execTime) + '</span></td>'
            + '<td class="fv-col-actions"><button class="fv-log-btn" onclick="clvOpen(\'' + escapeHtml(e.jobId) + '\')" title="Open console log"><svg width="14" height="14"><use href="#icon-file-text"/></svg></button></td>'
            + '</tr>';
    }
    tbody.innerHTML = html;
}

// Toggle the inline error detail panel for a failure view row (expand/collapse).
function toggleFvDetail(idx) {
    var tbody = document.getElementById('fv-tbody');
    var existingDetail = document.getElementById('fv-detail-' + idx);

    // Collapse if already open
    if (existingDetail) {
        existingDetail.remove();
        var chev = document.getElementById('fv-chev-' + idx);
        if (chev) chev.textContent = '\u25B6';
        return;
    }

    // Find the parent row and get its job entry
    var parentRow = tbody.querySelector('tr[data-fv-idx="' + idx + '"]');
    if (!parentRow) return;
    var jobId = parentRow.getAttribute('data-fv-job');
    var entry = window._fvEntries ? window._fvEntries[jobId] : null;
    if (!entry) return;

    // Update chevron to downward-pointing arrow
    var chev = document.getElementById('fv-chev-' + idx);
    if (chev) chev.textContent = '\u25BC';

    // Build the detail row HTML
    var detailHtml = '<tr id="fv-detail-' + idx + '" class="fv-detail-row">'
        + '<td colspan="4" class="fv-detail-cell">'
        + '<div class="fv-detail-panel">';

    for (var i = 0; i < entry.errorItems.length; i++) {
        var item = entry.errorItems[i];
        var levelClass = item.level === 'FATAL' || item.level === 'SEVERE'
            ? 'fv-detail-level-critical' : 'fv-detail-level-error';
        detailHtml += '<div class="fv-detail-item">'
            + '<div class="fv-detail-header">'
            + '<span class="fv-detail-level ' + levelClass + '">' + escapeHtml(item.level) + '</span>'
            + (item.lineNumber ? '<span class="fv-detail-line">Line ' + item.lineNumber + '</span>' : '')
            + '<span class="fv-detail-idx">' + (i + 1) + ' / ' + entry.errorItems.length + '</span>'
            + '</div>'
            + '<pre class="fv-detail-text">' + escapeHtml(item.detail) + '</pre>'
            + '</div>';
    }

    detailHtml += '</div></td></tr>';

    // Insert after the parent row
    parentRow.insertAdjacentHTML('afterend', detailHtml);
}

// Switch between job table and failure consolidation view.
function toggleFailureView() {
    const jobTable = document.getElementById('job-table');
    const failureView = document.getElementById('failure-view');
    const btnLabel = document.getElementById('ops-failure-view-label');
    if (!jobTable || !failureView) return;

    _failureViewActive = !_failureViewActive;

    if (_failureViewActive) {
        jobTable.style.display = 'none';
        failureView.classList.remove('hidden');
        if (btnLabel) btnLabel.textContent = 'Back to Jobs';
        renderFailureView();
        setToolbarViewState('failures');
        // Clear search
        const searchInput = document.getElementById('fv-search');
        if (searchInput) searchInput.value = '';
    } else {
        failureView.classList.add('hidden');
        jobTable.style.display = '';
        if (btnLabel) btnLabel.textContent = 'Failures';
        setToolbarViewState('jobs');
    }
}

// Filter failure view rows by search term. Searches the aggregated text (job name + errors).
function filterFailureRows(searchTerm) {
    var tbody = document.getElementById('fv-tbody');
    if (!tbody) return;
    var term = searchTerm.toLowerCase().trim();
    var rows = tbody.querySelectorAll('tr[data-fv-job]');
    var visible = 0;
    rows.forEach(function(row) {
        var idx = row.getAttribute('data-fv-idx');
        var detailRow = idx != null ? document.getElementById('fv-detail-' + idx) : null;
        if (!term) {
            row.style.display = '';
            if (detailRow) detailRow.style.display = '';
            visible++;
            return;
        }
        // Search against the pre-built searchBlob that contains job name, all error summaries, and full error text.
        var blob = (row.getAttribute('data-fv-search') || '').toLowerCase();
        var match = blob.indexOf(term) !== -1;
        row.style.display = match ? '' : 'none';
        if (detailRow) detailRow.style.display = match ? '' : 'none';
        if (match) visible++;
    });
    // Update subtitle with filtered count
    var sub = document.getElementById('fv-subtitle');
    if (sub) {
        if (term) {
            sub.textContent = 'Showing ' + visible + ' of ' + rows.length + ' jobs (filtered)';
        } else {
            sub.textContent = rows.length + ' job' + (rows.length !== 1 ? 's' : '') + ' with failures or instabilities';
        }
    }
}

// Wire up search input with debounce to avoid filtering on every keystroke
document.addEventListener('DOMContentLoaded', function() {
    const fvSearch = document.getElementById('fv-search');
    if (fvSearch) {
        fvSearch.addEventListener('input', function() {
            if (_fvSearchDebounce) clearTimeout(_fvSearchDebounce);
            _fvSearchDebounce = setTimeout(() => filterFailureRows(this.value), 200);
        });
    }
});

// Remove rerun status badges after a delay (10 seconds by default).
function scheduleRerunBadgeCleanup(jobIds, delay) {
    jobIds.forEach(jobId => {
        setTimeout(() => {
            appState.rerunStates.delete(jobId);
            const r = document.querySelector(`tr[data-job-id="${escapeHtml(jobId)}"]`);
            if (r) {
                const badge = r.querySelector('.badge-rerun');
                if (badge) badge.remove();
            }
        }, delay);
    });
}

// Send rerun request to Jenkins API and update UI with status badges.
async function triggerRerun(jobIds) {
    if (appState.activeOperationId) {
        showToast('Cannot rerun while a fetch/refresh is in progress', 'warning');
        return;
    }
    const creds = ensureCredentials('Please enter credentials');
    if (!creds) return;

    // Filter out jobs that are currently running
    jobIds = jobIds.filter(jobId => {
        const job = appState.jobs.get(jobId);
        return job && !job.is_running && job.latest_status !== 'IN_PROGRESS';
    });
    if (jobIds.length === 0) {
        showToast('All selected jobs are currently running', 'info');
        return;
    }

    const jobUrls = jobIds.map(jobId => {
        const job = appState.jobs.get(jobId);
        return job ? job.url : jobId;
    });

    // Mark jobs as "Triggering" and show badges
    jobIds.forEach(jobId => {
        appState.rerunStates.set(jobId, 'Triggering');
        const row = document.querySelector(`tr[data-job-id="${escapeHtml(jobId)}"]`);
        if (row) {
            updateRerunBadge(row, 'Triggering');
        }
    });

    try {
        const response = await fetch('/api/rerun', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                job_urls: jobUrls,
                jenkins_url: creds.jenkins_url,
                username: creds.username,
                api_token: creds.api_token
            })
        });

        const result = await response.json();
        if (response.ok) {
            // Update badges to "Triggered"
            jobIds.forEach(jobId => {
                appState.rerunStates.set(jobId, 'Triggered');
                const row = document.querySelector(`tr[data-job-id="${escapeHtml(jobId)}"]`);
                if (row) updateRerunBadge(row, 'Triggered');
            });
            scheduleRerunBadgeCleanup(jobIds, 10000);
            showToast(`${jobIds.length} job(s) rerun triggered`, 'success');
        } else {
            throw new Error(result.message || 'Rerun failed');
        }
    } catch (error) {
        // Mark as failed
        jobIds.forEach(jobId => {
            appState.rerunStates.set(jobId, 'TriggerFailed');
            const row = document.querySelector(`tr[data-job-id="${escapeHtml(jobId)}"]`);
            if (row) updateRerunBadge(row, 'TriggerFailed');
        });
        scheduleRerunBadgeCleanup(jobIds, 10000);
        reportFetchError('Rerun', 'Rerun failed for ' + jobIds.length + ' job(s)', '/api/rerun', error, 'Rerun failed: ' + error.message, jobIds.join(', '));
    }
}

// Update the rerun status badge on a table row based on the operation state.
function updateRerunBadge(row, state) {
    const statusCell = row.querySelector('.cell-status');
    if (!statusCell) return;

    let badge = row.querySelector('.badge-rerun');
    if (!badge) {
        badge = document.createElement('span');
        badge.className = 'badge-rerun';
        statusCell.appendChild(badge);
    }

    badge.className = 'badge-rerun';
    badge.textContent = state;

    if (state === 'Triggered') {
        badge.classList.add('badge-rerun-triggered');
        badge.title = 'Jenkins accepted the build request — this does not mean the build is running yet. Click Refresh to check for a new build.';
    } else if (state === 'TriggerFailed') {
        badge.classList.add('badge-rerun-failed');
        badge.textContent = 'Trigger Failed';
    } else if (state === 'PermissionDenied') {
        badge.classList.add('badge-rerun-denied');
        badge.textContent = 'Permission Denied';
    } else if (state === 'JobDisabled') {
        badge.classList.add('badge-rerun-disabled');
        badge.textContent = 'Job Disabled';
    }
}

// ========== EXPORT CSV ==========

// Export the current job table or failure view to a CSV file.
function exportCSV() {
    // If failure view is active, export failure entries instead
    if (_failureViewActive) {
        exportFailureCSV();
        return;
    }
    try {
    const visibleJobs = getVisibleJobs();
    if (visibleJobs.length === 0) {
        showToast('No jobs to export', 'info');
        return;
    }

    const pt = getPromotionTime();
    const includeRegression = !!pt;

    const headers = [
        'Job Name',
        'Latest Status',
        'Previous Status',
        'Last Passed',
        'Last Execution Time',
        'Tests Executed',
        'Tests Passed',
        'Tests Failed',
        'Test Errors',
        'Tests Skipped',
        'Duration (s)',
        'Metrics Source',
        'Domain',
        'Subcategory',
        'Impact Level',
        'Confidence',
        'Secondary Hint',
        'Log Analysis Labels',
        'Recommended Action',
        'Matched Rule',
        ...(includeRegression ? ['Baseline Validation'] : [])
    ];

    const regressionLabel = { passed: 'Validated', failed: 'Never Passed', in_progress: 'In Progress', not_executed: 'Not Executed Since Promotion' };

    const rows = visibleJobs.map(job => {
        const base = [
            escapeCSV(job.name),
            job.latest_status,
            job.previous_status || '',
            job.last_passed ? `${job.last_passed.build}` : '',
            job.last_execution_time || '',
            job.test_metrics?.total || '',
            job.test_metrics?.passed || '',
            job.test_metrics?.failed || '',
            job.test_metrics?.errors || '',
            job.test_metrics?.skipped || '',
            job.test_metrics?.duration_seconds || '',
            job.test_metrics?.metrics_source || '',
            job.classification?.primary_domain || '',
            job.classification?.subcategory || '',
            job.classification?.impact || '',
            job.classification?.confidence || '',
            job.classification?.secondary_hint ? escapeCSV(JSON.stringify(job.classification.secondary_hint)) : '',
            job.classification?.all_labels ? job.classification.all_labels.map(l => l.label).join(' | ') : (job.classification?.label || ''),
            job.classification?.action ? escapeCSV(job.classification.action) : '',
            job.classification?.matched_rule_name || ''
        ];
        if (includeRegression) {
            base.push(regressionLabel[deriveRegressionStatus(job, pt)] || '');
        }
        return base;
    });

    const csv = [headers, ...rows].map(r => r.map(c => `"${c}"`).join(',')).join('\n');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = `jenkins-analysis-${timestamp}.csv`;

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    showToast(`Exported ${visibleJobs.length} jobs to ${filename}`, 'success');
    } catch (csvErr) {
        diagLog('error', 'Export', 'CSV export failed', { stack: csvErr.stack, raw: csvErr.message });
        showToast('CSV export failed: ' + csvErr.message, 'error');
    }
}

// Escape special characters in CSV fields (double quotes).
function escapeCSV(str) {
    if (typeof str !== 'string') str = String(str);
    return str.replace(/"/g, '""');
}

// Export failure consolidation view to CSV with detailed error information.
function exportFailureCSV() {
    try {
    var entries = collectFailureEntries();
    if (entries.length === 0) {
        showToast('No failure entries to export', 'info');
        return;
    }
    var headers = ['Job Name', 'Job URL', 'Error Count', 'Error Summary', 'Full Errors', 'Last Execution Time'];
    var rows = entries.map(function(e) {
        // Build full error text from errorItems for export
        var fullText = (e.errorItems || []).map(function(item, idx) {
            return '[' + (idx + 1) + '] ' + (item.level || 'ERROR') + ': ' + (item.detail || item.message || '');
        }).join('\n');
        if (!fullText) fullText = e.errorSummary || '';
        return [
            escapeCSV(e.jobName),
            escapeCSV(e.jobUrl || ''),
            String(e.errorCount),
            escapeCSV(e.errorSummary),
            escapeCSV(fullText),
            e.execTime || ''
        ];
    });
    var csv = [headers].concat(rows).map(function(r) { return r.map(function(c) { return '"' + c + '"'; }).join(','); }).join('\n');
    var timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    var filename = 'failure-report-' + timestamp + '.csv';
    var blob = new Blob([csv], { type: 'text/csv' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
    showToast('Exported ' + entries.length + ' failed jobs to ' + filename, 'success');
    } catch (csvErr) {
        diagLog('error', 'Export', 'Failure CSV export failed', { stack: csvErr.stack, raw: csvErr.message });
        showToast('Failure CSV export failed: ' + csvErr.message, 'error');
    }
}
