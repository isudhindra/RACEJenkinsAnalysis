// Jenkins Dashboard streaming module — handles real-time SSE data fetching,
// row rendering, enrichment, and progress tracking for job analysis.
'use strict';

// Update the header status indicator (dot, label, chip) to reflect current operation state
function updateHeaderStatus(state) {
    const dot = document.getElementById('header-status-dot');
    const label = document.getElementById('header-status-label');
    const chip = document.getElementById('header-status-chip');
    if (!dot || !label) return;
    dot.classList.remove('connected', 'fetching', 'error');
    if (chip) chip.className = 'header-status-chip';
    if (state === 'fetching') {
        dot.classList.add('fetching');
        label.textContent = 'Fetching';
        if (chip) chip.classList.add('status--fetching');
    } else if (state === 'connected') {
        dot.classList.add('connected');
        label.textContent = 'Ready';
        if (chip) chip.classList.add('status--connected');
    } else if (state === 'error') {
        dot.classList.add('error');
        label.textContent = 'Error';
        if (chip) chip.classList.add('status--error');
    } else {
        label.textContent = 'Idle';
    }
}

// Initiate a fetch operation by validating credentials, building the request, and opening an SSE stream
function triggerFetch() {
    if (appState.activeOperationId) {
        showToast('Fetch already in progress', 'warning');
        return;
    }

    const creds = ensureCredentials('Please authenticate first');
    if (!creds) return;

    const environment = appState._selectedEnvironment;
    let url = '/api/fetch/stream';
    let body;

    if (appState.sourceMode === 'job_list') {
        // Job list mode — send explicit job names
        if (!appState.customJobList || appState.customJobList.jobs.length === 0) {
            showToast('Please select or upload a job list', 'error');
            return;
        }
        body = {
            source_mode: 'job_list',
            jenkins_url: creds.jenkins_url,
            username: creds.username,
            api_token: creds.api_token,
            job_names: appState.customJobList.jobs,
            environment: environment || null,
            promotion_time: getPromotionTimeISO()
        };
        appState.currentViewUrl = 'job_list:' + appState.customJobList.name;
    } else {
        // View mode — resolve view_path to full URL via instance base
        const viewSelect = document.getElementById('cfg-view-select');
        const viewPath = viewSelect.value;
        const resolvedUrl = appState._resolvedViewUrl;

        if (!viewPath && !resolvedUrl) {
            showToast('Please select a Jenkins view', 'error');
            return;
        }

        // Construct deterministic URL from view_path + jenkins_url
        const resolved = resolveViewUrl(viewPath);
        body = {
            source_mode: 'view_url',
            jenkins_url: creds.jenkins_url,
            username: creds.username,
            api_token: creds.api_token,
            view_path: resolved.viewPath,
            view_url: resolved.viewUrl,
            environment: environment || null,
            promotion_time: getPromotionTimeISO()
        };
        appState.currentViewUrl = resolved.viewUrl;
    }

    // Set fetch button to loading state
    const fetchBtn = document.getElementById('btn-fetch');
    fetchBtn.disabled = true;
    fetchBtn.innerHTML = '<span class="cfg-spinner"></span> Fetching...';
    document.getElementById('btn-update').style.display = 'none';
    document.getElementById('btn-refresh-failed').style.display = 'none';

    // Collapse config panel during fetch
    document.getElementById('config-panel').classList.remove('expanded');

    // Complete state reset before loading new dataset
    resetDashboardState();

    // Begin storytelling — first phase is establishing connection
    motionSetPhase('connecting');

    initFetchStream(url, body);
}

