// rendering.js — HTML for job table rows, expanded detail rows, and status labels.
'use strict';

function renderCheckboxCell(job) {
    return `<td class="checkbox-cell"><input type="checkbox" data-action="select" aria-label="Select job"></td>`;
}

// Job name as a link to its Jenkins page; full path on the title attribute for hover recovery.
function renderJobNameCell(job) {
    const fullName = job.full_name || job.name || '';
    return `<td class="job-name-cell cell-job-name"><a href="${escapeHtml(job.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(fullName)}">${escapeHtml(job.name)}</a></td>`;
}

// 5-square mini timeline of the job's last 5 build statuses (oldest left → newest right).
// recent_builds comes newest-first from the backend; we reverse so the eye reads chronologically.
const _SPARK_STATUS_CLASS = {
    'SUCCESS':     'spark-pass',
    'FAILURE':     'spark-fail',
    'UNSTABLE':    'spark-unstable',
    'ABORTED':     'spark-aborted',
    'IN_PROGRESS': 'spark-running',
    'NOT_BUILT':   'spark-empty',
    'UNKNOWN':     'spark-empty',
};
const _SPARK_SLOTS = 5;

function renderSparklineCell(job) {
    const builds = Array.isArray(job.recent_builds) ? job.recent_builds.slice(0, _SPARK_SLOTS) : [];
    if (!builds.length) {
        // No recent_builds yet (Stage 1 still running) — empty slots.
        let placeholder = '';
        for (let i = 0; i < _SPARK_SLOTS; i++) placeholder += '<span class="spark-cell spark-empty"></span>';
        return `<td class="cell-trend"><span class="sparkline">${placeholder}</span></td>`;
    }

    const ordered = builds.slice().reverse();
    // Pad short histories with empties on the LEFT (older = blank) for new jobs.
    while (ordered.length < _SPARK_SLOTS) ordered.unshift(null);

    const cells = ordered.map(b => {
        if (!b) return '<span class="spark-cell spark-empty" title="(no earlier build)"></span>';
        const cls = _SPARK_STATUS_CLASS[b.status] || 'spark-empty';
        const ts = b.timestamp ? new Date(b.timestamp).toLocaleString() : '';
        const title = `#${b.build_number} · ${b.status}${ts ? ' · ' + ts : ''}`;
        return `<span class="spark-cell ${cls}" title="${escapeHtml(title)}"></span>`;
    }).join('');

    return `<td class="cell-trend"><span class="sparkline">${cells}</span></td>`;
}


// Test metric columns (total / passed / failed / skipped / errors) with status colours.
function renderMetricCells(hasMetrics, errors, total, passed, failed, skipped, sourceTag, diag) {
    const dashTip = diag
        ? ` title="No counts available — ${escapeHtml(diag)}"`
        : '';
    const dash = `<span class="cell-metric-missing"${dashTip}>—</span>`;
    return `<td class="cell-total cell-metric cell-metric-highlight">${hasMetrics ? total + sourceTag : dash}</td>`
        + `<td class="cell-passed cell-metric">${hasMetrics ? renderMetricValue(passed, hasMetrics, 'cell-metric-success') : dash}</td>`
        + `<td class="cell-failed cell-metric">${hasMetrics ? renderMetricValue(failed, hasMetrics, 'cell-metric-danger')  : dash}</td>`
        + `<td class="cell-skipped cell-metric">${hasMetrics ? renderMetricValue(skipped, hasMetrics, 'cell-metric-warning') : dash}</td>`
        + `<td class="cell-errors cell-metric">${hasMetrics ? renderMetricValue(errors, hasMetrics, 'cell-metric-danger')  : dash}</td>`;
}

// Map build status to a CSS class so the console log icon picks up the right colour.
function _clgStatusClass(status) {
    switch (status) {
        case 'SUCCESS':     return ' clg-passed';
        case 'FAILURE':     return ' clg-failed';
        case 'UNSTABLE':    return ' clg-unstable';
        case 'ABORTED':     return ' clg-aborted';
        default:            return '';
    }
}

