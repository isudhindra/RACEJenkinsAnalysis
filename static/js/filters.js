// filters.js — Table sort, search/log-analysis/release-status filters, header canvas, column resize.
'use strict';

// == TABLE SORTING ==
let currentSortKey = null;
let currentSortDir = null; // 'asc' | 'desc' | null

function getSortValue(row, key, type) {
    const job = appState.jobs.get(row.getAttribute('data-job-id'));
    if (!job) return type === 'number' ? -Infinity : '';

    switch (key) {
        case 'name': return (job.name || '').toLowerCase();
        case 'status': return (job.latest_status || '').toLowerCase();
        case 'errors':
        case 'total':
        case 'passed':
        case 'failed':
        case 'skipped': {
            const m = job.test_metrics || {};
            return hasUsableMetrics(m) ? safeMetric(m, key) : -1;
        }
        case 'exec_time': {
            if (!job.last_execution_time) return 0;
            const d = new Date(job.last_execution_time);
            return isNaN(d.getTime()) ? 0 : d.getTime();
        }
        case 'regression': {
            const pt = getPromotionTime();
            const rs = deriveRegressionStatus(job, pt);
            if (rs === 'failed') return 0;
            if (rs === 'not_executed') return 1;
            return 2;
        }
        default: return '';
    }
}

// Update the arrow indicators on column headers to match current sort state.
function syncSortHeaders() {
    document.querySelectorAll('th[data-sortable]').forEach(th => {
        th.removeAttribute('data-sort-dir');
        const icon = th.querySelector('.th-sort-icon');
        if (icon) icon.textContent = '⇅';
    });
    if (currentSortDir && currentSortKey) {
        const activeTh = document.querySelector(`th[data-sort-key="${currentSortKey}"]`);
        if (activeTh) {
            activeTh.setAttribute('data-sort-dir', currentSortDir);
            const icon = activeTh.querySelector('.th-sort-icon');
            if (icon) icon.textContent = currentSortDir === 'asc' ? '↑' : '↓';
        }
    }
}

// Reorder rows in the DOM by the current sort, keeping detail rows paired with their job rows.
function sortAndReorderRows(key, type) {
    const tbody = document.querySelector('#job-table tbody');
    if (!tbody) return;

    const rows = Array.from(tbody.querySelectorAll('tr[data-job-id]:not(.detail-row)'));

    if (!currentSortDir) {
        // No active sort — restore original insertion order.
        rows.sort((a, b) =>
            (parseInt(a.dataset.insertionOrder) || 0) - (parseInt(b.dataset.insertionOrder) || 0)
        );
    } else {
        const dir = currentSortDir === 'asc' ? 1 : -1;
        rows.sort((a, b) => {
            const va = getSortValue(a, key, type);
            const vb = getSortValue(b, key, type);
            if (type === 'number' || type === 'timestamp') return (va - vb) * dir;
            return va < vb ? -dir : va > vb ? dir : 0;
        });
    }

    // Map of detail rows for O(1) lookup as we re-insert paired pairs.
    const detailMap = new Map();
    tbody.querySelectorAll('tr.detail-row').forEach(dr => {
        detailMap.set(dr.getAttribute('data-job-id'), dr);
    });
    rows.forEach(row => {
        tbody.appendChild(row);
        const detailRow = detailMap.get(row.getAttribute('data-job-id') + '_detail');
        if (detailRow) tbody.appendChild(detailRow);
    });
}

// Header-click cycle: no sort → desc → asc → no sort.
function sortTable(key, type) {
    if (currentSortKey === key) {
        if (currentSortDir === 'desc') currentSortDir = 'asc';
        else if (currentSortDir === 'asc') { currentSortDir = null; currentSortKey = null; }
        else currentSortDir = 'desc';
    } else {
        currentSortKey = key;
        currentSortDir = 'desc';
    }

    syncSortHeaders();
    sortAndReorderRows(key, type);
}

