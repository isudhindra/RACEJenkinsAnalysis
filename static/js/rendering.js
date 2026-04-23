// Jenkins Dashboard rendering module — generates HTML for job table rows and status labels.
// Extracted from dashboard.html for maintainability and reusability.
'use strict';

// Renders a checkbox cell for job selection in the table.
function renderCheckboxCell(job) {
    return `<td class="checkbox-cell"><input type="checkbox" data-action="select" aria-label="Select job"></td>`;
}

// Renders the job name as a clickable link to its Jenkins page.
function renderJobNameCell(job) {
    return `<td class="job-name-cell cell-job-name"><a href="${escapeHtml(job.url)}" target="_blank">${escapeHtml(job.name)}</a></td>`;
}

// Renders test metric columns (total, passed, failed, skipped, errors) with appropriate CSS classes.
function renderMetricCells(hasMetrics, errors, total, passed, failed, skipped, sourceTag) {
    return `<td class="cell-total cell-metric cell-metric-highlight">${hasMetrics ? total + sourceTag : '—'}</td>`
        + `<td class="cell-passed cell-metric">${renderMetricValue(passed, hasMetrics, 'cell-metric-success')}</td>`
        + `<td class="cell-failed cell-metric">${renderMetricValue(failed, hasMetrics, 'cell-metric-danger')}</td>`
        + `<td class="cell-skipped cell-metric">${renderMetricValue(skipped, hasMetrics, 'cell-metric-warning')}</td>`
        + `<td class="cell-errors cell-metric">${renderMetricValue(errors, hasMetrics, 'cell-metric-danger')}</td>`;
}

// Maps build status to a CSS class for styling the console log icon (color-coded by status).
function _clgStatusClass(status) {
    switch (status) {
        case 'SUCCESS':     return ' clg-passed';
        case 'FAILURE':     return ' clg-failed';
        case 'UNSTABLE':    return ' clg-unstable';
        case 'ABORTED':     return ' clg-aborted';
        default:            return '';
    }
}

// Renders a console log button icon with error count badge if present.
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