// Console-log button with optional error-count badge.
function renderConsoleLogBtn(job) {
    const hasEvidence = job.failure_evidence && job.failure_evidence.error_count > 0;
    const logIcon = `<svg width="14" height="14"><use href="#icon-file-text"/></svg>`;
    const errLabel = hasEvidence ? ' has-errors' : '';
    const statusCls = _clgStatusClass(job.latest_status);
    const title = hasEvidence
        ? 'Console Log (' + job.failure_evidence.error_count + ' errors)'
        : 'Console Log';
    return `<span class="icon icon-console-log${errLabel}${statusCls}" data-action="console-log" role="button" tabindex="0" aria-label="View console log" title="${title}">${logIcon}</span>`;
}

// Per-row actions: console log (with special handling for IN_PROGRESS builds), rerun, refresh.
function renderActionsCell(job) {
    const isRunning = job.is_running || job.latest_status === 'IN_PROGRESS';
    const rerunDisabled = isRunning ? ' title="Cannot rerun — build in progress"' : ' title="Rerun"';
    const rerunCls = isRunning ? ' icon-disabled' : '';
    const logIcon = `<svg width="14" height="14"><use href="#icon-file-text"/></svg>`;

    let consoleBtn;
    if (isRunning) {
        // While a build runs, show the previous build's analysis status colour if available.
        const ref = job.analysis_reference;
        if (ref && ref.status) {
            const errLabel = (job.failure_evidence && job.failure_evidence.error_count > 0) ? ' has-errors' : '';
            const refCls = _clgStatusClass(ref.status);
            consoleBtn = `<span class="icon icon-console-log${errLabel}${refCls}" data-action="console-log" role="button" tabindex="0" aria-label="View console log" title="Console log from previous build (${escapeHtml(ref.status)})">${logIcon}</span>`;
        } else {
            consoleBtn = `<span class="icon icon-console-log" data-action="console-log" role="button" tabindex="0" aria-label="View console log" title="Console Log (build in progress)">${logIcon}</span>`;
        }
    } else {
        consoleBtn = renderConsoleLogBtn(job);
    }

    return `<td class="cell-actions"><div class="action-group">`
        + consoleBtn
        + `<span class="icon icon-rerun${rerunCls}" data-action="rerun" role="button" tabindex="0" aria-label="Rerun job"${rerunDisabled}><svg width="14" height="14"><use href="#icon-play"/></svg></span>`
        + `<span class="icon icon-refresh" data-action="refresh" role="button" tabindex="0" aria-label="Refresh" title="Refresh"><svg width="14" height="14"><use href="#icon-rotate-cw"/></svg></span>`
        + `</div></td>`;
}

// Domain → chip colour for log-analysis labels. Defaults below are used until /api/config arrives.
const _domainColorMap = {
    "API / Backend Service": "blue",
    "Environment / Infrastructure": "orange",
    "Build / Configuration": "purple",
    "UI / Frontend": "teal",
    "Test Data": "amber",
    "Automation / Framework": "slate",
    "Browser / Driver": "indigo",
    "Unknown": "gray",
};

// Fallback chip labels for jobs with no classification or in special states.
const _fallbackLabels = {
    no_console_log: "No Console Data",
    no_pattern_match: "Unclassified Failure",
    success: "—",
    in_progress: "Build Running",
    aborted: "Build Aborted",
};

// Apply server-provided taxonomy overrides to the local maps (called once at startup).
function applyAnalysisTaxonomy(taxonomy) {
    if (taxonomy && taxonomy.domain_colors) {
        Object.assign(_domainColorMap, taxonomy.domain_colors);
    }
    if (taxonomy && taxonomy.fallback_labels) {
        Object.assign(_fallbackLabels, taxonomy.fallback_labels);
    }
}

// Visible chips before the "+N more" overflow toggle kicks in.
const MAX_VISIBLE_CHIPS = 5;

// Colour name → hex, used by the autocomplete dropdown dots.
const _dotHexMap = {
    gray: '#94A3B8', blue: '#3B82F6', orange: '#F97316', purple: '#A855F7',
    teal: '#14B8A6', amber: '#F59E0B', slate: '#64748B', indigo: '#6366F1'
};