// Reset the progress bar to initial state and initialize display elements
function resetProgressBar() {
    const bar = $id('progress-bar');
    bar.classList.remove('completed', 'has-errors');
    bar.classList.add('visible');
    $id('progress-fill').style.width = '0%';
    $id('progress-fill').classList.remove('complete', 'has-errors');
    setText('progress-pct', '0%');
    setText('progress-processed', '0');
    setText('progress-total', '0');
    setText('progress-errors', '0');
    setText('progress-stage-label', 'Discovering Jobs...');
    setText('progress-text', appState.sourceMode === 'job_list' ? 'Loading jobs from custom job list...' : 'Loading job list from Jenkins view...');
    show('progress-cancel-btn');
    $id('progress-completion').classList.remove('visible', 'success', 'warning');
    $id('stage-dot-1').className = 'stage-dot active';
    $id('stage-dot-2').className = 'stage-dot';
    $id('stage-dot-3').className = 'stage-dot';
    $id('progress-stage-icon').innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 2v4m0 12v4m-8-10H2m20 0h-2m-2.93-6.07l-1.41 1.41M7.34 16.66l-1.41 1.41m0-11.14l1.41 1.41m9.32 9.32l1.41 1.41"/></svg>';
    $id('progress-stage-icon').className = 'progress-stage-icon';
    appState._fetchErrorCount = 0;

    // Add bottom padding to table-container so rows aren't hidden behind
    // the floating progress overlay.
    var tc = document.querySelector('.table-container');
    if (tc) tc.classList.add('has-progress-overlay');
}

// Open an SSE stream to the server and handle incoming job data events in real-time
async function initFetchStream(url, body) {
    appState.activeOperationId = 'op_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

    resetProgressBar();
    updateHeaderStatus('fetching');
    beginStreamingMode();

    document.getElementById('config-panel').style.display = 'none';

    // statusTransitions already cleared by resetDashboardState;
    // fresh fetch has no prior statuses to compare against.

    // Create AbortController so cancelFetch() can abort the request
    const controller = new AbortController();
    appState._fetchAbortController = controller;

    try {
        const _sseT0 = performance.now();
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => response.statusText);
            diagLogNetwork('POST', url, response.status, Math.round(performance.now() - _sseT0), 'Server returned ' + response.status);
            throw new Error(`Server returned ${response.status}: ${errText}`);
        }
        diagLogNetwork('POST', url, response.status, Math.round(performance.now() - _sseT0), null, 'SSE stream opened');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(line.substring(6));
                        // Adopt the server's operation ID on first event
                        if (data.operation_id && appState.activeOperationId && appState.activeOperationId.startsWith('op_')) {
                            appState.activeOperationId = data.operation_id;
                        }
                        if (data.operation_id && data.operation_id !== appState.activeOperationId) {
                            console.log('Ignoring stale event:', data.operation_id);
                            continue;
                        }
                        // If operation was cancelled (activeOperationId is null), drop all events
                        if (!appState.activeOperationId) {
                            continue;
                        }

                        if (data.event_type === 'job_metadata') {
                            handleJobMetadata(data);
                        } else if (data.event_type === 'job_enriched') {
                            handleJobEnriched(data);
                        } else if (data.event_type === 'progress_update') {
                            handleProgressUpdate(data);
                        } else if (data.event_type === 'job_error') {
                            handleJobError(data);
                        } else if (data.event_type === 'fetch_complete') {
                            handleFetchComplete(data);
                        } else {
                            console.warn('[SSE] Unknown event type:', data.event_type, data);
                            diagLog('warning', 'SSE', 'Unknown event type: ' + data.event_type, { raw: JSON.stringify(data) });
                        }
                    } catch (e) {
                        console.error('Error parsing SSE event:', e);
                        diagLog('error', 'SSE', 'Error parsing SSE event', { stack: e.stack, raw: e.message });
                    }
                }
            }
        }
    } catch (error) {
        if (error.name === 'AbortError') return; // User cancelled — handled by cancelFetch()
        endStreamingMode(); // Clean up loading indicators on error
        reportFetchError('SSE', 'Connection error during fetch', '/api/fetch-jobs (SSE)', error, 'Connection error during fetch: ' + error.message);
        document.getElementById('progress-bar').classList.remove('visible');
        document.getElementById('config-panel').style.display = '';
        var tc = document.querySelector('.table-container');
        if (tc) tc.classList.remove('has-progress-overlay');
        appState.activeOperationId = null;
        appState._fetchAbortController = null;
        updateHeaderStatus('idle');
        updateFetchButton();
        updateEmptyState();
    }
}

