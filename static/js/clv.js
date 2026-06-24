// Console Log Viewer — interactive log viewer with filtering, search,
// error navigation, and chunked rendering for very large logs.

'use strict';

// Single state object shared across the CLV pipeline.
const clvState = {
    rawLines: [],           // [{ text, cls, lineNum }]
    filteredIndices: [],    // indices into rawLines matching the current filter
    renderedUpTo: 0,        // how many filteredIndices have been rendered
    chunkSize: 120,
    activeFilter: 'all',
    searchTerm: '',
    searchMatches: [],      // filteredIndices entries that contain the search term
    searchCursor: -1,
    observer: null,
    stats: { errors: 0, warnings: 0, info: 0, lines: 0, scenarios: 0, failedScenarios: 0 },
    errorIndices: [],
    errorBlocks: [],        // [{ startIdx, endIdx, anchorIdx }]
    errorBlockCursor: -1,
    parsedScenarios: [],
    phase: 'idle',          // 'idle' | 'loading' | 'ready' | 'shrunk'
    abortController: null,
    cachedSource: false,
    domWindowStart: 0,      // first filteredIndices position kept in the DOM
    domWindowSize: 600,     // max lines to keep in DOM (virtualisation cap)
    // — Idle-shrink bookkeeping
    idleTimer: null,
    lastActivityAt: 0,
    lastJobUrl: '',
    lastBuildNum: '',
    lastJobName: '',
    lastScrollTop: 0,
};

// 2 minutes of inactivity → release heavy buffers.
const IDLE_SHRINK_MS = 120 * 1000;

// Reset the idle timer whenever the user interacts with the CLV. Cheap:
// constant time, no allocation beyond the timeout handle.
function clvMarkActive() {
    if (clvState.phase === 'idle') return;     // modal isn't open
    clvState.lastActivityAt = Date.now();
    if (clvState.idleTimer) clearTimeout(clvState.idleTimer);
    clvState.idleTimer = setTimeout(clvShrinkOnIdle, IDLE_SHRINK_MS);
}

// Release the heavy CLV buffers + DOM and replace the body with a
// placeholder + Reload button. Keeps only the metadata needed to
// rehydrate via the existing fetch path. Called by the idle timer.
function clvShrinkOnIdle() {
    if (clvState.phase !== 'ready' && clvState.phase !== 'loading') return;

    const beforeLines = clvState.rawLines.length;
    const body = document.getElementById('clv-body');
    if (body) clvState.lastScrollTop = body.scrollTop || 0;

    // Cancel any in-flight fetch — a half-loaded log that the user
    // walked away from is the worst case for retained memory.
    if (clvState.abortController) {
        try { clvState.abortController.abort(); } catch (_) {}
        clvState.abortController = null;
    }

    // Drop every heavy buffer the audit identified.
    clvState.rawLines = [];
    clvState.filteredIndices = [];
    clvState.searchMatches = [];
    clvState.errorIndices = [];
    clvState.errorBlocks = [];
    clvState.errorBlockCursor = -1;
    clvState.parsedScenarios = [];
    clvState.renderedUpTo = 0;
    clvState.domWindowStart = 0;
    clvState.searchTerm = '';
    clvState.searchCursor = -1;
    clvState.phase = 'shrunk';

    // DOM teardown — also releases per-row event listeners.
    const container = document.getElementById('clv-log-container');
    if (container) container.innerHTML = '';

    // Disconnect observer + scroll listener so they don't fire on the
    // placeholder. clvOpen / Reload re-attaches them.
    if (clvState.observer) {
        clvState.observer.disconnect();
        clvState.observer = null;
    }
    if (body) body.removeEventListener('scroll', clvOnBodyScroll);
    if (_clvRecycleTimer) { clearTimeout(_clvRecycleTimer); _clvRecycleTimer = null; }

    clvState.idleTimer = null;

    // Replace the body with a small "released" notice + Reload button.
    if (container) {
        const placeholder = document.createElement('div');
        placeholder.className = 'clv-idle-placeholder';
        placeholder.innerHTML =
            '<div class="clv-idle-icon">⏸</div>' +
            '<div class="clv-idle-msg">Log released after 2 minutes of inactivity to reduce memory usage.</div>' +
            '<button type="button" class="clv-idle-reload" id="clv-idle-reload">Reload</button>';
        container.appendChild(placeholder);
        const btn = placeholder.querySelector('#clv-idle-reload');
        if (btn) btn.addEventListener('click', clvReloadAfterIdle);
    }

    // Visual: dim the toolbar + summary so the user knows the data
    // backing them is gone until a reload.
    const tb = document.getElementById('clv-toolbar');
    if (tb) { tb.classList.add('clv-toolbar--gated'); tb.classList.remove('clv-toolbar--ready'); }
    const sm = document.getElementById('clv-summary');
    if (sm) { sm.classList.add('clv-summary--gated'); sm.classList.remove('clv-summary--ready'); }

    // Approx freed bytes for the diag/debug log. We don't measure DOM,
    // just the JS-side string footprint as a proxy. 2 bytes per UTF-16
    // char gives a reasonable rough estimate.
    var approxKb = Math.round((beforeLines * 80) / 1024);
    var detail = beforeLines.toLocaleString() + ' lines released (~' + approxKb + ' KB)';
    console.debug('[CLV] idle-shrink fired:', detail);
    if (typeof diagLog === 'function') {
        diagLog('info', 'CLV', 'Idle shrink', { raw: detail });
    }
}

// Reload after an idle-shrink. Uses the existing fetch path so all the
// streaming, gzip, and error handling stays unified.
function clvReloadAfterIdle() {
    if (!clvState.lastJobUrl || !clvState.lastBuildNum) {
        console.warn('[CLV] reload requested but no job metadata retained');
        return;
    }
    var container = document.getElementById('clv-log-container');
    if (container) container.innerHTML = '';
    var loading = document.getElementById('clv-loading');
    if (loading) loading.style.display = 'flex';
    var msg = document.getElementById('clv-loading-msg');
    if (msg) msg.textContent = 'Reloading console log...';
    clvState.phase = 'loading';
    clvFetch(clvState.lastJobUrl, clvState.lastBuildNum);
}

