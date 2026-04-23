// Console Log Viewer (CLV) — Interactive log viewer for Jenkins builds with filtering, search, and error navigation
// Extracted from dashboard.html for maintainability as part of the phased JS extraction refactor

'use strict';

// Global state object for the console log viewer, tracking raw lines, filtering, search, and DOM virtualization
const clvState = {
    rawLines: [],           // Full array of { text, cls, lineNum }
    filteredIndices: [],     // Indices into rawLines matching current filter
    renderedUpTo: 0,        // How many filteredIndices have been rendered
    chunkSize: 120,         // Lines per render chunk
    activeFilter: 'all',
    searchTerm: '',
    searchMatches: [],      // Indices into filteredIndices that contain search term
    searchCursor: -1,
    observer: null,
    stats: { errors: 0, warnings: 0, info: 0, lines: 0, scenarios: 0, failedScenarios: 0 },
    errorIndices: [],       // All rawLine indices classified as 'error'
    errorBlocks: [],        // Grouped error blocks: [{ startIdx, endIdx, anchorIdx }]
    errorBlockCursor: -1,   // Current block position (-1 = not started)
    parsedScenarios: [],    // Structured scenario data for Steps view
    // Two-phase loading state
    phase: 'idle',          // 'idle' | 'loading' | 'ready'
    abortController: null,  // AbortController for in-flight fetch
    cachedSource: false,    // Was this log served from server cache?
    // DOM virtualization
    domWindowStart: 0,      // First filteredIndices position in DOM
    domWindowSize: 600,     // Max lines to keep in DOM at once
};

// Open console log modal for a given job, fetch the log, and begin rendering
function clvOpen(jobId) {
    const job = appState.jobs.get(jobId);
    if (!job) {
        console.warn('[CLV] clvOpen: job not found in appState for id:', jobId);
        diagLog('warning', 'CLV', 'Job not found in appState', { raw: jobId });
        return;
    }

    // Abort any in-flight fetch from a previous open
    if (clvState.abortController) {
        clvState.abortController.abort();
        clvState.abortController = null;
    }

    const isRunning = job.is_running || job.latest_status === 'IN_PROGRESS';
    const ref = job.analysis_reference;
    const useRef = isRunning && ref && ['FAILURE','UNSTABLE','ABORTED'].includes(ref.status);

    // Determine build context — safely handle missing three_run_context
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

    // Resolve job URL — handle both frontend property names
    const jobUrl = job.url || job.job_url || job.job_id || jobId;
    if (!jobUrl) {
        console.warn('[CLV] clvOpen: no job URL found for:', job.name || jobId);
        diagLog('warning', 'CLV', 'No job URL found', { raw: job.name || jobId });
        showToast('Cannot open console log — job URL is missing', 'error');
        return;
    }

    // Guard: build number must be resolvable
    if (buildNum === '?') {
        console.warn('[CLV] clvOpen: no build number available for:', jobUrl);
        diagLog('warning', 'CLV', 'No build number available', { raw: jobUrl });
        // Still allow opening — the fetch will handle the error gracefully
    }

    // Populate header — defensive null checks on all DOM elements
    var el;
    el = document.getElementById('clv-job-name');
    if (el) el.textContent = job.name || job.job_name || 'Unknown Job';
    el = document.getElementById('clv-build-info');
    if (el) el.textContent = 'Build #' + buildNum;
    el = document.getElementById('clv-build-status');
    if (el) el.textContent = buildStatus;
    el = document.getElementById('clv-source-ctx');
    if (el) el.textContent = sourceLabel;

    // Status dot color
    const dot = document.getElementById('clv-dot');
    if (dot) {
        dot.className = 'clv-title-dot';
        if (buildStatus === 'FAILURE') dot.classList.add('clv-title-dot--failure');
        else if (buildStatus === 'UNSTABLE') dot.classList.add('clv-title-dot--unstable');
        else if (buildStatus === 'SUCCESS') dot.classList.add('clv-title-dot--success');
        else dot.classList.add('clv-title-dot--aborted');
    }

    // Reset state
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

    // Reset UI — loading phase (all with null guards)
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

    // Gate toolbar + summary during loading phase
    el = document.getElementById('clv-toolbar');
    if (el) { el.classList.add('clv-toolbar--gated'); el.classList.remove('clv-toolbar--ready'); }
    el = document.getElementById('clv-summary');
    if (el) { el.classList.add('clv-summary--gated'); el.classList.remove('clv-summary--ready'); }

    // Reset panel to default size
    const panel = document.getElementById('clv-panel');
    if (panel) { panel.style.removeProperty('--clv-w'); panel.style.removeProperty('--clv-h'); }
    // Set keyboard hint for platform
    const kbdHint = document.getElementById('clv-kbd-hint');
    if (kbdHint) kbdHint.textContent = navigator.platform.indexOf('Mac') > -1 ? '⌘F' : 'Ctrl+F';

    // Show overlay
    el = document.getElementById('clv-overlay');
    if (el) el.classList.add('active');

    // Fetch console log (two-phase)
    clvFetch(jobUrl, buildNum);
}