// Schedule a debounced filter, sort, and summary update to reduce layout thrashing during SSE events
let _filterSortRaf = null;
function scheduleFilterSortUpdate() {
    if (_filterSortRaf) return;
    _filterSortRaf = requestAnimationFrame(() => {
        _filterSortRaf = null;
        applyFilters();
        updateSummaryBar();
    });
}

// Buffer system for batched DOM insertion of job rows during streaming
const _rowBatch = {
    queue: [],          // Pending { row, needsEnrichment } objects
    flushRaf: null,     // RAF handle for the flush loop
    chunkSize: 18,      // Rows to append per animation frame
    totalExpected: 0,   // From progress events (total_jobs)
    insertionCounter: 0,// Monotonic counter for insertion order
    skeletonRows: [],   // Currently displayed skeleton placeholder rows
    skeletonCount: 4,   // Number of skeleton rows to show
    isStreaming: false,  // True while SSE stream is active
};

// Show the inline loading indicator below the table
function showTableLoadingIndicator(message) {
    const el = $id('table-loading-indicator');
    if (!el) return;
    el.classList.remove('hidden');
    const msg = $id('tli-message');
    if (msg) msg.textContent = message || 'Loading rows...';
    updateLoadingCount();
}

// Hide the inline loading indicator
function hideTableLoadingIndicator() {
    const el = $id('table-loading-indicator');
    if (el) el.classList.add('hidden');
}

// Update the row counter in the loading indicator with current load progress
function updateLoadingCount() {
    const countEl = $id('tli-count');
    if (!countEl) return;
    const loaded = appState.jobs.size;
    if (_rowBatch.totalExpected > 0) {
        countEl.textContent = `${loaded} / ${_rowBatch.totalExpected} jobs`;
    } else if (loaded > 0) {
        countEl.textContent = `${loaded} jobs loaded`;
    } else {
        countEl.textContent = '';
    }
}

// Insert skeleton placeholder rows at the bottom of tbody for perceived loading performance
function showSkeletonRows() {
    removeSkeletonRows();
    const tbody = document.querySelector('#job-table tbody');
    if (!tbody) return;
    const colCount = document.querySelectorAll('#job-table thead th').length;
    for (let i = 0; i < _rowBatch.skeletonCount; i++) {
        const tr = document.createElement('tr');
        tr.className = 'skeleton-row';
        tr.style.opacity = String(1 - i * 0.2);
        // Build cells matching table column count
        const cells = [];
        for (let c = 0; c < colCount; c++) {
            const widthCls = c === 0 ? 'skel-ws' : c === 1 ? 'skel-w1' : c < 5 ? 'skel-w2' : 'skel-w3';
            cells.push(`<td class="skeleton-row"><span class="skel-block ${widthCls}"></span></td>`);
        }
        tr.innerHTML = cells.join('');
        tbody.appendChild(tr);
        _rowBatch.skeletonRows.push(tr);
    }
}

// Remove all skeleton placeholder rows from the DOM
function removeSkeletonRows() {
    _rowBatch.skeletonRows.forEach(tr => { if (tr.parentNode) tr.parentNode.removeChild(tr); });
    _rowBatch.skeletonRows = [];
}

// Enqueue a rendered row for batched DOM insertion via RAF-based flush cycle
function enqueueRow(row, needsEnrichment) {
    _rowBatch.queue.push({ row, needsEnrichment });
    // Show loading indicator if not already visible
    if (_rowBatch.queue.length === 1) {
        showTableLoadingIndicator('Loading rows...');
        showSkeletonRows();
    }
    scheduleRowFlush();
}

// Schedule a RAF-based flush of the row queue to batch DOM updates efficiently
function scheduleRowFlush() {
    if (_rowBatch.flushRaf) return;
    _rowBatch.flushRaf = requestAnimationFrame(flushRowBatch);
}

