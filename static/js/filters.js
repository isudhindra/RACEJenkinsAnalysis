// Jenkins Dashboard filters module: table sorting, animated header canvas, scroll animations, column resizing, and autocomplete-based log analysis filtering
'use strict';

// ========== TABLE SORTING ==========
// Track the current sort column and direction for the job table
let currentSortKey = null;
let currentSortDir = null; // 'asc' | 'desc' | null

// Extract the sortable value from a job row based on the key and type, handling different data types appropriately
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

// Update the sort direction indicators (up/down arrows) on table headers to show which column is currently sorted
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

// Sort the table rows by a given column and move them in the DOM, keeping detail rows paired with their job rows
function sortAndReorderRows(key, type) {
    const tbody = document.querySelector('#job-table tbody');
    if (!tbody) return;

    const rows = Array.from(tbody.querySelectorAll('tr[data-job-id]:not(.detail-row)'));

    if (!currentSortDir) {
        // No active sort, restore insertion order
        rows.sort((a, b) =>
            (parseInt(a.dataset.insertionOrder) || 0) - (parseInt(b.dataset.insertionOrder) || 0)
        );
    } else {
        // Apply sort in the current direction
        const dir = currentSortDir === 'asc' ? 1 : -1;
        rows.sort((a, b) => {
            const va = getSortValue(a, key, type);
            const vb = getSortValue(b, key, type);
            if (type === 'number' || type === 'timestamp') return (va - vb) * dir;
            return va < vb ? -dir : va > vb ? dir : 0;
        });
    }

    // Pre-collect detail rows into a Map for O(1) lookup
    const detailMap = new Map();
    tbody.querySelectorAll('tr.detail-row').forEach(dr => {
        detailMap.set(dr.getAttribute('data-job-id'), dr);
    });
    // Reinsert rows in sorted order, keeping detail rows below their job rows
    rows.forEach(row => {
        tbody.appendChild(row);
        const detailRow = detailMap.get(row.getAttribute('data-job-id') + '_detail');
        if (detailRow) tbody.appendChild(detailRow);
    });
}

// Toggle the sort direction when a header is clicked: no sort → descending → ascending → no sort
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