// == HEADER CANVAS ANIMATION ==
// Decorative signal-flow animation in the header banner. Respects prefers-reduced-motion.
(function initHeaderCanvas() {
    const canvas = document.getElementById('header-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced) { canvas.style.display = 'none'; return; }

    let W, H, dpr, rafId = null, time = 0;

    // Particle pools.
    let hStrings = [];   // Horizontal signal strings.
    let vStrings = [];   // Vertical cascade strings.
    let arcStrings = []; // Arc connectors with travelling dots.
    let nodes = [];      // Network junction nodes.
    let pulses = [];     // Fast energy pulses.
    let waveBands = [];  // Slow ambient wave bands.

    function resize() {
        const rect = canvas.parentElement.getBoundingClientRect();
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        W = rect.width; H = rect.height;
        canvas.width = W * dpr; canvas.height = H * dpr;
        canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        initAll();
    }

    function mkHString(forceLeft) {
        const yBase = 4 + Math.random() * (H - 8);
        const goRight = forceLeft !== undefined ? forceLeft : Math.random() > 0.25;
        const speed = (0.25 + Math.random() * 0.55) * (goRight ? 1 : -1);
        const len = 60 + Math.random() * 220;
        const amp = 2 + Math.random() * 8;
        const freq = 0.002 + Math.random() * 0.007;
        const phase = Math.random() * Math.PI * 2;
        const hue = 210 + Math.random() * 50;
        const sat = 55 + Math.random() * 25;
        const lit = 58 + Math.random() * 18;
        const alpha = 0.06 + Math.random() * 0.14;
        const lw = 0.4 + Math.random() * 1.1;
        const dash = Math.random() > 0.7 ? [4 + Math.random() * 8, 3 + Math.random() * 6] : [];
        return {
            x: goRight ? (-len - Math.random() * W * 0.5) : (W + Math.random() * W * 0.5),
            yBase, speed, len, amp, freq, phase, hue, sat, lit, alpha, lw, dash
        };
    }

    function mkVString() {
        const xBase = 20 + Math.random() * (W - 40);
        const goDown = Math.random() > 0.4;
        const speed = (0.15 + Math.random() * 0.35) * (goDown ? 1 : -1);
        const len = 15 + Math.random() * 35;
        const amp = 1 + Math.random() * 3;
        const freq = 0.03 + Math.random() * 0.06;
        const hue = 230 + Math.random() * 30;
        const alpha = 0.05 + Math.random() * 0.1;
        const lw = 0.3 + Math.random() * 0.6;
        return {
            y: goDown ? (-len - Math.random() * 20) : (H + Math.random() * 20),
            xBase, speed, len, amp, freq, hue, alpha, lw,
            phase: Math.random() * Math.PI * 2
        };
    }

    function mkArcString() {
        const fromSide = Math.random() > 0.5;
        const x1 = fromSide ? (Math.random() * W * 0.3) : (W * 0.7 + Math.random() * W * 0.3);
        const x2 = fromSide ? (W * 0.5 + Math.random() * W * 0.5) : (Math.random() * W * 0.5);
        const y1 = Math.random() * H;
        const y2 = Math.random() * H;
        const cpx = (x1 + x2) / 2 + (Math.random() - 0.5) * 80;
        const cpy = Math.min(y1, y2) - 10 - Math.random() * 25;
        const hue = 220 + Math.random() * 35;
        const alpha = 0.04 + Math.random() * 0.07;
        const lw = 0.3 + Math.random() * 0.5;
        return {
            x1, y1, x2, y2, cpx, cpy, hue, alpha, lw,
            progress: 0,
            speed: 0.003 + Math.random() * 0.005,
            dotRadius: 1 + Math.random() * 1.5,
            dotAlpha: 0.2 + Math.random() * 0.25,
            alive: true
        };
    }

    function mkNode() {
        return {
            x: 30 + Math.random() * (W - 60),
            y: 6 + Math.random() * (H - 12),
            r: 0.5 + Math.random() * 0.9,
            pulseSpd: 0.004 + Math.random() * 0.012,
            pulseOff: Math.random() * Math.PI * 2,
            hue: 215 + Math.random() * 40,
            baseA: 0.12 + Math.random() * 0.2
        };
    }

    function mkPulse() {
        const goRight = Math.random() > 0.3;
        const yB = 6 + Math.random() * (H - 12);
        return {
            x: goRight ? -10 : W + 10,
            yBase: yB, y: yB,
            speed: (1 + Math.random() * 1.8) * (goRight ? 1 : -1),
            r: 1.2 + Math.random() * 1.8,
            hue: 215 + Math.random() * 35,
            alpha: 0.25 + Math.random() * 0.2,
            amp: 1.5 + Math.random() * 4,
            freq: 0.006 + Math.random() * 0.012
        };
    }

    function mkWaveBand() {
        return {
            yBase: Math.random() * H,
            amp: 3 + Math.random() * 6,
            freq: 0.0015 + Math.random() * 0.003,
            speed: 0.002 + Math.random() * 0.004,
            phase: Math.random() * Math.PI * 2,
            hue: 218 + Math.random() * 30,
            alpha: 0.02 + Math.random() * 0.03,
            lw: 0.8 + Math.random() * 1.2
        };
    }

    function initAll() {
        const hCount = Math.max(10, Math.floor(W / 80));
        const vCount = Math.max(3, Math.floor(W / 300));
        const arcCount = Math.max(2, Math.floor(W / 400));
        const nodeCount = Math.max(5, Math.floor(W / 160));
        const waveCount = Math.max(3, Math.floor(W / 250));

        hStrings = []; vStrings = []; arcStrings = [];
        nodes = []; pulses = []; waveBands = [];

        for (let i = 0; i < hCount; i++) hStrings.push(mkHString());
        for (let i = 0; i < vCount; i++) vStrings.push(mkVString());
        for (let i = 0; i < arcCount; i++) arcStrings.push(mkArcString());
        for (let i = 0; i < nodeCount; i++) nodes.push(mkNode());
        for (let i = 0; i < waveCount; i++) waveBands.push(mkWaveBand());
    }

    function draw() {
        ctx.clearRect(0, 0, W, H);
        time++;

        // Layer 0: ambient wave bands.
        for (const wb of waveBands) {
            ctx.beginPath();
            ctx.lineWidth = wb.lw;
            ctx.strokeStyle = 'hsla(' + wb.hue + ', 50%, 60%, ' + wb.alpha + ')';
            for (let x = 0; x <= W; x += 6) {
                const y = wb.yBase + Math.sin(x * wb.freq + time * wb.speed + wb.phase) * wb.amp
                        + Math.sin(x * wb.freq * 2.3 + time * wb.speed * 0.7) * (wb.amp * 0.4);
                if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.stroke();
        }

        // Layer 1: node connection mesh.
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const dx = nodes[i].x - nodes[j].x;
                const dy = nodes[i].y - nodes[j].y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 140) {
                    const a = (1 - dist / 140) * 0.05;
                    ctx.beginPath();
                    ctx.moveTo(nodes[i].x, nodes[i].y);
                    ctx.lineTo(nodes[j].x, nodes[j].y);
                    ctx.strokeStyle = 'hsla(225, 50%, 65%, ' + a + ')';
                    ctx.lineWidth = 0.4;
                    ctx.stroke();
                }
            }
        }

        // Layer 2: horizontal signal strings.
        for (let i = hStrings.length - 1; i >= 0; i--) {
            const s = hStrings[i];
            s.x += s.speed;

            const headX = s.speed > 0 ? s.x + s.len : s.x;
            const tailX = s.speed > 0 ? s.x : s.x + s.len;

            if ((s.speed > 0 && tailX > W + 30) || (s.speed < 0 && headX < -30)) {
                hStrings[i] = mkHString(s.speed > 0);
                continue;
            }

            ctx.save();
            if (s.dash.length) ctx.setLineDash(s.dash);
            ctx.beginPath();
            ctx.lineWidth = s.lw;
            ctx.lineCap = 'round';

            const drawStart = Math.max(0, Math.min(tailX, headX));
            const drawEnd = Math.min(W, Math.max(tailX, headX));
            if (drawEnd > drawStart) {
                const segs = Math.max(3, Math.floor((drawEnd - drawStart) / 3));
                for (let k = 0; k <= segs; k++) {
                    const px = drawStart + (drawEnd - drawStart) * (k / segs);
                    const py = s.yBase + Math.sin(px * s.freq + s.phase + time * 0.007) * s.amp;
                    if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
                }

                const grd = ctx.createLinearGradient(
                    s.speed > 0 ? drawStart : drawEnd, 0,
                    s.speed > 0 ? drawEnd : drawStart, 0
                );
                grd.addColorStop(0, 'hsla(' + s.hue + ', ' + s.sat + '%, ' + s.lit + '%, 0)');
                grd.addColorStop(0.3, 'hsla(' + s.hue + ', ' + s.sat + '%, ' + s.lit + '%, ' + (s.alpha * 0.6) + ')');
                grd.addColorStop(1, 'hsla(' + s.hue + ', ' + s.sat + '%, ' + s.lit + '%, ' + s.alpha + ')');
                ctx.strokeStyle = grd;
                ctx.stroke();
            }
            ctx.restore();

            const hx = Math.max(0, Math.min(W, headX));
            const hy = s.yBase + Math.sin(hx * s.freq + s.phase + time * 0.007) * s.amp;
            if (hx > 0 && hx < W) {
                const gr = ctx.createRadialGradient(hx, hy, 0, hx, hy, 5);
                gr.addColorStop(0, 'hsla(' + s.hue + ', 80%, 75%, ' + (s.alpha * 2.5) + ')');
                gr.addColorStop(1, 'hsla(' + s.hue + ', 80%, 75%, 0)');
                ctx.fillStyle = gr;
                ctx.beginPath();
                ctx.arc(hx, hy, 5, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // Layer 3: vertical cascade strings.
        for (let i = vStrings.length - 1; i >= 0; i--) {
            const v = vStrings[i];
            v.y += v.speed;

            const headY = v.speed > 0 ? v.y + v.len : v.y;
            const tailY = v.speed > 0 ? v.y : v.y + v.len;

            if ((v.speed > 0 && tailY > H + 10) || (v.speed < 0 && headY < -10)) {
                vStrings[i] = mkVString();
                continue;
            }

            ctx.beginPath();
            ctx.lineWidth = v.lw;
            ctx.lineCap = 'round';
            ctx.strokeStyle = 'hsla(' + v.hue + ', 55%, 65%, ' + v.alpha + ')';

            const dy0 = Math.max(0, Math.min(tailY, headY));
            const dy1 = Math.min(H, Math.max(tailY, headY));
            if (dy1 > dy0) {
                const segs = Math.max(2, Math.floor((dy1 - dy0) / 3));
                for (let k = 0; k <= segs; k++) {
                    const py = dy0 + (dy1 - dy0) * (k / segs);
                    const px = v.xBase + Math.sin(py * v.freq + v.phase + time * 0.006) * v.amp;
                    if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
                }
                ctx.stroke();
            }

            const chy = Math.max(0, Math.min(H, headY));
            const chx = v.xBase + Math.sin(chy * v.freq + v.phase + time * 0.006) * v.amp;
            if (chy > 0 && chy < H) {
                ctx.beginPath();
                ctx.arc(chx, chy, 2.5, 0, Math.PI * 2);
                ctx.fillStyle = 'hsla(' + v.hue + ', 70%, 75%, ' + (v.alpha * 2) + ')';
                ctx.fill();
            }
        }

        // Layer 4: arc connectors with travelling dots.
        for (let i = arcStrings.length - 1; i >= 0; i--) {
            const a = arcStrings[i];
            a.progress += a.speed;

            if (a.progress > 1.3) {
                arcStrings[i] = mkArcString();
                continue;
            }

            ctx.beginPath();
            ctx.moveTo(a.x1, a.y1);
            ctx.quadraticCurveTo(a.cpx, a.cpy, a.x2, a.y2);
            ctx.strokeStyle = 'hsla(' + a.hue + ', 50%, 60%, ' + a.alpha + ')';
            ctx.lineWidth = a.lw;
            ctx.stroke();

            if (a.progress >= 0 && a.progress <= 1) {
                const t = a.progress;
                const mt = 1 - t;
                const dx = mt * mt * a.x1 + 2 * mt * t * a.cpx + t * t * a.x2;
                const dy = mt * mt * a.y1 + 2 * mt * t * a.cpy + t * t * a.y2;
                const gr = ctx.createRadialGradient(dx, dy, 0, dx, dy, a.dotRadius * 4);
                gr.addColorStop(0, 'hsla(' + a.hue + ', 80%, 78%, ' + a.dotAlpha + ')');
                gr.addColorStop(1, 'hsla(' + a.hue + ', 80%, 78%, 0)');
                ctx.fillStyle = gr;
                ctx.beginPath();
                ctx.arc(dx, dy, a.dotRadius * 4, 0, Math.PI * 2);
                ctx.fill();
                ctx.beginPath();
                ctx.arc(dx, dy, a.dotRadius, 0, Math.PI * 2);
                ctx.fillStyle = 'hsla(' + a.hue + ', 90%, 85%, ' + (a.dotAlpha * 1.5) + ')';
                ctx.fill();
            }
        }

        // Layer 5: pulsing network nodes.
        for (const n of nodes) {
            const pulse = Math.sin(time * n.pulseSpd + n.pulseOff);
            const a = n.baseA + pulse * 0.1;
            const r = n.r + pulse * 0.3;
            ctx.beginPath();
            ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
            ctx.fillStyle = 'hsla(' + n.hue + ', 60%, 70%, ' + Math.max(0, a) + ')';
            ctx.fill();
            if (a > 0.18) {
                ctx.beginPath();
                ctx.arc(n.x, n.y, r + 4, 0, Math.PI * 2);
                ctx.fillStyle = 'hsla(' + n.hue + ', 60%, 70%, ' + (a * 0.12) + ')';
                ctx.fill();
            }
        }

        // Layer 6: bright energy pulses.
        for (let i = pulses.length - 1; i >= 0; i--) {
            const p = pulses[i];
            p.x += p.speed;
            p.y = p.yBase + Math.sin(p.x * p.freq + time * 0.01) * p.amp;

            if ((p.speed > 0 && p.x > W + 20) || (p.speed < 0 && p.x < -20)) {
                pulses.splice(i, 1);
                continue;
            }

            const gr = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 5);
            gr.addColorStop(0, 'hsla(' + p.hue + ', 85%, 80%, ' + p.alpha + ')');
            gr.addColorStop(0.35, 'hsla(' + p.hue + ', 80%, 70%, ' + (p.alpha * 0.25) + ')');
            gr.addColorStop(1, 'hsla(' + p.hue + ', 80%, 70%, 0)');
            ctx.fillStyle = gr;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r * 5, 0, Math.PI * 2);
            ctx.fill();

            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fillStyle = 'hsla(' + p.hue + ', 92%, 88%, ' + Math.min(1, p.alpha * 1.4) + ')';
            ctx.fill();

            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x - p.speed * 8, p.y);
            ctx.strokeStyle = 'hsla(' + p.hue + ', 80%, 75%, ' + (p.alpha * 0.3) + ')';
            ctx.lineWidth = p.r * 0.6;
            ctx.lineCap = 'round';
            ctx.stroke();
        }

        // Spawn pulses periodically to keep a steady flow.
        if (time % 120 === 0 && pulses.length < 4) pulses.push(mkPulse());
        if (time % 200 === 100 && pulses.length < 4) pulses.push(mkPulse());

        rafId = requestAnimationFrame(draw);
    }

    resize();
    draw();

    // Debounce resize so we don't redraw on every pixel change.
    let resizeTimer;
    window.addEventListener('resize', function() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(resize, 200);
    });

    // Pause the animation while the tab is hidden (battery / CPU).
    document.addEventListener('visibilitychange', function() {
        if (document.hidden) {
            if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        } else {
            if (!rafId) draw();
        }
    });
})();

