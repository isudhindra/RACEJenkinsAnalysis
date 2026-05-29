// auto-refresh.js
'use strict';

const AR_INTERVAL_MS = 30000;
const AR_STORAGE_KEY = 'auto_refresh_enabled';
const AR_FLASH_DURATION_MS = 1600;

// Internal state — exposed under window for diagnostics only.
window._autoRefresh = {
    enabled: null,         // tri-state: null = uninitialised, true/false = user choice
    timer: null,           // setInterval handle
    lastStatuses: new Map(), // jobId → "<build_number>:<status>" signature
    inFlight: false,       // true while a poll is mid-request
};

// ---- Preference persistence ------------------------------------------------

function _isAutoRefreshOn() {
    if (window._autoRefresh.enabled !== null) return window._autoRefresh.enabled;
    try {
        const stored = localStorage.getItem(AR_STORAGE_KEY);
        // Default ON when the key is absent.
        return stored === null ? true : stored === '1';
    } catch (_) {
        return true;
    }
}

function _setAutoRefreshOn(on) {
    window._autoRefresh.enabled = !!on;
    try { localStorage.setItem(AR_STORAGE_KEY, on ? '1' : '0'); } catch (_) {}
}

// ---- Guards ----------------------------------------------------------------

function _shouldSkipThisTick() {
    if (document.hidden) return 'tab hidden';
    if (window._autoRefresh.inFlight) return 'previous poll in flight';
    if (appState && appState._fetchAbortController) return 'manual fetch in progress';
    if (!appState || !appState.jobs || appState.jobs.size === 0) return 'no jobs in view';
    if (!appState.authCredentials) return 'no credentials';
    return null;
}

// Build a stable signature string used to detect "anything changed for this job".
function _sig(buildNumber, status) {
    return (buildNumber == null ? '' : String(buildNumber)) + ':' + (status || '');
}

// ---- Core poll -------------------------------------------------------------

async function _pollOnce() {
    const skipReason = _shouldSkipThisTick();
    if (skipReason) return;

    window._autoRefresh.inFlight = true;
    try {
        const creds = appState.authCredentials;
        const jobUrls = Array.from(appState.jobs.keys());

        const resp = await fetch('/api/poll-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                job_urls: jobUrls,
                jenkins_url: creds.jenkins_url,
                username: creds.username,
                api_token: creds.api_token,
            }),
        });

        if (resp.status === 401 || resp.status === 403) {
            // Credentials no longer valid — stop polling silently.
            _stopAutoRefresh('auth');
            return;
        }
        if (!resp.ok) {
            diagLog && diagLog('warning', 'AutoRefresh', `Poll failed HTTP ${resp.status}`);
            return;
        }

        const data = await resp.json();
        const statuses = Array.isArray(data.statuses) ? data.statuses : [];

        // Diff against last known signatures.  First poll seeds the cache
        // with whatever the server reports, so no false-positive "everything
        // changed" toast on startup.
        const changed = [];
        const isFirstPoll = window._autoRefresh.lastStatuses.size === 0;

        for (const s of statuses) {
            const sig = _sig(s.build_number, s.status);
            const previous = window._autoRefresh.lastStatuses.get(s.job_url);
            window._autoRefresh.lastStatuses.set(s.job_url, sig);
            if (!isFirstPoll && previous !== undefined && previous !== sig) {
                changed.push(s.job_url);
            }
        }

        if (!changed.length) return;

        // Tier 2: pull the full record for each changed job so metrics and
        // release_status stay correct.  Reuse the existing request path so
        // promotion_time and credential resolution are identical.
        await Promise.all(changed.map(_enrichChangedJob));

        // Status / build_number changed → the previous TRIGGERED chip (if
        // any) has done its job; clear it immediately rather than waiting
        // for the 10-second scheduleRerunBadgeCleanup timer.  Otherwise
        // users see TRIGGERED alongside a fresh terminal status, which
        // contradicts itself.
        changed.forEach(_clearRerunBadge);

        // After enrichment, flash + toast.
        changed.forEach(_flashRow);
        _showAutoRefreshToast(changed.length);

    } catch (err) {
        diagLog && diagLog('warning', 'AutoRefresh', 'Poll error: ' + (err && err.message));
    } finally {
        window._autoRefresh.inFlight = false;
    }
}

