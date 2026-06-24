/* Classifier rule sandbox — wires the "Test a classification rule"
 */
(function () {
    'use strict';

    function init() {
        var btn = document.getElementById('rt-run');
        if (!btn) return;  // Panel not on this page.
        btn.addEventListener('click', runClassifyTest);
        var copyBtn = document.getElementById('rt-copy');
        if (copyBtn) copyBtn.addEventListener('click', copyResultToClipboard);
        var clearBtn = document.getElementById('rt-clear');
        if (clearBtn) clearBtn.addEventListener('click', clearAll);
        var closeBtn = document.getElementById('rt-close');
        if (closeBtn) closeBtn.addEventListener('click', closePanel);
    }

    // Empty both textareas, the result pane, and the status — ready for a new test.
    function clearAll() {
        var log = document.getElementById('rt-log');
        var yaml = document.getElementById('rt-yaml');
        var result = document.getElementById('rt-result');
        var copyBtn = document.getElementById('rt-copy');
        if (log) log.value = '';
        if (yaml) yaml.value = '';
        if (result) result.textContent = '';
        if (copyBtn) copyBtn.disabled = true;
        setStatus('', null);
        if (log && typeof log.focus === 'function') log.focus();
    }

    // Close the panel — same path as the header toggle button.
    function closePanel() {
        var panel = document.getElementById('rule-test-panel');
        if (panel) panel.removeAttribute('open');
    }

    // Copy the latest classification JSON to the clipboard.
    // Falls back to execCommand for older browsers / non-secure contexts.
    function copyResultToClipboard() {
        var pre = document.getElementById('rt-result');
        var btn = document.getElementById('rt-copy');
        if (!pre || !btn) return;
        var text = pre.textContent || '';
        if (!text.trim()) return;

        function flash(label, kind) {
            var orig = btn.dataset.origHtml || btn.innerHTML;
            btn.dataset.origHtml = orig;
            btn.textContent = label;
            btn.classList.add('rule-test-btn--' + (kind || 'ok'));
            setTimeout(function () {
                btn.innerHTML = orig;
                btn.classList.remove('rule-test-btn--ok', 'rule-test-btn--err');
            }, 1500);
        }

        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text)
                .then(function () { flash('✓ Copied', 'ok'); })
                .catch(function () { flash('Copy failed', 'err'); });
            return;
        }
        // Legacy fallback for non-HTTPS / older browsers.
        try {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            var ok = document.execCommand('copy');
            document.body.removeChild(ta);
            flash(ok ? '✓ Copied' : 'Copy failed', ok ? 'ok' : 'err');
        } catch (_) { flash('Copy failed', 'err'); }
    }

    function setStatus(text, kind) {
        var el = document.getElementById('rt-status');
        if (!el) return;
        el.textContent = text || '';
        el.className = 'rule-test-status' + (kind ? ' rule-test-status--' + kind : '');
    }

    function runClassifyTest() {
        var log = (document.getElementById('rt-log') || {}).value || '';
        var yaml = (document.getElementById('rt-yaml') || {}).value || '';
        var result = document.getElementById('rt-result');

        if (!log.trim()) {
            setStatus('Paste a console log first.', 'warn');
            return;
        }

        setStatus('Classifying…', 'busy');
        result.textContent = '';

        var body = { console_text: log };
        if (yaml.trim()) body.candidate_rules_yaml = yaml;

        apiFetch('/api/classify-test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })
            .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
            .then(function (payload) {
                if (!payload.ok) {
                    setStatus('Error', 'err');
                    result.textContent = JSON.stringify(payload.body, null, 2);
                    return;
                }
                var b = payload.body;
                if (b.matched) {
                    var tag = b.candidate_used ? ' (candidate active)' : '';
                    setStatus('Matched: ' + (b.primary && b.primary.label) + tag, 'ok');
                } else {
                    setStatus('No rule matched', 'warn');
                }
                result.textContent = JSON.stringify(b, null, 2);
                var copyBtn = document.getElementById('rt-copy');
                if (copyBtn) copyBtn.disabled = false;
            })
            .catch(function (err) {
                setStatus('Network error', 'err');
                result.textContent = String(err);
            });
    }

    function toggleRuleTestPanel() {
        var panel = document.getElementById('rule-test-panel');
        if (!panel) return;
        var willOpen = !panel.hasAttribute('open');
        if (willOpen) {
            panel.setAttribute('open', '');
            // Defer scroll until layout settles after the panel expands.
            setTimeout(function () {
                panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
                var log = document.getElementById('rt-log');
                if (log && typeof log.focus === 'function') log.focus();
            }, 50);
        } else {
            panel.removeAttribute('open');
        }
    }
    window.toggleRuleTestPanel = toggleRuleTestPanel;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