// ========== HEADER CANVAS ANIMATION — Signal Flow System ==========
// Create an animated network visualization in the header using canvas with particles and wave patterns
(function initHeaderCanvas() {
    const canvas = document.getElementById('header-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Respect user's motion preference and hide animation if reduced motion is requested
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced) { canvas.style.display = 'none'; return; }

    let W, H, dpr, rafId = null, time = 0;

    // Particle pools for different animation elements
    let hStrings = [];   // Horizontal signal strings
    let vStrings = [];   // Vertical cascade strings
    let arcStrings = []; // Arc connector strings
    let nodes = [];      // Network junction nodes
    let pulses = [];     // Fast energy pulses
    let waveBands = [];  // Slow ambient wave bands

    // Resize the canvas when the window or parent container changes size
    function resize() {
        const rect = canvas.parentElement.getBoundingClientRect();
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        W = rect.width; H = rect.height;
        canvas.width = W * dpr; canvas.height = H * dpr;
        canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        initAll();
    }

    // Create a horizontal signal string: a wavy line that moves left or right across the canvas
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

    // Create a vertical cascade string: a wavy line that moves up or down through the canvas
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

    // Create an arc connector: a curved path with a travelling dot that represents data flow
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

    // Create a network node: a small pulsing dot that connects to nearby nodes
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

    // Create an energy pulse: a bright moving orb that travels horizontally
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

    // Create a wave band: slow, undulating bands in the background
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

    // Initialize all particle pools with appropriate counts based on canvas size
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

    // Draw all animation layers to create the final composite visualization
    function draw() {
        ctx.clearRect(0, 0, W, H);
        time++;

        // Layer 0: Ambient wave bands (background)
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

        // Layer 1: Node connection mesh (draw lines between nearby nodes)
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

        // Layer 2: Horizontal signal strings (wavy lines moving left or right)
        for (let i = hStrings.length - 1; i >= 0; i--) {
            const s = hStrings[i];
            s.x += s.speed;

            const headX = s.speed > 0 ? s.x + s.len : s.x;
            const tailX = s.speed > 0 ? s.x : s.x + s.len;

            // Recycle the string when it goes off-screen
            if ((s.speed > 0 && tailX > W + 30) || (s.speed < 0 && headX < -30)) {
                hStrings[i] = mkHString(s.speed > 0);
                continue;
            }

            ctx.save();
            if (s.dash.length) ctx.setLineDash(s.dash);
            ctx.beginPath();
            ctx.lineWidth = s.lw;
            ctx.lineCap = 'round';

            // Build path with sine wave
            const drawStart = Math.max(0, Math.min(tailX, headX));
            const drawEnd = Math.min(W, Math.max(tailX, headX));
            if (drawEnd > drawStart) {
                const segs = Math.max(3, Math.floor((drawEnd - drawStart) / 3));
                for (let k = 0; k <= segs; k++) {
                    const px = drawStart + (drawEnd - drawStart) * (k / segs);
                    const py = s.yBase + Math.sin(px * s.freq + s.phase + time * 0.007) * s.amp;
                    if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
                }

                // Fade gradient along trail length
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

            // Draw bright head dot at the leading edge of the string
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

        // Layer 3: Vertical cascade strings (wavy lines moving up or down)
        for (let i = vStrings.length - 1; i >= 0; i--) {
            const v = vStrings[i];
            v.y += v.speed;

            const headY = v.speed > 0 ? v.y + v.len : v.y;
            const tailY = v.speed > 0 ? v.y : v.y + v.len;

            // Recycle the string when it goes off-screen
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

            // Draw small head glow at the leading edge
            const chy = Math.max(0, Math.min(H, headY));
            const chx = v.xBase + Math.sin(chy * v.freq + v.phase + time * 0.006) * v.amp;
            if (chy > 0 && chy < H) {
                ctx.beginPath();
                ctx.arc(chx, chy, 2.5, 0, Math.PI * 2);
                ctx.fillStyle = 'hsla(' + v.hue + ', 70%, 75%, ' + (v.alpha * 2) + ')';
                ctx.fill();
            }
        }

        // Layer 4: Arc connector strings (curved paths with travelling dots)
        for (let i = arcStrings.length - 1; i >= 0; i--) {
            const a = arcStrings[i];
            a.progress += a.speed;

            // Recycle the arc when its animation completes
            if (a.progress > 1.3) {
                arcStrings[i] = mkArcString();
                continue;
            }

            // Draw the full arc path faintly
            ctx.beginPath();
            ctx.moveTo(a.x1, a.y1);
            ctx.quadraticCurveTo(a.cpx, a.cpy, a.x2, a.y2);
            ctx.strokeStyle = 'hsla(' + a.hue + ', 50%, 60%, ' + a.alpha + ')';
            ctx.lineWidth = a.lw;
            ctx.stroke();

            // Draw travelling dot along the arc
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

        // Layer 5: Network nodes (pulsing dots with optional halos)
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

        // Layer 6: Energy pulses (bright moving orbs with halos and trails)
        for (let i = pulses.length - 1; i >= 0; i--) {
            const p = pulses[i];
            p.x += p.speed;
            p.y = p.yBase + Math.sin(p.x * p.freq + time * 0.01) * p.amp;

            // Remove pulse when it goes off-screen
            if ((p.speed > 0 && p.x > W + 20) || (p.speed < 0 && p.x < -20)) {
                pulses.splice(i, 1);
                continue;
            }

            // Outer halo
            const gr = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 5);
            gr.addColorStop(0, 'hsla(' + p.hue + ', 85%, 80%, ' + p.alpha + ')');
            gr.addColorStop(0.35, 'hsla(' + p.hue + ', 80%, 70%, ' + (p.alpha * 0.25) + ')');
            gr.addColorStop(1, 'hsla(' + p.hue + ', 80%, 70%, 0)');
            ctx.fillStyle = gr;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r * 5, 0, Math.PI * 2);
            ctx.fill();

            // Bright core
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fillStyle = 'hsla(' + p.hue + ', 92%, 88%, ' + Math.min(1, p.alpha * 1.4) + ')';
            ctx.fill();

            // Tiny motion trail
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x - p.speed * 8, p.y);
            ctx.strokeStyle = 'hsla(' + p.hue + ', 80%, 75%, ' + (p.alpha * 0.3) + ')';
            ctx.lineWidth = p.r * 0.6;
            ctx.lineCap = 'round';
            ctx.stroke();
        }

        // Spawn energy pulses periodically to keep a steady flow
        if (time % 120 === 0 && pulses.length < 4) pulses.push(mkPulse());
        if (time % 200 === 100 && pulses.length < 4) pulses.push(mkPulse());

        // Continue animation loop
        rafId = requestAnimationFrame(draw);
    }

    // Initialize and start the animation
    resize();
    draw();

    // Handle window resize events with debouncing to avoid excessive redraws
    let resizeTimer;
    window.addEventListener('resize', function() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(resize, 200);
    });

    // Pause animation when page is hidden, resume when visible (energy saving)
    document.addEventListener('visibilitychange', function() {
        if (document.hidden) {
            if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        } else {
            if (!rafId) draw();
        }
    });
})();

