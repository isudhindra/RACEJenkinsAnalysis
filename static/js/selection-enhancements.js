'use strict';

let _selectionAnchor = null;

// Selectors of elements that should keep their default click behaviour.
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

// Apply selection state to a single row 
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

// After any selection change, sync the header checkbox state and the
// toolbar action buttons (Rerun Selected count, etc.).  Mirrors what
// toggleJobSelection in filters.js already does.
function _syncHeaderAndToolbar() {
    const allCheckbox = document.getElementById('select-all-checkbox');
    if (allCheckbox) {
        const visibleCbs = _visibleJobRowsInOrder()
            .map(r => r.querySelector('input[type="checkbox"][data-action="select"]'))
            .filter(Boolean);
        const checkedCount = visibleCbs.filter(cb => cb.checked).length;
        allCheckbox.checked = checkedCount > 0 && checkedCount === visibleCbs.length;
        // Indeterminate state — some-but-not-all selected.  Tri-state hint.
        allCheckbox.indeterminate = checkedCount > 0 && checkedCount < visibleCbs.length;
    }
    if (typeof updateToolbarActions === 'function') updateToolbarActions();
}

// Range select between two job IDs (inclusive), setting every row in the
// range to `targetState`.  Uses current DOM order so the range honours the
// active sort + filter combination.
function _applyRangeSelect(anchorJobId, currentJobId, targetState) {
    const rows = _visibleJobRowsInOrder();
    const ai = rows.findIndex(r => r.getAttribute('data-job-id') === anchorJobId);
    const ci = rows.findIndex(r => r.getAttribute('data-job-id') === currentJobId);
    if (ai === -1 || ci === -1) return false;
    const [start, end] = ai <= ci ? [ai, ci] : [ci, ai];
    for (let i = start; i <= end; i++) _setRowSelected(rows[i], targetState);
    return true;
}

// Single-row toggle — keeps the existing change-event path's behaviour but
// also keeps the visual .row-selected class in sync.
function _toggleSingleRow(row) {
    const jobId = row.getAttribute('data-job-id');
    const willBeSelected = !appState.selectedJobs.has(jobId);
    _setRowSelected(row, willBeSelected);
}

// ---- Click handler -------------------------------------------------------
//
// Attached on DOMContentLoaded.  Uses event delegation against <tbody>.

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

        // Click on an interactive child that ISN'T the row's own checkbox →
        // leave it alone (job-name link, expand icon, rerun button, etc.).
        if (!isCheckbox && _isInteractive(e.target)) return;

        const jobId = row.getAttribute('data-job-id');

        // ---- Shift+click → range select --------------------------------
        if (e.shiftKey && _selectionAnchor && _selectionAnchor !== jobId) {
            // Decide the target state from the anchor row's current state.
            const targetState = appState.selectedJobs.has(_selectionAnchor);
            const ok = _applyRangeSelect(_selectionAnchor, jobId, targetState);
            if (ok) {
                e.preventDefault();
                _syncHeaderAndToolbar();
                // Clear text selection that shift+click would otherwise leave.
                if (window.getSelection) window.getSelection().removeAllRanges();
                return;
            }
        }

        // ---- Plain click ------------------------------------------------
        if (isCheckbox) {
            setTimeout(() => {
                row.classList.toggle('row-selected', e.target.checked);
                _selectionAnchor = jobId;
                _syncHeaderAndToolbar();
            }, 0);
            return;
        }

        // Click on a non-interactive cell — toggle the row.
        _toggleSingleRow(row);
        _selectionAnchor = jobId;
        _syncHeaderAndToolbar();
    });

    // ---- Ctrl/Cmd + hover → paint-select -----------------------------
    //
    // Hold the modifier and move the cursor across rows; each row the
    // cursor enters is added to the selection.  Like dragging a paint
    // brush — fastest way to pick a contiguous group when shift+click
    // is too precise.
    //
    // Tracked row prevents the same mouseover bursts (one per child
    // element entered) from firing the handler multiple times for the
    // same row.  We only act on transitions into a *new* row.
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

    // Cosmetic: change the row cursor to "cell" while the modifier is
    // held so users see immediate feedback that paint-select is armed.
    document.addEventListener('keydown', function(e) {
        if (e.ctrlKey || e.metaKey) document.body.classList.add('paint-select-armed');
    });
    document.addEventListener('keyup', function(e) {
        if (!e.ctrlKey && !e.metaKey) document.body.classList.remove('paint-select-armed');
    });
    // Releasing the tab (blur) should also clear the cursor cue.
    window.addEventListener('blur', () => document.body.classList.remove('paint-select-armed'));

    // The select-all header checkbox should also clear the anchor — after
    // a bulk toggle the next shift+click should start a fresh range.
    const all = document.getElementById('select-all-checkbox');
    if (all) {
        all.addEventListener('change', function() {
            _selectionAnchor = null;
            // After toggleSelectAll runs (existing filters.js handler),
            // re-paint the .row-selected class on every visible row.
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

// Auto-init on DOMContentLoaded.  Idempotent — only one handler is attached.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initSelectionEnhancements);
} else {
    _initSelectionEnhancements();
}

// Predicate for each named category.  Reads the job record carried on each
// row via appState.jobs (so the rules match exactly what the table shows).
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

// Apply the bulk selection.
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

// Update live counts shown in the dropdown items, then toggle the menu.
// Called via the trigger button's onclick.
function openSelectDropdown() {
    // Count visible rows matching each category.
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

    // Promotion-only items appear only when a promotion time is set.
    const promoActive = !!(appState && appState.promotionTime);
    document.querySelectorAll('#ops-select-menu .promo-only').forEach(el => {
        el.style.display = promoActive ? '' : 'none';
    });

    // Disable items with a count of 0 — keeps them visible (so users learn
    // the menu structure) but un-clickable so nothing happens.
    document.querySelectorAll('#ops-select-menu .ops-dropdown-item').forEach(btn => {
        const countEl = btn.querySelector('.ops-dropdown-count');
        const txt = countEl ? countEl.textContent : '';
        const zero = countEl && (txt === '' || txt === '(0)');
        // "All Visible" and "Clear Selection" are always enabled.
        const alwaysOn = btn.textContent.trim().startsWith('All Visible') ||
                         btn.textContent.trim().startsWith('Clear Selection');
        btn.disabled = !alwaysOn && zero;
        btn.style.opacity = btn.disabled ? '0.4' : '';
    });

    if (typeof toggleOpsDropdown === 'function') toggleOpsDropdown('ops-select-dropdown');
}
