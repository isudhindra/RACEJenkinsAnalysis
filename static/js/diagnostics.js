// diagnostics.js — Developer diagnostics slide-up panel.
// Captures app logs, network traces, and runtime errors for the Console and Network tabs.
'use strict';

// In-memory store for diagnostic entries (capped at 500 per tab).
const _diagStore = {
    consoleLogs: [],
    networkLogs: [],
    maxEntries: 500,
    panelOpen: false,
    activeTab: 'console'
};

//  Core loggers ─

// Record an app-level entry shown in the Console tab.
// severity: 'error' | 'warning' | 'info'; source: module; detail: optional metadata.
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

// Record an HTTP request/response entry shown in the Network tab.
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

// Log a failed POST to Console + Network tabs and optionally toast the user.
function reportFetchError(category, logMsg, endpoint, err, toastMsg, extra) {
    var meta = { stack: err.stack, raw: err.message };
    if (extra !== undefined) meta.extra = extra;
    diagLog('error', category, logMsg, meta);
    diagLogNetwork('POST', endpoint, 0, null, err.message);
    if (toastMsg) showToast(toastMsg, 'error');
}

//  Internal UI helpers 

function _diagUpdateCount(tab) {
    const count = tab === 'console' ? _diagStore.consoleLogs.length : _diagStore.networkLogs.length;
    const el = document.getElementById('diag-count-' + tab);
    if (!el) return;
    el.textContent = count;
    el.classList.toggle('has-errors', count > 0);
    el.classList.toggle('empty', count === 0);
}

// Toggle the toolbar's red diagnostics dot when errors exist.
function _diagShowErrorDot(show) {
    const dot = document.getElementById('diag-error-dot');
    if (dot) dot.style.display = show ? '' : 'none';
}

// Format a Date as "HH:MM:SS.mmm" for the timestamp column.
function _diagFmtTime(d) {
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
        + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

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

function _diagShortUrl(url) {
    try { return new URL(url, location.origin).pathname; } catch { return url; }
}

function _diagEsc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function _diagScrollToBottom(tab) {
    const body = document.getElementById('diag-body-' + tab);
    if (body) body.scrollTop = body.scrollHeight;
}

//  Public panel controls 

function toggleDiagPanel() {
    const panel = document.getElementById('diag-panel');
    if (!panel) return;
    _diagStore.panelOpen = !_diagStore.panelOpen;
    panel.classList.toggle('open', _diagStore.panelOpen);
    if (_diagStore.panelOpen) {
        _diagRebuildActiveTab();
    }
}

function switchDiagTab(tab) {
    _diagStore.activeTab = tab;
    document.querySelectorAll('.diag-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.diagTab === tab);
    });
    document.getElementById('diag-body-console').style.display = tab === 'console' ? '' : 'none';
    document.getElementById('diag-body-network').style.display = tab === 'network' ? '' : 'none';
    _diagRebuildActiveTab();
}

function _diagRebuildActiveTab() {
    const tab = _diagStore.activeTab;
    const body = document.getElementById('diag-body-' + tab);
    if (!body) return;
    // Keep the empty-state placeholder; remove only rendered entries.
    const entries = body.querySelectorAll('.diag-entry');
    entries.forEach(e => e.remove());

    const logs = tab === 'console' ? _diagStore.consoleLogs : _diagStore.networkLogs;
    const emptyEl = document.getElementById('diag-empty-' + tab);
    if (emptyEl) emptyEl.style.display = logs.length === 0 ? '' : 'none';

    const renderFn = tab === 'console' ? _diagRenderConsoleEntry : _diagRenderNetworkEntry;
    logs.forEach(entry => renderFn(entry));
    _diagScrollToBottom(tab);
}

function clearDiagLogs() {
    _diagStore.consoleLogs = [];
    _diagStore.networkLogs = [];
    _diagUpdateCount('console');
    _diagUpdateCount('network');
    _diagShowErrorDot(false);
    _diagRebuildActiveTab();
}

// Download a JSON file of all captured console and network logs.
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

//  Resize handle 
// Drag the top edge of the panel to resize it vertically.
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

//  Global error hooks ─

// Recursion guard so logging an error inside diagLog itself doesn't loop forever.
let _diagSelfLogging = false;
function _diagSafeLog(severity, source, message, detail) {
    if (_diagSelfLogging) return;
    _diagSelfLogging = true;
    try { diagLog(severity, source, message, detail); }
    finally { _diagSelfLogging = false; }
}

