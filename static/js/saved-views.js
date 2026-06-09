// saved-views.js — name-it / restore-it bookmarks for the dashboard.
//
// What gets saved per view:
//   * Jenkins instance ID         (config-panel context)
//   * Resolved view URL           (which Jenkins view was picked)
//   * Status / release-status / search-text filters
//   * Promotion time              (for release-validation)
//   * View mode                   (summary vs detail)
//
// Everything lives in localStorage under the single key SAVED_VIEWS_KEY.
// No backend — saved views are personal, per-device, never synced.
//
// Public functions (called from inline handlers in the template):
//   openSavedViewsDropdown()    — toggle the dropdown
//   saveCurrentView()           — prompt for name, persist current state
//   applySavedView(name)        — restore everything; refetch is up to the user
//   deleteSavedView(name)       — remove + re-render the menu
'use strict';

const SAVED_VIEWS_KEY = 'jjat.saved_views';
const SAVED_VIEWS_MAX = 25; // cap to keep localStorage tidy + the menu scannable


// ── Persistence ────────────────────────────────────────────────────────

function _readSavedViews() {
    try {
        const raw = localStorage.getItem(SAVED_VIEWS_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        // Corrupted JSON — start fresh rather than crash.
        console.warn('[saved-views] localStorage corrupt, resetting:', e);
        return [];
    }
}

function _writeSavedViews(views) {
    try {
        localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(views));
    } catch (e) {
        console.error('[saved-views] write failed:', e);
    }
}


// ── State snapshot / restore ───────────────────────────────────────────

// Capture the bits of appState that uniquely identify a "view configuration".
function _captureCurrentSnapshot() {
    const filters = appState.filters || {};
    return {
        instance_id:     appState.selectedInstance ? appState.selectedInstance.id : null,
        view_url:        appState._resolvedViewUrl || null,
        view_path:       (document.getElementById('view-select') || {}).value || null,
        view_mode:       appState.viewMode || 'summary',
        promotion_time:  appState.promotionTime || null,
        filter_status:   filters.status || null,
        filter_release:  filters.releaseStatus || null,
        filter_search:   filters.searchText || '',
        filter_la:       Array.from(filters.logAnalysisLabels || []),
        saved_at:        new Date().toISOString(),
    };
}

// Restore a snapshot into the live DOM/state.  Stops short of triggering
// a fetch — the user clicks Fetch Jobs themselves to confirm intent.
function _applySnapshot(snap) {
    // Filters
    const fs = document.getElementById('filter-status');
    if (fs) fs.value = snap.filter_status || '';

    const fr = document.getElementById('filter-release-status');
    if (fr) fr.value = snap.filter_release || '';

    const search = document.getElementById('filter-search');
    if (search) search.value = snap.filter_search || '';

    // Restore log-analysis multi-select
    appState.filters.logAnalysisLabels = Array.from(snap.filter_la || []);
    if (typeof updateSelectedLabelBadge === 'function') updateSelectedLabelBadge();

    // Promotion time — restore both the input value AND the downstream UI
    // (release-status dropdown visibility, regression column, dual-panel KPI)
    // by routing through applyPromotionTime() rather than mutating
    // appState.promotionTime directly.  Without this the dropdown stays
    // hidden until the user manually re-applies promotion.
    if (snap.promotion_time) {
        const promoInput = document.getElementById('promotion-datetime');
        if (promoInput) promoInput.value = snap.promotion_time.replace(/Z$/, '').slice(0, 16);
        if (typeof applyPromotionTime === 'function') {
            applyPromotionTime();
        } else {
            appState.promotionTime = snap.promotion_time;
        }
    } else {
        // Snapshot has no promotion — clear any active promotion so the
        // restored view matches what the user saved.
        const promoInput = document.getElementById('promotion-datetime');
        if (promoInput && promoInput.value) {
            promoInput.value = '';
            if (typeof applyPromotionTime === 'function') applyPromotionTime();
        }
    }

    // View mode (summary / detail)
    if (snap.view_mode && typeof switchViewMode === 'function') {
        switchViewMode(snap.view_mode);
    }

    // Instance + view path — only restorable if the same instance still exists.
    if (snap.instance_id) {
        const instanceSelect = document.getElementById('instance-select');
        if (instanceSelect && Array.from(instanceSelect.options).some(o => o.value === snap.instance_id)) {
            instanceSelect.value = snap.instance_id;
            if (typeof onInstanceChange === 'function') onInstanceChange();
        }
    }
    if (snap.view_path) {
        // Try to set after onInstanceChange has populated the view select.
        setTimeout(() => {
            const vs = document.getElementById('view-select');
            if (vs && Array.from(vs.options).some(o => o.value === snap.view_path)) {
                vs.value = snap.view_path;
                if (typeof onViewChange === 'function') onViewChange();
            }
        }, 200);
    }

    // Apply filter rerender to whatever is already in the table.
    if (typeof applyFilters === 'function') applyFilters();
}


