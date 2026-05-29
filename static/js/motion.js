'use strict';

// ── Phase lifecycle 
var _motion = {
    phase: 'idle',          // current storytelling phase
    phaseStartTime: 0,      // when the current phase began (performance.now)
    rowsRevealed: 0,        // how many rows have entered so far
    kpiRevealed: false,     // whether KPI panels have been revealed
    completionRevealed: false,
};

// ── Phase transitions ──────────────────────────────────────────────────

// Move to a new storytelling phase — updates the narrative strip and triggers
// CSS class changes that drive the visual transitions.
function motionSetPhase(phase) {
    if (_motion.phase === phase) return;
    console.log('[Motion] Phase:', _motion.phase, '→', phase);
    _motion.phase = phase;
    _motion.phaseStartTime = performance.now();

    var strip = document.getElementById('motion-narrative');
    if (!strip) return;

    // Show the strip when we leave idle, and hide KPI metrics until data arrives
    if (phase !== 'idle') {
        strip.classList.add('motion-active');
        var kpiC = document.getElementById('kpi-container');
        if (kpiC && !kpiC.classList.contains('kpi-revealed')) {
            kpiC.classList.add('kpi-waiting');
        }
    }

    // Update all phase nodes
    var nodes = strip.querySelectorAll('.motion-phase-node');
    var phases = ['connecting', 'discovering', 'fetching', 'classifying', 'complete'];
    var currentIdx = phases.indexOf(phase);

    for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        node.classList.remove('phase-active', 'phase-done', 'phase-upcoming');
        if (i < currentIdx) {
            node.classList.add('phase-done');
        } else if (i === currentIdx) {
            node.classList.add('phase-active');
        } else {
            node.classList.add('phase-upcoming');
        }
    }

    // Update the connecting line fills
    var lines = strip.querySelectorAll('.motion-phase-line');
    for (var j = 0; j < lines.length; j++) {
        lines[j].classList.toggle('line-filled', j < currentIdx);
        lines[j].classList.toggle('line-active', j === currentIdx - 1 || (j === currentIdx && phase !== 'connecting'));
    }

    // On completion, trigger the settle animation sequence
    if (phase === 'complete') {
        _scheduleCompletionSettle();
    }
}

// Reset motion state back to idle — called when fetch is cancelled or before a new fetch
function motionReset() {
    _motion.phase = 'idle';
    _motion.rowsRevealed = 0;
    _motion.kpiRevealed = false;
    _motion.completionRevealed = false;

    var strip = document.getElementById('motion-narrative');
    if (strip) {
        strip.classList.remove('motion-active', 'motion-settled');
        var nodes = strip.querySelectorAll('.motion-phase-node');
        for (var i = 0; i < nodes.length; i++) {
            nodes[i].classList.remove('phase-active', 'phase-done', 'phase-upcoming');
            nodes[i].classList.add('phase-upcoming');
        }
        var lines = strip.querySelectorAll('.motion-phase-line');
        for (var j = 0; j < lines.length; j++) {
            lines[j].classList.remove('line-filled', 'line-active');
        }
    }

    // Reset KPI panel motion classes
    var kpiContainer = document.getElementById('kpi-container');
    if (kpiContainer) {
        kpiContainer.classList.remove('kpi-waiting', 'kpi-revealed', 'kpi-settling');
    }
}

// Trigger the KPI panel reveal animation when the first meaningful data arrives.
// Called from updateSummaryBar after jobs are loaded.
function motionRevealKPI() {
    if (_motion.kpiRevealed) return;
    if (_motion.phase === 'idle') return;
    if (appState.jobs.size === 0) return;

    console.log('[Motion] KPI reveal triggered — jobs:', appState.jobs.size);
    _motion.kpiRevealed = true;

    var kpiContainer = document.getElementById('kpi-container');
    if (!kpiContainer) return;

    // Remove the waiting state and trigger the reveal
    kpiContainer.classList.remove('kpi-waiting');
    kpiContainer.classList.add('kpi-revealed');

    // Stagger each metric block inside the panel
    var metrics = kpiContainer.querySelectorAll('.kpi-metric');
    for (var i = 0; i < metrics.length; i++) {
        metrics[i].style.setProperty('--stagger', i);
        // Add count-up blur effect to value digits
        var val = metrics[i].querySelector('.kpi-metric-val');
        if (val) {
            val.style.setProperty('--stagger', i);
            val.classList.add('motion-counting');
        }
    }

    // Clean up count-up class after animations finish
    setTimeout(function() {
        var vals = kpiContainer.querySelectorAll('.kpi-metric-val.motion-counting');
        for (var k = 0; k < vals.length; k++) {
            vals[k].classList.remove('motion-counting');
        }
    }, 1200);
}

// ── Row entry enhancement ──────────────────────────────────────────────

// Track row reveal count for stagger calculations
function motionNoteRowInserted() {
    _motion.rowsRevealed++;
}

// ── Completion settle ──────────────────────────────────────────────────

// After fetch completes, run a short orchestrated "settle" sequence:
// 1. Phase strip pulses and settles
// 2. KPI panels get a subtle emphasis
// 3. The strip minimizes after a delay
function _scheduleCompletionSettle() {
    if (_motion.completionRevealed) return;
    console.log('[Motion] Completion settle — rows revealed:', _motion.rowsRevealed);
    _motion.completionRevealed = true;

    var kpiContainer = document.getElementById('kpi-container');
    if (kpiContainer) {
        kpiContainer.classList.add('kpi-settling');
        // Remove settling class after animation plays
        setTimeout(function() {
            if (kpiContainer) kpiContainer.classList.remove('kpi-settling');
        }, 900);
    }

    // Auto-minimize the narrative strip after the user has seen completion
    setTimeout(function() {
        var strip = document.getElementById('motion-narrative');
        if (strip && _motion.phase === 'complete') {
            strip.classList.add('motion-settled');
        }
    }, 4000);
}

// ── Enrichment pulse ───────────────────────────────────────────────────

// Flash a subtle blue pulse on a row when classification data arrives.
// Enhances the existing row-just-enriched animation with a smoother feel.
function motionEnrichRow(row) {
    if (!row) return;
    console.log('[Motion] Row enriched:', row.dataset.jobId);
    row.classList.add('motion-enrich-pulse');
    setTimeout(function() {
        row.classList.remove('motion-enrich-pulse');
    }, 1000);
}
