// diagnostics.js — Developer diagnostics panel (console + network tabs).
// Captures application-level logs, network request traces, and runtime errors
// into a slide-up panel the developer can open from the toolbar.
'use strict';

// In-memory store for all diagnostic entries (capped at 500 per tab).
const _diagStore = {
    consoleLogs: [],
    networkLogs: [],
    maxEntries: 500,
    panelOpen: false,
    activeTab: 'console'
};

// ── Core loggers ───────────────────────────────────────────────────────

// Record an application-level log entry (shown in the Console tab).
// severity: 'error' | 'warning' | 'info'; source: module name; detail: optional metadata.
function diagLog(severity, source, message, detail) {
    const entry = {
        ts: new Date(),
        severity: severity,
        source: source,
        message: String(message),
        detail: detail || null
    };
    _diagStore.consoleLogs.push(entry);
    if (_diagStore.consoleLogs.length > _diagStore.maxEntries) {
        _diagStore.consoleLogs.splice(0, _diagStore.consoleLogs.length - _diagStore.maxEntries);
    }
    _diagUpdateCount('console');
    _diagShowErrorDot(severity === 'error' || severity === 'warning');
    if (_diagStore.panelOpen && _diagStore.activeTab === 'console') {
        _diagRenderConsoleEntry(entry);
        _diagScrollToBottom('console');
    }
}

// Record an HTTP request/response entry (shown in the Network tab).
// Called after every backend API call with timing and error info.
function diagLogNetwork(method, url, status, duration, error, detail) {
    const entry = {
        ts: new Date(),
        method: (method || 'GET').toUpperCase(),
        url: url,
        status: status,
        duration: duration,
        error: error || null,
        detail: detail || null
    };
    _diagStore.networkLogs.push(entry);
    if (_diagStore.networkLogs.length > _diagStore.maxEntries) {
        _diagStore.networkLogs.splice(0, _diagStore.networkLogs.length - _diagStore.maxEntries);
    }
    _diagUpdateCount('network');
    if (error || (status && status >= 400)) {
        _diagShowErrorDot(true);
    }
    if (_diagStore.panelOpen && _diagStore.activeTab === 'network') {
        _diagRenderNetworkEntry(entry);
        _diagScrollToBottom('network');
    }
}

// Shorthand for logging a failed POST: writes to both Console and Network tabs,
// and optionally shows an error toast. Replaces the recurring 3-line pattern.
function reportFetchError(category, logMsg, endpoint, err, toastMsg, extra) {
    var meta = { stack: err.stack, raw: err.message };
    if (extra !== undefined) meta.extra = extra;
    diagLog('error', category, logMsg, meta);
    diagLogNetwork('POST', endpoint, 0, null, err.message);
    if (toastMsg) showToast(toastMsg, 'error');
}

// ── Internal UI helpers ────────────────────────────────────────────────

// Refresh the entry-count badge on a tab header.
function _diagUpdateCount(tab) {
    const count = tab === 'console' ? _diagStore.consoleLogs.length : _diagStore.networkLogs.length;
    const el = document.getElementById('diag-count-' + tab);
    if (!el) return;
    el.textContent = count;
    el.classList.toggle('has-errors', count > 0);
    el.classList.toggle('empty', count === 0);
}

// Toggle the red dot on the toolbar diagnostics button when errors exist.
function _diagShowErrorDot(show) {
    const dot = document.getElementById('diag-error-dot');
    if (dot) dot.style.display = show ? '' : 'none';
}