// == SCROLL-TRIGGERED ANIMATIONS ==
let _scrollRowObserver = null;

// Thead shadow on scroll, plus row scroll-reveal via IntersectionObserver.
function initScrollAnimations() {
    const tableContainer = document.querySelector('.table-container');
    const thead = document.querySelector('#job-table thead');
    if (!tableContainer || !thead) return;

    tableContainer.addEventListener('scroll', function() {
        if (tableContainer.scrollTop > 4) {
            thead.classList.add('thead-scrolled');
        } else {
            thead.classList.remove('thead-scrolled');
        }
    }, { passive: true });

    if ('IntersectionObserver' in window) {
        _scrollRowObserver = new IntersectionObserver(function(entries) {
            entries.forEach(function(entry) {
                if (entry.isIntersecting) {
                    const row = entry.target;
                    row.classList.remove('scroll-hidden');
                    row.classList.add('scroll-reveal');
                    _scrollRowObserver.unobserve(row);
                }
            });
        }, {
            root: tableContainer,
            rootMargin: '50px 0px',
            threshold: 0.05
        });
    }
}


function observeRowForScroll(_row) {
    return;
}

// == COLUMN RESIZING ==
// Drag the right edge of any resizable header to resize the column.
function initColumnResizing() {
    document.querySelectorAll('th[data-resizable]').forEach(th => {
        const handle = document.createElement('div');
        handle.className = 'col-resize-handle';
        th.appendChild(handle);

        let startX, startWidth;
        const minW = parseInt(getComputedStyle(th).minWidth) || 100;
        const maxW = parseInt(getComputedStyle(th).maxWidth) || 500;

        handle.addEventListener('mousedown', function(e) {
            e.preventDefault();
            e.stopPropagation();
            startX = e.pageX;
            startWidth = th.offsetWidth;
            handle.classList.add('active');

            function onMouseMove(e) {
                const newWidth = Math.min(maxW, Math.max(minW, startWidth + (e.pageX - startX)));
                th.style.width = newWidth + 'px';
            }
            function onMouseUp() {
                handle.classList.remove('active');
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            }
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    });
}

// Wire table interactivity once the DOM is ready.
document.addEventListener('DOMContentLoaded', function() {
    document.querySelectorAll('th[data-sortable]').forEach(th => {
        th.addEventListener('click', function(e) {
            // Clicks on the resize handle shouldn't trigger a sort.
            if (e.target.classList.contains('col-resize-handle')) return;
            sortTable(this.dataset.sortKey, this.dataset.sortType);
        });
    });
    initColumnResizing();
    initScrollAnimations();

    // Mark the promotion state pending when the user edits the datetime input.
    const promoInput = document.getElementById('promotion-datetime');
    if (promoInput) {
        promoInput.addEventListener('change', markPromoPending);
        promoInput.addEventListener('input', markPromoPending);
    }
});

// Debounce typed search at 80ms so it feels live, but apply an EMPTY input instantly
// so clearing the box restores the full table without lag.
let _searchDebounce = null;
function debouncedApplyFilters() {
    clearTimeout(_searchDebounce);
    const searchEl = document.getElementById('filter-search');
    if (searchEl && searchEl.value === '') {
        applyFilters();
        return;
    }
    _searchDebounce = setTimeout(() => applyFilters(), 80);
}

// == LOG ANALYSIS FILTER — searchable autocomplete ==
// Unique labels across the loaded jobs, sorted by frequency desc.
function collectLogAnalysisLabels() {
    var labelMap = {};
    appState.jobs.forEach(function(job) {
        var cls = job.classification;
        if (!cls) return;
        var entries = [];
        if (cls.all_labels && cls.all_labels.length > 0) {
            entries = cls.all_labels;
        } else if (cls.label) {
            entries = [{ label: cls.label, domain: cls.primary_domain || 'Unknown' }];
        }
        entries.forEach(function(e) {
            if (!labelMap[e.label]) {
                labelMap[e.label] = { label: e.label, domain: e.domain, color: _domainColorMap[e.domain] || 'gray', count: 0 };
            }
            labelMap[e.label].count++;
        });
    });
    return Object.values(labelMap).sort(function(a, b) { return b.count - a.count; });
}

// Label cache; rebuilt whenever the dataset changes.
var _laLabelCache = [];

function rebuildLogAnalysisLabelCache() {
    _laLabelCache = collectLogAnalysisLabels();
}

// Reveal the log-analysis filter (Detail mode only).
function showLogAnalysisFilter() {
    var wrap = document.getElementById('la-filter-wrap');
    if (wrap) {
        rebuildLogAnalysisLabelCache();
        wrap.style.display = 'inline-flex';
    }
}

// Hide and clear the log-analysis filter (Detail → Summary switch).
function hideLogAnalysisFilter() {
    var wrap = document.getElementById('la-filter-wrap');
    if (wrap) wrap.style.display = 'none';
    var hadActive = (appState.filters.logAnalysisLabels || []).length > 0;
    clearLogAnalysisFilter();
    if (hadActive) {
        applyFilters();
    }
}

// Clear every selected log-analysis label (multi-select).
function clearLogAnalysisFilter() {
    var input = document.getElementById('la-filter-input');
    var clearBtn = document.getElementById('la-filter-clear');
    if (input) {
        input.value = '';
        input.classList.remove('la-has-value');
    }
    if (clearBtn) clearBtn.style.display = 'none';
    closeLogAnalysisDropdown();
    appState.filters.logAnalysisLabels = [];
    updateSelectedLabelBadge();
}


function updateSelectedLabelBadge() {
    var badge = document.getElementById('la-filter-count');
    var input = document.getElementById('la-filter-input');
    var labels = appState.filters.logAnalysisLabels || [];
    if (!badge) return;
    if (labels.length === 0) {
        badge.style.display = 'none';
        badge.textContent = '';
        badge.title = '';
        if (input) input.classList.remove('la-has-value');
        return;
    }
    badge.style.display = 'inline-block';
    badge.textContent = String(labels.length);
    badge.title = 'Filtering by ' + labels.length + ' label' + (labels.length === 1 ? '' : 's') + ':\n• ' + labels.join('\n• ');
    if (input) input.classList.add('la-has-value');
}

// Open the autocomplete dropdown filtered by `query`.
function openLogAnalysisDropdown(query) {
    var dropdown = document.getElementById('la-dropdown');
    if (!dropdown) return;
    var q = (query || '').toLowerCase().trim();
    var matches = _laLabelCache.filter(function(item) {
        return q.length === 0 || item.label.toLowerCase().indexOf(q) !== -1;
    });

    if (matches.length === 0) {
        dropdown.innerHTML = '<div class="la-dropdown-empty">No matching labels</div>';
    } else {
        // Build items, highlighting the matched substring inside each label.
        var selected = appState.filters.logAnalysisLabels || [];
        dropdown.innerHTML = matches.map(function(item, idx) {
            var hex = _dotHexMap[item.color] || '#94A3B8';
            var display = escapeHtml(item.label);
            if (q.length > 0) {
                var lowerDisplay = item.label.toLowerCase();
                var matchIdx = lowerDisplay.indexOf(q);
                if (matchIdx !== -1) {
                    var before = escapeHtml(item.label.substring(0, matchIdx));
                    var match = escapeHtml(item.label.substring(matchIdx, matchIdx + q.length));
                    var after = escapeHtml(item.label.substring(matchIdx + q.length));
                    display = before + '<span class="la-dropdown-match">' + match + '</span>' + after;
                }
            }
            var isSel = selected.indexOf(item.label) !== -1;
            var cls = 'la-dropdown-item' + (idx === 0 ? ' la-item-active' : '') + (isSel ? ' la-item-selected' : '');
            var check = isSel ? '<span class="la-item-check" aria-hidden="true">✓</span>' : '<span class="la-item-check" aria-hidden="true"></span>';
            return '<div class="' + cls + '" data-label="' + escapeHtml(item.label) + '" data-index="' + idx + '">'
                 + check
                 + '<span class="la-dropdown-item-dot" style="background:' + hex + '"></span>'
                 + '<span style="overflow:hidden;text-overflow:ellipsis">' + display + '</span>'
                 + '<span class="la-dropdown-item-count">' + item.count + '</span>'
                 + '</div>';
        }).join('');
    }
    dropdown.classList.add('la-dropdown-open');
    _laActiveIndex = matches.length > 0 ? 0 : -1;
    _laVisibleItems = matches;
}

function closeLogAnalysisDropdown() {
    var dropdown = document.getElementById('la-dropdown');
    if (dropdown) dropdown.classList.remove('la-dropdown-open');
    _laActiveIndex = -1;
    _laVisibleItems = [];
}

// Toggle one label in/out of the multi-select filter.
function selectLogAnalysisLabel(label) {
    var input = document.getElementById('la-filter-input');
    var clearBtn = document.getElementById('la-filter-clear');
    var labels = appState.filters.logAnalysisLabels || [];
    var idx = labels.indexOf(label);
    if (idx === -1) {
        labels.push(label);
    } else {
        labels.splice(idx, 1);
    }
    appState.filters.logAnalysisLabels = labels;

    // Clear any typed search so the dropdown shows all labels — the user is in "pick several" mode now.
    if (input) {
        input.value = '';
        input.classList.toggle('la-has-value', labels.length > 0);
    }
    if (clearBtn) clearBtn.style.display = labels.length > 0 ? 'flex' : 'none';

    updateSelectedLabelBadge();
    // Re-open so the user sees the updated check marks.
    openLogAnalysisDropdown('');
    applyFilters();
}

// Keyboard navigation state for the dropdown.
var _laActiveIndex = -1;
var _laVisibleItems = [];

(function initLogAnalysisFilter() {
    document.addEventListener('DOMContentLoaded', function() {
        var input = document.getElementById('la-filter-input');
        var clearBtn = document.getElementById('la-filter-clear');
        var dropdown = document.getElementById('la-dropdown');
        if (!input || !dropdown) return;

        input.addEventListener('focus', function() {
            rebuildLogAnalysisLabelCache();
            openLogAnalysisDropdown(input.value);
        });

        // Typing only filters the dropdown — it does NOT clear selected labels.
        // Removing labels is done via the X button or a chip click.
        input.addEventListener('input', function() {
            openLogAnalysisDropdown(input.value);
        });

        input.addEventListener('keydown', function(e) {
            if (!dropdown.classList.contains('la-dropdown-open')) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    openLogAnalysisDropdown(input.value);
                    e.preventDefault();
                }
                return;
            }
            var items = dropdown.querySelectorAll('.la-dropdown-item');
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                _laActiveIndex = Math.min(_laActiveIndex + 1, items.length - 1);
                updateLaActiveItem(items);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                _laActiveIndex = Math.max(_laActiveIndex - 1, 0);
                updateLaActiveItem(items);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (_laActiveIndex >= 0 && _laActiveIndex < items.length) {
                    selectLogAnalysisLabel(items[_laActiveIndex].getAttribute('data-label'));
                }
            } else if (e.key === 'Escape') {
                closeLogAnalysisDropdown();
                input.blur();
            }
        });

        dropdown.addEventListener('mousedown', function(e) {
            e.preventDefault(); // Keep the input focused.
            var item = e.target.closest('.la-dropdown-item');
            if (item) {
                selectLogAnalysisLabel(item.getAttribute('data-label'));
            }
        });

        // Sync the keyboard highlight with mouse hover.
        dropdown.addEventListener('mouseover', function(e) {
            var item = e.target.closest('.la-dropdown-item');
            if (item) {
                var items = dropdown.querySelectorAll('.la-dropdown-item');
                items.forEach(function(el) { el.classList.remove('la-item-active'); });
                item.classList.add('la-item-active');
                _laActiveIndex = parseInt(item.getAttribute('data-index'), 10);
            }
        });

        // Brief delay on blur so click events on dropdown items still fire.
        input.addEventListener('blur', function() {
            setTimeout(function() { closeLogAnalysisDropdown(); }, 150);
        });


        clearBtn.addEventListener('mousedown', function(e) {
            e.preventDefault();
            clearLogAnalysisFilter();
            applyFilters();

            input.focus();
            rebuildLogAnalysisLabelCache();
            openLogAnalysisDropdown('');
        });

    });
})();