// Open the CLV modal for a job, fetch its console log, and begin rendering.
function clvOpen(jobId) {
    const job = appState.jobs.get(jobId);
    if (!job) {
        console.warn('[CLV] clvOpen: job not found in appState for id:', jobId);
        diagLog('warning', 'CLV', 'Job not found in appState', { raw: jobId });
        return;
    }

    // Abort any in-flight fetch from a previous open.
    if (clvState.abortController) {
        clvState.abortController.abort();
        clvState.abortController = null;
    }

    const isRunning = job.is_running || job.latest_status === 'IN_PROGRESS';
    const ref = job.analysis_reference;
    const useRef = isRunning && ref && ['FAILURE','UNSTABLE','ABORTED'].includes(ref.status);

    // For running jobs we view the previous completed build instead of the live one.
    let buildNum, buildStatus, sourceLabel;
    const trc = job.three_run_context || {};
    if (useRef) {
        const prevBuild = trc.previous || {};
        buildNum = prevBuild.build_number || '?';
        buildStatus = ref.status || 'UNKNOWN';
        sourceLabel = 'Previous completed build (current build in progress)';
    } else {
        const latest = trc.latest || {};
        buildNum = latest.build_number || '?';
        buildStatus = job.latest_status || 'UNKNOWN';
        sourceLabel = '';
    }

    // Tolerate either property name from upstream code paths.
    const jobUrl = job.url || job.job_url || job.job_id || jobId;
    if (!jobUrl) {
        console.warn('[CLV] clvOpen: no job URL found for:', job.name || jobId);
        diagLog('warning', 'CLV', 'No job URL found', { raw: job.name || jobId });
        showToast('Cannot open console log — job URL is missing', 'error');
        return;
    }

    if (buildNum === '?') {
        console.warn('[CLV] clvOpen: no build number available for:', jobUrl);
        diagLog('warning', 'CLV', 'No build number available', { raw: jobUrl });
        // Still allow opening — the fetch surfaces the error gracefully.
    }

    var el;
    el = document.getElementById('clv-job-name');
    if (el) el.textContent = job.name || job.job_name || 'Unknown Job';
    el = document.getElementById('clv-build-info');
    if (el) el.textContent = 'Build #' + buildNum;
    el = document.getElementById('clv-build-status');
    if (el) el.textContent = buildStatus;
    el = document.getElementById('clv-source-ctx');
    if (el) el.textContent = sourceLabel;

    const dot = document.getElementById('clv-dot');
    if (dot) {
        dot.className = 'clv-title-dot';
        if (buildStatus === 'FAILURE') dot.classList.add('clv-title-dot--failure');
        else if (buildStatus === 'UNSTABLE') dot.classList.add('clv-title-dot--unstable');
        else if (buildStatus === 'SUCCESS') dot.classList.add('clv-title-dot--success');
        else dot.classList.add('clv-title-dot--aborted');
    }

    // Reset state for a fresh load.
    clvState.rawLines = [];
    clvState.filteredIndices = [];
    clvState.renderedUpTo = 0;
    clvState.activeFilter = 'all';
    clvState.searchTerm = '';
    clvState.searchMatches = [];
    clvState.searchCursor = -1;
    clvState.errorIndices = [];
    clvState.errorBlocks = [];
    clvState.errorBlockCursor = -1;
    clvState.parsedScenarios = [];
    clvState.stats = { errors: 0, warnings: 0, info: 0, lines: 0, scenarios: 0, failedScenarios: 0 };
    clvState.phase = 'loading';
    clvState.cachedSource = false;
    clvState.domWindowStart = 0;

    // Reset UI to the loading phase.
    el = document.getElementById('clv-log-container');
    if (el) el.innerHTML = '';
    el = document.getElementById('clv-loading');
    if (el) el.style.display = 'flex';
    el = document.getElementById('clv-loading-msg');
    if (el) el.textContent = 'Fetching console log...';
    el = document.getElementById('clv-loading-detail');
    if (el) el.textContent = '';
    el = document.getElementById('clv-loading-progress');
    if (el) el.style.display = 'none';
    el = document.getElementById('clv-loading-bar');
    if (el) el.style.width = '0%';
    el = document.getElementById('clv-search');
    if (el) el.value = '';
    el = document.getElementById('clv-search-count');
    if (el) el.textContent = '';
    document.querySelectorAll('.clv-filter-btn').forEach(function(b) {
        b.classList.toggle('active', b.dataset.clvFilter === 'all');
    });

    // Gate toolbar + summary while loading.
    el = document.getElementById('clv-toolbar');
    if (el) { el.classList.add('clv-toolbar--gated'); el.classList.remove('clv-toolbar--ready'); }
    el = document.getElementById('clv-summary');
    if (el) { el.classList.add('clv-summary--gated'); el.classList.remove('clv-summary--ready'); }

    const panel = document.getElementById('clv-panel');
    if (panel) { panel.style.removeProperty('--clv-w'); panel.style.removeProperty('--clv-h'); }
    const kbdHint = document.getElementById('clv-kbd-hint');
    if (kbdHint) kbdHint.textContent = navigator.platform.indexOf('Mac') > -1 ? '⌘F' : 'Ctrl+F';

    el = document.getElementById('clv-overlay');
    if (el) {
        el.classList.add('active');
        el.setAttribute('aria-hidden', 'false');
    }

    // Stash metadata so Reload (after idle-shrink) can re-fetch without
    // re-walking appState. lastScrollTop is captured at shrink time.
    clvState.lastJobUrl = jobUrl;
    clvState.lastBuildNum = buildNum;
    clvState.lastJobName = job.name || job.job_name || '';
    clvState.lastScrollTop = 0;

    clvFetch(jobUrl, buildNum);
    clvMarkActive();
}

// Fetch the console log. Handles both cached text/plain streams and SSE-with-progress.
async function clvFetch(jobUrl, buildNum) {
    const controller = new AbortController();
    clvState.abortController = controller;

    try {
        const creds = ensureCredentials();
        if (!creds) throw new Error('Jenkins credentials not available');
        const resp = await apiFetch('/api/console-log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                job_url: jobUrl,
                build_number: buildNum,
                jenkins_url: creds.jenkins_url,
                username: creds.username,
                api_token: creds.api_token,
            }),
            signal: controller.signal,
        });

        if (!resp.ok) {
            let errMsg = 'HTTP ' + resp.status;
            try {
                const ct = resp.headers.get('Content-Type') || '';
                if (ct.includes('application/json')) {
                    const errBody = await resp.json();
                    if (errBody && errBody.error) errMsg = errBody.error;
                }
            } catch (_) { /* keep HTTP code as the message */ }
            throw new Error(errMsg);
        }

        const contentType = resp.headers.get('Content-Type') || '';
        const isCached = resp.headers.get('X-CLV-Cached') === 'true' || contentType.includes('text/plain');
        const source = resp.headers.get('X-CLV-Source') || 'jenkins';
        clvState.cachedSource = isCached;

        if (isCached || contentType.includes('text/plain')) {
            var loadMsg = document.getElementById('clv-loading-msg');
            var loadDetail = document.getElementById('clv-loading-detail');
            if (loadMsg) loadMsg.textContent = 'Streaming console log...';

            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let processed = 0;
            let sinceYield = 0;
            const BATCH_LINES = 3000;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();   // keep partial last line for next chunk

                for (const line of lines) {
                    if (line.length > 0 || clvState.rawLines.length > 0) {
                        clvProcessLine(line);
                    }
                    processed++;
                    sinceYield++;
                    // Yield to the browser every BATCH_LINES so the page stays responsive.
                    if (sinceYield >= BATCH_LINES) {
                        sinceYield = 0;
                        if (loadMsg) loadMsg.textContent = 'Processing ' + processed.toLocaleString() + ' lines...';
                        if (loadDetail) loadDetail.textContent = processed.toLocaleString() + ' lines';
                        await new Promise(r => setTimeout(r, 0));
                        if (controller.signal.aborted) return;
                    }
                }
            }

            // Flush trailing partial line + any bytes buffered in the decoder.
            buffer += decoder.decode();
            if (buffer.length > 0) {
                clvProcessLine(buffer);
                processed++;
            }

            if (loadMsg) loadMsg.textContent = 'Finalising ' + processed.toLocaleString() + ' lines...';
            // One more yield so the message paints before analysis kicks off.
            await new Promise(r => setTimeout(r, 0));
            if (controller.signal.aborted) return;
            clvActivateAnalysis();
        } else {
            // SSE stream with periodic progress events.
            var progEl = document.getElementById('clv-loading-progress');
            if (progEl) progEl.style.display = 'block';
            var msgEl = document.getElementById('clv-loading-msg');
            if (msgEl) msgEl.textContent = 'Receiving console log...';

            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                let boundary;
                while ((boundary = buffer.indexOf('\n\n')) !== -1) {
                    const raw = buffer.slice(0, boundary);
                    buffer = buffer.slice(boundary + 2);

                    const match = raw.match(/^data:\s*(.+)$/m);
                    if (!match) continue;

                    let evt;
                    try { evt = JSON.parse(match[1]); } catch (e) { continue; }

                    if (evt.type === 'line') {
                        clvProcessLine(evt.text != null ? evt.text : '');
                    } else if (evt.type === 'progress') {
                        var bar = document.getElementById('clv-loading-bar');
                        if (bar) bar.style.width = (evt.pct || 0) + '%';
                        var detail = document.getElementById('clv-loading-detail');
                        if (detail) detail.textContent =
                            (evt.loaded || 0).toLocaleString() + ' / ' + (evt.total || 0).toLocaleString() + ' lines (' + (evt.pct || 0) + '%)';
                    } else if (evt.type === 'complete') {
                        clvActivateAnalysis();
                    }
                }
            }

            // Stream ended without an explicit 'complete' — activate anyway.
            if (clvState.phase === 'loading') {
                clvActivateAnalysis();
            }
        }

    } catch (err) {
        if (err.name === 'AbortError') return; // user closed overlay during fetch
        console.error('[CLV] clvFetch error:', err);
        reportFetchError('CLV', 'Console log fetch error', '/api/console-log', err);
        var loadEl = document.getElementById('clv-loading');
        if (loadEl) {
            loadEl.style.display = 'flex';
            loadEl.innerHTML =
                '<div class="clv-loading-row"><span style="color:#FCA5A5">Failed to load console log: ' + escapeHtml(err.message || 'Unknown error') + '</span></div>';
        }
    } finally {
        clvState.abortController = null;
    }
}

