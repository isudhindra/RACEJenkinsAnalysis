// streaming.js — SSE pipeline: opens the stream, dispatches events, and drives row insertion/enrichment.
'use strict';

// Reflect the current operation state in the header status dot/label/chip.
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

// Validate credentials, build the SSE request body, and open the stream.
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
        // Job list mode — send explicit job names.
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
        // View mode — resolve view_path → full view_url against the instance base.
        const viewSelect = document.getElementById('cfg-view-select');
        const viewPath = viewSelect.value;
        const resolvedUrl = appState._resolvedViewUrl;

        if (!viewPath && !resolvedUrl) {
            showToast('Please select a Jenkins view', 'error');
            return;
        }

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

    const fetchBtn = document.getElementById('btn-fetch');
    fetchBtn.disabled = true;
    fetchBtn.innerHTML = '<span class="cfg-spinner"></span> Fetching...';
    document.getElementById('btn-update').style.display = 'none';
    document.getElementById('btn-refresh-failed').style.display = 'none';

    document.getElementById('config-panel').classList.remove('expanded');

    // Full state reset before loading the new dataset.
    resetDashboardState();

    motionSetPhase('connecting');

    initFetchStream(url, body);
}

// Reset the progress bar widgets back to a clean "0% / discovering" state.
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

    // Pad the table container so rows aren't hidden behind the floating progress overlay.
    var tc = document.querySelector('.table-container');
    if (tc) tc.classList.add('has-progress-overlay');
}