// ========== SCROLL-TRIGGERED ANIMATIONS ==========
// Cache for the row intersection observer used for scroll reveal animations
let _scrollRowObserver = null;

// Initialize scroll animations: thead shadow and row viewport-triggered reveals
function initScrollAnimations() {
    const tableContainer = document.querySelector('.table-container');
    const thead = document.querySelector('#job-table thead');
    if (!tableContainer || !thead) return;

    // Add shadow to table header when content is scrolled down
    tableContainer.addEventListener('scroll', function() {
        if (tableContainer.scrollTop > 4) {
            thead.classList.add('thead-scrolled');
        } else {
            thead.classList.remove('thead-scrolled');
        }
    }, { passive: true });

    // Use IntersectionObserver to reveal rows as they enter the viewport
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

// ========== COLUMN RESIZING ==========
// Allow users to resize table columns by dragging the right edge of headers
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

            // Track mouse movement to update column width
            function onMouseMove(e) {
                const newWidth = Math.min(maxW, Math.max(minW, startWidth + (e.pageX - startX)));
                th.style.width = newWidth + 'px';
            }
            // Release drag and clean up event listeners
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

// Set up table interactivity when the page loads
document.addEventListener('DOMContentLoaded', function() {
    // Wire sort handlers on clickable headers and initialize column resizing
    document.querySelectorAll('th[data-sortable]').forEach(th => {
        th.addEventListener('click', function(e) {
            // Don't sort when clicking the resize handle
            if (e.target.classList.contains('col-resize-handle')) return;
            sortTable(this.dataset.sortKey, this.dataset.sortType);
        });
    });
    initColumnResizing();
    initScrollAnimations();

    // Track manual promotion date/time changes to mark the state as pending
    const promoInput = document.getElementById('promotion-datetime');
    if (promoInput) {
        promoInput.addEventListener('change', markPromoPending);
        promoInput.addEventListener('input', markPromoPending);
    }
});

// Debounce search input to avoid too many filter recalculations (F4 keystroke filtering)
let _searchDebounce = null;
function debouncedApplyFilters() {
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => applyFilters(), 200);
}

// ========== LOG ANALYSIS FILTER — searchable autocomplete ==========
// Build a list of unique log analysis labels with counts from the job dataset
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

// Cache of current log analysis labels, rebuilt when the dataset changes
var _laLabelCache = [];

// Rebuild the label cache from the current job dataset
function rebuildLogAnalysisLabelCache() {
    _laLabelCache = collectLogAnalysisLabels();
}

// Show the log analysis filter control in the UI (called when entering Detail mode)
function showLogAnalysisFilter() {
    var wrap = document.getElementById('la-filter-wrap');
    if (wrap) {
        rebuildLogAnalysisLabelCache();
        wrap.style.display = 'inline-flex';
    }
}

// Hide and clear the log analysis filter (called when leaving Detail mode)
function hideLogAnalysisFilter() {
    var wrap = document.getElementById('la-filter-wrap');
    if (wrap) wrap.style.display = 'none';
    var hadActive = (appState.filters.logAnalysisLabels || []).length > 0;
    clearLogAnalysisFilter();
    if (hadActive) {
        applyFilters();
    }
}

// Clear ALL log analysis labels from the filter (multi-select).
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

