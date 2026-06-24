// Row selection: shift-click ranges, ctrl/cmd-hover paint, bulk-select by category.
'use strict';

let _selectionAnchor = null;

// Elements that should keep their native click behaviour (links, buttons, etc.).
const _INTERACTIVE_SELECTOR =
    'a, button, label, input, [data-action], .rec-chip-overflow, .ops-dropdown-menu';

function _isInteractive(el) {
    if (!el) return false;
    return !!el.closest(_INTERACTIVE_SELECTOR);
}

function _visibleJobRowsInOrder() {
    return Array.from(
        document.querySelectorAll('tbody tr[data-job-id]:not(.detail-row)')
    ).filter(r => r.style.display !== 'none');
}

function _setRowSelected(row, selected) {
    if (!row) return;
    const jobId = row.getAttribute('data-job-id');
    if (!jobId) return;
    const cb = row.querySelector('input[type="checkbox"][data-action="select"]');
    if (cb) cb.checked = selected;
    if (selected) {
        appState.selectedJobs.add(jobId);
        row.classList.add('row-selected');
    } else {
        appState.selectedJobs.delete(jobId);
        row.classList.remove('row-selected');
    }
}

// After any selection change, sync header checkbox + toolbar action buttons.
// Mirrors what toggleJobSelection in filters.js does.
function _syncHeaderAndToolbar() {
    const allCheckbox = document.getElementById('select-all-checkbox');
    if (allCheckbox) {
        const visibleCbs = _visibleJobRowsInOrder()
            .map(r => r.querySelector('input[type="checkbox"][data-action="select"]'))
            .filter(Boolean);
        const checkedCount = visibleCbs.filter(cb => cb.checked).length;
        allCheckbox.checked = checkedCount > 0 && checkedCount === visibleCbs.length;
        // Tri-state hint when some-but-not-all are selected.
        allCheckbox.indeterminate = checkedCount > 0 && checkedCount < visibleCbs.length;
    }
    if (typeof updateToolbarActions === 'function') updateToolbarActions();
    if (typeof updateScopeIndicator === 'function') updateScopeIndicator();
    // Selection counts toward Clear button's badge.
    if (typeof updateClearFiltersButton === 'function') updateClearFiltersButton();
}

// Inclusive range select between two job IDs in current DOM order, so the
// range respects the active sort + filter.
function _applyRangeSelect(anchorJobId, currentJobId, targetState) {
    const rows = _visibleJobRowsInOrder();
    const ai = rows.findIndex(r => r.getAttribute('data-job-id') === anchorJobId);
    const ci = rows.findIndex(r => r.getAttribute('data-job-id') === currentJobId);
    if (ai === -1 || ci === -1) return false;
    const [start, end] = ai <= ci ? [ai, ci] : [ci, ai];
    for (let i = start; i <= end; i++) _setRowSelected(rows[i], targetState);
    return true;
}

// Toggle one row, keeping the .row-selected class in sync with the checkbox.
function _toggleSingleRow(row) {
    const jobId = row.getAttribute('data-job-id');
    const willBeSelected = !appState.selectedJobs.has(jobId);
    _setRowSelected(row, willBeSelected);
}

// Attached on DOMContentLoaded; delegates clicks from <tbody>.
function _initSelectionEnhancements() {
    const tbody = document.querySelector('#job-table tbody');
    if (!tbody) return;

    tbody.addEventListener('click', function(e) {
        const row = e.target.closest('tr[data-job-id]:not(.detail-row)');
        if (!row) return;

        const isCheckbox =
            e.target.tagName === 'INPUT' &&
            e.target.type === 'checkbox' &&
            e.target.dataset.action === 'select';

        // Skip interactive children that aren't the row's own checkbox
        // (job-name link, expand icon, rerun button, etc.).
        if (!isCheckbox && _isInteractive(e.target)) return;

        const jobId = row.getAttribute('data-job-id');

        // Shift+click → range select.
        if (e.shiftKey && _selectionAnchor && _selectionAnchor !== jobId) {
            const targetState = appState.selectedJobs.has(_selectionAnchor);
            const ok = _applyRangeSelect(_selectionAnchor, jobId, targetState);
            if (ok) {
                e.preventDefault();
                _syncHeaderAndToolbar();
                // Clear the text selection shift+click would otherwise leave.
                if (window.getSelection) window.getSelection().removeAllRanges();
                return;
            }
        }

        if (isCheckbox) {
            setTimeout(() => {
                row.classList.toggle('row-selected', e.target.checked);
                _selectionAnchor = jobId;
                _syncHeaderAndToolbar();
            }, 0);
            return;
        }

        // Plain click on a non-interactive cell toggles the row.
        _toggleSingleRow(row);
        _selectionAnchor = jobId;
        _syncHeaderAndToolbar();
    });

    // Ctrl/Cmd + hover paint-select: hold the modifier and drag the cursor
    // across rows to add each to the selection. _lastPaintRow debounces the
    // mouseover bursts that fire as the cursor crosses child elements.
    let _lastPaintRow = null;
    tbody.addEventListener('mouseover', function(e) {
        const modifierHeld = e.ctrlKey || e.metaKey;
        if (!modifierHeld) {
            _lastPaintRow = null;
            return;
        }
        const row = e.target.closest('tr[data-job-id]:not(.detail-row)');
        if (!row || row === _lastPaintRow) return;
        _lastPaintRow = row;
        _setRowSelected(row, true);
        _syncHeaderAndToolbar();
    });
    tbody.addEventListener('mouseleave', function() {
        _lastPaintRow = null;
    });

    // Cursor cue: signal paint-select is armed while the modifier is held.
    document.addEventListener('keydown', function(e) {
        if (e.ctrlKey || e.metaKey) document.body.classList.add('paint-select-armed');
    });
    document.addEventListener('keyup', function(e) {
        if (!e.ctrlKey && !e.metaKey) document.body.classList.remove('paint-select-armed');
    });
    window.addEventListener('blur', () => document.body.classList.remove('paint-select-armed'));

    // Select-all also resets the anchor so the next shift+click starts fresh.
    const all = document.getElementById('select-all-checkbox');
    if (all) {
        all.addEventListener('change', function() {
            _selectionAnchor = null;
            // After toggleSelectAll (filters.js) runs, re-paint .row-selected.
            setTimeout(() => {
                _visibleJobRowsInOrder().forEach(r => {
                    const sel = appState.selectedJobs.has(r.getAttribute('data-job-id'));
                    r.classList.toggle('row-selected', sel);
                });
                _syncHeaderAndToolbar();
            }, 0);
        });
    }
}