// Render log-analysis chips (multi- or single-label) with "+N more" overflow expansion.
function renderLogAnalysisChips(classification, jobStatus) {
    // No classification: render the appropriate fallback label for the status.
    if (!classification || (!classification.label && !(classification.all_labels && classification.all_labels.length))) {
        if (jobStatus === 'SUCCESS') return '<span class="text-muted">—</span>';
        if (jobStatus === 'IN_PROGRESS') return _renderChipHtml(_fallbackLabels.in_progress || 'Build Running', 'gray', '');
        if (jobStatus === 'ABORTED') return _renderChipHtml(_fallbackLabels.aborted || 'Build Aborted', 'gray', '');
        return '<span class="text-muted">—</span>';
    }

    // Unify the multi-label and single-label cases into one entries[] list.
    var entries = [];
    var labels = classification.all_labels;
    if (labels && labels.length > 0) {
        entries = labels.map(function(e) {
            return { label: e.label, color: _domainColorMap[e.domain] || 'gray', tip: e.action || '' };
        });
    } else {
        var lbl = classification.label;
        var dom = classification.primary_domain || 'Unknown';
        entries = [{ label: lbl, color: _domainColorMap[dom] || 'gray', tip: classification.action || '' }];
    }

    if (entries.length <= 1) {
        return _renderChipHtml(entries[0].label, entries[0].color, entries[0].tip);
    }

    // Render the first MAX_VISIBLE_CHIPS inline; the rest are CSS-hidden via
    // .rec-chip-overflow-hidden until the user clicks the "+N more" toggle
    // (delegated handler in app.js flips an .is-expanded class on the wrapper).
    var visible = entries.slice(0, MAX_VISIBLE_CHIPS);
    var overflow = entries.slice(MAX_VISIBLE_CHIPS);
    var html = '<div class="rec-chip-row" data-count="' + entries.length + '">';
    visible.forEach(function(e) {
        html += _renderChipHtml(e.label, e.color, e.tip);
    });
    overflow.forEach(function(e) {
        html += _renderChipHtml(e.label, e.color, e.tip, 'rec-chip-overflow-hidden');
    });

    if (overflow.length > 0) {
        // type="button" prevents accidental form submits in case of future wrapping.
        html += '<button type="button" class="rec-chip-overflow"'
              + ' data-action="toggle-overflow"'
              + ' data-count-collapsed="+' + overflow.length + ' more"'
              + ' data-count-expanded="× less"'
              + ' aria-expanded="false">+' + overflow.length + ' more</button>';
    }

    html += '</div>';
    return html;
}

// One label chip; extraClass='rec-chip-overflow-hidden' marks it hidden until expansion.
function _renderChipHtml(label, color, tooltip, extraClass) {
    const safeLabel = escapeHtml(label);
    const safeTip = escapeHtml(tooltip);
    const cls = 'rec-chip rec-chip--' + color + (extraClass ? ' ' + extraClass : '');
    return `<span class="${cls}" title="${safeTip}"><span class="rec-chip-dot"></span>${safeLabel}</span>`;
}

// "(prev)" marker appended to the Total cell when counts came from the prior build.
function metricsSourceTag(m) {
    if (m && m.from_previous_build) {
        return '<span class="cell-metrics-from-prev" title="Counts from the previous completed build — the current run is still in-flight or was aborted.">(prev)</span>';
    }
    return '';
}