// Flush one chunk of rows from the queue into the DOM with controlled performance
function flushRowBatch() {
    _rowBatch.flushRaf = null;
    const tbody = document.querySelector('#job-table tbody');
    if (!tbody) return;

    const chunk = _rowBatch.queue.splice(0, _rowBatch.chunkSize);
    if (chunk.length === 0) return;

    // Remove skeleton rows before inserting real rows, they'll be re-added if more expected
    removeSkeletonRows();

    // Use a DocumentFragment for batched DOM insertion (single reflow)
    const fragment = document.createDocumentFragment();
    chunk.forEach(({ row, needsEnrichment }) => {
        if (needsEnrichment) {
            row.classList.add('row-pending');
            const recCell = row.querySelector('.cell-log-analysis');
            if (recCell) recCell.innerHTML = '<span class="row-enriching-indicator">Analyzing...</span>';
        }
        // Cap stagger delay: max 0.7s regardless of row count, then batch offset
        const staggerBase = Math.min(_rowBatch.insertionCounter * 0.035, 0.7);
        row.style.animationDelay = staggerBase + 's';
        row.dataset.insertionOrder = _rowBatch.insertionCounter++;
        fragment.appendChild(row);
        // Track row insertion for motion stagger calculations
        motionNoteRowInserted();
    });
    tbody.appendChild(fragment);

    // Observe rows for scroll-reveal (batch — defer to next microtask to avoid layout thrash)
    requestAnimationFrame(() => {
        chunk.forEach(({ row }) => observeRowForScroll(row));
    });

    // Update loading counter
    updateLoadingCount();

    // If more rows queued, schedule next flush + show skeletons
    if (_rowBatch.queue.length > 0) {
        showSkeletonRows();
        scheduleRowFlush();
    } else if (_rowBatch.isStreaming) {
        // Stream still active but queue empty — keep indicator, add skeletons
        showSkeletonRows();
    } else {
        // All done
        removeSkeletonRows();
        hideTableLoadingIndicator();
    }

    // Schedule debounced filter/sort/KPI updates
    scheduleFilterSortUpdate();
    updateEmptyState();
}

// Signal that SSE streaming has started — show loading state and transition UI
function beginStreamingMode() {
    _rowBatch.isStreaming = true;
    _rowBatch.insertionCounter = 0;
    _rowBatch.totalExpected = 0;

    // Immediately transition from empty-state to table layout to show structural presence early
    var emptyEl = $id('empty-state');
    if (emptyEl) emptyEl.classList.add('hidden');
    var noResultsEl = $id('no-results-state');
    if (noResultsEl) noResultsEl.classList.add('hidden');

    var table = $id('job-table');
    if (table) {
        table.classList.remove('hidden');
        table.style.display = 'table';
    }

    showTableLoadingIndicator('Preparing rows...');
    showSkeletonRows();

    // Advance storytelling — stream opened, now discovering jobs
    motionSetPhase('discovering');
}

// Signal that SSE streaming has ended — flush remaining rows and clean up loading UI
function endStreamingMode() {
    _rowBatch.isStreaming = false;
    removeSkeletonRows();
    // Flush any remaining rows immediately
    if (_rowBatch.queue.length > 0) {
        if (_rowBatch.flushRaf) { cancelAnimationFrame(_rowBatch.flushRaf); _rowBatch.flushRaf = null; }
        // Flush all remaining at once
        const tbody = document.querySelector('#job-table tbody');
        if (tbody) {
            const fragment = document.createDocumentFragment();
            const remaining = _rowBatch.queue.splice(0);
            remaining.forEach(({ row, needsEnrichment }) => {
                if (needsEnrichment) {
                    row.classList.add('row-pending');
                    const recCell = row.querySelector('.cell-log-analysis');
                    if (recCell) recCell.innerHTML = '<span class="row-enriching-indicator">Analyzing...</span>';
                }
                row.style.animationDelay = '0s';
                row.dataset.insertionOrder = _rowBatch.insertionCounter++;
                fragment.appendChild(row);
            });
            tbody.appendChild(fragment);
            remaining.forEach(({ row }) => observeRowForScroll(row));
        }
    }
    hideTableLoadingIndicator();
}