// Format a Date into "HH:MM:SS.mmm" for the entry timestamp column.
function _diagFmtTime(d) {
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
        + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

// Append a single console-log entry to the Console tab body.
function _diagRenderConsoleEntry(entry) {
    const body = document.getElementById('diag-body-console');
    if (!body) return;
    const empty = document.getElementById('diag-empty-console');
    if (empty) empty.style.display = 'none';

    const div = document.createElement('div');
    div.className = 'diag-entry';
    div.onclick = function() { div.classList.toggle('expanded'); };

    const sevClass = 'sev-' + (entry.severity === 'warning' ? 'warning' : entry.severity === 'error' ? 'error' : 'info');
    let detailHtml = '';
    if (entry.detail) {
        detailHtml = '<div class="diag-detail">';
        if (entry.detail.raw) {
            detailHtml += '<div class="diag-detail-row"><span class="diag-detail-label">Detail:</span> <span class="diag-detail-val">' + _diagEsc(String(entry.detail.raw)) + '</span></div>';
        }
        if (entry.detail.extra) {
            detailHtml += '<div class="diag-detail-row"><span class="diag-detail-label">Extra:</span> <span class="diag-detail-val">' + _diagEsc(String(entry.detail.extra)) + '</span></div>';
        }
        if (entry.detail.stack) {
            detailHtml += '<div class="diag-detail-stack">' + _diagEsc(entry.detail.stack) + '</div>';
        }
        detailHtml += '</div>';
    }

    div.innerHTML =
        '<span class="diag-ts">' + _diagFmtTime(entry.ts) + '</span>' +
        '<span class="diag-severity ' + sevClass + '">' + entry.severity + '</span>' +
        '<span class="diag-msg"><span class="diag-source">[' + _diagEsc(entry.source) + ']</span>' + _diagEsc(entry.message) + '</span>' +
        detailHtml;

    body.appendChild(div);
}

// Append a single network entry to the Network tab body.
function _diagRenderNetworkEntry(entry) {
    const body = document.getElementById('diag-body-network');
    if (!body) return;
    const empty = document.getElementById('diag-empty-network');
    if (empty) empty.style.display = 'none';

    const div = document.createElement('div');
    div.className = 'diag-entry';
    div.onclick = function() { div.classList.toggle('expanded'); };

    const isErr = entry.error || (entry.status && entry.status >= 400);
    const statusClass = isErr ? 'status-err' : 'status-ok';
    const statusText = entry.status || (entry.error ? 'ERR' : '—');
    const durText = entry.duration != null ? entry.duration + 'ms' : '';

    let detailHtml = '<div class="diag-detail">';
    detailHtml += '<div class="diag-detail-row"><span class="diag-detail-label">URL:</span> <span class="diag-detail-val">' + _diagEsc(entry.url) + '</span></div>';
    if (entry.duration != null) {
        detailHtml += '<div class="diag-detail-row"><span class="diag-detail-label">Duration:</span> <span class="diag-detail-val">' + entry.duration + 'ms</span></div>';
    }
    if (entry.error) {
        detailHtml += '<div class="diag-detail-row"><span class="diag-detail-label">Error:</span> <span class="diag-detail-val">' + _diagEsc(String(entry.error)) + '</span></div>';
    }
    if (entry.detail) {
        detailHtml += '<div class="diag-detail-row"><span class="diag-detail-label">Detail:</span> <span class="diag-detail-val">' + _diagEsc(String(typeof entry.detail === 'object' ? JSON.stringify(entry.detail) : entry.detail)) + '</span></div>';
    }
    detailHtml += '</div>';

    div.innerHTML =
        '<span class="diag-ts">' + _diagFmtTime(entry.ts) + '</span>' +
        '<span><span class="diag-net-method">' + entry.method + '</span><span class="diag-net-status ' + statusClass + '">' + statusText + '</span></span>' +
        '<span class="diag-msg">' + _diagEsc(_diagShortUrl(entry.url)) + (durText ? ' <span class="diag-source">' + durText + '</span>' : '') + '</span>' +
        detailHtml;

    body.appendChild(div);
}

// Extract just the pathname from a URL for compact display.
function _diagShortUrl(url) {
    try { return new URL(url, location.origin).pathname; } catch { return url; }
}

// Quick HTML-escape using a temporary text node (avoids regex edge cases).
function _diagEsc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

// Scroll a tab body to the bottom so the newest entry is visible.
function _diagScrollToBottom(tab) {
    const body = document.getElementById('diag-body-' + tab);
    if (body) body.scrollTop = body.scrollHeight;
}

// ── Public panel controls ──────────────────────────────────────────────

// Open or close the diagnostics slide-up panel.
function toggleDiagPanel() {
    const panel = document.getElementById('diag-panel');
    if (!panel) return;
    _diagStore.panelOpen = !_diagStore.panelOpen;
    panel.classList.toggle('open', _diagStore.panelOpen);
    if (_diagStore.panelOpen) {
        _diagRebuildActiveTab();
    }
}

// Switch between the Console and Network tabs inside the panel.
function switchDiagTab(tab) {
    _diagStore.activeTab = tab;
    document.querySelectorAll('.diag-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.diagTab === tab);
    });
    document.getElementById('diag-body-console').style.display = tab === 'console' ? '' : 'none';
    document.getElementById('diag-body-network').style.display = tab === 'network' ? '' : 'none';
    _diagRebuildActiveTab();
}