function updateLaActiveItem(items) {
    items.forEach(function(el, idx) {
        if (idx === _laActiveIndex) {
            el.classList.add('la-item-active');
            el.scrollIntoView({ block: 'nearest' });
        } else {
            el.classList.remove('la-item-active');
        }
    });
}

//  Release-status filter — populated from actual data ─
// The dropdown only shows buckets that exist in the current dataset, so the
// user never picks a value that yields an empty table. Canonical order is
// workflow order (PASS → PENDING → FAIL → NA), with unknown future values
// appended in insertion order (forward-compat).

const _RELEASE_STATUS_ORDER = ['PASS', 'PENDING', 'FAIL', 'NA'];
const _RELEASE_STATUS_LABEL = {
    PASS: 'Pass',
    PENDING: 'Pending',
    FAIL: 'Fail',
    NA: 'Not Applicable',
};
let _lastReleaseStatusFingerprint = '';

function populateReleaseStatusFilter() {
    const sel = document.getElementById('filter-release-status');
    if (!sel) return;

    const present = new Set();
    if (window.appState && appState.jobs) {
        appState.jobs.forEach(job => {
            const rs = job && job.release_status;
            if (rs) present.add(rs);
        });
    }

    // Skip the rebuild if the set of available release statuses hasn't changed —
    // stops the dropdown flickering while jobs stream in.
    const fingerprint = Array.from(present).sort().join('|');
    if (fingerprint === _lastReleaseStatusFingerprint) return;
    _lastReleaseStatusFingerprint = fingerprint;

    // Remember the previous pick so we can restore it (or fall back to "All").
    const prevValue = sel.value;

    sel.innerHTML = '<option value="">All Release Status</option>';

    for (const status of _RELEASE_STATUS_ORDER) {
        if (!present.has(status)) continue;
        const opt = document.createElement('option');
        opt.value = status;
        opt.textContent = _RELEASE_STATUS_LABEL[status];
        sel.appendChild(opt);
    }
    // Forward-compat: any unrecognised backend values after the canonical list.
    for (const status of present) {
        if (_RELEASE_STATUS_ORDER.indexOf(status) !== -1) continue;
        const opt = document.createElement('option');
        opt.value = status;
        opt.textContent = status;
        sel.appendChild(opt);
    }

    // Restore prior pick if still valid; otherwise reset to "All" and clear filter state.
    if (prevValue && present.has(prevValue)) {
        sel.value = prevValue;
    } else {
        sel.value = '';
        if (window.appState && appState.filters) appState.filters.releaseStatus = null;
    }
}