// Reset the batch buffer state completely for a fresh fetch cycle
function resetRowBatch() {
    if (_rowBatch.flushRaf) { cancelAnimationFrame(_rowBatch.flushRaf); _rowBatch.flushRaf = null; }
    _rowBatch.queue = [];
    _rowBatch.insertionCounter = 0;
    _rowBatch.totalExpected = 0;
    _rowBatch.isStreaming = false;
    removeSkeletonRows();
    hideTableLoadingIndicator();
}

// Process a job_metadata event: create or update a job record and render its row
function handleJobMetadata(data) {
    const jobId = data.job_url;
    const isRunning = data.is_running === true || data.current_status === 'IN_PROGRESS';
    const analysisRef = data.analysis_reference || null;
    const job = {
        job_id: jobId,
        name: data.job_name,
        url: data.job_url,
        latest_status: data.current_status,
        is_running: isRunning,
        analysis_reference: analysisRef,
        previous_status: data.previous_status || (data.three_run_context && data.three_run_context.previous ? data.three_run_context.previous.status : null) || data.current_status,
        last_passed: (data.three_run_context && data.three_run_context.last_passed) || data.last_passed || null,
        test_metrics: data.test_metrics || {},
        last_refreshed_at: new Date(data.last_refreshed_at || Date.now()),
        last_execution_time: data.last_execution_time || (data.three_run_context && data.three_run_context.latest ? data.three_run_context.latest.timestamp : null) || null,
        data_completeness: data.data_completeness || 'UNKNOWN',
        three_run_context: data.three_run_context || {},
        recent_builds: data.recent_builds || [],
        classification: data.classification || null,
        failure_evidence: data.failure_evidence || null
    };

    appState.lastRefreshTimes.set(jobId, new Date());
    const existingRow = document.querySelector(`tr[data-job-id="${escapeHtml(jobId)}"]`);

    appState.jobs.set(jobId, job);

    if (existingRow) {
        // Row already exists — update in place (selective refresh case)
        updateJobRow(jobId, job);
        existingRow.classList.remove('row-pending');
        scheduleFilterSortUpdate();
    } else {
        // New row — create element and enqueue for batched insertion
        const row = renderJobRow(job);
        const needsEnrichment = !isRunning && ['FAILURE', 'UNSTABLE'].includes(data.current_status);
        enqueueRow(row, needsEnrichment);
    }

    updateEmptyState();
    // Refresh promotion panel if active
    if (appState.promotionTime) updatePromotionPanel(appState.promotionTime);
}

// Merge enrichment fields from a data payload into an existing job object (shared by SSE and refresh)
function mergeEnrichmentFields(job, data) {
    if (data.classification)   job.classification = data.classification;
    if (data.three_run_context) job.three_run_context = data.three_run_context;
    if (data.test_metrics)     job.test_metrics = data.test_metrics;
    if (data.data_completeness) job.data_completeness = data.data_completeness;
    if (data.failure_evidence) job.failure_evidence = data.failure_evidence;
    if (data.recent_builds && data.recent_builds.length) job.recent_builds = data.recent_builds;
}