// Move from loading → ready: run the analysis pipeline and reveal toolbar + summary.
function clvActivateAnalysis() {
    clvState.phase = 'ready';

    var loadingEl = document.getElementById('clv-loading');
    if (loadingEl) loadingEl.style.display = 'none';

    // Try the analysis pipeline; if it crashes still show the raw log.
    try {
        clvBuildErrorBlocks();
        clvBuildFilteredList();
        clvRenderChunk();
        clvUpdateStats();
        clvSetupObserver();
    } catch (analysisErr) {
        console.error('[CLV] Analysis pipeline error:', analysisErr);
        diagLog('error', 'CLV', 'Analysis pipeline error', { stack: analysisErr.stack, raw: analysisErr.message });
        clvBuildFilteredList();
        try { clvRenderChunk(); } catch (_) {}
    }

    var toolbar = document.getElementById('clv-toolbar');
    var summary = document.getElementById('clv-summary');
    if (toolbar) { toolbar.classList.remove('clv-toolbar--gated'); toolbar.classList.add('clv-toolbar--ready'); }
    if (summary) { summary.classList.remove('clv-summary--gated'); summary.classList.add('clv-summary--ready'); }

    if (clvState.cachedSource) {
        var srcCtx = document.getElementById('clv-source-ctx');
        if (srcCtx) {
            var existing = srcCtx.textContent;
            srcCtx.textContent = existing ? existing + ' • Cached' : 'Served from cache';
        }
    }

    // After an idle-shrink → Reload, jump back to the last scroll
    // position so the user doesn't lose their place. RAF gives layout
    // a chance to settle before we read scrollTop.
    if (clvState.lastScrollTop > 0) {
        var savedTop = clvState.lastScrollTop;
        clvState.lastScrollTop = 0;
        requestAnimationFrame(function() {
            var body = document.getElementById('clv-body');
            if (body) body.scrollTop = savedTop;
        });
    }

    // Arm the idle timer now that the log is fully loaded and visible.
    clvMarkActive();
}