// Fetch console log from backend API, handles both streaming (SSE) and full text responses
async function clvFetch(jobUrl, buildNum) {
    const controller = new AbortController();
    clvState.abortController = controller;

    try {
        const creds = ensureCredentials();
        if (!creds) throw new Error('Jenkins credentials not available');
        const resp = await fetch('/api/console-log', {
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
            // Try to extract error detail from JSON response body
            let errMsg = 'HTTP ' + resp.status;
            try {
                const ct = resp.headers.get('Content-Type') || '';
                if (ct.includes('application/json')) {
                    const errBody = await resp.json();
                    if (errBody && errBody.error) errMsg = errBody.error;
                }
            } catch (_) { } // keep default errMsg
            throw new Error(errMsg);
        }

        const contentType = resp.headers.get('Content-Type') || '';
        const isCached = resp.headers.get('X-CLV-Cached') === 'true' || contentType.includes('text/plain');
        const source = resp.headers.get('X-CLV-Source') || 'jenkins';
        clvState.cachedSource = isCached;

        if (isCached || contentType.includes('text/plain')) {
            // ── Full response (text/plain) — direct from Jenkins via backend ──
            var loadMsg = document.getElementById('clv-loading-msg');
            if (loadMsg) loadMsg.textContent = 'Processing console log...';
            const text = await resp.text();
            const lines = text.split('\n');
            for (const line of lines) {
                if (line.length > 0 || clvState.rawLines.length > 0) {
                    clvProcessLine(line);
                }
            }
            clvActivateAnalysis();
        } else {
            // ── SSE stream with progress events ──
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

                // Parse SSE events from buffer
                let boundary;
                while ((boundary = buffer.indexOf('\n\n')) !== -1) {
                    const raw = buffer.slice(0, boundary);
                    buffer = buffer.slice(boundary + 2);

                    // Parse "data: {...}" format
                    const match = raw.match(/^data:\s*(.+)$/m);
                    if (!match) continue;

                    let evt;
                    try { evt = JSON.parse(match[1]); } catch (e) { continue; }

                    if (evt.type === 'line') {
                        clvProcessLine(evt.text != null ? evt.text : '');
                    } else if (evt.type === 'progress') {
                        // Update progress UI
                        var bar = document.getElementById('clv-loading-bar');
                        if (bar) bar.style.width = (evt.pct || 0) + '%';
                        var detail = document.getElementById('clv-loading-detail');
                        if (detail) detail.textContent =
                            (evt.loaded || 0).toLocaleString() + ' / ' + (evt.total || 0).toLocaleString() + ' lines (' + (evt.pct || 0) + '%)';
                    } else if (evt.type === 'complete') {
                        // All lines received — transition to analysis phase
                        clvActivateAnalysis();
                    }
                }
            }

            // If we never got a 'complete' event (stream ended), activate anyway
            if (clvState.phase === 'loading') {
                clvActivateAnalysis();
            }
        }

    } catch (err) {
        if (err.name === 'AbortError') return; // User closed overlay during fetch
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

// Transition from loading to ready phase, run full analysis pipeline and enable all features
function clvActivateAnalysis() {
    clvState.phase = 'ready';

    // Hide loading indicator
    var loadingEl = document.getElementById('clv-loading');
    if (loadingEl) loadingEl.style.display = 'none';

    // Run full analysis pipeline (wrapped in try-catch to prevent overlay from breaking)
    try {
        clvBuildErrorBlocks();
        clvBuildFilteredList();
        clvRenderChunk();
        clvUpdateStats();
        clvSetupObserver();
    } catch (analysisErr) {
        console.error('[CLV] Analysis pipeline error:', analysisErr);
        diagLog('error', 'CLV', 'Analysis pipeline error', { stack: analysisErr.stack, raw: analysisErr.message });
        // Still show the raw log even if analysis fails
        clvBuildFilteredList();
        try { clvRenderChunk(); } catch (_) {}
    }

    // Un-gate toolbar and summary — reveal with animation
    var toolbar = document.getElementById('clv-toolbar');
    var summary = document.getElementById('clv-summary');
    if (toolbar) { toolbar.classList.remove('clv-toolbar--gated'); toolbar.classList.add('clv-toolbar--ready'); }
    if (summary) { summary.classList.remove('clv-summary--gated'); summary.classList.add('clv-summary--ready'); }

    // Show cache indicator in source context if served from cache
    if (clvState.cachedSource) {
        var srcCtx = document.getElementById('clv-source-ctx');
        if (srcCtx) {
            var existing = srcCtx.textContent;
            srcCtx.textContent = existing ? existing + ' • Cached' : 'Served from cache';
        }
    }
}

// Pattern registry for classifying log lines — multi-framework, priority-ordered, first match wins
// Each rule: { id, cls, re, framework? } where cls feeds filters, rendering, and stats
const CLV_PATTERNS = [

    // ── Cucumber: step markers (unicode) ──────────────────────────
    { id: 'cuke-step-pass',    cls: 'step-pass',  re: /^\s*\u2714\s/,                  framework: 'cucumber' },
    { id: 'cuke-step-fail',    cls: 'step-fail',  re: /^\s*\u2718\s/,                  framework: 'cucumber' },
    { id: 'cuke-step-skip',    cls: 'step-skip',  re: /^\s*\u21b7\s/,                  framework: 'cucumber' },

    // ── Cucumber: step markers (legacy text) ──────────────────────
    { id: 'cuke-step-pass-legacy', cls: 'step-pass', re: /\.\.\.\s*PASSED\b/,          framework: 'cucumber' },
    { id: 'cuke-step-fail-legacy', cls: 'step-fail', re: /\.\.\.\s*FAILED\b/,          framework: 'cucumber' },
    { id: 'cuke-step-skip-legacy', cls: 'step-skip', re: /\.\.\.\s*SKIPPED\b/,         framework: 'cucumber' },

    // ── Cucumber: scenario / feature headers ──────────────────────
    { id: 'cuke-scenario',     cls: 'scenario',   re: /^(?:\s*|\S.*?\]\s*)Scenario(?:\s+Outline)?:/,  framework: 'cucumber' },
    { id: 'cuke-feature',      cls: 'feature',    re: /(?:^\s*|\[INFO\]\s*)Feature:/,  framework: 'cucumber' },

    // ── Java / JVM log-level markers ──────────────────────────────
    { id: 'java-error',        cls: 'error',      re: /\[ERROR\]|\[FATAL\]|\[SEVERE\]/, framework: 'java' },
    { id: 'java-stacktrace',   cls: 'stacktrace', re: /^\s+\t?at\s/,                   framework: 'java' },
    { id: 'cuke-stackref',     cls: 'stacktrace', re: /^\s+\u273d\./,                  framework: 'cucumber' },
    { id: 'java-more-frames',  cls: 'stacktrace', re: /\.\.\.\s\d+\smore$/,            framework: 'java' },
    { id: 'java-exception',    cls: 'error',      re: /^\s+(java\.|org\.|com\.|net\.)[\w.]+Exception/, framework: 'java' },
    { id: 'java-error-cls',    cls: 'error',      re: /^\s+(java\.|org\.|com\.|net\.)[\w.]+Error/,     framework: 'java' },

    // ── Java / JVM log-level info & warn ──────────────────────────
    { id: 'java-warn',         cls: 'warn',       re: /\[WARN\]/,                      framework: 'java' },
    { id: 'java-info',         cls: 'info',       re: /\[INFO\]/,                      framework: 'java' },

    // ── Cucumber: Given/When/Then keywords ────────────────────────
    { id: 'cuke-keyword',      cls: 'step',       re: /(?:^\s*|\]\s*)(Given|When|Then|And|But)\b/, framework: 'cucumber' },

    // ── Jenkins pipeline (stage-specific rules MUST precede generic [Pipeline]) ─
    { id: 'jenkins-stage',     cls: 'stage',      re: /^\[Pipeline\]\s*\{\s*\(.*\)$/,  framework: 'jenkins' },
    { id: 'jenkins-stage-alt', cls: 'stage',      re: /^Stage\s+"[^"]+"\s*(started|skipped)/i, framework: 'jenkins' },
    { id: 'jenkins-pipeline',  cls: 'pipeline',   re: /^\[Pipeline\]/,                 framework: 'jenkins' },

    // ── Current summary patterns ──────────────────────────────────
    { id: 'summary-results',   cls: 'summary',    re: /TEST RESULTS SUMMARY|FAILED SCENARIOS/, framework: 'generic' },
    { id: 'summary-finished',  cls: 'summary',    re: /^Finished:/,                    framework: 'jenkins' },
    { id: 'summary-banner',    cls: 'summary',    re: /^\s*[|_]{2,}/,                  framework: 'generic' },
    { id: 'summary-tests',     cls: 'summary',    re: /T E S T S/,                     framework: 'generic' },

    // ====================================================================
    //  Cross-framework patterns (additive, lower priority)
    // ====================================================================

    // ── Playwright / JS test-runner errors ────────────────────────
    { id: 'pw-timeout',        cls: 'error',      re: /TimeoutError:|Timed?\s*out\b.*\d+ms/i,         framework: 'playwright' },
    { id: 'pw-locator',        cls: 'error',      re: /locator\s+(resolved|not\s+found|not\s+visible)/i, framework: 'playwright' },
    { id: 'pw-expect-fail',    cls: 'error',      re: /expect\(.*\)\.(toBe|toEqual|toHave|toContain|toMatch)\b/i, framework: 'playwright' },
    { id: 'pw-assertion',      cls: 'error',      re: /AssertionError|AssertError|assert\.\w+\(/i,    framework: 'playwright' },
    { id: 'pw-strict-mode',    cls: 'error',      re: /strict mode violation/i,        framework: 'playwright' },
    { id: 'pw-test-header',    cls: 'test-block',  re: /^\s*[✓✗✘×·]\s+.+\(\d+(\.\d+)?m?s\)\s*$/,    framework: 'playwright' },

    // ── Cypress errors ────────────────────────────────────────────
    { id: 'cy-assert-fail',    cls: 'error',      re: /CypressError:|AssertionError:/,  framework: 'cypress' },
    { id: 'cy-cmd-fail',       cls: 'error',      re: /cy\.\w+\(\)\s*failed/i,        framework: 'cypress' },
    { id: 'cy-element-err',    cls: 'error',      re: /element\s+not\s+(found|visible|interactable)/i, framework: 'cypress' },
    { id: 'cy-spec-header',    cls: 'test-block',  re: /^\s*(Running|Spec|Suite):/i,   framework: 'cypress' },
    { id: 'cy-passing-fail',   cls: 'result-summary', re: /^\s*\d+\s+(passing|failing|pending)\b/i,   framework: 'cypress' },

    // ── Node / JS stack traces ────────────────────────────────────
    { id: 'node-stack',        cls: 'stacktrace', re: /^\s+at\s+.*\(.*:\d+:\d+\)/,    framework: 'node' },
    { id: 'node-stack-anon',   cls: 'stacktrace', re: /^\s+at\s+(async\s+)?[\w.<>]+\s+\(/, framework: 'node' },
    { id: 'node-internal',     cls: 'stacktrace', re: /^\s+at\s+(node:|internal\/)/,   framework: 'node' },

    // ── Result / summary lines (must precede generic error catch-alls because result lines often contain "failed") ───
    { id: 'gen-test-result',   cls: 'result-summary', re: /^\s*Tests?:\s*\d+/i,        framework: 'generic' },
    { id: 'gen-result-count',  cls: 'result-summary', re: /\d+\s+(tests?|specs?|suites?)\s+(passed|failed|skipped)/i, framework: 'generic' },
    { id: 'gen-result-total',  cls: 'result-summary', re: /^(Tests|Suites|Scenarios)\s*:.*\d+\s*(passed|failed)/i,    framework: 'generic' },
    { id: 'gen-build-result',  cls: 'result-summary', re: /^(BUILD|Build)\s+(SUCCESS|FAILURE|UNSTABLE)/i,              framework: 'generic' },

    // ── Generic error keywords (broad catch) ──────────────────────
    { id: 'gen-error-prefix',  cls: 'error',      re: /^ERROR\b|^FATAL\b|^SEVERE\b/,  framework: 'generic' },
    { id: 'gen-failed-line',   cls: 'error',      re: /\bFAILURE\b|\bFAILED\b/i,      framework: 'generic' },
    { id: 'gen-exception',     cls: 'error',      re: /Exception:|Error:|ENOENT|ECONNREFUSED|EACCES/,  framework: 'generic' },
    { id: 'gen-connection',    cls: 'error',      re: /Connection\s+(refused|reset|timed\s*out)/i,     framework: 'generic' },

    // ── Generic warning keywords ──────────────────────────────────
    { id: 'gen-warn-prefix',   cls: 'warn',       re: /^WARN\b|^WARNING\b|Warning:/i,  framework: 'generic' },
    { id: 'gen-deprecation',   cls: 'warn',       re: /\bDeprecationWarning\b|\bDeprecated\b/i,       framework: 'generic' },

    // ── Generic info keywords ─────────────────────────────────────
    { id: 'gen-info-prefix',   cls: 'info',       re: /^INFO\b/,                       framework: 'generic' },

    // ── Test-block / section headers (Playwright, Jest, Mocha, etc) ─
    { id: 'gen-test-header',   cls: 'test-block', re: /^\s*(Test|Spec|Describe|Context|Suite)\s*:/i,   framework: 'generic' },
    { id: 'gen-test-case',     cls: 'test-block', re: /^\s*(it|test)\s+['"`]/i,        framework: 'generic' },

    // ── Pipeline / stage markers ──────────────────────────────────
    { id: 'gen-stage-marker',  cls: 'stage',      re: /^\[Stage:\s*[^\]]+\]/i,         framework: 'generic' },
    { id: 'gen-phase-marker',  cls: 'stage',      re: /^={3,}\s*.+\s*={3,}$/,          framework: 'generic' },
    { id: 'gen-step-marker',   cls: 'stage',      re: /^Step\s+\d+\s*(\/\s*\d+)?\s*:/i, framework: 'generic' },
];

// Classify a single console-log line by testing it against the pattern registry, first match wins
function clvClassifyLine(text) {
    for (let i = 0; i < CLV_PATTERNS.length; i++) {
        if (CLV_PATTERNS[i].re.test(text)) return CLV_PATTERNS[i].cls;
    }
    return 'plain';
}

// Process a single log line: classify it, add to rawLines, update stats, and build scenario/test structure
function clvProcessLine(text) {
    if (text == null) text = '';
    const cls = clvClassifyLine(text);
    const idx = clvState.rawLines.length;
    clvState.rawLines.push({ text, cls, lineNum: idx + 1 });

    // Update stats
    if (cls === 'error') {
        clvState.stats.errors++;
        clvState.errorIndices.push(idx);
    }
    if (cls === 'warn') clvState.stats.warnings++;
    if (cls === 'info') clvState.stats.info++;
    if (cls === 'scenario' || cls === 'test-block') clvState.stats.scenarios++;
    if (cls === 'step-fail') clvState.stats.failedScenarios++;
    clvState.stats.lines++;

    // ── Build scenario / test-block structure for Steps view ──
    //
    // Cucumber scenarios: opened by cls==='scenario', steps are
    //   step-pass / step-fail / step-skip, errors attach to last fail.
    //
    // Generic test blocks (Playwright, Cypress, Jest, etc.): opened
    //   by cls==='test-block'. Subsequent errors/stacktraces attach
    //   to the block. No explicit step sub-items unless the log has them.

    if (cls === 'scenario') {
        // Cucumber scenario header
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
        // Generic test/spec/suite header from any framework
        const name = text.replace(/^\s*[✓✗✘×·]\s*/, '')
                         .replace(/^\s*(Test|Spec|Describe|Context|Suite|Running|it|test)\s*:\s*/i, '')
                         .replace(/\(\d+(\.\d+)?m?s\)\s*$/, '')
                         .replace(/['"`]/g, '').trim() || text.trim();
        // Detect if the header itself indicates failure
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
        // Associate error with the last failed step in this scenario/block
        if (sc.steps.length > 0 && sc.steps[sc.steps.length - 1].status === 'fail') {
            if (!sc.steps[sc.steps.length - 1].error) sc.steps[sc.steps.length - 1].error = [];
            sc.steps[sc.steps.length - 1].error.push(text);
        } else if (sc.framework === 'generic') {
            // For generic test blocks without explicit steps, attach
            // errors directly to the block and mark it as failed
            sc.status = 'fail';
        }
        sc.errorLines.push(idx);
    }
}

// Build list of filtered indices based on active filter (all, errors, warnings, info, steps)
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

// Render next chunk of filtered log lines (120 at a time for lazy loading)
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

        // CSS class for line type
        const clsMap = {
            'error': 'clv-line--error', 'warn': 'clv-line--warn', 'info': 'clv-line--info',
            'step': 'clv-line--step', 'step-pass': 'clv-line--step clv-line--step-pass',
            'step-fail': 'clv-line--step-fail', 'step-skip': 'clv-line--step-skip',
            'stacktrace': 'clv-line--stacktrace', 'pipeline': 'clv-line--pipeline',
            'scenario': 'clv-line--scenario', 'feature': 'clv-line--feature',
            'summary': 'clv-line--summary',
            'test-block': 'clv-line--scenario',             // renders like scenario headers
            'stage': 'clv-line--pipeline',                  // renders like pipeline lines
            'result-summary': 'clv-line--summary',          // renders like summary lines
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

        // Phase 2: Add fold toggle for feature/scenario/test-block lines
        if (cls === 'feature' || cls === 'scenario' || cls === 'test-block') {
            const foldBtn = document.createElement('span');
            foldBtn.className = 'clv-fold-toggle';
            foldBtn.textContent = '▾';
            foldBtn.addEventListener('click', function(ev) { ev.stopPropagation(); clvToggleFold(rawIdx, foldBtn); });
            textSpan.appendChild(foldBtn);
            // Linkify URLs in the text portion after the fold toggle
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

    // Re-apply search highlighting if active
    if (clvState.searchTerm) clvHighlightSearch();
}

// Setup intersection observer to trigger progressive rendering when user scrolls near end of log
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

    // Scroll-based DOM recycling for large logs
    body.removeEventListener('scroll', clvOnBodyScroll);
    body.addEventListener('scroll', clvOnBodyScroll, { passive: true });
}

// Debounce timer for DOM recycling during scroll
let _clvRecycleTimer = null;

// Debounced scroll handler to avoid thrashing during fast scrolling
function clvOnBodyScroll() {
    // Debounce recycling to avoid thrashing during fast scroll
    if (_clvRecycleTimer) return;
    _clvRecycleTimer = setTimeout(() => {
        _clvRecycleTimer = null;
        clvRecycleDom();
    }, 150);
}

// Remove DOM lines far outside viewport to keep memory usage low on large logs
function clvRecycleDom() {
    // Only recycle if we have a lot of rendered lines
    const container = document.getElementById('clv-log-container');
    const body = document.getElementById('clv-body');
    if (!container || !body) return;

    const children = container.children;
    if (children.length < clvState.domWindowSize * 1.2) return; // Not enough to bother

    const bodyRect = body.getBoundingClientRect();
    const buffer = bodyRect.height * 2; // Keep 2 viewport heights above and below

    let removedTop = 0;
    let removedBottom = 0;

    // Remove lines far above the viewport
    while (children.length > clvState.domWindowSize) {
        const first = children[0];
        if (!first) break;
        const rect = first.getBoundingClientRect();
        if (rect.bottom < bodyRect.top - buffer) {
            first.remove();
            removedTop++;
        } else {
            break;
        }
    }

    // Remove lines far below the viewport
    while (children.length > clvState.domWindowSize) {
        const last = children[children.length - 1];
        if (!last) break;
        const rect = last.getBoundingClientRect();
        if (rect.top > bodyRect.bottom + buffer) {
            last.remove();
            removedBottom++;
        } else {
            break;
        }
    }
}

// Update stats display (line counts, error counts, scenario counts)
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

    // Show/hide error navigation
    const errNav = document.getElementById('clv-err-nav');
    if (errNav) {
        errNav.style.display = clvState.errorIndices.length > 0 ? '' : 'none';
        clvUpdateErrNavButtons();
    }
}

// Group consecutive error/stacktrace lines into logical blocks for block-based error navigation
function clvBuildErrorBlocks() {
    // Group consecutive error/stacktrace/step-fail lines into blocks.
    // A block is a contiguous run of error-related lines (with a gap tolerance
    // of up to 2 non-error lines to keep closely related content together).
    const blocks = [];
    const errorClasses = new Set(['error', 'stacktrace', 'step-fail']);
    let current = null;

    for (let i = 0; i < clvState.rawLines.length; i++) {
        const cls = clvState.rawLines[i].cls;
        if (errorClasses.has(cls)) {
            if (current === null) {
                current = { startIdx: i, endIdx: i, anchorIdx: i };
            } else if (i - current.endIdx <= 3) {
                // Extend block (allow small gaps for blank lines / context)
                current.endIdx = i;
            } else {
                // New block
                blocks.push(current);
                current = { startIdx: i, endIdx: i, anchorIdx: i };
            }
            // Set anchor to first 'error' line in block (not stacktrace)
            if (cls === 'error' && clvState.rawLines[current.anchorIdx].cls !== 'error') {
                current.anchorIdx = i;
            }
        }
    }
    if (current !== null) blocks.push(current);
    clvState.errorBlocks = blocks;
}

// Update error navigation button states (prev/next/first) based on current cursor position
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
        // Initial state — no block selected yet
        posEl.textContent = total + ' error ' + (total === 1 ? 'block' : 'blocks');
        firstBtn.disabled = false;
        prevBtn.disabled = true;
        // Enable Next in initial state so user has two intuitive entry points
        nextBtn.disabled = false;
    } else {
        posEl.textContent = (cur + 1) + ' / ' + total;
        firstBtn.disabled = false;
        prevBtn.disabled = cur <= 0;
        nextBtn.disabled = cur >= total - 1;
    }
}

// Check if error block's anchor line is visible in the viewport
function clvIsBlockVisible(block) {
    // Check if the anchor line of this block is currently visible in the viewport
    const body = document.getElementById('clv-body');
    const container = document.getElementById('clv-log-container');
    if (!body || !container) return false;

    const anchorEl = container.querySelector(`[data-raw-idx="${block.anchorIdx}"]`);
    if (!anchorEl) return false;

    const bodyRect = body.getBoundingClientRect();
    const elRect = anchorEl.getBoundingClientRect();
    return elRect.top >= bodyRect.top && elRect.bottom <= bodyRect.bottom;
}

// Ensure a specific filtered index is rendered, re-rendering if DOM recycling removed it
function clvEnsureRendered(filterIdxTarget) {
    if (filterIdxTarget < 0 || filterIdxTarget >= clvState.filteredIndices.length) return;
    const container = document.getElementById('clv-log-container');
    // Check if the target raw index is already in the DOM
    const rawIdx = clvState.filteredIndices[filterIdxTarget];
    if (container.querySelector(`[data-raw-idx="${rawIdx}"]`)) return;

    // The line was recycled. Clear DOM and re-render a window around the target.
    container.innerHTML = '';
    const windowHalf = Math.floor(clvState.chunkSize * 2);
    clvState.renderedUpTo = Math.max(0, filterIdxTarget - windowHalf);

    // Render chunks until we pass the target
    while (clvState.renderedUpTo <= filterIdxTarget && clvState.renderedUpTo < clvState.filteredIndices.length) {
        clvRenderChunk();
    }
}

// Scroll to error block and highlight all lines in the block
function _clvScrollToErrorBlock(cursorIdx) {
    const blocks = clvState.errorBlocks;
    const block = blocks[cursorIdx];
    if (!block) { clvUpdateErrNavButtons(); return; }

    const anchorRawIdx = block.anchorIdx;
    const filterIdx = clvState.filteredIndices.indexOf(anchorRawIdx);
    if (filterIdx === -1) { clvUpdateErrNavButtons(); return; }

    // Ensure the target is rendered (handles both progressive loading and recycled DOM)
    while (clvState.renderedUpTo <= filterIdx) { clvRenderChunk(); }
    clvEnsureRendered(filterIdx);

    // Scroll to anchor and highlight entire block
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

// Navigate between error blocks (first, next, prev) with smart scrolling and highlighting
function clvErrNav(action) {
    if (clvState.phase !== 'ready') return; // Block nav during loading
    const blocks = clvState.errorBlocks;
    if (blocks.length === 0) return;

    // Clear previous highlights
    document.querySelectorAll('.clv-line--error-active').forEach(el => el.classList.remove('clv-line--error-active'));
    document.querySelectorAll('.clv-line--error-block-anchor').forEach(el => el.classList.remove('clv-line--error-block-anchor'));

    // If not in 'all' or 'errors' filter, switch to 'all'
    if (clvState.activeFilter !== 'all' && clvState.activeFilter !== 'errors') {
        clvSetFilter('all');
    }

    if (action === 'first') {
        clvState.errorBlockCursor = 0;
    } else if (action === 'next') {
        // If no block is active yet, treat Next as "jump to first"
        if (clvState.errorBlockCursor === -1) {
            clvState.errorBlockCursor = 0;
            _clvScrollToErrorBlock(0);
            return;
        }
        // Find next block that is NOT visible in viewport
        let candidate = clvState.errorBlockCursor + 1;
        while (candidate < blocks.length && clvIsBlockVisible(blocks[candidate])) {
            candidate++;
        }
        if (candidate < blocks.length) {
            clvState.errorBlockCursor = candidate;
        } else if (clvState.errorBlockCursor < blocks.length - 1) {
            // All remaining are visible; just go to last
            clvState.errorBlockCursor = blocks.length - 1;
        }
    } else if (action === 'prev') {
        // Find previous block that is NOT visible in viewport
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

// Change active filter and rebuild log view (all, errors, warnings, info, steps)
function clvSetFilter(filter) {
    clvState.activeFilter = filter;
    document.querySelectorAll('.clv-filter-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.clvFilter === filter));

    // Reset error navigation cursor so next/prev starts fresh (F5)
    clvState.errorBlockCursor = -1;
    document.querySelectorAll('.clv-line--error-active').forEach(el =>
        el.classList.remove('clv-line--error-active'));
    document.querySelectorAll('.clv-line--error-block-anchor').forEach(el =>
        el.classList.remove('clv-line--error-block-anchor'));
    clvUpdateErrNavButtons();

    const container = document.getElementById('clv-log-container');
    container.innerHTML = '';

    // Steps filter uses structured rendering
    if (filter === 'steps') {
        clvRenderStepsView(container);
        return;
    }

    // All other filters use line-based rendering
    clvBuildFilteredList();
    clvState.renderedUpTo = 0;
    clvRenderChunk();
    clvSetupObserver();

    // Re-apply search
    if (clvState.searchTerm) clvSearch(clvState.searchTerm);
}

// Render structured view of scenarios and test blocks with embedded errors (Steps filter)
function clvRenderStepsView(container) {
    if (clvState.parsedScenarios.length === 0) {
        container.innerHTML = '<div style="padding:40px 20px;color:#64748B;text-align:center;font-size:13px">No scenarios or test blocks found in this log.</div>';
        return;
    }

    const fragment = document.createDocumentFragment();

    for (const sc of clvState.parsedScenarios) {
        // Scenario / test-block header
        const header = document.createElement('div');
        header.className = 'clv-scenario-header';
        const statusBadge = document.createElement('span');
        statusBadge.className = 'clv-scenario-status clv-scenario-status--' + sc.status;
        statusBadge.textContent = sc.status === 'fail' ? 'FAIL' : 'PASS';
        const nameSpan = document.createElement('span');
        // Adapt label: Cucumber uses "Scenario:", generic uses "Test:"
        const labelPrefix = sc.framework === 'cucumber' ? 'Scenario: ' : 'Test: ';
        nameSpan.textContent = labelPrefix + sc.name;
        header.appendChild(statusBadge);
        header.appendChild(nameSpan);
        fragment.appendChild(header);

        // Steps
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

            // If step has associated error, show it inline
            if (step.error && step.error.length > 0) {
                const errBlock = document.createElement('div');
                errBlock.className = 'clv-step-error';
                // Show first few error lines (skip deep stack trace)
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

        // Generic test blocks without explicit steps: show associated
        // error lines directly under the header (Playwright, Cypress, etc.)
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

// Jump to the first error block
function clvJumpToFirstError() {
    // Delegate to error nav
    clvErrNav('first');
}

// Search log for a term and build list of matching lines
function clvSearch(term) {
    clvState.searchTerm = term.toLowerCase();
    clvState.searchMatches = [];
    clvState.searchCursor = -1;

    // Clear existing highlights (preserve fold toggles)
    document.querySelectorAll('.clv-line-text').forEach(textEl => {
        if (!textEl.querySelector('.clv-match')) return;
        const lineEl = textEl.closest('.clv-line');
        const rawIdx = lineEl ? parseInt(lineEl.dataset.rawIdx, 10) : -1;
        const rawText = rawIdx >= 0 && clvState.rawLines[rawIdx] ? clvState.rawLines[rawIdx].text : textEl.textContent;
        const foldToggle = textEl.querySelector('.clv-fold-toggle');
        if (foldToggle) {
            const foldHtml = foldToggle.outerHTML;
            // Restore fold toggle + linkified text
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

    // Find matches in filtered indices
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
        clvSearchNav(1); // Jump to first match
    }
}

// Highlight all search matches in currently rendered lines
function clvHighlightSearch() {
    if (!clvState.searchTerm) return;
    const container = document.getElementById('clv-log-container');
    const lines = container.querySelectorAll('.clv-line');

    lines.forEach(lineEl => {
        const textEl = lineEl.querySelector('.clv-line-text');
        if (!textEl) return;

        // Use rawLines text (not textContent which includes fold toggle chars)
        const rawIdx = parseInt(lineEl.dataset.rawIdx, 10);
        const rawText = clvState.rawLines[rawIdx] ? clvState.rawLines[rawIdx].text : textEl.textContent;
        const lower = rawText.toLowerCase();
        const term = clvState.searchTerm;

        if (!lower.includes(term)) return;

        // Preserve fold toggle if present
        const foldToggle = textEl.querySelector('.clv-fold-toggle');
        const foldHtml = foldToggle ? foldToggle.outerHTML : '';

        // Build highlighted HTML (with linkification on non-match segments)
        let html = foldHtml;
        let pos = 0;
        let idx = lower.indexOf(term, pos);
        while (idx !== -1) {
            html += clvLinkifyHtml(escapeHtml(rawText.substring(pos, idx)));
            html += '<span class="clv-match">' + escapeHtml(rawText.substring(idx, idx + term.length)) + '</span>';
            pos = idx + term.length;
            idx = lower.indexOf(term, pos);
        }
        html += clvLinkifyHtml(escapeHtml(rawText.substring(pos)));
        textEl.innerHTML = html;

        // Re-bind fold toggle event if it was preserved
        if (foldHtml) {
            const newToggle = textEl.querySelector('.clv-fold-toggle');
            if (newToggle) {
                newToggle.addEventListener('click', function(ev) { ev.stopPropagation(); clvToggleFold(rawIdx, newToggle); });
            }
        }
    });
}

// Navigate to next/previous search match
function clvSearchNav(direction) {
    if (clvState.searchMatches.length === 0) return;

    // Remove previous active highlight
    document.querySelectorAll('.clv-match-active').forEach(el => el.classList.remove('clv-match-active'));

    clvState.searchCursor += direction;
    if (clvState.searchCursor >= clvState.searchMatches.length) clvState.searchCursor = 0;
    if (clvState.searchCursor < 0) clvState.searchCursor = clvState.searchMatches.length - 1;

    const filterIdx = clvState.searchMatches[clvState.searchCursor];

    // Ensure rendered
    while (clvState.renderedUpTo <= filterIdx) {
        clvRenderChunk();
    }

    // Scroll to line
    const rawIdx = clvState.filteredIndices[filterIdx];
    const container = document.getElementById('clv-log-container');
    const line = container.querySelector(`[data-raw-idx="${rawIdx}"]`);
    if (line) {
        line.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Highlight the specific match in this line
        const match = line.querySelector('.clv-match');
        if (match) match.classList.add('clv-match-active');
    }

    document.getElementById('clv-search-count').textContent =
        (clvState.searchCursor + 1) + ' / ' + clvState.searchMatches.length;
}

// Keyboard shortcuts for CLV (Ctrl+F for search, Enter/Shift+Enter for search nav)
// Note: Escape is handled in setupEventListeners() with priority dispatch.
document.addEventListener('keydown', function(e) {
    const overlay = document.getElementById('clv-overlay');
    if (!overlay || !overlay.classList.contains('active')) return;

    // Ctrl+F / Cmd+F — focus search (override browser find)
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        const input = document.getElementById('clv-search');
        if (input) { input.focus(); input.select(); }
        return;
    }

    // Enter / Shift+Enter — search navigation (when search input focused)
    if (e.key === 'Enter' && document.activeElement && document.activeElement.id === 'clv-search') {
        e.preventDefault();
        clvSearchNav(e.shiftKey ? -1 : 1);
        return;
    }
});

// Resizable panel with mouse drag on edges
(function() {
    const MIN_W = 960;    // minimum width = default width
    const MIN_H_VH = 82;  // minimum height as vh

    function getMinH() { return window.innerHeight * MIN_H_VH / 100; }

    document.addEventListener('mousedown', function(e) {
        const handle = e.target.closest('[data-clv-resize]');
        if (!handle) return;
        e.preventDefault();

        const panel = document.getElementById('clv-panel');
        if (!panel) return;

        const dir = handle.dataset.clvResize; // 'e', 's', 'se', 'w', 'sw'
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

            // Horizontal resize — symmetric (both sides expand equally from center)
            if (dir.includes('e')) {
                newW = startW + dx * 2; // *2 because growth is symmetric
            } else if (dir.includes('w')) {
                newW = startW - dx * 2;
            }

            // Vertical resize — symmetric
            if (dir.includes('s')) {
                newH = startH + dy * 2;
            }

            // Clamp
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

// Copy all filtered lines to clipboard
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

// Copy a single line to clipboard
function clvCopyLine(rawIdx) {
    const line = clvState.rawLines[rawIdx];
    if (!line) return;
    navigator.clipboard.writeText(line.text).then(() => {
        clvShowCopyToast('Line ' + line.lineNum + ' copied');
    }).catch(() => {});
}

// Show temporary toast notification
function clvShowCopyToast(msg) {
    const toast = document.getElementById('clv-copy-toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('visible');
    clearTimeout(clvState._toastTimer);
    clvState._toastTimer = setTimeout(() => toast.classList.remove('visible'), 1500);
}

// Download full log as text file
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

// Toggle anchor state on a line (only one anchor allowed at a time)
function clvAnchorLine(rawIdx, lineEl) {
    // Toggle anchor on/off
    if (lineEl.classList.contains('clv-line--anchored')) {
        lineEl.classList.remove('clv-line--anchored');
        return;
    }
    // Clear previous anchor
    const prev = document.querySelector('.clv-line--anchored');
    if (prev) prev.classList.remove('clv-line--anchored');
    lineEl.classList.add('clv-line--anchored');
}

// Collapse/expand feature/scenario/test-block sections with keyboard-friendly fold toggle
function clvToggleFold(rawIdx, toggleEl) {
    const container = document.getElementById('clv-log-container');
    const isCollapsed = toggleEl.classList.toggle('collapsed');
    const triggerLine = clvState.rawLines[rawIdx];
    const isFeat = triggerLine.cls === 'feature';
    // Section-boundary classes: feature, scenario, test-block
    const sectionHeaders = new Set(['feature', 'scenario', 'test-block']);

    // Walk subsequent rendered lines and fold/unfold
    const allLines = container.querySelectorAll('.clv-line');
    let found = false;
    for (const el of allLines) {
        const idx = parseInt(el.dataset.rawIdx, 10);
        if (idx === rawIdx) { found = true; continue; }
        if (!found) continue;

        const cls = clvState.rawLines[idx].cls;
        // Stop at next feature (if folding a feature) or next section header (if folding scenario/test-block)
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

// Close console log modal and cleanup all state
function clvClose() {
    const overlay = document.getElementById('clv-overlay');
    overlay.classList.remove('active');

    // Abort any in-flight fetch
    if (clvState.abortController) {
        clvState.abortController.abort();
        clvState.abortController = null;
    }

    // Clear debounced scroll/recycle timer
    if (_clvRecycleTimer) { clearTimeout(_clvRecycleTimer); _clvRecycleTimer = null; }

    // DOM cleanup — release log content from memory
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

    if (clvState.observer) {
        clvState.observer.disconnect();
        clvState.observer = null;
    }

    // Remove scroll listener for DOM recycling
    const body = document.getElementById('clv-body');
    if (body) body.removeEventListener('scroll', clvOnBodyScroll);
}

// Legacy aliases for backward compatibility
function openErrorLogModal(jobId) { clvOpen(jobId); }
function closeErrorLogModal() { clvClose(); }