async function _enrichChangedJob(jobUrl) {
    const creds = appState.authCredentials;
    const existing = appState.jobs.get(jobUrl);
    const jobName = existing ? (existing.name || existing.job_name) : jobUrl.split('/').pop();
    try {
        const resp = await fetch('/api/refresh-single', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                job_url: jobUrl,
                job_name: jobName,
                jenkins_url: creds.jenkins_url,
                username: creds.username,
                api_token: creds.api_token,
                promotion_time: (typeof getPromotionTimeISO === 'function') ? getPromotionTimeISO() : '',
            }),
        });
        if (!resp.ok) return;
        const data = await resp.json();
        // Update the in-memory store + DOM via the same path the manual
        // single-row refresh uses.
        if (data && data.job_url) {
            data.latest_status = data.current_status;  // mirror the streaming.js mapping
            appState.jobs.set(data.job_url, data);
            if (typeof updateJobRow === 'function') {
                updateJobRow(data.job_url, data);
            }
        }
    } catch (_) {
        // Silent — keep the loop running.
    }
}

// ---- Visual feedback -------------------------------------------------------

function _flashRow(jobUrl) {
    const row = document.querySelector(`tr[data-job-id="${CSS.escape(jobUrl)}"]:not(.detail-row)`);
    if (!row) return;
    row.classList.remove('row-auto-refresh-flash');
    // Force reflow so the animation restarts if it's already running.
    void row.offsetWidth;
    row.classList.add('row-auto-refresh-flash');
    setTimeout(() => row.classList.remove('row-auto-refresh-flash'), AR_FLASH_DURATION_MS + 100);
}

// Remove the small TRIGGERED chip for a job once we have proof the rerun
// has taken effect (status or build_number has moved on).  Mirrors the
// DOM + state cleanup that scheduleRerunBadgeCleanup does on a 10s timer,
// but without the wait — fresh status implicitly means the trigger landed.
function _clearRerunBadge(jobUrl) {
    if (appState && appState.rerunStates) {
        appState.rerunStates.delete(jobUrl);
    }
    const row = document.querySelector(`tr[data-job-id="${CSS.escape(jobUrl)}"]:not(.detail-row)`);
    if (!row) return;
    const badge = row.querySelector('.badge-rerun');
    if (badge) badge.remove();
}

function _showAutoRefreshToast(n) {
    const msg = n === 1 ? '1 job updated' : (n + ' jobs updated');
    if (typeof showToast === 'function') {
        showToast(msg, 'info');
    }
}

// ---- Lifecycle -------------------------------------------------------------

function _startAutoRefresh() {
    if (window._autoRefresh.timer) return;
    window._autoRefresh.lastStatuses.clear();  // fresh start
    window._autoRefresh.timer = setInterval(_pollOnce, AR_INTERVAL_MS);
    // Fire one poll quickly so the cache is seeded; first real diff happens
    // on the second tick 30s later.
    setTimeout(_pollOnce, 1500);
}

function _stopAutoRefresh(_reason) {
    if (window._autoRefresh.timer) {
        clearInterval(window._autoRefresh.timer);
        window._autoRefresh.timer = null;
    }
    window._autoRefresh.lastStatuses.clear();
}

// Public toggle — bound to the toolbar button.
function toggleAutoRefresh() {
    const next = !_isAutoRefreshOn();
    _setAutoRefreshOn(next);
    _updateAutoRefreshButton(next);
    if (next) _startAutoRefresh();
    else _stopAutoRefresh('user');
    if (typeof showToast === 'function') {
        showToast('Auto-refresh: ' + (next ? 'ON' : 'OFF'), 'info');
    }
}

function _updateAutoRefreshButton(on) {
    const btn = document.getElementById('btn-auto-refresh');
    if (!btn) return;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.classList.toggle('auto-refresh-on', !!on);
    btn.classList.toggle('auto-refresh-off', !on);
    const label = btn.querySelector('.btn-auto-refresh-label');
    if (label) label.textContent = on ? 'Auto-refresh: ON' : 'Auto-refresh: OFF';
}

// Visibility API — pause when the tab is hidden, resume when it returns.
document.addEventListener('visibilitychange', () => {
    if (!_isAutoRefreshOn()) return;
    if (document.hidden) {
        // Leave the timer running — _shouldSkipThisTick handles the skip.
        // We don't fully stop because resumption is implicit.
    } else {
        // Tab back in foreground — poll once immediately so the user sees
        // current state without waiting up to 30 more seconds.
        setTimeout(_pollOnce, 250);
    }
});

// Bootstrap: started by app.js after the first successful fetch populates
// appState.jobs.  Exposed for that integration point.
function initAutoRefresh() {
    const on = _isAutoRefreshOn();
    _setAutoRefreshOn(on);  // normalise + persist default
    _updateAutoRefreshButton(on);
    if (on) _startAutoRefresh();
}