// Process a job_enriched event: update a job with analysis results and re-render its row
function handleJobEnriched(data) {
    const jobId = data.job_url;
    const job = appState.jobs.get(jobId);
    if (!job) return;

    // Classification has enriched label/hint fields that need specific mapping
    if (data.classification) {
        const c = data.classification;
        job.classification = {
            primary_domain: c.primary_domain,
            subcategory: c.subcategory,
            impact: c.impact,
            confidence: c.confidence,
            matched_rule_name: c.matched_rule_name,
            matched_pattern: c.matched_pattern,
            evidence_snippet: c.evidence_snippet,
            action: c.action,
            label: c.label || c.subcategory || '',
            all_labels: c.all_labels || [],
            secondary_hint: c.secondary_hint
        };
    }

    // Merge remaining enrichment fields
    mergeEnrichmentFields(job, { ...data, classification: null });

    const row = document.querySelector(`tr[data-job-id="${escapeHtml(jobId)}"]`);
    if (row) {
        row.classList.remove('row-pending');
        row.classList.add('row-just-enriched');
        row.style.animationDelay = '0s';
        updateJobRow(jobId, job);
        setTimeout(() => row.classList.remove('row-just-enriched'), 800);
        // Trigger the motion enrichment pulse animation on this row
        motionEnrichRow(row);
    }

    rebuildLogAnalysisLabelCache();
    applyFilters();
    updateSummaryBar();
}

// Process a progress_update event: update progress bar and stage indicators with fetch status
function handleProgressUpdate(data) {
    const progressFill = document.getElementById('progress-fill');
    const progressText = document.getElementById('progress-text');
    const total = data.total || 1;
    const completed = data.completed || 0;
    const pct = Math.round((completed / total) * 100);

    // Feed total into row batch system for progress display
    if (total > 0) _rowBatch.totalExpected = total;
    updateLoadingCount();

    // Update progress bar width
    progressFill.style.width = pct + '%';

    // Update percentage display
    document.getElementById('progress-pct').textContent = pct + '%';

    // Update processed/total counters
    document.getElementById('progress-processed').textContent = completed;
    document.getElementById('progress-total').textContent = total;

    // Stage-specific labels and mini stage dots
    const stageLabel = document.getElementById('progress-stage-label');
    const dot1 = document.getElementById('stage-dot-1');
    const dot2 = document.getElementById('stage-dot-2');
    const dot3 = document.getElementById('stage-dot-3');

    if (data.stage === 'stage_1') {
        stageLabel.textContent = 'Fetching Build Results & Test Metrics';
        progressText.textContent = `Retrieving metadata for ${completed} of ${total} jobs...`;
        dot1.className = 'stage-dot done';
        dot2.className = 'stage-dot active';
        dot3.className = 'stage-dot';
        // Advance narrative — now pulling execution data
        motionSetPhase('fetching');
    } else if (data.stage === 'stage_2') {
        stageLabel.textContent = 'Analyzing Failures & Classifying';
        progressText.textContent = `Analyzing console logs — ${completed} of ${total} failed jobs classified...`;
        dot1.className = 'stage-dot done';
        dot2.className = 'stage-dot done';
        dot3.className = 'stage-dot active';
        // Advance narrative — now classifying failures
        motionSetPhase('classifying');
    }

    // Track error count
    if (!appState._fetchErrorCount) appState._fetchErrorCount = 0;
}

// Process a job_error event: mark the job as failed and update progress error count
function handleJobError(data) {
    const jobId = data.job_url;
    const job = appState.jobs.get(jobId);
    if (!job) return;

    diagLog('warning', 'SSE', 'Job fetch error: ' + (data.error || 'unknown'), { extra: jobId });
    job.error = data.error;
    const row = document.querySelector(`tr[data-job-id="${escapeHtml(jobId)}"]`);
    if (row) {
        row.querySelector('.cell-status').innerHTML = `<span class="badge badge-fetch-error" aria-label="Fetch error">Fetch Error</span>`;
    }

    // Increment error counter in progress bar
    if (!appState._fetchErrorCount) appState._fetchErrorCount = 0;
    appState._fetchErrorCount++;
    const errEl = document.getElementById('progress-errors');
    if (errEl) errEl.textContent = appState._fetchErrorCount;
}