// Build a complete <tr> for the job: checkbox, name, status, actions, metrics, trend, chips.
function renderJobRow(job) {
    const tr = document.createElement('tr');
    tr.setAttribute('data-job-id', job.job_id);
    tr.setAttribute('data-status', job.latest_status);

    const statusBadge = renderStatusBadge(job.latest_status);

    // Per-job test metrics — extractJobMetrics is the single source of truth.
    const snap = extractJobMetrics(job);
    const hm = snap.hasMetrics;
    const totalCount   = hm ? snap.total   : '—';
    const passedCount  = hm ? snap.passed  : '—';
    const failedCount  = hm ? snap.failed  : '—';
    const errorsCount  = hm ? snap.errors  : '—';
    const skippedCount = hm ? snap.skipped : '—';
    const m = job.test_metrics || {};
    const sourceTag = metricsSourceTag(m);
    const diag = m.metrics_diagnostic || '';

    const classification = job.classification || {};
    const evidenceText = classification.evidence_snippet ? classification.evidence_snippet.substring(0, 100) : '';
    const recChipHtml = renderLogAnalysisChips(job.classification, job.latest_status);

    tr.innerHTML = renderCheckboxCell(job)
        + renderJobNameCell(job)
        + `<td class="status-cell cell-status">${statusBadge}</td>`
        + renderActionsCell(job)
        + renderMetricCells(hm, errorsCount, totalCount, passedCount, failedCount, skippedCount, sourceTag, diag)
        + renderSparklineCell(job)
        + `<td class="cell-exec-time">${formatExecTime(job.last_execution_time)}</td>`
        + renderRegressionCell(job)
        + `<td class="col-evidence cell-meta hidden">${escapeHtml(evidenceText)}</td>`
        + `<td class="col-full-classification hidden">${escapeHtml(classification.subcategory || '')}</td>`
        + `<td class="cell-log-analysis">${recChipHtml}</td>`
        + `<td class="col-expand hidden"><span class="icon icon-expand" data-action="expand" role="button" tabindex="0" aria-label="Expand details">▶</span></td>`;

    // Respect current view mode for rows that arrive while streaming.
    if (appState.viewMode === 'detail') {
        tr.classList.add('detail-mode');
    }

    // Register in the rowEls perf cache for O(1) lookups (streaming enrichment,
    // filters, auto-refresh flash, promotion recompute).
    if (window.appState && appState.rowEls) {
        appState.rowEls.set(job.job_id, tr);
    }

    return tr;
}

// Update an existing row in place: status, metrics, sparkline, exec time, regression, classification, actions.
function updateJobRow(jobId, job) {
    const row = (appState.rowEls && appState.rowEls.get(jobId))
        || document.querySelector(`tr[data-job-id="${escapeHtml(jobId)}"]`);
    if (!row) return;

    row.setAttribute('data-status', job.latest_status);

    const statusCell = row.querySelector('.cell-status');
    if (statusCell) statusCell.innerHTML = renderStatusBadge(job.latest_status);

    const snap = extractJobMetrics(job);
    const hm = snap.hasMetrics;
    const sourceTag = metricsSourceTag(job.test_metrics || {});

    const metricCellUpdates = [
        ['.cell-errors',  hm ? snap.errors  : null, 'cell-metric-danger'],
        ['.cell-passed',  hm ? snap.passed  : null, 'cell-metric-success'],
        ['.cell-failed',  hm ? snap.failed  : null, 'cell-metric-danger'],
        ['.cell-skipped', hm ? snap.skipped : null, 'cell-metric-warning'],
    ];
    for (const [sel, val, cls] of metricCellUpdates) {
        const cell = row.querySelector(sel);
        if (cell) cell.innerHTML = renderMetricValue(val, hm, cls);
    }
    const totalCell = row.querySelector('.cell-total');
    if (totalCell) totalCell.innerHTML = hm ? (snap.total + sourceTag) : '—';

    // Rebuild the trend sparkline so refreshes / re-runs surface new statuses immediately.
    const trendCell = row.querySelector('.cell-trend');
    if (trendCell) {
        const tmp = document.createElement('tr');
        tmp.innerHTML = renderSparklineCell(job);
        const fresh = tmp.querySelector('.cell-trend');
        if (fresh) trendCell.innerHTML = fresh.innerHTML;
    }

    const execTimeCell = row.querySelector('.cell-exec-time');
    if (execTimeCell) execTimeCell.innerHTML = formatExecTime(job.last_execution_time);

    // Regression column is only present while promotion time is active.
    const regCell = row.querySelector('.cell-regression');
    if (regCell) {
        const pt = getPromotionTime();
        const rs = deriveRegressionStatus(job, pt);
        regCell.setAttribute('data-regression', rs);
        regCell.innerHTML = renderRegressionBadge(rs);
    }

    const recCell = row.querySelector('.cell-log-analysis');
    if (recCell) recCell.innerHTML = renderLogAnalysisChips(job.classification, job.latest_status);

    const actionsCell = row.querySelector('.cell-actions');
    if (actionsCell) {
        // renderActionsCell returns a full <td>…</td>; extract its innerHTML.
        const tmp = document.createElement('tr');
        tmp.innerHTML = renderActionsCell(job);
        const newActions = tmp.querySelector('.cell-actions');
        if (newActions) actionsCell.innerHTML = newActions.innerHTML;
    }

    checkStaleRow(row, jobId);

    if (appState.promotionTime) updatePromotionPanel(appState.promotionTime);
}