//  Clear-filters button — active-count + disabled state
function updateClearFiltersButton() {
    if (typeof updateScopeIndicator === 'function') updateScopeIndicator();
    const btn = document.getElementById('btn-clear-filters');
    if (!btn) return;
    const f = (window.appState && appState.filters) || {};
    let n = 0;
    if (f.status)                                       n++;
    if (f.releaseStatus)                                n++;
    if (f.searchText && f.searchText.trim().length > 0) n++;
    if (Array.isArray(f.logAnalysisLabels) && f.logAnalysisLabels.length > 0) n++;
    // Selection counts as one bucket (not N rows) so the badge stays a small integer.
    if (window.appState && appState.selectedJobs && appState.selectedJobs.size > 0) n++;

    // Hide the button entirely when there's nothing to clear — avoids a
    // dim orphan pill in the toolbar row.
    btn.disabled = (n === 0);
    btn.hidden = (n === 0);

    const badge = document.getElementById('clear-filter-count');
    if (badge) {
        if (n > 0) { badge.textContent = String(n); badge.hidden = false; }
        else       { badge.hidden = true; }
    }
}


// Filters apply immediately — the previous deferred approach caused a
// noticeable blank-table flicker. Overlay helpers kept in case a future
// slow filter needs them.
function showTableOverlay() {
    const el = document.getElementById('table-overlay');
    if (el) { el.classList.add('is-visible'); el.setAttribute('aria-hidden', 'false'); }
}
function hideTableOverlay() {
    const el = document.getElementById('table-overlay');
    if (el) { el.classList.remove('is-visible'); el.setAttribute('aria-hidden', 'true'); }
}
function withTableLoading(work) {
    work();
}