// Open the log analysis dropdown and populate it with labels matching the query
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
        // Build dropdown items with highlighted search matches.
        var selected = appState.filters.logAnalysisLabels || [];
        dropdown.innerHTML = matches.map(function(item, idx) {
            var hex = _dotHexMap[item.color] || '#94A3B8';
            var display = escapeHtml(item.label);
            // Highlight the matching substring if there's a query
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

// Close the dropdown and clear the keyboard navigation state
function closeLogAnalysisDropdown() {
    var dropdown = document.getElementById('la-dropdown');
    if (dropdown) dropdown.classList.remove('la-dropdown-open');
    _laActiveIndex = -1;
    _laVisibleItems = [];
}

// Toggle a label in the multi-select filter.
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

    // Clear any typed search so the dropdown re-renders showing all
    // labels (the user is in "pick several" mode now).
    if (input) {
        input.value = '';
        input.classList.toggle('la-has-value', labels.length > 0);
    }
    if (clearBtn) clearBtn.style.display = labels.length > 0 ? 'flex' : 'none';

    updateSelectedLabelBadge();
    // Re-open the dropdown so the user sees the updated check marks
    openLogAnalysisDropdown('');
    applyFilters();
}

// Keyboard navigation state for the log analysis dropdown
var _laActiveIndex = -1;
var _laVisibleItems = [];

// Initialize log analysis filter autocomplete with keyboard and mouse interactions
(function initLogAnalysisFilter() {
    document.addEventListener('DOMContentLoaded', function() {
        var input = document.getElementById('la-filter-input');
        var clearBtn = document.getElementById('la-filter-clear');
        var dropdown = document.getElementById('la-dropdown');
        if (!input || !dropdown) return;

        // Open dropdown when the input gets focus
        input.addEventListener('focus', function() {
            rebuildLogAnalysisLabelCache();
            openLogAnalysisDropdown(input.value);
        });

        // Update dropdown as the user types.  Typing only filters the
        // dropdown — it does NOT clear any selected labels.  Use the X
        // button or click a chip's × to remove labels.
        input.addEventListener('input', function() {
            openLogAnalysisDropdown(input.value);
        });

        // Handle arrow keys and Enter for dropdown navigation
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

        // Select a label when the user clicks a dropdown item
        dropdown.addEventListener('mousedown', function(e) {
            e.preventDefault(); // prevent input blur
            var item = e.target.closest('.la-dropdown-item');
            if (item) {
                selectLogAnalysisLabel(item.getAttribute('data-label'));
            }
        });

        // Update keyboard selection when the user hovers over items
        dropdown.addEventListener('mouseover', function(e) {
            var item = e.target.closest('.la-dropdown-item');
            if (item) {
                var items = dropdown.querySelectorAll('.la-dropdown-item');
                items.forEach(function(el) { el.classList.remove('la-item-active'); });
                item.classList.add('la-item-active');
                _laActiveIndex = parseInt(item.getAttribute('data-index'), 10);
            }
        });

        // Close dropdown when input loses focus
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

// Update which dropdown item is highlighted during keyboard navigation
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

// Table-overlay helpers
let _overlayRefCount = 0;
function showTableOverlay() {
    _overlayRefCount++;
    const el = document.getElementById('table-overlay');
    if (el) { el.classList.add('is-visible'); el.setAttribute('aria-hidden', 'false'); }
}
function hideTableOverlay() {
    _overlayRefCount = Math.max(0, _overlayRefCount - 1);
    if (_overlayRefCount > 0) return;
    const el = document.getElementById('table-overlay');
    if (el) { el.classList.remove('is-visible'); el.setAttribute('aria-hidden', 'true'); }
}
// Public-ish wrapper used by other modules
function withTableLoading(work) {
    showTableOverlay();
    requestAnimationFrame(function() {
        requestAnimationFrame(function() {
            try { work(); }
            finally { hideTableOverlay(); }
        });
    });
}

// Public entry point
function applyFilters() {
    withTableLoading(_applyFiltersImpl);
}

// Synchronous core — original behaviour
function _applyFiltersImpl() {
    appState.filters.status = document.getElementById('filter-status').value || null;

    var rawSearch = document.getElementById('filter-search').value || '';
    appState.filters.searchText = rawSearch.toLowerCase();
    appState.filters._searchRe = null;
    if (rawSearch.trim().length > 0) {
        try {
            appState.filters._searchRe = new RegExp(rawSearch, 'i');
        } catch (e) {
            // Invalid regex — keep _searchRe null; matchesFilters will
            // fall back to substring on searchText.
            appState.filters._searchRe = null;
        }
    }

    // Release Status filter — only meaningful when the column is visible (promotion-active).
    // When hidden, the input is unreachable so the value is naturally null.
    var releaseSel = document.getElementById('filter-release-status');
    appState.filters.releaseStatus = (releaseSel && releaseSel.value) ? releaseSel.value : null;
    // logAnalysisLabels

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

        // Also hide/show detail rows paired with their job row
        const detailRow = document.querySelector(`tr[data-job-id="${escapeHtml(jobId)}_detail"]`);
        if (detailRow) {
            detailRow.style.display = visible ? '' : 'none';
        }
    });

    // Re-apply current sort if one is active
    reapplyCurrentSort();
    updateToolbarActions();

    // Sync the select-all checkbox state with the current visible selection
    const allCheckbox = document.getElementById('select-all-checkbox');
    if (allCheckbox) {
        const visibleCbs = Array.from(document.querySelectorAll(
            'tbody tr[data-job-id]:not(.detail-row):not([style*="display: none"]) input[type="checkbox"]'
        ));
        allCheckbox.checked = visibleCbs.length > 0 && visibleCbs.every(cb => cb.checked);
    }

    updateEmptyState();
}

// Check if a job matches all currently active filters
function matchesFilters(job) {
    if (appState.filters.status && job.latest_status !== appState.filters.status) return false;

    // Release Status filter — backend emits 'PASS' / 'PENDING' / 'FAIL' / 'NA'.
    if (appState.filters.releaseStatus && job.release_status !== appState.filters.releaseStatus) return false;

    if (appState.filters.searchText) {
        const re = appState.filters._searchRe;
        if (re) {
            // Regex path — test the raw name/url so anchors (^, $) work
            if (!re.test(job.name) && !re.test(job.url)) return false;
        } else {
            // Fallback: pattern didn't compile, treat as case-insensitive substring.
            const searchText = appState.filters.searchText;
            if (!job.name.toLowerCase().includes(searchText) && !job.url.toLowerCase().includes(searchText)) {
                return false;
            }
        }
    }

    // Log Analysis label filter (Detail mode only)
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

// Re-sort the table without changing the current sort direction (called after filters change)
function reapplyCurrentSort() {
    if (!currentSortKey || !currentSortDir) return;
    const th = document.querySelector(`th[data-sort-key="${currentSortKey}"]`);
    const type = th ? (th.dataset.sortType || 'string') : 'string';
    sortAndReorderRows(currentSortKey, type);
}

// ========== SELECTION & EXPANSION ==========
// Toggle the selection state of all visible job rows
function toggleSelectAll(checked) {
    const checkboxes = document.querySelectorAll('tbody tr[data-job-id]:not(.detail-row) input[type="checkbox"]');
    checkboxes.forEach(cb => {
        const row = cb.closest('tr');
        // Only affect visible (not filtered-out) rows
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
}

// Toggle the selection state of a single job and update the select-all checkbox accordingly
function toggleJobSelection(jobId) {
    if (appState.selectedJobs.has(jobId)) {
        appState.selectedJobs.delete(jobId);
    } else {
        appState.selectedJobs.add(jobId);
    }

    const allCheckbox = document.getElementById('select-all-checkbox');
    // Only consider visible (not filtered-out) rows for "select all" state
    const visibleCheckboxes = Array.from(document.querySelectorAll('tbody tr[data-job-id]:not(.detail-row):not([style*="display: none"]) input[type="checkbox"]'));
    allCheckbox.checked = visibleCheckboxes.length > 0 && visibleCheckboxes.every(cb => cb.checked);
    updateToolbarActions();
}

// Expand or collapse a job's detail row with additional information
function toggleRowExpansion(jobId) {
    const job = appState.jobs.get(jobId);
    if (!job) return;

    if (appState.expandedRows.has(jobId)) {
        // Close the detail row
        appState.expandedRows.delete(jobId);
        const detailRow = document.querySelector(`tr[data-job-id="${escapeHtml(jobId)}_detail"]`);
        if (detailRow) detailRow.remove();
        const row = document.querySelector(`tr[data-job-id="${escapeHtml(jobId)}"]`);
        if (row) row.classList.remove('expanded');
    } else {
        // Open the detail row
        appState.expandedRows.add(jobId);
        const row = document.querySelector(`tr[data-job-id="${escapeHtml(jobId)}"]`);
        if (row) {
            row.classList.add('expanded');
            const detailRow = renderExpandedDetail(job);
            row.after(detailRow);
        }
    }
}