// Auto-init on DOMContentLoaded — idempotent, single handler.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initSelectionEnhancements);
} else {
    _initSelectionEnhancements();
}

// Predicate per category — read from appState.jobs so rules match the table.
function _categoryPredicate(category) {
    switch (category) {
        case 'visible':
            return () => true;
        case 'failed':
            return job => job.latest_status === 'FAILURE' || job.health_state === 'FAILED';
        case 'unstable':
            return job => job.latest_status === 'UNSTABLE' || job.health_state === 'UNSTABLE';
        case 'aborted':
            return job => job.latest_status === 'ABORTED' || job.health_state === 'ABORTED';
        case 'needs_rerun':
            return job => job.release_status === 'FAIL';
        case 'pending':
            return job => job.release_status === 'PENDING';
        default:
            return () => false;
    }
}

// Bulk-select all visible rows that match the named category.
function selectByCategory(category) {
    if (category === 'clear') {
        appState.selectedJobs.clear();
        _visibleJobRowsInOrder().forEach(r => {
            const cb = r.querySelector('input[type="checkbox"][data-action="select"]');
            if (cb) cb.checked = false;
            r.classList.remove('row-selected');
        });
        _syncHeaderAndToolbar();
        if (typeof showToast === 'function') showToast('Selection cleared', 'info');
        return;
    }

    const predicate = _categoryPredicate(category);
    const rows = _visibleJobRowsInOrder();
    appState.selectedJobs.clear();
    rows.forEach(row => {
        const jobId = row.getAttribute('data-job-id');
        const job = appState.jobs.get(jobId);
        const match = job ? predicate(job) : false;
        _setRowSelected(row, match);
    });
    _syncHeaderAndToolbar();
    const n = appState.selectedJobs.size;
    if (typeof showToast === 'function') {
        const label = n === 1 ? 'job' : 'jobs';
        showToast(`Selected ${n} ${label}`, n > 0 ? 'success' : 'info');
    }
}

// Refresh live counts in the dropdown items, then toggle the menu.
function openSelectDropdown() {
    const rows = _visibleJobRowsInOrder();
    const counts = {
        visible: 0, failed: 0, unstable: 0, aborted: 0,
        needs_rerun: 0, pending: 0,
    };
    rows.forEach(r => {
        const job = appState.jobs.get(r.getAttribute('data-job-id'));
        if (!job) return;
        counts.visible++;
        if (_categoryPredicate('failed')(job)) counts.failed++;
        if (_categoryPredicate('unstable')(job)) counts.unstable++;
        if (_categoryPredicate('aborted')(job)) counts.aborted++;
        if (_categoryPredicate('needs_rerun')(job)) counts.needs_rerun++;
        if (_categoryPredicate('pending')(job)) counts.pending++;
    });

    const set = (id, n) => {
        const el = document.getElementById(id);
        if (el) el.textContent = n > 0 ? `(${n})` : '';
    };
    set('sel-count-visible',     counts.visible);
    set('sel-count-failed',      counts.failed);
    set('sel-count-unstable',    counts.unstable);
    set('sel-count-aborted',     counts.aborted);
    set('sel-count-needs-rerun', counts.needs_rerun);
    set('sel-count-pending',     counts.pending);

    // Promotion-only items only show when a promotion time is set.
    const promoActive = !!(appState && appState.promotionTime);
    document.querySelectorAll('#ops-select-menu .promo-only').forEach(el => {
        el.style.display = promoActive ? '' : 'none';
    });

    // Items with zero matches stay visible (menu structure stays familiar)
    // but become un-clickable.
    document.querySelectorAll('#ops-select-menu .ops-dropdown-item').forEach(btn => {
        const countEl = btn.querySelector('.ops-dropdown-count');
        const txt = countEl ? countEl.textContent : '';
        const zero = countEl && (txt === '' || txt === '(0)');
        // "All Visible" + "Clear Selection" are always enabled.
        const alwaysOn = btn.textContent.trim().startsWith('All Visible') ||
                         btn.textContent.trim().startsWith('Clear Selection');
        btn.disabled = !alwaysOn && zero;
        btn.style.opacity = btn.disabled ? '0.4' : '';
    });

    if (typeof toggleOpsDropdown === 'function') toggleOpsDropdown('ops-select-dropdown');
}