function applyFilters() {
    withTableLoading(_applyFiltersImpl);
}

function _applyFiltersImpl() {
    appState.filters.status = document.getElementById('filter-status').value || null;

    var rawSearch = document.getElementById('filter-search').value || '';
    appState.filters.searchText = rawSearch.toLowerCase();
    appState.filters._searchRe = null;
    if (rawSearch.trim().length > 0) {
        // Wildcard-aware search:
        //   - `*` or `?` in pattern → glob, anchored, case-insensitive
        //     (e.g. `*-api-*`, `prp1-*-failure`).
        //   - Otherwise → plain case-insensitive substring (fallback below).
        // We deliberately don't parse arbitrary regex; users typing `(` or `+`
        // would otherwise get surprise matches.
        const trimmed = rawSearch.trim();
        if (/[*?]/.test(trimmed)) {
            try {
                // Escape regex specials except `*` / `?`, then translate the
                // wildcards. Anchored ^...$ — wildcard semantics are full-name.
                const escaped = trimmed
                    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                    .replace(/\*/g, '.*')
                    .replace(/\?/g, '.');
                appState.filters._searchRe = new RegExp('^' + escaped + '$', 'i');
            } catch (e) {
                // Should not happen post-escape; fall back to substring search.
                appState.filters._searchRe = null;
            }
        }
    }

    // Release Status filter — only meaningful when the column is visible (promotion active).
    var releaseSel = document.getElementById('filter-release-status');
    appState.filters.releaseStatus = (releaseSel && releaseSel.value) ? releaseSel.value : null;

    const rows = Array.from(document.querySelectorAll('tbody tr[data-job-id]:not(.detail-row)'));
    rows.forEach(row => {
        const jobId = row.getAttribute('data-job-id');
        const job = appState.jobs.get(jobId);

        if (!job) {
            row.style.display = 'none';
            return;
        }

        const visible = matchesFilters(job);
        row.style.display = visible ? '' : 'none';

        const detailRow = document.querySelector(`tr[data-job-id="${escapeHtml(jobId)}_detail"]`);
        if (detailRow) {
            detailRow.style.display = visible ? '' : 'none';
        }
    });

    reapplyCurrentSort();
    updateToolbarActions();

    // Keep select-all in sync with the current visible row set.
    const allCheckbox = document.getElementById('select-all-checkbox');
    if (allCheckbox) {
        const visibleCbs = Array.from(document.querySelectorAll(
            'tbody tr[data-job-id]:not(.detail-row):not([style*="display: none"]) input[type="checkbox"]'
        ));
        allCheckbox.checked = visibleCbs.length > 0 && visibleCbs.every(cb => cb.checked);
    }

    updateEmptyState();
    updateClearFiltersButton();
}