// Capture-phase window 'error' — also catches resource-load failures.
window.addEventListener('error', function(event) {
    // Resource-load errors have an element target and no event.error.
    const tgt = event.target;
    if (tgt && tgt !== window && (tgt.tagName === 'LINK' || tgt.tagName === 'SCRIPT' ||
                                  tgt.tagName === 'IMG' || tgt.tagName === 'SOURCE')) {
        _diagSafeLog('error', 'Resource', 'Failed to load ' + tgt.tagName.toLowerCase(), {
            raw: tgt.src || tgt.href || '(no url)',
            extra: tgt.tagName
        });
        return;
    }
    _diagSafeLog('error', 'Runtime', event.message || 'Uncaught error', {
        stack: event.error ? event.error.stack : null,
        raw: event.filename ? event.filename + ':' + event.lineno + ':' + event.colno : null
    });
}, true);  // capture phase so resource errors are visible

window.addEventListener('unhandledrejection', function(event) {
    const msg = event.reason instanceof Error ? event.reason.message : String(event.reason);
    _diagSafeLog('error', 'Promise', 'Unhandled rejection: ' + msg, {
        stack: event.reason instanceof Error ? event.reason.stack : null
    });
});

// Mirror console.error / console.warn into the diagnostics panel.
(function patchConsole() {
    const orig = {
        error: console.error.bind(console),
        warn:  console.warn.bind(console)
    };

    function fmt(args) {
        return Array.prototype.map.call(args, function (a) {
            if (a == null) return String(a);
            if (a instanceof Error) return a.message;
            if (typeof a === 'object') {
                try { return JSON.stringify(a); } catch (_) { return String(a); }
            }
            return String(a);
        }).join(' ');
    }

    console.error = function () {
        orig.error.apply(console, arguments);
        const stack = (arguments[0] instanceof Error) ? arguments[0].stack : null;
        _diagSafeLog('error', 'Console', fmt(arguments), stack ? { stack: stack } : null);
    };
    console.warn = function () {
        orig.warn.apply(console, arguments);
        _diagSafeLog('warning', 'Console', fmt(arguments));
    };
})();

// Wrap window.fetch to auto-log failures into the Network tab.
(function patchFetch() {
    const origFetch = window.fetch;
    if (!origFetch) return;
    window.fetch = function (resource, init) {
        const url = (typeof resource === 'string') ? resource :
                    (resource && resource.url) ? resource.url : String(resource);
        const method = (init && init.method) ? init.method.toUpperCase() :
                       (resource && resource.method) ? resource.method.toUpperCase() : 'GET';
        const t0 = (performance && performance.now) ? performance.now() : Date.now();
        return origFetch.call(this, resource, init).then(function (resp) {
            if (!resp.ok && resp.status >= 400) {
                const dur = Math.round(((performance && performance.now) ? performance.now() : Date.now()) - t0);
                diagLogNetwork(method, url, resp.status, dur, resp.statusText || ('HTTP ' + resp.status));
            }
            return resp;
        }, function (err) {
            const dur = Math.round(((performance && performance.now) ? performance.now() : Date.now()) - t0);
            // AbortError = deliberate abort or AbortController timeout.
            const isAbort = err && (err.name === 'AbortError');
            const status = isAbort ? 'TIMEOUT' : 'ERR';
            diagLogNetwork(method, url, status, dur, err && err.message ? err.message : String(err));
            throw err;
        });
    };
})();

// Wrap setTimeout / setInterval so callback exceptions surface in diagnostics.
(function patchTimers() {
    const origST = window.setTimeout;
    const origSI = window.setInterval;

    function wrap(fn, name) {
        if (typeof fn !== 'function') return fn;
        return function () {
            try { return fn.apply(this, arguments); }
            catch (e) {
                _diagSafeLog('error', name, e && e.message ? e.message : String(e), {
                    stack: e && e.stack ? e.stack : null
                });
                throw e;
            }
        };
    }

    window.setTimeout = function (fn, delay) {
        const args = Array.prototype.slice.call(arguments, 2);
        return origST.call(window, wrap(fn, 'setTimeout'), delay, ...args);
    };
    window.setInterval = function (fn, delay) {
        const args = Array.prototype.slice.call(arguments, 2);
        return origSI.call(window, wrap(fn, 'setInterval'), delay, ...args);
    };
})();