// Renders action buttons for a job row: console log (with special handling for running builds), rerun, and refresh.
function renderActionsCell(job) {
    const isRunning = job.is_running || job.latest_status === 'IN_PROGRESS';
    const rerunDisabled = isRunning ? ' title="Cannot rerun — build in progress"' : ' title="Rerun"';
    const rerunCls = isRunning ? ' icon-disabled' : '';
    const logIcon = `<svg width="14" height="14"><use href="#icon-file-text"/></svg>`;

    // Console log button: available for all statuses, color-coded
    let consoleBtn;
    if (isRunning) {
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

// Domain-to-color map for log analysis label chips, loaded from /api/config at startup.
// Defaults shown here are used until server config arrives.
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

// Fallback labels for jobs with no classification or in special states.
const _fallbackLabels = {
    no_console_log: "No Console Data",
    no_pattern_match: "Unclassified Failure",
    success: "—",
    in_progress: "Build Running",
    aborted: "Build Aborted",
};

// Updates domain-to-color and fallback label maps from server-provided taxonomy config.
// Called once after /api/config loads to customize labels and colors.
function applyAnalysisTaxonomy(taxonomy) {
    if (taxonomy && taxonomy.domain_colors) {
        Object.assign(_domainColorMap, taxonomy.domain_colors);
    }
    if (taxonomy && taxonomy.fallback_labels) {
        Object.assign(_fallbackLabels, taxonomy.fallback_labels);
    }
}

// Maximum number of label chips to show inline before overflow indicator.
const MAX_VISIBLE_CHIPS = 5;

// Color-to-hex map for rendering colored dots in tooltip overflow list.
const _dotHexMap = {
    gray: '#94A3B8', blue: '#3B82F6', orange: '#F97316', purple: '#A855F7',
    teal: '#14B8A6', amber: '#F59E0B', slate: '#64748B', indigo: '#6366F1'
};

// Renders log analysis label chips for a job, supporting both multi-label and single-label modes.
// Shows up to MAX_VISIBLE_CHIPS inline, with overflow hidden in a tooltip.
function renderLogAnalysisChips(classification, jobStatus) {
    // Passing / running / aborted jobs with no classification → fallback label
    if (!classification || (!classification.label && !(classification.all_labels && classification.all_labels.length))) {
        if (jobStatus === 'SUCCESS') return '<span class="text-muted">—</span>';
        if (jobStatus === 'IN_PROGRESS') return _renderChipHtml(_fallbackLabels.in_progress || 'Build Running', 'gray', '');
        if (jobStatus === 'ABORTED') return _renderChipHtml(_fallbackLabels.aborted || 'Build Aborted', 'gray', '');
        return '<span class="text-muted">—</span>';
    }

    // Build unified label list (multi-label or single-label fallback)
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

    // Single chip — no wrapper needed
    if (entries.length <= 1) {
        return _renderChipHtml(entries[0].label, entries[0].color, entries[0].tip);
    }

    // Multiple chips — show up to MAX_VISIBLE_CHIPS inline, overflow the rest
    var visible = entries.slice(0, MAX_VISIBLE_CHIPS);
    var overflow = entries.slice(MAX_VISIBLE_CHIPS);
    var html = '<div class="rec-chip-row">';
    visible.forEach(function(e) {
        html += _renderChipHtml(e.label, e.color, e.tip);
    });

    if (overflow.length > 0) {
        html += '<span class="rec-chip-overflow">+' + overflow.length + ' more';
        // Tooltip lists only the hidden overflow labels by name
        html += '<span class="rec-chip-tooltip">';
        overflow.forEach(function(e) {
            var hex = _dotHexMap[e.color] || '#94A3B8';
            html += '<span class="rec-chip-tooltip-item">'
                  + '<span class="rec-chip-tooltip-dot" style="background:' + hex + '"></span>'
                  + escapeHtml(e.label)
                  + '</span>';
        });
        html += '</span></span>';
    }

    html += '</div>';
    return html;
}

// Helper: renders a single label chip with color, label text, and optional tooltip.
function _renderChipHtml(label, color, tooltip) {
    const safeLabel = escapeHtml(label);
    const safeTip = escapeHtml(tooltip);
    return `<span class="rec-chip rec-chip--${color}" title="${safeTip}"><span class="rec-chip-dot"></span>${safeLabel}</span>`;
}

// Returns a small superscript indicator if metrics came from console parsing, or empty string otherwise.
function metricsSourceTag(m) {
    return (m && m.metrics_source === 'console')
        ? '<span style="font-size:9px;color:#6B7280;font-weight:500;vertical-align:super" title="Metrics parsed from console output">⌘</span>'
        : '';
}

// Renders a complete job table row with all cells: checkbox, name, status, actions, metrics, and analysis chips.
function renderJobRow(job) {
    const tr = document.createElement('tr');
    tr.setAttribute('data-job-id', job.job_id);
    tr.setAttribute('data-status', job.latest_status);

    const statusBadge = renderStatusBadge(job.latest_status);

    // Per-job test metric columns
    const m = job.test_metrics || {};
    const hm = hasUsableMetrics(m);
    const totalCount = hm ? m.total : '—';
    const passedCount = hm ? (m.passed || 0) : '—';
    const failedCount = hm ? (m.failed || 0) : '—';
    const errorsCount = hm ? (m.errors || 0) : '—';
    const skippedCount = hm ? (m.skipped || 0) : '—';
    const sourceTag = metricsSourceTag(m);

    const classification = job.classification || {};
    const evidenceText = classification.evidence_snippet ? classification.evidence_snippet.substring(0, 100) : '';
    const recChipHtml = renderLogAnalysisChips(job.classification, job.latest_status);

    tr.innerHTML = renderCheckboxCell(job)
        + renderJobNameCell(job)
        + `<td class="status-cell cell-status">${statusBadge}</td>`
        + renderActionsCell(job)
        + renderMetricCells(hm, errorsCount, totalCount, passedCount, failedCount, skippedCount, sourceTag)
        + `<td class="cell-exec-time">${formatExecTime(job.last_execution_time)}</td>`
        + renderRegressionCell(job)
        + `<td class="col-evidence cell-meta hidden">${escapeHtml(evidenceText)}</td>`
        + `<td class="col-full-classification hidden">${escapeHtml(classification.subcategory || '')}</td>`
        + `<td class="cell-log-analysis">${recChipHtml}</td>`
        + `<td class="col-expand hidden"><span class="icon icon-expand" data-action="expand" role="button" tabindex="0" aria-label="Expand details">▶</span></td>`;

    // Respect current view mode for new rows arriving during fetch
    if (appState.viewMode === 'detail') {
        tr.classList.add('detail-mode');
    }

    return tr;
}

// Updates an existing job row's cells with new job data (status, metrics, timestamps, classification, etc.).
function updateJobRow(jobId, job) {
    const row = document.querySelector(`tr[data-job-id="${escapeHtml(jobId)}"]`);
    if (!row) return;

    row.setAttribute('data-status', job.latest_status);

    const statusCell = row.querySelector('.cell-status');
    if (statusCell) statusCell.innerHTML = renderStatusBadge(job.latest_status);

    // Update per-job test metric columns
    const m = job.test_metrics || {};
    const hm = hasUsableMetrics(m);
    const sourceTag = metricsSourceTag(m);

    const metricCellUpdates = [
        ['.cell-errors',  hm ? (m.errors  || 0) : null, 'cell-metric-danger'],
        ['.cell-passed',  hm ? (m.passed  || 0) : null, 'cell-metric-success'],
        ['.cell-failed',  hm ? (m.failed  || 0) : null, 'cell-metric-danger'],
        ['.cell-skipped', hm ? (m.skipped || 0) : null, 'cell-metric-warning'],
    ];
    for (const [sel, val, cls] of metricCellUpdates) {
        const cell = row.querySelector(sel);
        if (cell) cell.innerHTML = renderMetricValue(val, hm, cls);
    }
    const totalCell = row.querySelector('.cell-total');
    if (totalCell) totalCell.innerHTML = hm ? m.total + sourceTag : '—';

    const execTimeCell = row.querySelector('.cell-exec-time');
    if (execTimeCell) execTimeCell.innerHTML = formatExecTime(job.last_execution_time);

    // Update regression status cell if promotion time is active
    const regCell = row.querySelector('.cell-regression');
    if (regCell) {
        const pt = getPromotionTime();
        const rs = deriveRegressionStatus(job, pt);
        regCell.setAttribute('data-regression', rs);
        regCell.innerHTML = renderRegressionBadge(rs);
    }

    const recCell = row.querySelector('.cell-log-analysis');
    if (recCell) recCell.innerHTML = renderLogAnalysisChips(job.classification, job.latest_status);

    // Rebuild actions cell using the same renderer as renderJobRow
    const actionsCell = row.querySelector('.cell-actions');
    if (actionsCell) {
        // renderActionsCell returns <td>...</td> — extract its innerHTML
        const tmp = document.createElement('tr');
        tmp.innerHTML = renderActionsCell(job);
        const newActions = tmp.querySelector('.cell-actions');
        if (newActions) actionsCell.innerHTML = newActions.innerHTML;
    }

    checkStaleRow(row, jobId);

    // Refresh promotion panel counts when a job status changes
    if (appState.promotionTime) updatePromotionPanel(appState.promotionTime);
}

// Renders an expandable detail row showing job classification, evidence, metrics, and other metadata.
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
