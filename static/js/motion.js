// motion.js — Storytelling animations for the fetch lifecycle (narrative strip + KPI reveal).
'use strict';

var _motion = {
    phase: 'idle',          // current storytelling phase
    phaseStartTime: 0,      // performance.now() when the phase began
    rowsRevealed: 0,        // rows that have animated in
    kpiRevealed: false,     // whether KPI panels have been revealed
    completionRevealed: false,
};

//  Phase transitions 

// Advance to a new fetch phase — updates the narrative strip and triggers transitions.
function motionSetPhase(phase) {
    if (_motion.phase === phase) return;
    console.log('[Motion] Phase:', _motion.phase, '→', phase);
    _motion.phase = phase;
    _motion.phaseStartTime = performance.now();

    var strip = document.getElementById('motion-narrative');
    if (!strip) return;

    // Leaving idle: reveal the strip and hide KPIs until data lands.
    if (phase !== 'idle') {
        strip.classList.add('motion-active');
        var kpiC = document.getElementById('kpi-container');
        if (kpiC && !kpiC.classList.contains('kpi-revealed')) {
            kpiC.classList.add('kpi-waiting');
        }
    }

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

    var lines = strip.querySelectorAll('.motion-phase-line');
    for (var j = 0; j < lines.length; j++) {
        lines[j].classList.toggle('line-filled', j < currentIdx);
        lines[j].classList.toggle('line-active', j === currentIdx - 1 || (j === currentIdx && phase !== 'connecting'));
    }

    if (phase === 'complete') {
        _scheduleCompletionSettle();
    }
}

// Reset motion state — called on cancel or before a fresh fetch.
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

    var kpiContainer = document.getElementById('kpi-container');
    if (kpiContainer) {
        kpiContainer.classList.remove('kpi-waiting', 'kpi-revealed', 'kpi-settling');
    }
}

// Reveal the KPI panel when the first meaningful data arrives (called from updateSummaryBar).
function motionRevealKPI() {
    if (_motion.kpiRevealed) return;
    if (_motion.phase === 'idle') return;
    if (appState.jobs.size === 0) return;

    console.log('[Motion] KPI reveal triggered — jobs:', appState.jobs.size);
    _motion.kpiRevealed = true;

    var kpiContainer = document.getElementById('kpi-container');
    if (!kpiContainer) return;

    kpiContainer.classList.remove('kpi-waiting');
    kpiContainer.classList.add('kpi-revealed');

    // Stagger each metric block inside the panel for a sequential reveal.
    var metrics = kpiContainer.querySelectorAll('.kpi-metric');
    for (var i = 0; i < metrics.length; i++) {
        metrics[i].style.setProperty('--stagger', i);
        var val = metrics[i].querySelector('.kpi-metric-val');
        if (val) {
            val.style.setProperty('--stagger', i);
            val.classList.add('motion-counting');
        }
    }

    setTimeout(function() {
        var vals = kpiContainer.querySelectorAll('.kpi-metric-val.motion-counting');
        for (var k = 0; k < vals.length; k++) {
            vals[k].classList.remove('motion-counting');
        }
    }, 1200);
}

//  Row entry tracking ─

function motionNoteRowInserted() {
    _motion.rowsRevealed++;
}

//  Completion settle 

// After fetch completes: pulse KPIs, then auto-minimise the narrative strip.
function _scheduleCompletionSettle() {
    if (_motion.completionRevealed) return;
    console.log('[Motion] Completion settle — rows revealed:', _motion.rowsRevealed);
    _motion.completionRevealed = true;

    var kpiContainer = document.getElementById('kpi-container');
    if (kpiContainer) {
        kpiContainer.classList.add('kpi-settling');
        setTimeout(function() {
            if (kpiContainer) kpiContainer.classList.remove('kpi-settling');
        }, 900);
    }

    setTimeout(function() {
        var strip = document.getElementById('motion-narrative');
        if (strip && _motion.phase === 'complete') {
            strip.classList.add('motion-settled');
        }
    }, 4000);
}

//Enrichment pulse

// Blue pulse on a row when its classification data arrives.
function motionEnrichRow(row) {
    if (!row) return;
    console.log('[Motion] Row enriched:', row.dataset.jobId);
    row.classList.add('motion-enrich-pulse');
    setTimeout(function() {
        row.classList.remove('motion-enrich-pulse');
    }, 1000);
}
