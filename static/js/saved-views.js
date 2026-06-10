// Saved views — personal, per-device bookmarks for instance + view + filters
// + promotion time + view mode. Persisted in localStorage (no backend sync).
//
// Public handlers (template inline events):
//   openSavedViewsDropdown / saveCurrentView / applySavedView / deleteSavedView
'use strict';

const SAVED_VIEWS_KEY = 'jjat.saved_views';
const SAVED_VIEWS_MAX = 25;   // cap to keep storage tidy and menu scannable


//  Persistence 

function _readSavedViews() {
    try {
        const raw = localStorage.getItem(SAVED_VIEWS_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        // Corrupt JSON — start fresh rather than crash.
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


//  Snapshot / restore 
function _formatLocalNaive(d) {
    if (!(d instanceof Date) || isNaN(d.getTime())) return null;
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
        + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// Capture the bits of appState that uniquely identify a view configuration.
function _captureCurrentSnapshot() {
    const filters = appState.filters || {};
    const joblistSelect = document.getElementById('cfg-joblist-select');
    const promoInput = document.getElementById('promotion-datetime');
    let promoSaved = null;
    if (promoInput && promoInput.value) {
        promoSaved = promoInput.value;
    } else if (appState.promotionTime instanceof Date) {
        promoSaved = _formatLocalNaive(appState.promotionTime);
    }
    return {
        instance_id:     appState.selectedInstance ? appState.selectedInstance.id : null,
        source_mode:     appState.sourceMode || 'view',
        view_url:        appState._resolvedViewUrl || null,
        view_path:       (document.getElementById('cfg-view-select') || {}).value || null,
        joblist_file:    (joblistSelect && joblistSelect.value) || null,
        view_mode:       appState.viewMode || 'summary',
        promotion_time:  promoSaved,
        filter_status:   filters.status || null,
        filter_release:  filters.releaseStatus || null,
        filter_search:   filters.searchText || '',
        filter_la:       Array.from(filters.logAnalysisLabels || []),
        saved_at:        new Date().toISOString(),
    };
}

// Restore a snapshot into the live DOM/state. Doesn't auto-fetch —
// the user clicks Fetch Jobs to confirm intent.
function _applySnapshot(snap) {
    const fs = document.getElementById('filter-status');
    if (fs) fs.value = snap.filter_status || '';

    const fr = document.getElementById('filter-release-status');
    if (fr) fr.value = snap.filter_release || '';

    const search = document.getElementById('filter-search');
    if (search) search.value = snap.filter_search || '';

    appState.filters.logAnalysisLabels = Array.from(snap.filter_la || []);
    if (typeof updateSelectedLabelBadge === 'function') updateSelectedLabelBadge();

    // Route through applyPromotionTime()
    if (snap.promotion_time) {
        const promoInput = document.getElementById('promotion-datetime');
        if (promoInput) {
            const raw = String(snap.promotion_time);
            if (/Z$/.test(raw) || /[+-]\d{2}:?\d{2}$/.test(raw)) {
                promoInput.value = _formatLocalNaive(new Date(raw)) || raw.slice(0, 16);
            } else {
                promoInput.value = raw.slice(0, 16);
            }
        }
        if (typeof applyPromotionTime === 'function') {
            applyPromotionTime();
        } else {
            const d = new Date(snap.promotion_time);
            appState.promotionTime = isNaN(d.getTime()) ? null : d;
        }
    } else {
        // Snapshot had no promotion — clear any active one to match.
        const promoInput = document.getElementById('promotion-datetime');
        if (promoInput && promoInput.value) {
            promoInput.value = '';
            if (typeof applyPromotionTime === 'function') applyPromotionTime();
        }
    }

    if (snap.view_mode && typeof switchViewMode === 'function') {
        switchViewMode(snap.view_mode);
    }

    // Instance + view path: only restore when the instance still exists.
    if (snap.instance_id) {
        const instanceSelect = document.getElementById('cfg-jenkins-url');
        if (instanceSelect && Array.from(instanceSelect.options).some(o => o.value === snap.instance_id)) {
            instanceSelect.value = snap.instance_id;
            if (typeof onInstanceChange === 'function') onInstanceChange();
        }
    }
    // Restore source mode (Jenkins view vs custom job list) 
    if (snap.source_mode && typeof switchSourceMode === 'function') {
        switchSourceMode(snap.source_mode);
    }
    if (snap.view_path) {
        // Wait for onInstanceChange() to populate the view select first.
        setTimeout(() => {
            const vs = document.getElementById('cfg-view-select');
            if (vs && Array.from(vs.options).some(o => o.value === snap.view_path)) {
                vs.value = snap.view_path;
                if (typeof onViewChange === 'function') onViewChange();
            }
        }, 200);
    }
    if (snap.joblist_file) {
        setTimeout(() => {
            const js = document.getElementById('cfg-joblist-select');
            if (js && Array.from(js.options).some(o => o.value === snap.joblist_file)) {
                js.value = snap.joblist_file;
                if (typeof onJobListChange === 'function') onJobListChange();
            }
        }, 200);
    }

    // Re-run filters against whatever's already in the table.
    if (typeof applyFilters === 'function') applyFilters();
}


//  Menu rendering 

function _renderMenu() {
    const menu = document.getElementById('ops-saved-views-menu');
    if (!menu) return;

    const views = _readSavedViews();
    // Inline name input — replaces blocking prompt() (no theming, no
    // validation, silent clobber on duplicate names).
    let html = `
        <div class="ops-saved-view-savebar">
            <input type="text" id="ops-saved-view-name" class="ops-saved-view-input"
                   placeholder="Name this view…"
                   maxlength="60"
                   autocomplete="off"
                   onkeydown="if(event.key==='Enter'){event.preventDefault();_handleSaveCurrentViewSubmit();}"
                   onclick="event.stopPropagation()" />
            <button class="ops-dropdown-item ops-saved-view-savebtn"
                    type="button"
                    onclick="_handleSaveCurrentViewSubmit()">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                Save
            </button>
        </div>
        <div class="ops-saved-view-hint" id="ops-saved-view-hint" hidden></div>
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


//  Public handlers (template inline events) 

function openSavedViewsDropdown() {
    _renderMenu();
    if (typeof toggleOpsDropdown === 'function') {
        toggleOpsDropdown('ops-saved-views-dropdown');
    }
}

// Bound to the inline save bar's Enter key / Save button.
function _handleSaveCurrentViewSubmit() {
    const input = document.getElementById('ops-saved-view-name');
    const hint = document.getElementById('ops-saved-view-hint');
    if (!input) return;
    const name = (input.value || '').trim();
    if (!name) {
        if (hint) {
            hint.textContent = 'Enter a name first.';
            hint.hidden = false;
        }
        input.focus();
        return;
    }
    saveCurrentView(name);
}

function saveCurrentView(nameArg) {
    // Defensive: fall back to prompt() if a caller invokes without a name.
    // The toolbar UI now always supplies one via _handleSaveCurrentViewSubmit.
    const name = (nameArg != null
        ? String(nameArg)
        : (typeof prompt === 'function' ? (prompt('Name this view:') || '') : '')
    ).trim();
    if (!name) return;

    const snap = _captureCurrentSnapshot();
    if (!snap.instance_id) {
        if (typeof showToast === 'function') {
            showToast('Pick a Jenkins instance first, then save.', 'warning');
        } else {
            alert('Pick a Jenkins instance first, then save.');
        }
        return;
    }

    let views = _readSavedViews();
    const existed = views.some(v => v.name === name);
    // One slot per name — overwrite, and surface the overwrite via toast.
    views = views.filter(v => v.name !== name);
    views.unshift({ name, snapshot: snap });
    if (views.length > SAVED_VIEWS_MAX) views = views.slice(0, SAVED_VIEWS_MAX);
    _writeSavedViews(views);
    if (typeof showToast === 'function') {
        showToast(existed ? `Updated saved view "${name}"` : `Saved view "${name}"`, 'success');
    }
    if (typeof closeOpsDropdowns === 'function') closeOpsDropdowns();
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