// Open an SSE stream and dispatch incoming events.
async function initFetchStream(url, body) {
    appState.activeOperationId = 'op_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

    resetProgressBar();
    updateHeaderStatus('fetching');
    beginStreamingMode();

    document.getElementById('config-panel').style.display = 'none';

    // AbortController is the canonical cancellation channel for cancelFetch().
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

        const dispatchSseLine = (line) => {
            if (!line.startsWith('data: ')) return;
            // AbortController.signal is the canonical cancellation channel.
            // The operation_id check below is belt-and-braces against a race
            // where a second fetch started server-side could leak events.
            if (controller.signal.aborted) return;
            try {
                const data = JSON.parse(line.substring(6));
                // Adopt the server's operation ID on the first event we see.
                if (data.operation_id && appState.activeOperationId && appState.activeOperationId.startsWith('op_')) {
                    appState.activeOperationId = data.operation_id;
                }
                if (data.operation_id && appState.activeOperationId &&
                    data.operation_id !== appState.activeOperationId) {
                    return;
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
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop();

            for (const line of lines) {
                dispatchSseLine(line);
            }
        }

        // Flush any final decoder bytes after the stream ends.
        buffer += decoder.decode();
        if (buffer.trim().length > 0) {
            const tail = buffer.split('\n\n');
            for (const line of tail) {
                if (line.length > 0) dispatchSseLine(line);
            }
        }

        // Safety net: server closed the stream but never emitted FETCH_COMPLETE
        if (_rowBatch && _rowBatch.isStreaming) {
            diagLog('warning', 'SSE', 'Stream ended without FETCH_COMPLETE — running safety-net KPI flush');
            endStreamingMode();
            try { updateSummaryBar(); } catch (e) { console.error('safety-net updateSummaryBar:', e); }
            try {
                if (appState.promotionTime && typeof updateRegressionKPI === 'function') {
                    updateRegressionKPI(appState.promotionTime);
                }
            } catch (e) { console.error('safety-net updateRegressionKPI:', e); }
            // Make sure the UI matches an idle dashboard.
            document.getElementById('progress-bar').classList.remove('visible');
            document.getElementById('config-panel').style.display = '';
            const tc = document.querySelector('.table-container');
            if (tc) tc.classList.remove('has-progress-overlay');
            appState.activeOperationId = null;
            appState._fetchAbortController = null;
            updateHeaderStatus('idle');
            updateFetchButton();
            updateEmptyState();
        }
    } catch (error) {
        if (error.name === 'AbortError') return; // User cancelled — handled by cancelFetch().
        endStreamingMode();
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

// Batches table updates while jobs stream in so we don't re-filter and re-sort
// on every event. The final pass runs once after the stream ends.
let _filterSortRaf = null;
function scheduleFilterSortUpdate() {
    if (_filterSortRaf) return;
    if (_rowBatch && _rowBatch.isStreaming) return;
    _filterSortRaf = requestAnimationFrame(() => {
        _filterSortRaf = null;
        // Repopulate the release-status dropdown from the current job set first
        // — its own fingerprint memoisation keeps this cheap per frame.
        if (typeof populateReleaseStatusFilter === 'function') populateReleaseStatusFilter();
        applyFilters();
        updateSummaryBar();
    });
}

// Buffer for batched DOM insertion of job rows during streaming.
const _rowBatch = {
    queue: [],          // Pending { row, needsEnrichment } objects.
    flushRaf: null,     // RAF handle for the flush loop.
    chunkSize: 18,      // Rows appended per animation frame.
    totalExpected: 0,   // From progress events (total_jobs).
    insertionCounter: 0,// Monotonic counter for stable insertion order.
    skeletonRows: [],   // Currently displayed skeleton placeholders.
    skeletonCount: 4,
    isStreaming: false, // True while the SSE stream is active.
    // Pending timer IDs that strip .row-fresh after the entry animation;
    // tracked so resetRowBatch() can cancel them and release closure refs
    // to rows that have been thrown away by a fresh fetch.
    freshTimers: [],
};

function showTableLoadingIndicator(message) {
    const el = $id('table-loading-indicator');
    if (!el) return;
    el.classList.remove('hidden');
    const msg = $id('tli-message');
    if (msg) msg.textContent = message || 'Loading rows...';
    updateLoadingCount();
}

function hideTableLoadingIndicator() {
    const el = $id('table-loading-indicator');
    if (el) el.classList.add('hidden');
}

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

// Insert skeleton placeholder rows for perceived loading speed.
function showSkeletonRows() {
    removeSkeletonRows();
    const tbody = document.querySelector('#job-table tbody');
    if (!tbody) return;
    const colCount = document.querySelectorAll('#job-table thead th').length;
    for (let i = 0; i < _rowBatch.skeletonCount; i++) {
        const tr = document.createElement('tr');
        tr.className = 'skeleton-row';
        tr.style.opacity = String(1 - i * 0.2);
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

function removeSkeletonRows() {
    _rowBatch.skeletonRows.forEach(tr => { if (tr.parentNode) tr.parentNode.removeChild(tr); });
    _rowBatch.skeletonRows = [];
}

// Queue a rendered row for batched DOM insertion via the RAF flush cycle.
function enqueueRow(row, needsEnrichment) {
    _rowBatch.queue.push({ row, needsEnrichment });
    if (_rowBatch.queue.length === 1) {
        showTableLoadingIndicator('Loading rows...');
        showSkeletonRows();
    }
    scheduleRowFlush();
}

function scheduleRowFlush() {
    if (_rowBatch.flushRaf) return;
    _rowBatch.flushRaf = requestAnimationFrame(flushRowBatch);
}

// Append one chunk's worth of rows in a single DocumentFragment per frame.
function flushRowBatch() {
    _rowBatch.flushRaf = null;
    const tbody = document.querySelector('#job-table tbody');
    if (!tbody) return;

    const chunk = _rowBatch.queue.splice(0, _rowBatch.chunkSize);
    if (chunk.length === 0) return;

    // Remove skeletons before insertion; re-added below if more rows are still expected.
    removeSkeletonRows();

    // Single reflow per frame via DocumentFragment.
    const fragment = document.createDocumentFragment();
    chunk.forEach(({ row, needsEnrichment }) => {
        if (needsEnrichment) {
            row.classList.add('row-pending');
            const recCell = row.querySelector('.cell-log-analysis');
            if (recCell) recCell.innerHTML = '<span class="row-enriching-indicator">Analyzing...</span>';
        }
        // Cap stagger at 0.7s so large fetches don't get unbearably long entry delays.
        const staggerBase = Math.min(_rowBatch.insertionCounter * 0.035, 0.7);
        row.style.animationDelay = staggerBase + 's';
        row.dataset.insertionOrder = _rowBatch.insertionCounter++;
        // .row-fresh gates the entry animation so it plays exactly once on insertion.
        // Without it the animation re-fires each time a filter toggles display:none.
        row.classList.add('row-fresh');
        fragment.appendChild(row);
        motionNoteRowInserted();
    });
    tbody.appendChild(fragment);

    // Strip the entry-animation class once it has had time to settle (0.5s anim + 0.7s max stagger).
    // Track the timer so resetRowBatch() can cancel it if these rows are discarded mid-animation.
    const animRows = chunk.map(c => c.row);
    const timerId = setTimeout(() => {
        for (const r of animRows) {
            r.classList.remove('row-fresh');
            r.style.animationDelay = '';
        }
        const idx = _rowBatch.freshTimers.indexOf(timerId);
        if (idx !== -1) _rowBatch.freshTimers.splice(idx, 1);
    }, 1500);
    _rowBatch.freshTimers.push(timerId);

    // Defer scroll-reveal observation to the next frame to avoid extra layout work.
    requestAnimationFrame(() => {
        chunk.forEach(({ row }) => observeRowForScroll(row));
    });

    updateLoadingCount();

    if (_rowBatch.queue.length > 0) {
        showSkeletonRows();
        scheduleRowFlush();
    } else if (_rowBatch.isStreaming) {
        // Queue is empty but more rows are still coming — keep skeletons visible.
        showSkeletonRows();
    } else {
        removeSkeletonRows();
        hideTableLoadingIndicator();
    }

    scheduleFilterSortUpdate();
    updateEmptyState();
}

// Enter streaming mode — switch to the table layout and start the narrative.
function beginStreamingMode() {
    _rowBatch.isStreaming = true;
    _rowBatch.insertionCounter = 0;
    _rowBatch.totalExpected = 0;

    // Swap empty-state for the table early so the user sees structure immediately.
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

    motionSetPhase('discovering');
}

// Exit streaming mode — flush any queued rows immediately and clean up loading UI.
function endStreamingMode() {
    _rowBatch.isStreaming = false;
    removeSkeletonRows();
    if (_rowBatch.queue.length > 0) {
        if (_rowBatch.flushRaf) { cancelAnimationFrame(_rowBatch.flushRaf); _rowBatch.flushRaf = null; }
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
    // Run the filter/sort pass that was suppressed during streaming so the
    // final view reflects every enrichment that arrived.
    scheduleFilterSortUpdate();
}

// Reset the row-batch buffer to a clean slate for a fresh fetch cycle.
function resetRowBatch() {
    if (_rowBatch.flushRaf) { cancelAnimationFrame(_rowBatch.flushRaf); _rowBatch.flushRaf = null; }
    // Cancel pending row-fresh cleanup timers so they don't keep closure
    // refs alive to rows that are being thrown away.
    for (const t of _rowBatch.freshTimers) clearTimeout(t);
    _rowBatch.freshTimers = [];
    _rowBatch.queue = [];
    _rowBatch.insertionCounter = 0;
    _rowBatch.totalExpected = 0;
    _rowBatch.isStreaming = false;
    removeSkeletonRows();
    hideTableLoadingIndicator();
}

// Handle a job_metadata event: upsert the job record and render or refresh its row.
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
        failure_evidence: data.failure_evidence || null,
        // Backend computes release_status server-side when promotion_time is supplied.
        // Stored on the job so the Release-Status filter and selection helpers can
        // read it directly without recomputing client-side.
        release_status: data.release_status || null
    };

    appState.lastRefreshTimes.set(jobId, new Date());
    const existingRow = getJobRowEl(jobId);

    appState.jobs.set(jobId, job);

    if (existingRow) {
        // Selective refresh path — update in place.
        updateJobRow(jobId, job);
        existingRow.classList.remove('row-pending');
        scheduleFilterSortUpdate();
    } else {
        // New row — render and enqueue for batched insertion.
        const row = renderJobRow(job);
        const needsEnrichment = !isRunning && ['FAILURE', 'UNSTABLE'].includes(data.current_status);
        enqueueRow(row, needsEnrichment);
    }

    updateEmptyState();
    if (appState.promotionTime) updatePromotionPanel(appState.promotionTime);
}

// Merge enrichment fields into an existing job record (shared by SSE + single-job refresh).
function mergeEnrichmentFields(job, data) {
    if (data.classification)   job.classification = data.classification;
    if (data.three_run_context) job.three_run_context = data.three_run_context;
    if (data.test_metrics)     job.test_metrics = data.test_metrics;
    if (data.data_completeness) job.data_completeness = data.data_completeness;
    if (data.failure_evidence) job.failure_evidence = data.failure_evidence;
    if (data.recent_builds && data.recent_builds.length) job.recent_builds = data.recent_builds;
    // Backend recomputes release_status whenever promotion_time is set;
    // accept the latest value so the filter dropdown stays accurate.
    if (data.release_status) job.release_status = data.release_status;
}

// Handle a job_enriched event: layer classification + metrics onto an existing row.
function handleJobEnriched(data) {
    const jobId = data.job_url;
    const job = appState.jobs.get(jobId);
    if (!job) return;

    // Classification carries enriched label/hint fields that need explicit mapping.
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

    mergeEnrichmentFields(job, { ...data, classification: null });

    const row = getJobRowEl(jobId);
    if (row) {
        row.classList.remove('row-pending');
        row.classList.add('row-just-enriched');
        row.style.animationDelay = '0s';
        updateJobRow(jobId, job);
        setTimeout(() => row.classList.remove('row-just-enriched'), 800);
        motionEnrichRow(row);
    }

    rebuildLogAnalysisLabelCache();
    // Batched so a burst of enriched jobs only triggers one filter+summary
    // pass, not one per event.
    scheduleFilterSortUpdate();
}

// Handle a progress_update event: update progress bar, stage dots, and narrative phase.
function handleProgressUpdate(data) {
    const progressFill = document.getElementById('progress-fill');
    const progressText = document.getElementById('progress-text');
    const total = data.total || 1;
    const completed = data.completed || 0;
    const pct = Math.round((completed / total) * 100);

    if (total > 0) _rowBatch.totalExpected = total;
    updateLoadingCount();

    progressFill.style.width = pct + '%';
    document.getElementById('progress-pct').textContent = pct + '%';
    document.getElementById('progress-processed').textContent = completed;
    document.getElementById('progress-total').textContent = total;

    const stageLabel = document.getElementById('progress-stage-label');
    const dot1 = document.getElementById('stage-dot-1');
    const dot2 = document.getElementById('stage-dot-2');
    const dot3 = document.getElementById('stage-dot-3');

    // `data.stage` is the lowercase *pipeline phase* ("stage_1" = metadata fetch,
    // "stage_2" = enrichment). It is intentionally distinct from the uppercase
    // StageCompletion enum on individual job records — see jjat/models.py.
    if (data.stage === 'stage_1') {
        stageLabel.textContent = 'Fetching Build Results & Test Metrics';
        progressText.textContent = `Retrieving metadata for ${completed} of ${total} jobs...`;
        dot1.className = 'stage-dot done';
        dot2.className = 'stage-dot active';
        dot3.className = 'stage-dot';
        motionSetPhase('fetching');
    } else if (data.stage === 'stage_2') {
        stageLabel.textContent = 'Analyzing Failures & Classifying';
        progressText.textContent = `Analyzing console logs — ${completed} of ${total} failed jobs classified...`;
        dot1.className = 'stage-dot done';
        dot2.className = 'stage-dot done';
        dot3.className = 'stage-dot active';
        motionSetPhase('classifying');
    }

    if (!appState._fetchErrorCount) appState._fetchErrorCount = 0;
}

// Handle a job_error event: mark the row as a fetch failure and bump the progress error counter.
function handleJobError(data) {
    const jobId = data.job_url;
    const job = appState.jobs.get(jobId);
    if (!job) return;

    diagLog('warning', 'SSE', 'Job fetch error: ' + (data.error || 'unknown'), { extra: jobId });
    job.error = data.error;
    const row = getJobRowEl(jobId);
    if (row) {
        row.querySelector('.cell-status').innerHTML = `<span class="badge badge-fetch-error" aria-label="Fetch error">Fetch Error</span>`;
    }

    if (!appState._fetchErrorCount) appState._fetchErrorCount = 0;
    appState._fetchErrorCount++;
    const errEl = document.getElementById('progress-errors');
    if (errEl) errEl.textContent = appState._fetchErrorCount;
}

// Flip the progress bar into success or has-errors completion state.
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

// Build the toast/completion text combining job count, test totals, errors, and duration.
function computeCompletionSummary(totalJobs, failedJobs, errorCount, duration) {
    const agg = aggregateTestMetrics(appState.jobs.values());
    const parts = [`${totalJobs} jobs loaded`];
    if (agg.total > 0) parts.push(`${agg.total.toLocaleString()} tests (${agg.failed.toLocaleString()} failed)`);
    else if (failedJobs > 0) parts.push(`${failedJobs} failures classified`);
    if (errorCount > 0) parts.push(`${errorCount} fetch errors`);
    parts.push(`completed in ${duration.toFixed(1)}s`);
    return { text: parts.join(' · '), cumTests: agg.total, totalJobs, duration };
}

// Hide the progress bar after a 5s grace period so the user has time to read the result.
function scheduleProgressBarHide(progressBar, progressFill) {
    setTimeout(() => {
        progressBar.classList.remove('visible', 'completed', 'has-errors');
        progressFill.classList.remove('complete', 'has-errors');
        progressFill.style.width = '0%';
        $id('progress-completion').classList.remove('visible', 'success', 'warning');
        $id('config-panel').style.display = '';
        var tc = document.querySelector('.table-container');
        if (tc) tc.classList.remove('has-progress-overlay');
    }, 5000);
}

// Handle a fetch_complete event: finalise streaming, run the completion summary, and tidy UI.
function handleFetchComplete(data) {
    motionSetPhase('complete');
    endStreamingMode();

    // Stamp the freshness chip — release managers see when data was last refreshed.
    if (typeof markDataFresh === 'function') markDataFresh();

    const duration = data.duration_seconds || 0;
    const errorCount = appState._fetchErrorCount || 0;
    const totalJobs = data.total_jobs || 0;
    const failedJobs = data.failed_count || 0;

    const { progressBar, progressFill } = updateProgressBarComplete(errorCount);

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

    // Kick the background auto-refresh poll loop. initAutoRefresh is idempotent.
    if (typeof initAutoRefresh === 'function') {
        initAutoRefresh();
    }
}

// Abort the active fetch and reset UI back to idle.
function cancelFetch() {
    if (!appState.activeOperationId) return;

    if (appState._fetchAbortController) {
        appState._fetchAbortController.abort();
        appState._fetchAbortController = null;
    }

    appState.activeOperationId = null;
    appState._fetchErrorCount = 0;

    endStreamingMode();

    $id('progress-bar').classList.remove('visible', 'completed', 'has-errors');
    $id('progress-fill').style.width = '0%';
    $id('progress-fill').classList.remove('complete', 'has-errors');
    $id('progress-completion').classList.remove('visible', 'success', 'warning');
    $id('config-panel').style.display = '';
    var tc = document.querySelector('.table-container');
    if (tc) tc.classList.remove('has-progress-overlay');

    motionReset();

    updateHeaderStatus('idle');
    updateFetchButton();
    showToast('Fetch cancelled', 'warning');
}

// Toast the user if any status changed but the row is hidden by the current filter.
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

// Open a new SSE stream that refreshes only failed/unstable/aborted/selected jobs.
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
        // Scope to *visible* rows only — "Refresh Failed" should act on what
        // the user actually sees, not on jobs hidden by an active search/filter.
        // Matches triggerRerunAllFailed() and updateToolbarActions() semantics.
        jobIds = (typeof getVisibleJobs === 'function' ? getVisibleJobs() : Array.from(appState.jobs.values()))
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

    // Full refresh resets dashboard state; scoped refreshes preserve filters/sort/selection.
    if (scope === 'all') {
        resetDashboardState();
    }

    const fetchBtn = document.getElementById('btn-fetch');
    fetchBtn.disabled = true;
    document.getElementById('btn-update').disabled = true;
    document.getElementById('btn-refresh-failed').disabled = true;

    await initFetchStream('/api/refresh/stream', body);
}

function handleRefreshAction(action) {
    if (!action) return;
    triggerSelectiveRefresh(action);
}