// Update the progress bar visual state to show completion (success or with warnings)
function updateProgressBarComplete(errorCount) {
    const progressBar = $id('progress-bar');
    const progressFill = $id('progress-fill');
    const stageIcon = $id('progress-stage-icon');
    const stageLabel = $id('progress-stage-label');

    $id('stage-dot-1').className = 'stage-dot done';
    $id('stage-dot-2').className = 'stage-dot done';
    $id('stage-dot-3').className = 'stage-dot done';
    progressFill.style.width = '100%';
    setText('progress-pct', '100%');

    if (errorCount > 0) {
        progressBar.classList.add('has-errors');
        progressFill.classList.add('has-errors');
        stageIcon.className = 'progress-stage-icon error';
        stageLabel.textContent = 'Completed with Warnings';
    } else {
        progressBar.classList.add('completed');
        progressFill.classList.add('complete');
        stageIcon.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';
        stageIcon.className = 'progress-stage-icon completed';
        stageLabel.textContent = 'Fetch Complete';
    }
    return { progressBar, progressFill };
}

// Build the completion summary text combining job count, test metrics, errors, and duration
function computeCompletionSummary(totalJobs, failedJobs, errorCount, duration) {
    const agg = aggregateTestMetrics(appState.jobs.values());
    const parts = [`${totalJobs} jobs loaded`];
    if (agg.total > 0) parts.push(`${agg.total.toLocaleString()} tests (${agg.failed.toLocaleString()} failed)`);
    else if (failedJobs > 0) parts.push(`${failedJobs} failures classified`);
    if (errorCount > 0) parts.push(`${errorCount} fetch errors`);
    parts.push(`completed in ${duration.toFixed(1)}s`);
    return { text: parts.join(' · '), cumTests: agg.total, totalJobs, duration };
}

// Schedule the progress bar to hide after a delay
function scheduleProgressBarHide(progressBar, progressFill) {
    setTimeout(() => {
        progressBar.classList.remove('visible', 'completed', 'has-errors');
        progressFill.classList.remove('complete', 'has-errors');
        progressFill.style.width = '0%';
        $id('progress-completion').classList.remove('visible', 'success', 'warning');
        $id('config-panel').style.display = '';
        // Remove the bottom padding now that the overlay is gone
        var tc = document.querySelector('.table-container');
        if (tc) tc.classList.remove('has-progress-overlay');
    }, 5000);
}

// Process a fetch_complete event: finalize streaming, show completion summary, and clean up UI
function handleFetchComplete(data) {
    // Signal the motion system that fetch is complete — triggers settle animations
    motionSetPhase('complete');

    // Flush remaining buffered rows and remove loading indicators
    endStreamingMode();

    const duration = data.duration_seconds || 0;
    const errorCount = appState._fetchErrorCount || 0;
    const totalJobs = data.total_jobs || 0;
    const failedJobs = data.failed_count || 0;

    const { progressBar, progressFill } = updateProgressBarComplete(errorCount);

    // Show completion summary
    const completionEl = $id('progress-completion');
    completionEl.classList.add('visible', errorCount > 0 ? 'warning' : 'success');
    const summary = computeCompletionSummary(totalJobs, failedJobs, errorCount, duration);
    setText('progress-completion-text', summary.text);

    hide('progress-cancel-btn');
    setText('progress-text', 'Analysis complete');

    detectStatusTransitions();
    rebuildLogAnalysisLabelCache();
    applyFilters();
    updateSummaryBar();
    updateEmptyState();
    updateFetchButton();
    // Final promotion panel refresh after all jobs loaded
    if (appState.promotionTime) updatePromotionPanel(appState.promotionTime);

    const toastMsg = summary.cumTests > 0
        ? `Fetch complete: ${summary.totalJobs} jobs · ${summary.cumTests.toLocaleString()} tests (${summary.duration.toFixed(1)}s)`
        : `Fetch complete: ${summary.totalJobs} jobs (${summary.duration.toFixed(1)}s)`;
    showToast(toastMsg, 'success');

    appState.activeOperationId = null;
    appState._fetchAbortController = null;
    appState._fetchErrorCount = 0;
    updateHeaderStatus('connected');

    scheduleProgressBarHide(progressBar, progressFill);

    // Start (or restart) the background auto-refresh poll loop now that the
    // table has data.  initAutoRefresh is idempotent — safe to call after
    // every fetch_complete.
    if (typeof initAutoRefresh === 'function') {
        initAutoRefresh();
    }
}