// Line classifier rules
const CLV_PATTERNS = [

    //  Cucumber: step markers (unicode) 
    { id: 'cuke-step-pass',    cls: 'step-pass',  re: /^\s*\u2714\s/,                  framework: 'cucumber' },
    { id: 'cuke-step-fail',    cls: 'step-fail',  re: /^\s*\u2718\s/,                  framework: 'cucumber' },
    { id: 'cuke-step-skip',    cls: 'step-skip',  re: /^\s*\u21b7\s/,                  framework: 'cucumber' },

    //  Cucumber: step markers (legacy text) 
    { id: 'cuke-step-pass-legacy', cls: 'step-pass', re: /\.\.\.\s*PASSED\b/,          framework: 'cucumber' },
    { id: 'cuke-step-fail-legacy', cls: 'step-fail', re: /\.\.\.\s*FAILED\b/,          framework: 'cucumber' },
    { id: 'cuke-step-skip-legacy', cls: 'step-skip', re: /\.\.\.\s*SKIPPED\b/,         framework: 'cucumber' },

    //  Cucumber: scenario / feature headers 
    { id: 'cuke-scenario',     cls: 'scenario',   re: /^(?:\s*|\S.*?\]\s*)Scenario(?:\s+Outline)?:/,  framework: 'cucumber' },
    { id: 'cuke-feature',      cls: 'feature',    re: /(?:^\s*|\[INFO\]\s*)Feature:/,  framework: 'cucumber' },

    //  Java / JVM log-level markers 
    { id: 'java-error',        cls: 'error',      re: /\[ERROR\]|\[FATAL\]|\[SEVERE\]/, framework: 'java' },
    { id: 'java-stacktrace',   cls: 'stacktrace', re: /^\s+\t?at\s/,                   framework: 'java' },
    { id: 'cuke-stackref',     cls: 'stacktrace', re: /^\s+\u273d\./,                  framework: 'cucumber' },
    { id: 'java-more-frames',  cls: 'stacktrace', re: /\.\.\.\s\d+\smore$/,            framework: 'java' },
    { id: 'java-exception',    cls: 'error',      re: /^\s+(java\.|org\.|com\.|net\.)[\w.]+Exception/, framework: 'java' },
    { id: 'java-error-cls',    cls: 'error',      re: /^\s+(java\.|org\.|com\.|net\.)[\w.]+Error/,     framework: 'java' },

    //  Java / JVM log-level info & warn 
    { id: 'java-warn',         cls: 'warn',       re: /\[WARN\]/,                      framework: 'java' },
    { id: 'java-info',         cls: 'info',       re: /\[INFO\]/,                      framework: 'java' },

    //  Cucumber: Given/When/Then keywords 
    { id: 'cuke-keyword',      cls: 'step',       re: /(?:^\s*|\]\s*)(Given|When|Then|And|But)\b/, framework: 'cucumber' },

    //  Jenkins pipeline (stage-specific rules MUST precede generic [Pipeline]) ─
    { id: 'jenkins-stage',     cls: 'stage',      re: /^\[Pipeline\]\s*\{\s*\(.*\)$/,  framework: 'jenkins' },
    { id: 'jenkins-stage-alt', cls: 'stage',      re: /^Stage\s+"[^"]+"\s*(started|skipped)/i, framework: 'jenkins' },
    { id: 'jenkins-pipeline',  cls: 'pipeline',   re: /^\[Pipeline\]/,                 framework: 'jenkins' },

    //  Current summary patterns 
    { id: 'summary-results',   cls: 'summary',    re: /TEST RESULTS SUMMARY|FAILED SCENARIOS/, framework: 'generic' },
    { id: 'summary-finished',  cls: 'summary',    re: /^Finished:/,                    framework: 'jenkins' },
    { id: 'summary-banner',    cls: 'summary',    re: /^\s*[|_]{2,}/,                  framework: 'generic' },
    { id: 'summary-tests',     cls: 'summary',    re: /T E S T S/,                     framework: 'generic' },

    //  Cross-framework patterns (additive, lower priority)

    //  Playwright / JS test-runner errors 
    { id: 'pw-timeout',        cls: 'error',      re: /TimeoutError:|Timed?\s*out\b.*\d+ms/i,         framework: 'playwright' },
    { id: 'pw-locator',        cls: 'error',      re: /locator\s+(resolved|not\s+found|not\s+visible)/i, framework: 'playwright' },
    { id: 'pw-expect-fail',    cls: 'error',      re: /expect\(.*\)\.(toBe|toEqual|toHave|toContain|toMatch)\b/i, framework: 'playwright' },
    { id: 'pw-assertion',      cls: 'error',      re: /AssertionError|AssertError|assert\.\w+\(/i,    framework: 'playwright' },
    { id: 'pw-strict-mode',    cls: 'error',      re: /strict mode violation/i,        framework: 'playwright' },
    { id: 'pw-test-header',    cls: 'test-block',  re: /^\s*[✓✗✘×·]\s+.+\(\d+(\.\d+)?m?s\)\s*$/,    framework: 'playwright' },

    //  Cypress errors 
    { id: 'cy-assert-fail',    cls: 'error',      re: /CypressError:|AssertionError:/,  framework: 'cypress' },
    { id: 'cy-cmd-fail',       cls: 'error',      re: /cy\.\w+\(\)\s*failed/i,        framework: 'cypress' },
    { id: 'cy-element-err',    cls: 'error',      re: /element\s+not\s+(found|visible|interactable)/i, framework: 'cypress' },
    { id: 'cy-spec-header',    cls: 'test-block',  re: /^\s*(Running|Spec|Suite):/i,   framework: 'cypress' },
    { id: 'cy-passing-fail',   cls: 'result-summary', re: /^\s*\d+\s+(passing|failing|pending)\b/i,   framework: 'cypress' },

    //  Node / JS stack traces 
    { id: 'node-stack',        cls: 'stacktrace', re: /^\s+at\s+.*\(.*:\d+:\d+\)/,    framework: 'node' },
    { id: 'node-stack-anon',   cls: 'stacktrace', re: /^\s+at\s+(async\s+)?[\w.<>]+\s+\(/, framework: 'node' },
    { id: 'node-internal',     cls: 'stacktrace', re: /^\s+at\s+(node:|internal\/)/,   framework: 'node' },

    //  Result / summary lines (must precede generic error catch-alls because result lines often contain "failed") ─
    { id: 'gen-test-result',   cls: 'result-summary', re: /^\s*Tests?:\s*\d+/i,        framework: 'generic' },
    { id: 'gen-result-count',  cls: 'result-summary', re: /\d+\s+(tests?|specs?|suites?)\s+(passed|failed|skipped)/i, framework: 'generic' },
    { id: 'gen-result-total',  cls: 'result-summary', re: /^(Tests|Suites|Scenarios)\s*:.*\d+\s*(passed|failed)/i,    framework: 'generic' },
    { id: 'gen-build-result',  cls: 'result-summary', re: /^(BUILD|Build)\s+(SUCCESS|FAILURE|UNSTABLE)/i,              framework: 'generic' },

    //  Generic error keywords (broad catch) 
    { id: 'gen-error-prefix',  cls: 'error',      re: /^ERROR\b|^FATAL\b|^SEVERE\b/,  framework: 'generic' },
    { id: 'gen-build-failure', cls: 'error',      re: /\bBUILD\s+FAILURE\b|<<<\s+FAILURE\b|>>>\s+FAILED\b|\bTESTS?\s+FAILED\b/, framework: 'generic' },
    // Cucumber failure marker — `Test failed at step:` is the canonical
    { id: 'cucumber-step-fail',cls: 'error',      re: /^\s*Test failed at step:|^\s*✘\s/, framework: 'cucumber' },
    { id: 'gen-exception',     cls: 'error',      re: /Exception:|Error:|ENOENT|ECONNREFUSED|EACCES/,  framework: 'generic' },
    { id: 'gen-connection',    cls: 'error',      re: /Connection\s+(refused|reset|timed\s*out)/i,     framework: 'generic' },

    //  Generic warning keywords 
    { id: 'gen-warn-prefix',   cls: 'warn',       re: /^WARN\b|^WARNING\b|Warning:/i,  framework: 'generic' },
    { id: 'gen-deprecation',   cls: 'warn',       re: /\bDeprecationWarning\b|\bDeprecated\b/i,       framework: 'generic' },

    //  Generic info keywords ─
    { id: 'gen-info-prefix',   cls: 'info',       re: /^INFO\b/,                       framework: 'generic' },

    //  Test-block / section headers (Playwright, Jest, Mocha, etc) ─
    { id: 'gen-test-header',   cls: 'test-block', re: /^\s*(Test|Spec|Describe|Context|Suite)\s*:/i,   framework: 'generic' },
    { id: 'gen-test-case',     cls: 'test-block', re: /^\s*(it|test)\s+['"`]/i,        framework: 'generic' },

    //  Pipeline / stage markers 
    { id: 'gen-stage-marker',  cls: 'stage',      re: /^\[Stage:\s*[^\]]+\]/i,         framework: 'generic' },
    { id: 'gen-phase-marker',  cls: 'stage',      re: /^={3,}\s*.+\s*={3,}$/,          framework: 'generic' },
    { id: 'gen-step-marker',   cls: 'stage',      re: /^Step\s+\d+\s*(\/\s*\d+)?\s*:/i, framework: 'generic' },
];

// Classify a single console-log line. A leading [LEVEL] prefix wins;
// otherwise CLV_PATTERNS is checked in order with first-match semantics.
function clvClassifyLine(text) {
    const prefixMatch = text.slice(0, 80).match(/\[\s*(ERROR|FATAL|SEVERE|WARN(?:ING)?|INFO|DEBUG|TRACE)\s*\]/i);
    if (prefixMatch) {
        const level = prefixMatch[1].toUpperCase();
        if (level === 'ERROR' || level === 'FATAL' || level === 'SEVERE') {
            return 'error';
        }
        if (level === 'WARN' || level === 'WARNING') return 'warn';
        // INFO / DEBUG / TRACE — never an error regardless of body content.
        return 'info';
    }

    for (let i = 0; i < CLV_PATTERNS.length; i++) {
        if (CLV_PATTERNS[i].re.test(text)) return CLV_PATTERNS[i].cls;
    }
    return 'plain';
}

// Classify + index a line, then update stats and the scenario/test structure.
function clvProcessLine(text) {
    if (text == null) text = '';
    const cls = clvClassifyLine(text);
    const idx = clvState.rawLines.length;
    clvState.rawLines.push({ text, cls, lineNum: idx + 1 });

    if (cls === 'error') {
        clvState.stats.errors++;
        clvState.errorIndices.push(idx);
    }
    if (cls === 'warn') clvState.stats.warnings++;
    if (cls === 'info') clvState.stats.info++;
    if (cls === 'scenario' || cls === 'test-block') clvState.stats.scenarios++;
    if (cls === 'step-fail') clvState.stats.failedScenarios++;
    clvState.stats.lines++;

    //  Build the scenario / test-block structure used by the Steps view 
    if (cls === 'scenario') {
        const name = text.replace(/^.*?Scenario(?:\s+Outline)?:\s*/, '').replace(/\s*#.*$/, '').trim();
        clvState.parsedScenarios.push({
            name: name,
            lineIdx: idx,
            status: 'pass',
            steps: [],
            errorLines: [],
            framework: 'cucumber',
        });
    } else if (cls === 'test-block') {
        // Generic test/spec/suite header from any framework.
        const name = text.replace(/^\s*[✓✗✘×·]\s*/, '')
                         .replace(/^\s*(Test|Spec|Describe|Context|Suite|Running|it|test)\s*:\s*/i, '')
                         .replace(/\(\d+(\.\d+)?m?s\)\s*$/, '')
                         .replace(/['"`]/g, '').trim() || text.trim();
        const isFail = /[✗✘×]|fail/i.test(text);
        clvState.parsedScenarios.push({
            name: name,
            lineIdx: idx,
            status: isFail ? 'fail' : 'pass',
            steps: [],
            errorLines: [],
            framework: 'generic',
        });
    } else if ((cls === 'step-pass' || cls === 'step-fail' || cls === 'step-skip') && clvState.parsedScenarios.length > 0) {
        const sc = clvState.parsedScenarios[clvState.parsedScenarios.length - 1];
        const stepText = text.replace(/^\s*[\u2714\u2718\u21b7]\s*/, '').replace(/\s*#.*$/, '').replace(/\s*\.\.\.\s*(PASSED|FAILED|SKIPPED).*$/, '').trim();
        const stepStatus = cls === 'step-pass' ? 'pass' : cls === 'step-fail' ? 'fail' : 'skip';
        sc.steps.push({ text: stepText, status: stepStatus, lineIdx: idx, error: null });
        if (stepStatus === 'fail') sc.status = 'fail';
    } else if ((cls === 'error' || cls === 'stacktrace') && clvState.parsedScenarios.length > 0) {
        const sc = clvState.parsedScenarios[clvState.parsedScenarios.length - 1];
        // Attach the error to the last failed step in this scenario/block.
        if (sc.steps.length > 0 && sc.steps[sc.steps.length - 1].status === 'fail') {
            if (!sc.steps[sc.steps.length - 1].error) sc.steps[sc.steps.length - 1].error = [];
            sc.steps[sc.steps.length - 1].error.push(text);
        } else if (sc.framework === 'generic') {
            // Generic blocks have no explicit steps — mark the block failed.
            sc.status = 'fail';
        }
        sc.errorLines.push(idx);
    }
}

// Rebuild filteredIndices from the active filter (all / errors / warnings / info / steps).
function clvBuildFilteredList() {
    const f = clvState.activeFilter;
    clvState.filteredIndices = [];
    clvState.renderedUpTo = 0;

    for (let i = 0; i < clvState.rawLines.length; i++) {
        const { cls } = clvState.rawLines[i];
        if (f === 'all') { clvState.filteredIndices.push(i); continue; }
        if (f === 'errors' && (cls === 'error' || cls === 'stacktrace' || cls === 'step-fail' || cls === 'summary' || cls === 'result-summary')) { clvState.filteredIndices.push(i); continue; }
        if (f === 'warnings' && cls === 'warn') { clvState.filteredIndices.push(i); continue; }
        if (f === 'info' && (cls === 'info' || cls === 'stage' || cls === 'pipeline')) { clvState.filteredIndices.push(i); continue; }
        if (f === 'steps' && (cls === 'feature' || cls === 'scenario' || cls === 'step' || cls === 'step-pass' || cls === 'step-fail' || cls === 'step-skip' || cls === 'test-block')) { clvState.filteredIndices.push(i); continue; }
    }
}

// Render the next chunk of filtered log lines (chunkSize at a time).
function clvRenderChunk() {
    const container = document.getElementById('clv-log-container');
    const start = clvState.renderedUpTo;
    const end = Math.min(start + clvState.chunkSize, clvState.filteredIndices.length);

    if (start >= clvState.filteredIndices.length) return;

    const fragment = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
        const rawIdx = clvState.filteredIndices[i];
        const { text, cls, lineNum } = clvState.rawLines[rawIdx];

        const div = document.createElement('div');
        div.className = 'clv-line';
        div.dataset.rawIdx = rawIdx;

        const clsMap = {
            'error': 'clv-line--error', 'warn': 'clv-line--warn', 'info': 'clv-line--info',
            'step': 'clv-line--step', 'step-pass': 'clv-line--step clv-line--step-pass',
            'step-fail': 'clv-line--step-fail', 'step-skip': 'clv-line--step-skip',
            'stacktrace': 'clv-line--stacktrace', 'pipeline': 'clv-line--pipeline',
            'scenario': 'clv-line--scenario', 'feature': 'clv-line--feature',
            'summary': 'clv-line--summary',
            'test-block': 'clv-line--scenario',     // renders like a scenario header
            'stage': 'clv-line--pipeline',          // renders like a pipeline line
            'result-summary': 'clv-line--summary',  // renders like a summary line
        };
        if (clsMap[cls]) div.className += ' ' + clsMap[cls];

        const numSpan = document.createElement('span');
        numSpan.className = 'clv-line-num';
        numSpan.textContent = lineNum;
        numSpan.title = 'Click to anchor • Double-click to copy line';
        numSpan.addEventListener('click', function(ev) { ev.stopPropagation(); clvAnchorLine(rawIdx, div); });
        numSpan.addEventListener('dblclick', function(ev) { ev.stopPropagation(); clvCopyLine(rawIdx); });

        const textSpan = document.createElement('span');
        textSpan.className = 'clv-line-text';

        // Section headers get a fold toggle so the user can collapse the block.
        if (cls === 'feature' || cls === 'scenario' || cls === 'test-block') {
            const foldBtn = document.createElement('span');
            foldBtn.className = 'clv-fold-toggle';
            foldBtn.textContent = '▾';
            foldBtn.addEventListener('click', function(ev) { ev.stopPropagation(); clvToggleFold(rawIdx, foldBtn); });
            textSpan.appendChild(foldBtn);
            const textNode = document.createElement('span');
            textNode.innerHTML = clvLinkifyHtml(escapeHtml(text));
            textSpan.appendChild(textNode);
        } else {
            textSpan.innerHTML = clvLinkifyHtml(escapeHtml(text));
        }

        div.appendChild(numSpan);
        div.appendChild(textSpan);
        fragment.appendChild(div);
    }

    container.appendChild(fragment);
    clvState.renderedUpTo = end;

    if (clvState.searchTerm) clvHighlightSearch();
}

// IntersectionObserver-driven progressive rendering: render the next chunk
// when the sentinel scrolls into view.
function clvSetupObserver() {
    if (clvState.observer) clvState.observer.disconnect();

    const sentinel = document.getElementById('clv-sentinel');
    const body = document.getElementById('clv-body');

    clvState.observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && clvState.renderedUpTo < clvState.filteredIndices.length) {
            clvRenderChunk();
            clvRecycleDom();
        }
    }, { root: body, rootMargin: '200px' });

    clvState.observer.observe(sentinel);

    body.removeEventListener('scroll', clvOnBodyScroll);
    body.addEventListener('scroll', clvOnBodyScroll, { passive: true });
}

let _clvRecycleTimer = null;

// Debounce scroll-driven DOM recycling so fast scrolls don't thrash.
function clvOnBodyScroll() {
    clvMarkActive();
    if (_clvRecycleTimer) return;
    _clvRecycleTimer = setTimeout(() => {
        _clvRecycleTimer = null;
        clvRecycleDom();
    }, 150);
}

// Drop DOM lines that are far outside the viewport to cap memory on huge logs.
// Two-pass: collect candidates first, then remove in a batch — interleaving
// getBoundingClientRect() and remove() would force a reflow per row.
function clvRecycleDom() {
    const container = document.getElementById('clv-log-container');
    const body = document.getElementById('clv-body');
    if (!container || !body) return;

    const children = container.children;
    const overflow = children.length - clvState.domWindowSize;
    if (overflow < clvState.domWindowSize * 0.2) return;   // not enough to bother

    const bodyRect = body.getBoundingClientRect();
    const buffer = bodyRect.height * 2;   // keep 2 viewport heights above/below

    // Read pass — collect references; no DOM mutation yet so the layout
    // that getBoundingClientRect() reads stays consistent in this batch.
    const toRemove = [];
    let i = 0;
    while (i < overflow && i < children.length) {
        const node = children[i];
        const rect = node.getBoundingClientRect();
        if (rect.bottom < bodyRect.top - buffer) {
            toRemove.push(node);
            i++;
        } else {
            break;
        }
    }
    let j = children.length - 1;
    let bottomBudget = overflow - toRemove.length;
    while (bottomBudget > 0 && j >= 0) {
        const node = children[j];
        const rect = node.getBoundingClientRect();
        if (rect.top > bodyRect.bottom + buffer) {
            toRemove.push(node);
            bottomBudget--;
            j--;
        } else {
            break;
        }
    }

    // Write pass — batch removals so no forced reflow happens per removal.
    for (const node of toRemove) node.remove();
}

// Repaint the stats footer (line / error / warning / scenario counts).
function clvUpdateStats() {
    const s = clvState.stats;
    document.getElementById('clv-total-lines').textContent = s.lines.toLocaleString();
    document.getElementById('clv-error-count').textContent = s.errors;
    document.getElementById('clv-warn-count').textContent = s.warnings;

    const scStat = document.getElementById('clv-sc-stat');
    const fscStat = document.getElementById('clv-fsc-stat');
    if (s.scenarios > 0) {
        scStat.style.display = '';
        document.getElementById('clv-sc-count').textContent = s.scenarios;
    } else {
        scStat.style.display = 'none';
    }
    if (s.failedScenarios > 0) {
        fscStat.style.display = '';
        document.getElementById('clv-fsc-count').textContent = s.failedScenarios;
    } else {
        fscStat.style.display = 'none';
    }

    const errNav = document.getElementById('clv-err-nav');
    if (errNav) {
        errNav.style.display = clvState.errorIndices.length > 0 ? '' : 'none';
        clvUpdateErrNavButtons();
    }
}

// Group consecutive error/stacktrace/step-fail lines into navigable blocks,
// allowing small gaps for blank lines / context. Anchor = first true 'error' line.
function clvBuildErrorBlocks() {
    const blocks = [];
    const errorClasses = new Set(['error', 'stacktrace', 'step-fail']);
    let current = null;

    for (let i = 0; i < clvState.rawLines.length; i++) {
        const cls = clvState.rawLines[i].cls;
        if (errorClasses.has(cls)) {
            if (current === null) {
                current = { startIdx: i, endIdx: i, anchorIdx: i };
            } else if (i - current.endIdx <= 3) {
                current.endIdx = i;
            } else {
                blocks.push(current);
                current = { startIdx: i, endIdx: i, anchorIdx: i };
            }
            if (cls === 'error' && clvState.rawLines[current.anchorIdx].cls !== 'error') {
                current.anchorIdx = i;
            }
        }
    }
    if (current !== null) blocks.push(current);
    clvState.errorBlocks = blocks;
}

// Sync the prev/next/first button states with the current cursor position.
function clvUpdateErrNavButtons() {
    const total = clvState.errorBlocks.length;
    const cur = clvState.errorBlockCursor;
    const posEl = document.getElementById('clv-err-pos');
    const firstBtn = document.getElementById('clv-err-first');
    const prevBtn = document.getElementById('clv-err-prev');
    const nextBtn = document.getElementById('clv-err-next');
    if (!posEl) return;

    if (total === 0) { posEl.textContent = ''; return; }

    if (cur === -1) {
        // Initial state — Next acts as "jump to first" so there are two entry points.
        posEl.textContent = total + ' error ' + (total === 1 ? 'block' : 'blocks');
        firstBtn.disabled = false;
        prevBtn.disabled = true;
        nextBtn.disabled = false;
    } else {
        posEl.textContent = (cur + 1) + ' / ' + total;
        firstBtn.disabled = false;
        prevBtn.disabled = cur <= 0;
        nextBtn.disabled = cur >= total - 1;
    }
}

// Is this block's anchor line currently visible in the viewport?
function clvIsBlockVisible(block) {
    const body = document.getElementById('clv-body');
    const container = document.getElementById('clv-log-container');
    if (!body || !container) return false;

    const anchorEl = container.querySelector(`[data-raw-idx="${block.anchorIdx}"]`);
    if (!anchorEl) return false;

    const bodyRect = body.getBoundingClientRect();
    const elRect = anchorEl.getBoundingClientRect();
    return elRect.top >= bodyRect.top && elRect.bottom <= bodyRect.bottom;
}

// Make sure `filterIdxTarget` is currently in the DOM, re-rendering a window
// around it if recycling has dropped it.
function clvEnsureRendered(filterIdxTarget) {
    if (filterIdxTarget < 0 || filterIdxTarget >= clvState.filteredIndices.length) return;
    const container = document.getElementById('clv-log-container');
    const rawIdx = clvState.filteredIndices[filterIdxTarget];
    if (container.querySelector(`[data-raw-idx="${rawIdx}"]`)) return;

    container.innerHTML = '';
    const windowHalf = Math.floor(clvState.chunkSize * 2);
    clvState.renderedUpTo = Math.max(0, filterIdxTarget - windowHalf);

    while (clvState.renderedUpTo <= filterIdxTarget && clvState.renderedUpTo < clvState.filteredIndices.length) {
        clvRenderChunk();
    }
}

// Scroll to the cursor's error block and highlight every line in it.
function _clvScrollToErrorBlock(cursorIdx) {
    const blocks = clvState.errorBlocks;
    const block = blocks[cursorIdx];
    if (!block) { clvUpdateErrNavButtons(); return; }

    const anchorRawIdx = block.anchorIdx;
    const filterIdx = clvState.filteredIndices.indexOf(anchorRawIdx);
    if (filterIdx === -1) { clvUpdateErrNavButtons(); return; }

    clvEnsureRendered(filterIdx);

    const container = document.getElementById('clv-log-container');
    const anchorEl = container.querySelector(`[data-raw-idx="${anchorRawIdx}"]`);
    if (anchorEl) anchorEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

    for (let ri = block.startIdx; ri <= block.endIdx; ri++) {
        const lineEl = container.querySelector(`[data-raw-idx="${ri}"]`);
        if (lineEl) {
            lineEl.classList.add('clv-line--error-active');
            if (ri === block.anchorIdx) lineEl.classList.add('clv-line--error-block-anchor');
        }
    }

    clvUpdateErrNavButtons();
}

// Jump between error blocks (first / next / prev). Skips blocks already in view.
function clvErrNav(action) {
    clvMarkActive();
    if (clvState.phase !== 'ready') return;
    const blocks = clvState.errorBlocks;
    if (blocks.length === 0) return;

    document.querySelectorAll('.clv-line--error-active').forEach(el => el.classList.remove('clv-line--error-active'));
    document.querySelectorAll('.clv-line--error-block-anchor').forEach(el => el.classList.remove('clv-line--error-block-anchor'));

    // Only 'all' / 'errors' filters surface error blocks.
    if (clvState.activeFilter !== 'all' && clvState.activeFilter !== 'errors') {
        clvSetFilter('all');
    }

    if (action === 'first') {
        clvState.errorBlockCursor = 0;
    } else if (action === 'next') {
        // Treat Next as "jump to first" when nothing is active yet.
        if (clvState.errorBlockCursor === -1) {
            clvState.errorBlockCursor = 0;
            _clvScrollToErrorBlock(0);
            return;
        }
        let candidate = clvState.errorBlockCursor + 1;
        while (candidate < blocks.length && clvIsBlockVisible(blocks[candidate])) {
            candidate++;
        }
        if (candidate < blocks.length) {
            clvState.errorBlockCursor = candidate;
        } else if (clvState.errorBlockCursor < blocks.length - 1) {
            clvState.errorBlockCursor = blocks.length - 1;
        }
    } else if (action === 'prev') {
        let candidate = clvState.errorBlockCursor - 1;
        while (candidate >= 0 && clvIsBlockVisible(blocks[candidate])) {
            candidate--;
        }
        if (candidate >= 0) {
            clvState.errorBlockCursor = candidate;
        } else if (clvState.errorBlockCursor > 0) {
            clvState.errorBlockCursor = 0;
        }
    }

    _clvScrollToErrorBlock(clvState.errorBlockCursor);
}

// Switch the active filter and rebuild the log view.
function clvSetFilter(filter) {
    clvMarkActive();
    clvState.activeFilter = filter;
    document.querySelectorAll('.clv-filter-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.clvFilter === filter));

    // Reset error-nav cursor so next/prev starts fresh.
    clvState.errorBlockCursor = -1;
    document.querySelectorAll('.clv-line--error-active').forEach(el =>
        el.classList.remove('clv-line--error-active'));
    document.querySelectorAll('.clv-line--error-block-anchor').forEach(el =>
        el.classList.remove('clv-line--error-block-anchor'));
    clvUpdateErrNavButtons();

    const container = document.getElementById('clv-log-container');
    container.innerHTML = '';

    // Steps view has its own structured renderer.
    if (filter === 'steps') {
        clvRenderStepsView(container);
        return;
    }

    clvBuildFilteredList();
    clvState.renderedUpTo = 0;
    clvRenderChunk();
    clvSetupObserver();

    if (clvState.searchTerm) clvSearch(clvState.searchTerm);
}

// Steps view — structured render of scenarios / test blocks with errors inline.
function clvRenderStepsView(container) {
    if (clvState.parsedScenarios.length === 0) {
        container.innerHTML = '<div style="padding:40px 20px;color:#64748B;text-align:center;font-size:13px">No scenarios or test blocks found in this log.</div>';
        return;
    }

    const fragment = document.createDocumentFragment();

    for (const sc of clvState.parsedScenarios) {
        const header = document.createElement('div');
        header.className = 'clv-scenario-header';
        const statusBadge = document.createElement('span');
        statusBadge.className = 'clv-scenario-status clv-scenario-status--' + sc.status;
        statusBadge.textContent = sc.status === 'fail' ? 'FAIL' : 'PASS';
        const nameSpan = document.createElement('span');
        // Cucumber → "Scenario:"; everything else → "Test:".
        const labelPrefix = sc.framework === 'cucumber' ? 'Scenario: ' : 'Test: ';
        nameSpan.textContent = labelPrefix + sc.name;
        header.appendChild(statusBadge);
        header.appendChild(nameSpan);
        fragment.appendChild(header);

        for (const step of sc.steps) {
            const entry = document.createElement('div');
            entry.className = 'clv-step-entry clv-step-entry--' + step.status;

            const marker = document.createElement('span');
            marker.className = 'clv-step-marker';
            marker.textContent = step.status === 'pass' ? '\u2714' : step.status === 'fail' ? '\u2718' : '\u21b7';

            const textSpan = document.createElement('span');
            textSpan.className = 'clv-step-text';
            textSpan.textContent = step.text;

            entry.appendChild(marker);
            entry.appendChild(textSpan);
            fragment.appendChild(entry);

            // Inline the step's error lines, separating message from deep stack frames.
            if (step.error && step.error.length > 0) {
                const errBlock = document.createElement('div');
                errBlock.className = 'clv-step-error';
                const errLines = step.error.filter(l => !(/^\s+at\s/.test(l) || /^\s+\tat\s/.test(l) || /\.\.\.\s\d+\smore$/.test(l)));
                const traceLines = step.error.filter(l => /^\s+at\s/.test(l) || /^\s+\tat\s/.test(l) || /\.\.\.\s\d+\smore$/.test(l) || /^\s+\u273d\./.test(l));
                let errText = errLines.map(l => l.trim()).join('\n');
                if (traceLines.length > 0) {
                    errText += '\n' + traceLines.slice(0, 4).map(l => l.trim()).join('\n');
                    if (traceLines.length > 4) errText += '\n    ... ' + (traceLines.length - 4) + ' more frames';
                }
                errBlock.textContent = errText;
                fragment.appendChild(errBlock);
            }
        }

        // Generic blocks (Playwright, Cypress, etc.) have no explicit steps —
        // attach error lines directly under the header.
        if (sc.steps.length === 0 && sc.errorLines.length > 0) {
            const errBlock = document.createElement('div');
            errBlock.className = 'clv-step-error';
            const errTexts = sc.errorLines.slice(0, 12).map(idx => clvState.rawLines[idx]?.text?.trim() || '');
            let errText = errTexts.join('\n');
            if (sc.errorLines.length > 12) errText += '\n    ... ' + (sc.errorLines.length - 12) + ' more lines';
            errBlock.textContent = errText;
            fragment.appendChild(errBlock);
        }
    }

    container.appendChild(fragment);
}

function clvJumpToFirstError() {
    clvErrNav('first');
}

// Search for a term across filtered lines and jump to the first match.
function clvSearch(term) {
    clvMarkActive();
    clvState.searchTerm = term.toLowerCase();
    clvState.searchMatches = [];
    clvState.searchCursor = -1;

    // Clear previous highlights while preserving fold toggles.
    document.querySelectorAll('.clv-line-text').forEach(textEl => {
        if (!textEl.querySelector('.clv-match')) return;
        const lineEl = textEl.closest('.clv-line');
        const rawIdx = lineEl ? parseInt(lineEl.dataset.rawIdx, 10) : -1;
        const rawText = rawIdx >= 0 && clvState.rawLines[rawIdx] ? clvState.rawLines[rawIdx].text : textEl.textContent;
        const foldToggle = textEl.querySelector('.clv-fold-toggle');
        if (foldToggle) {
            const foldHtml = foldToggle.outerHTML;
            const textNode = document.createElement('span');
            textNode.innerHTML = clvLinkifyHtml(escapeHtml(rawText));
            textEl.innerHTML = foldHtml;
            textEl.appendChild(textNode);
            const newToggle = textEl.querySelector('.clv-fold-toggle');
            if (newToggle) newToggle.addEventListener('click', function(ev) { ev.stopPropagation(); clvToggleFold(rawIdx, newToggle); });
        } else {
            textEl.innerHTML = clvLinkifyHtml(escapeHtml(rawText));
        }
    });

    const countEl = document.getElementById('clv-search-count');
    if (!term) { countEl.textContent = ''; return; }

    for (let i = 0; i < clvState.filteredIndices.length; i++) {
        const rawIdx = clvState.filteredIndices[i];
        if (clvState.rawLines[rawIdx].text.toLowerCase().includes(clvState.searchTerm)) {
            clvState.searchMatches.push(i);
        }
    }

    countEl.textContent = clvState.searchMatches.length > 0
        ? clvState.searchMatches.length + ' found'
        : 'No matches';

    if (clvState.searchMatches.length > 0) {
        clvHighlightSearch();
        clvSearchNav(1);   // jump to first match
    }
}

// Highlight search matches in currently rendered lines.
function clvHighlightSearch() {
    if (!clvState.searchTerm) return;
    const container = document.getElementById('clv-log-container');
    const lines = container.querySelectorAll('.clv-line');
    const term = clvState.searchTerm;

    lines.forEach(lineEl => {
        const textEl = lineEl.querySelector('.clv-line-text');
        if (!textEl) return;

        // Use raw text — textContent would include the fold-toggle characters.
        const rawIdx = parseInt(lineEl.dataset.rawIdx, 10);
        const rawText = clvState.rawLines[rawIdx] ? clvState.rawLines[rawIdx].text : textEl.textContent;
        const lower = rawText.toLowerCase();

        if (!lower.includes(term)) return;

        const foldToggle = textEl.querySelector('.clv-fold-toggle');
        const foldHtml = foldToggle ? foldToggle.outerHTML : '';

        const temp = document.createElement('span');
        temp.innerHTML = clvLinkifyHtml(escapeHtml(rawText));
        clvHighlightTermInTextNodes(temp, term);

        textEl.innerHTML = foldHtml + temp.innerHTML;

        // Re-bind the preserved fold toggle's click handler.
        if (foldHtml) {
            const newToggle = textEl.querySelector('.clv-fold-toggle');
            if (newToggle) {
                newToggle.addEventListener('click', function(ev) { ev.stopPropagation(); clvToggleFold(rawIdx, newToggle); });
            }
        }
    });
}

// Wrap every occurrence of `term` inside `root` in a .clv-match span.
// Idempotent — already-wrapped text nodes are skipped.
function clvHighlightTermInTextNodes(root, term) {
    if (!term) return;
    const termLow = term.toLowerCase();
    const termLen = term.length;

    // Collect text nodes up front — never iterate a TreeWalker while mutating.
    const walker = document.createTreeWalker(
        root, NodeFilter.SHOW_TEXT,
        {
            acceptNode: function(node) {
                if (node.parentNode && node.parentNode.classList &&
                    node.parentNode.classList.contains('clv-match')) {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            }
        }
    );
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);

    for (const textNode of nodes) {
        const text = textNode.nodeValue;
        const lower = text.toLowerCase();
        let idx = lower.indexOf(termLow);
        if (idx === -1) continue;

        const frag = document.createDocumentFragment();
        let pos = 0;
        while (idx !== -1) {
            if (idx > pos) {
                frag.appendChild(document.createTextNode(text.substring(pos, idx)));
            }
            const mark = document.createElement('span');
            mark.className = 'clv-match';
            mark.textContent = text.substring(idx, idx + termLen);
            frag.appendChild(mark);
            pos = idx + termLen;
            idx = lower.indexOf(termLow, pos);
        }
        if (pos < text.length) {
            frag.appendChild(document.createTextNode(text.substring(pos)));
        }
        textNode.parentNode.replaceChild(frag, textNode);
    }
}

// Step to the next/previous search match.
function clvSearchNav(direction) {
    clvMarkActive();
    if (clvState.searchMatches.length === 0) return;

    document.querySelectorAll('.clv-match-active').forEach(el => el.classList.remove('clv-match-active'));

    clvState.searchCursor += direction;
    if (clvState.searchCursor >= clvState.searchMatches.length) clvState.searchCursor = 0;
    if (clvState.searchCursor < 0) clvState.searchCursor = clvState.searchMatches.length - 1;

    const filterIdx = clvState.searchMatches[clvState.searchCursor];

    clvEnsureRendered(filterIdx);

    const rawIdx = clvState.filteredIndices[filterIdx];
    const container = document.getElementById('clv-log-container');
    const line = container.querySelector(`[data-raw-idx="${rawIdx}"]`);
    if (line) {
        line.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const match = line.querySelector('.clv-match');
        if (match) match.classList.add('clv-match-active');
    }

    document.getElementById('clv-search-count').textContent =
        (clvState.searchCursor + 1) + ' / ' + clvState.searchMatches.length;
}

// CLV keyboard shortcuts: Ctrl/Cmd+F focuses search; Enter / Shift+Enter cycle matches.
// Escape lives in setupEventListeners() so it has priority over the modal stack.
document.addEventListener('keydown', function(e) {
    const overlay = document.getElementById('clv-overlay');
    if (!overlay || !overlay.classList.contains('active')) return;

    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        const input = document.getElementById('clv-search');
        if (input) { input.focus(); input.select(); }
        return;
    }

    if (e.key === 'Enter' && document.activeElement && document.activeElement.id === 'clv-search') {
        e.preventDefault();
        clvSearchNav(e.shiftKey ? -1 : 1);
        return;
    }
});

// Drag-to-resize the CLV panel from any of its edges. Resize is symmetric:
// the panel grows/shrinks equally from the centre.
(function() {
    const MIN_W = 960;
    const MIN_H_VH = 82;

    function getMinH() { return window.innerHeight * MIN_H_VH / 100; }

    document.addEventListener('mousedown', function(e) {
        const handle = e.target.closest('[data-clv-resize]');
        if (!handle) return;
        e.preventDefault();

        const panel = document.getElementById('clv-panel');
        if (!panel) return;

        const dir = handle.dataset.clvResize;   // 'e' | 's' | 'se' | 'w' | 'sw'
        const startX = e.clientX;
        const startY = e.clientY;
        const rect = panel.getBoundingClientRect();
        const startW = rect.width;
        const startH = rect.height;
        const minH = getMinH();
        const maxW = window.innerWidth * 0.98;
        const maxH = window.innerHeight * 0.96;

        panel.classList.add('clv-resizing');

        function onMove(ev) {
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;
            let newW = startW;
            let newH = startH;

            // *2 because the panel grows symmetrically from the centre.
            if (dir.includes('e')) {
                newW = startW + dx * 2;
            } else if (dir.includes('w')) {
                newW = startW - dx * 2;
            }
            if (dir.includes('s')) {
                newH = startH + dy * 2;
            }

            newW = Math.max(MIN_W, Math.min(newW, maxW));
            newH = Math.max(minH, Math.min(newH, maxH));

            panel.style.setProperty('--clv-w', newW + 'px');
            panel.style.setProperty('--clv-h', newH + 'px');
        }

        function onUp() {
            panel.classList.remove('clv-resizing');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
})();

function clvCopyFiltered() {
    const lines = [];
    for (const rawIdx of clvState.filteredIndices) {
        lines.push(clvState.rawLines[rawIdx].text);
    }
    if (lines.length === 0) return;

    navigator.clipboard.writeText(lines.join('\n')).then(() => {
        clvShowCopyToast('Copied ' + lines.length + ' lines');
    }).catch(() => {
        clvShowCopyToast('Copy failed');
    });
}

function clvCopyLine(rawIdx) {
    const line = clvState.rawLines[rawIdx];
    if (!line) return;
    navigator.clipboard.writeText(line.text).then(() => {
        clvShowCopyToast('Line ' + line.lineNum + ' copied');
    }).catch(() => {});
}

function clvShowCopyToast(msg) {
    const toast = document.getElementById('clv-copy-toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('visible');
    clearTimeout(clvState._toastTimer);
    clvState._toastTimer = setTimeout(() => toast.classList.remove('visible'), 1500);
}

// Download the full log as a .log file.
function clvDownload() {
    if (clvState.rawLines.length === 0) return;
    const jobName = (document.getElementById('clv-job-name').textContent || 'console').replace(/\s+/g, '-');
    const buildNum = (document.getElementById('clv-build-info').textContent || '').replace(/\D/g, '');
    const filename = jobName + '-build-' + buildNum + '.log';

    const text = clvState.rawLines.map(l => l.text).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Toggle the anchor on a line — only one anchor can be active at a time.
function clvAnchorLine(rawIdx, lineEl) {
    if (lineEl.classList.contains('clv-line--anchored')) {
        lineEl.classList.remove('clv-line--anchored');
        return;
    }
    const prev = document.querySelector('.clv-line--anchored');
    if (prev) prev.classList.remove('clv-line--anchored');
    lineEl.classList.add('clv-line--anchored');
}

// Collapse/expand feature / scenario / test-block sections.
function clvToggleFold(rawIdx, toggleEl) {
    const container = document.getElementById('clv-log-container');
    const isCollapsed = toggleEl.classList.toggle('collapsed');
    const triggerLine = clvState.rawLines[rawIdx];
    const isFeat = triggerLine.cls === 'feature';
    const sectionHeaders = new Set(['feature', 'scenario', 'test-block']);

    const allLines = container.querySelectorAll('.clv-line');
    let found = false;
    for (const el of allLines) {
        const idx = parseInt(el.dataset.rawIdx, 10);
        if (idx === rawIdx) { found = true; continue; }
        if (!found) continue;

        const cls = clvState.rawLines[idx].cls;
        // Stop at the next boundary — next feature (when folding a feature)
        // or next section header (when folding a scenario/test-block).
        if (isFeat && cls === 'feature') break;
        if (!isFeat && sectionHeaders.has(cls)) break;

        if (isCollapsed) {
            el.classList.add('clv-line--folded');
        } else {
            el.classList.remove('clv-line--folded');
        }
    }

    toggleEl.textContent = isCollapsed ? '▸' : '▾';
}

// Close the CLV modal and release all state so memory doesn't grow per-open.
function clvClose() {
    const overlay = document.getElementById('clv-overlay');
    if (overlay) overlay.setAttribute('aria-hidden', 'true');
    overlay.classList.remove('active');

    if (clvState.abortController) {
        clvState.abortController.abort();
        clvState.abortController = null;
    }

    if (_clvRecycleTimer) { clearTimeout(_clvRecycleTimer); _clvRecycleTimer = null; }

    // Idle-shrink timer must die with the modal — otherwise it would
    // fire later and try to shrink state that's already been wiped.
    if (clvState.idleTimer) { clearTimeout(clvState.idleTimer); clvState.idleTimer = null; }

    document.getElementById('clv-log-container').innerHTML = '';
    clvState.rawLines = [];
    clvState.filteredIndices = [];
    clvState.searchMatches = [];
    clvState.renderedUpTo = 0;
    clvState.errorIndices = [];
    clvState.errorBlocks = [];
    clvState.errorBlockCursor = -1;
    clvState.parsedScenarios = [];
    clvState.phase = 'idle';
    clvState.cachedSource = false;
    clvState.domWindowStart = 0;
    // Metadata can go too — nothing references it once the modal is shut.
    clvState.lastJobUrl = '';
    clvState.lastBuildNum = '';
    clvState.lastJobName = '';
    clvState.lastScrollTop = 0;
    clvState.lastActivityAt = 0;

    if (clvState.observer) {
        clvState.observer.disconnect();
        clvState.observer = null;
    }

    const body = document.getElementById('clv-body');
    if (body) body.removeEventListener('scroll', clvOnBodyScroll);
}

// Legacy aliases — keep until all call sites migrate to clvOpen / clvClose.
function openErrorLogModal(jobId) { clvOpen(jobId); }
function closeErrorLogModal() { clvClose(); }