// Re-render all entries for the currently active tab from the in-memory store.
function _diagRebuildActiveTab() {
    const tab = _diagStore.activeTab;
    const body = document.getElementById('diag-body-' + tab);
    if (!body) return;
    // Remove rendered entries but keep the empty placeholder
    const entries = body.querySelectorAll('.diag-entry');
    entries.forEach(e => e.remove());

    const logs = tab === 'console' ? _diagStore.consoleLogs : _diagStore.networkLogs;
    const emptyEl = document.getElementById('diag-empty-' + tab);
    if (emptyEl) emptyEl.style.display = logs.length === 0 ? '' : 'none';

    const renderFn = tab === 'console' ? _diagRenderConsoleEntry : _diagRenderNetworkEntry;
    logs.forEach(entry => renderFn(entry));
    _diagScrollToBottom(tab);
}

// Wipe all console and network log entries and reset the UI.
function clearDiagLogs() {
    _diagStore.consoleLogs = [];
    _diagStore.networkLogs = [];
    _diagUpdateCount('console');
    _diagUpdateCount('network');
    _diagShowErrorDot(false);
    _diagRebuildActiveTab();
}

// Download a JSON file containing all captured console and network logs.
function exportDiagLogs() {
    const data = {
        exported: new Date().toISOString(),
        console: _diagStore.consoleLogs.map(e => ({
            time: e.ts.toISOString(), severity: e.severity, source: e.source,
            message: e.message, detail: e.detail
        })),
        network: _diagStore.networkLogs.map(e => ({
            time: e.ts.toISOString(), method: e.method, url: e.url,
            status: e.status, duration: e.duration, error: e.error, detail: e.detail
        }))
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'diagnostics-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
}

// ── Resize handle ──────────────────────────────────────────────────────

// Allow the user to drag the top edge of the panel to resize it vertically.
(function initDiagResize() {
    document.addEventListener('DOMContentLoaded', function() {
        const handle = document.getElementById('diag-resize');
        const panel = document.getElementById('diag-panel');
        if (!handle || !panel) return;
        let startY, startH;
        handle.addEventListener('mousedown', function(e) {
            e.preventDefault();
            startY = e.clientY;
            startH = panel.offsetHeight;
            const onMove = function(ev) {
                const newH = Math.max(120, Math.min(window.innerHeight - 80, startH + (startY - ev.clientY)));
                panel.style.height = newH + 'px';
            };
            const onUp = function() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    });
})();

// ── Global error hooks ─────────────────────────────────────────────────

// Capture uncaught synchronous errors so they appear in the diagnostics Console tab.
window.addEventListener('error', function(event) {
    diagLog('error', 'Runtime', event.message || 'Uncaught error', {
        stack: event.error ? event.error.stack : null,
        raw: event.filename ? event.filename + ':' + event.lineno + ':' + event.colno : null
    });
});

// Capture unhandled promise rejections the same way.
window.addEventListener('unhandledrejection', function(event) {
    const msg = event.reason instanceof Error ? event.reason.message : String(event.reason);
    diagLog('error', 'Promise', 'Unhandled rejection: ' + msg, {
        stack: event.reason instanceof Error ? event.reason.stack : null
    });
});