// Expanded detail row with classification, evidence, secondary hint, and matched rule.
function renderExpandedDetail(job) {
    const tr = document.createElement('tr');
    tr.className = 'detail-row visible';
    tr.setAttribute('data-job-id', job.job_id + '_detail');

    const classification = job.classification || {};
    const secondaryHint = classification.secondary_hint;
    const secondaryHintText = secondaryHint ?
        `Secondary Hint: ${escapeHtml(secondaryHint.domain || '')} — ${escapeHtml(secondaryHint.subcategory || '')}` : '';

    const prevStatusBadge = renderStatusBadge(job.previous_status || job.latest_status);
    const lastPassedText = job.last_passed ? `Build ${job.last_passed.build_number || job.last_passed.build || '?'}` : '—';

    const detailContent = `
        <td colspan="${document.getElementById('job-table').classList.contains('promotion-active') ? 16 : 15}" style="padding: 0;">
            <div class="detail-panel">
                <div class="detail-section" style="display:flex;gap:32px;flex-wrap:wrap;">
                    <div>
                        <div class="detail-label">Classification</div>
                        <div class="detail-classification">
                            <div><strong>${escapeHtml(classification.primary_domain || 'Unknown')} → ${escapeHtml(classification.subcategory || '')} → ${escapeHtml(classification.impact || '')}</strong></div>
                            <div style="font-size: 12px; color: var(--color-text-secondary); margin-top: 4px;">Confidence: ${renderConfidenceBadge(classification.confidence)}</div>
                        </div>
                    </div>
                    <div>
                        <div class="detail-label">Previous Status</div>
                        <div class="detail-value">${prevStatusBadge}</div>
                    </div>
                    <div>
                        <div class="detail-label">Last Passed</div>
                        <div class="detail-value">${lastPassedText}</div>
                    </div>
                </div>

                ${secondaryHintText ? `
                <div class="detail-section">
                    <div class="detail-label">Secondary Hint</div>
                    <div class="detail-value">${secondaryHintText}</div>
                </div>
                ` : ''}

                ${classification.evidence_snippet ? `
                <div class="detail-section">
                    <div class="detail-label">Evidence Snippet</div>
                    <div class="detail-evidence">${escapeHtml(classification.evidence_snippet)}</div>
                </div>
                ` : ''}

                ${(classification.all_labels && classification.all_labels.length > 0) || classification.label || classification.action ? `
                <div class="detail-section">
                    <div class="detail-label">Log Analysis</div>
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                        ${renderLogAnalysisChips(classification, '')}
                        ${classification.action ? `<span style="font-size:12px;color:var(--color-text-secondary)">${escapeHtml(classification.action)}</span>` : ''}
                    </div>
                </div>
                ` : ''}

                ${classification.matched_rule_name ? `
                <div class="detail-section">
                    <div class="detail-label">Matched Rule</div>
                    <div class="detail-value">${escapeHtml(classification.matched_rule_name)}</div>
                </div>
                ` : ''}

                ${job.data_completeness && job.data_completeness !== 'COMPLETE' ? `
                <div class="detail-section">
                    <div class="detail-label">Data Completeness</div>
                    <div class="detail-value">${escapeHtml(job.data_completeness)}</div>
                </div>
                ` : ''}
            </div>
        </td>
    `;

    tr.innerHTML = detailContent;
    return tr;
}