// ── Menu rendering ─────────────────────────────────────────────────────

function _renderMenu() {
    const menu = document.getElementById('ops-saved-views-menu');
    if (!menu) return;

    const views = _readSavedViews();
    let html = `
        <button class="ops-dropdown-item" onclick="saveCurrentView(); closeOpsDropdowns()">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            Save current view…
        </button>
    `;

    if (views.length === 0) {
        html += `<div class="ops-dropdown-empty">No saved views yet.</div>`;
    } else {
        html += `<div class="ops-dropdown-divider"></div>`;
        for (const v of views) {
            const safeName = escapeHtml(v.name);
            const safeMeta = escapeHtml(_describeSnapshot(v.snapshot));
            html += `
                <div class="ops-saved-view-row">
                    <button class="ops-dropdown-item ops-saved-view-apply" onclick="applySavedView('${safeName.replace(/'/g, "\\'")}'); closeOpsDropdowns()" title="${safeMeta}">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                        <span class="ops-saved-view-name">${safeName}</span>
                        <span class="ops-saved-view-meta">${safeMeta}</span>
                    </button>
                    <button class="ops-saved-view-delete" onclick="deleteSavedView('${safeName.replace(/'/g, "\\'")}'); event.stopPropagation()" title="Delete">×</button>
                </div>
            `;
        }
    }
    menu.innerHTML = html;
}

function _describeSnapshot(s) {
    const parts = [];
    if (s.view_path)      parts.push(s.view_path);
    if (s.filter_status)  parts.push(`status=${s.filter_status}`);
    if (s.filter_release) parts.push(`release=${s.filter_release}`);
    if (s.filter_search)  parts.push(`search="${s.filter_search}"`);
    if (s.view_mode && s.view_mode !== 'summary') parts.push(s.view_mode);
    return parts.length ? parts.join(' · ') : '(no filters)';
}


// ── Public handlers (called from template inline events) ───────────────

function openSavedViewsDropdown() {
    _renderMenu();
    if (typeof toggleOpsDropdown === 'function') {
        toggleOpsDropdown('ops-saved-views-dropdown');
    }
}

function saveCurrentView() {
    const name = (prompt('Name this view:') || '').trim();
    if (!name) return;

    const snap = _captureCurrentSnapshot();
    if (!snap.instance_id && !snap.view_path) {
        if (typeof showToast === 'function') {
            showToast('Pick an instance + view first, then save.', 'warning');
        } else {
            alert('Pick an instance + view first, then save.');
        }
        return;
    }

    let views = _readSavedViews();
    // Overwrite if name already exists.
    views = views.filter(v => v.name !== name);
    views.unshift({ name, snapshot: snap });
    if (views.length > SAVED_VIEWS_MAX) views = views.slice(0, SAVED_VIEWS_MAX);
    _writeSavedViews(views);

    if (typeof showToast === 'function') {
        showToast(`Saved view "${name}"`, 'success');
    }
}

function applySavedView(name) {
    const views = _readSavedViews();
    const entry = views.find(v => v.name === name);
    if (!entry) return;
    _applySnapshot(entry.snapshot);
    if (typeof showToast === 'function') {
        showToast(`Loaded view "${name}" — click Fetch Jobs to refresh.`, 'info');
    }
}

function deleteSavedView(name) {
    const views = _readSavedViews().filter(v => v.name !== name);
    _writeSavedViews(views);
    _renderMenu();
}