// Does the job pass every active filter?
function matchesFilters(job) {
    if (appState.filters.status && job.latest_status !== appState.filters.status) return false;

    if (appState.filters.releaseStatus && job.release_status !== appState.filters.releaseStatus) return false;

    if (appState.filters.searchText) {
        // Defensive `|| ''` — a single missing name/url would otherwise throw
        // and abort the entire filter pass, making search look broken everywhere.
        const name = (job.name || '').toString();
        const url  = (job.url  || '').toString();
        const re = appState.filters._searchRe;
        if (re) {
            // Wildcard regex path — test raw name/url so the ^...$ anchors work.
            if (!re.test(name) && !re.test(url)) return false;
        } else {
            // Plain case-insensitive substring fallback.
            const searchText = appState.filters.searchText;
            if (!name.toLowerCase().includes(searchText) && !url.toLowerCase().includes(searchText)) {
                return false;
            }
        }
    }

    // Log Analysis label filter (Detail mode only).
    const selLabels = appState.filters.logAnalysisLabels || [];
    if (selLabels.length > 0) {
        const cls = job.classification;
        if (!cls) return false;
        let hit = false;
        if (cls.all_labels && cls.all_labels.length > 0) {
            hit = cls.all_labels.some(function(e) { return selLabels.indexOf(e.label) !== -1; });
        } else if (cls.label) {
            hit = selLabels.indexOf(cls.label) !== -1;
        }
        if (!hit) return false;
    }

    return true;
}