// Abort the active fetch operation and reset UI to idle state
function cancelFetch() {
    if (!appState.activeOperationId) return;

    // Abort the network request
    if (appState._fetchAbortController) {
        appState._fetchAbortController.abort();
        appState._fetchAbortController = null;
    }

    appState.activeOperationId = null;
    appState._fetchErrorCount = 0;

    // End streaming mode — flush any queued rows, hide loading indicator
    endStreamingMode();

    $id('progress-bar').classList.remove('visible', 'completed', 'has-errors');
    $id('progress-fill').style.width = '0%';
    $id('progress-fill').classList.remove('complete', 'has-errors');
    $id('progress-completion').classList.remove('visible', 'success', 'warning');
    $id('config-panel').style.display = '';
    // Remove overlay padding
    var tc = document.querySelector('.table-container');
    if (tc) tc.classList.remove('has-progress-overlay');

    // Reset the motion narrative strip back to idle on cancel
    motionReset();

    updateHeaderStatus('idle');
    updateFetchButton();
    showToast('Fetch cancelled', 'warning');
}

// Detect status transitions for jobs and notify user of changes filtered out of current view
function detectStatusTransitions() {
    const changed = [];
    appState.statusTransitions.forEach((oldStatus, jobId) => {
        const job = appState.jobs.get(jobId);
        if (job && job.latest_status !== oldStatus) {
            changed.push({
                jobId: jobId,
                name: job.name,
                old: oldStatus,
                new: job.latest_status
            });
        }
    });

    if (changed.length === 0) return;

    const visibleJobs = new Set();
    document.querySelectorAll('tbody tr[data-job-id]').forEach(row => {
        const jobId = row.getAttribute('data-job-id');
        if (row.style.display !== 'none') {
            visibleJobs.add(jobId);
        }
    });

    const hiddenChanges = changed.filter(c => !visibleJobs.has(c.jobId));
    if (hiddenChanges.length > 0) {
        const summary = hiddenChanges.map(c => `${c.old} → ${c.new}`).join(', ');
        showToast(`${hiddenChanges.length} jobs changed status (${summary}) — hidden by current filter`, 'info');
    }
}

// Trigger a selective refresh of failed/unstable jobs or a subset, opening a new SSE stream
async function triggerSelectiveRefresh(scope) {
    if (appState.activeOperationId) {
        showToast('Operation already in progress', 'warning');
        return;
    }

    const creds = ensureCredentials('Please enter credentials');
    if (!creds) return;

    let jobIds = [];
    const statusMap = { 'failed': 'FAILURE', 'unstable': 'UNSTABLE', 'aborted': 'ABORTED' };
    if (statusMap[scope]) {
        jobIds = Array.from(appState.jobs.values())
            .filter(job => job.latest_status === statusMap[scope])
            .map(job => job.job_id);
    } else if (scope === 'selected') {
        jobIds = Array.from(appState.selectedJobs);
    }

    const body = {
        scope: scope,
        job_ids: jobIds,
        jenkins_url: creds.jenkins_url,
        username: creds.username,
        api_token: creds.api_token,
        promotion_time: getPromotionTimeISO()
    };

    appState.statusTransitions.clear();
    appState.jobs.forEach((job, jobId) => {
        appState.statusTransitions.set(jobId, job.latest_status);
    });

    // Full refresh ('all') resets dashboard state; scoped refreshes do not
    if (scope === 'all') {
        resetDashboardState();
    }

    // Set buttons to loading state
    const fetchBtn = document.getElementById('btn-fetch');
    fetchBtn.disabled = true;
    document.getElementById('btn-update').disabled = true;
    document.getElementById('btn-refresh-failed').disabled = true;

    await initFetchStream('/api/refresh/stream', body);
}

// Route refresh button actions to the selective refresh handler
function handleRefreshAction(action) {
    if (!action) return;
    triggerSelectiveRefresh(action);
}