// Re-sort the table without flipping direction; called after filter changes.
function reapplyCurrentSort() {
    if (!currentSortKey || !currentSortDir) return;
    const th = document.querySelector(`th[data-sort-key="${currentSortKey}"]`);
    const type = th ? (th.dataset.sortType || 'string') : 'string';
    sortAndReorderRows(currentSortKey, type);
}

// == SELECTION & EXPANSION ==
// Toggle every currently-visible job row.
function toggleSelectAll(checked) {
    const checkboxes = document.querySelectorAll('tbody tr[data-job-id]:not(.detail-row) input[type="checkbox"]');
    checkboxes.forEach(cb => {
        const row = cb.closest('tr');
        // Only touch visible (un-filtered) rows.
        if (row.style.display === 'none') return;
        cb.checked = checked;
        const jobId = row.getAttribute('data-job-id');
        if (checked) {
            appState.selectedJobs.add(jobId);
        } else {
            appState.selectedJobs.delete(jobId);
        }
    });
    updateToolbarActions();
    updateClearFiltersButton();
}

// Toggle one job and reconcile the select-all checkbox state.
function toggleJobSelection(jobId) {
    if (appState.selectedJobs.has(jobId)) {
        appState.selectedJobs.delete(jobId);
    } else {
        appState.selectedJobs.add(jobId);
    }

    const allCheckbox = document.getElementById('select-all-checkbox');
    // "Select all" state considers visible rows only.
    const visibleCheckboxes = Array.from(document.querySelectorAll('tbody tr[data-job-id]:not(.detail-row):not([style*="display: none"]) input[type="checkbox"]'));
    allCheckbox.checked = visibleCheckboxes.length > 0 && visibleCheckboxes.every(cb => cb.checked);
    updateToolbarActions();
    updateClearFiltersButton();
}

// Expand or collapse a job's detail row.
function toggleRowExpansion(jobId) {
    const job = appState.jobs.get(jobId);
    if (!job) return;

    if (appState.expandedRows.has(jobId)) {
        appState.expandedRows.delete(jobId);
        const detailRow = document.querySelector(`tr[data-job-id="${escapeHtml(jobId)}_detail"]`);
        if (detailRow) detailRow.remove();
        const row = document.querySelector(`tr[data-job-id="${escapeHtml(jobId)}"]`);
        if (row) row.classList.remove('expanded');
    } else {
        appState.expandedRows.add(jobId);
        const row = document.querySelector(`tr[data-job-id="${escapeHtml(jobId)}"]`);
        if (row) {
            row.classList.add('expanded');
            const detailRow = renderExpandedDetail(job);
            row.after(detailRow);
        }
    }
}
