// config.js — Auth wizard: Jenkins authentication, view/job-list discovery, and step state.
'use strict';

// Show "(Ns)" after `thresholdMs` so the user sees the wait isn't frozen.
function _runElapsedTimer(el, baseText, options) {
    if (!el) return { stop: function () {} };
    options = options || {};
    var thresholdMs = options.thresholdMs || 5000;
    var startedAt = Date.now();
    el.textContent = baseText;
    var intervalId = setInterval(function () {
        var elapsed = Date.now() - startedAt;
        if (elapsed >= thresholdMs) {
            el.textContent = baseText + ' (' + Math.round(elapsed / 1000) + 's)';
        }
    }, 1000);
    return {
        stop: function () { clearInterval(intervalId); }
    };
}

function toggleConfigPanel() {
    const panel = document.getElementById('config-panel');
    panel.classList.toggle('expanded');
}

// User picked a different Jenkins instance: refresh dependent UI + state.
function onInstanceChange() {
    const select = document.getElementById('cfg-jenkins-url');
    const customGroup = document.getElementById('custom-url-group');
    const customInput = document.getElementById('cfg-custom-url');

    if (select.value === '__custom__') {
        customGroup.classList.add('cfg-custom-url-visible');
        setTimeout(function() { customInput.focus(); }, 80);
        appState.selectedInstance = null;
    } else {
        customGroup.classList.remove('cfg-custom-url-visible');
        customInput.value = '';
        customInput.classList.remove('cfg-input-valid', 'cfg-input-invalid');
        document.getElementById('cfg-custom-url-valid').classList.remove('visible');
        hideError('cfg-url-error');
        if (appState.contextsData && appState.contextsData.instances) {
            appState.selectedInstance = appState.contextsData.instances.find(i => i.jenkins_url === select.value) || null;
            if (appState.selectedInstance && appState.selectedInstance.default_username) {
                document.getElementById('cfg-username').value = appState.selectedInstance.default_username;
            }
        }
    }

    resetViewStep();
    updateConfigChips();
    updateFetchButton();
    // Predefined job lists come from contexts.json (no Jenkins round-trip),
    // so we can populate them before auth and refresh them on every instance switch.
    populateJobListDropdown();
}

// http/https with a non-empty hostname.
function isValidJenkinsUrl(url) {
    if (!url) return false;
    try {
        var parsed = new URL(url);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0;
    } catch (e) {
        return false;
    }
}

// Real-time (debounced) validation of the custom Jenkins URL input.
(function initCustomUrlValidation() {
    document.addEventListener('DOMContentLoaded', function() {
        var input = document.getElementById('cfg-custom-url');
        var checkIcon = document.getElementById('cfg-custom-url-valid');
        if (!input) return;

        var debounceTimer = null;
        input.addEventListener('input', function() {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(function() {
                var val = input.value.trim();
                hideError('cfg-url-error');
                if (val.length === 0) {
                    input.classList.remove('cfg-input-valid', 'cfg-input-invalid');
                    checkIcon.classList.remove('visible');
                } else if (isValidJenkinsUrl(val)) {
                    input.classList.remove('cfg-input-invalid');
                    input.classList.add('cfg-input-valid');
                    checkIcon.classList.add('visible');
                } else {
                    input.classList.remove('cfg-input-valid');
                    input.classList.add('cfg-input-invalid');
                    checkIcon.classList.remove('visible');
                }
            }, 250);
        });

        input.addEventListener('blur', function() {
            var val = input.value.trim();
            if (val.endsWith('/')) val = val.replace(/\/+$/, '');
            input.value = val;
            if (val.length > 0 && !isValidJenkinsUrl(val)) {
                showError('cfg-url-error', 'Enter a valid URL (e.g. https://jenkins.company.com)');
            }
        });
    });
})();

// Active Jenkins URL — preset dropdown value or custom input field.
function getActiveJenkinsUrl() {
    const select = document.getElementById('cfg-jenkins-url');
    if (select.value === '__custom__') {
        return document.getElementById('cfg-custom-url').value.trim().replace(/\/+$/, '');
    }
    return select.value;
}

// Validate manually-entered credentials with the backend, then move to view discovery.
async function authenticateCredentials() {
    const jenkinsUrl = getActiveJenkinsUrl();
    const username = document.getElementById('cfg-username').value.trim();
    const token = document.getElementById('cfg-token').value.trim();

    hideError('cfg-auth-error');
    hideError('cfg-auth-success');

    if (!jenkinsUrl) {
        var sel = document.getElementById('cfg-jenkins-url');
        if (sel.value === '__custom__') {
            showError('cfg-url-error', 'Enter the Jenkins base URL before authenticating');
            document.getElementById('cfg-custom-url').focus();
        } else {
            showError('cfg-auth-error', 'Select a Jenkins instance');
        }
        return;
    }
    if (document.getElementById('cfg-jenkins-url').value === '__custom__' && !isValidJenkinsUrl(jenkinsUrl)) {
        showError('cfg-url-error', 'Enter a valid URL (e.g. https://jenkins.company.com)');
        document.getElementById('cfg-custom-url').focus();
        return;
    }
    if (!username || !token) {
        showError('cfg-auth-error', 'Username and API token are required');
        return;
    }

    const btn = document.getElementById('btn-authenticate');
    btn.innerHTML = '<span class="cfg-spinner"></span> <span class="cfg-btn-status">Connecting to Jenkins…</span>';
    btn.disabled = true;
    const statusEl = btn.querySelector('.cfg-btn-status');
    const timer = _runElapsedTimer(statusEl, 'Connecting to Jenkins…');

    try {
        const resp = await apiFetch('/api/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jenkins_url: jenkinsUrl, username, api_token: token })
        });
        timer.stop();
        const data = await resp.json();

        if (data.valid) {
            lockAuthStep(jenkinsUrl, username, token);
            await discoverViews(jenkinsUrl, username, token);
        } else {
            showError('cfg-auth-error', data.message || 'Authentication failed');
            btn.innerHTML = 'Authenticate';
            btn.disabled = false;
        }
    } catch (err) {
        timer.stop();
        showError('cfg-auth-error', 'Connection error: ' + err.message);
        reportFetchError('Auth', 'Manual auth connection error', '/api/validate', err);
        btn.innerHTML = 'Authenticate';
        btn.disabled = false;
    }
}

// If env credentials are present on the server (JENKINS_TEST_USERNAME / JENKINS_TEST_API_KEY),
// inject a one-click auth button; otherwise the manual flow stays intact.
async function checkEnvCredentials() {
    // Reentrancy guard: if the section already exists (e.g. unlockAuth retry),
    // there's nothing to inject — keep what's there.
    if (document.getElementById('env-auth-section')) return;

    let data;
    try {
        const resp = await apiFetch('/api/env-credentials-check');
        data = await resp.json();
    } catch (err) {
        if (typeof diagLog === 'function') {
            diagLog('warning', 'Auth', '/api/env-credentials-check failed — env-auth button unavailable', { raw: err && err.message });
        }
        return;
    }
    if (!data || !data.available) {
        // Helps the user spot "vars set in shell but Python doesn't see them" — the most common silent failure.
        if (typeof diagLog === 'function') {
            const userVar = (data && data.username_var) || 'JENKINS_TEST_USERNAME';
            const keyVar = (data && data.api_key_var) || 'JENKINS_TEST_API_KEY';
            diagLog('info', 'Auth',
                'Env-auth unavailable — server reports ' + userVar + ' and ' + keyVar +
                ' not set. If they ARE set in your shell, the launch process didn\'t inherit them ' +
                '(check `export` in your shell rc file, or set them in .env).');
        }
        return;
    }

    const authActions = document.getElementById('auth-actions');
    if (!authActions) return;

    const userVar = data.username_var || 'JENKINS_TEST_USERNAME';
    const keyVar = data.api_key_var || 'JENKINS_TEST_API_KEY';
    const section = document.createElement('div');
    section.className = 'env-auth-section';
    section.id = 'env-auth-section';
    section.innerHTML =
        '<div class="env-auth-label">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0D9488" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 12h.01"/><path d="M10 12h.01"/><path d="M14 12h.01"/></svg>' +
            'Environment Credentials Detected' +
        '</div>' +
        '<button class="cfg-btn cfg-btn-env" id="btn-env-authenticate" onclick="authenticateWithEnvCredentials()">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>Authenticate using Environment Variables' +
        '</button>' +
        '<div class="env-auth-hint">Credentials sourced from <code>' + userVar + '</code> and <code>' + keyVar + '</code>. The API key is never displayed.</div>' +
        '<div class="env-auth-divider">or authenticate manually</div>';

    authActions.parentElement.insertBefore(section, authActions);
}

// Authenticate using server-held env credentials; token never leaves the backend.
async function authenticateWithEnvCredentials() {
    const jenkinsUrl = getActiveJenkinsUrl();

    hideError('cfg-auth-error');
    hideError('cfg-auth-success');

    if (!jenkinsUrl) {
        showError('cfg-auth-error', 'Select a Jenkins instance first');
        return;
    }

    const btn = document.getElementById('btn-env-authenticate');
    const origHTML = btn.innerHTML;
    btn.innerHTML = '<span class="cfg-spinner"></span> <span class="cfg-btn-status">Connecting to Jenkins…</span>';
    btn.disabled = true;
    const statusEl = btn.querySelector('.cfg-btn-status');
    const timer = _runElapsedTimer(statusEl, 'Connecting to Jenkins…');

    try {
        const resp = await apiFetch('/api/env-validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jenkins_url: jenkinsUrl })
        });
        timer.stop();
        const data = await resp.json();

        if (data.valid) {
            // Use the returned username; the token stays server-side (shown as bullets in the UI).
            const envUsername = data.username || 'env-user';
            lockAuthStep(jenkinsUrl, envUsername, '••••••••');
            await discoverViews(jenkinsUrl, envUsername, '••••••••');
        } else {
            showError('cfg-auth-error', data.message || 'Environment authentication failed — use manual authentication below');
            btn.innerHTML = origHTML;
            btn.disabled = false;
        }
    } catch (err) {
        timer.stop();
        showError('cfg-auth-error', 'Connection error: ' + err.message + ' — use manual authentication below');
        reportFetchError('Auth', 'Env auth connection error', '/api/env-validate', err);
        btn.innerHTML = origHTML;
        btn.disabled = false;
    }
}

// Mark the auth step complete and stash credentials in app state.
function lockAuthStep(jenkinsUrl, username, token) {
    const step = document.getElementById('step-auth');
    step.classList.remove('step-active');
    step.classList.add('step-complete', 'step-locked');

    show('auth-badge');
    hide('auth-actions');
    show('auth-lock-overlay');

    const envSection = document.getElementById('env-auth-section');
    if (envSection) envSection.style.display = 'none';

    const instName = appState.selectedInstance ? appState.selectedInstance.display_name : '';
    const envLabel = document.getElementById('header-env-label');
    if (envLabel && instName) envLabel.textContent = instName;

    appState.authCredentials = { jenkins_url: jenkinsUrl, username, api_token: token };

    updateConfigChips();
}

// Reopen the auth step for re-entry and reset env-auth UI.
function unlockAuth(e) {
    if (e) e.stopPropagation();
    const step = document.getElementById('step-auth');
    step.classList.remove('step-complete', 'step-locked');
    step.classList.add('step-active');

    hide('auth-badge');
    show('auth-actions');
    hide('auth-lock-overlay');

    const envSection = document.getElementById('env-auth-section');
    if (envSection) {
        envSection.style.display = 'block';
        const envBtn = document.getElementById('btn-env-authenticate');
        if (envBtn) {
            envBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>Authenticate using Environment Variables';
            envBtn.disabled = false;
        }
    } else {
        // First-load probe may have failed (network blip or DOM not ready)
        checkEnvCredentials();
    }

    const btn = document.getElementById('btn-authenticate');
    btn.innerHTML = 'Authenticate';
    btn.disabled = false;

    hideError('cfg-auth-error');
    hideError('cfg-auth-success');

    appState.authCredentials = null;
    resetViewStep();
    updateConfigChips();
    updateFetchButton();
}

// Populate the Jenkins views dropdown after auth succeeds.
async function discoverViews(jenkinsUrl, username, token) {
    const viewStep = document.getElementById('step-view');
    viewStep.classList.remove('step-locked');
    viewStep.classList.add('step-active');

    const viewSelect = document.getElementById('cfg-view-select');
    viewSelect.innerHTML = '<option value="">Loading views from Jenkins…</option>';
    viewSelect.disabled = true;

    // Surface elapsed time so the user sees the wait isn't frozen.
    const loadingOption = viewSelect.options[0];
    const viewsTimer = _runElapsedTimer(loadingOption, 'Loading views from Jenkins…');

    const instanceId = appState.selectedInstance ? appState.selectedInstance.id : '';

    try {
        const resp = await apiFetch('/api/discover-views', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jenkins_url: jenkinsUrl, username, api_token: token })
        });
        viewsTimer.stop();
        const data = await resp.json();

        viewSelect.innerHTML = '<option value="">Select a view...</option>';

        if (data.views && data.views.length > 0) {
            data.views.forEach(v => {
                // Convert absolute view URL into a path relative to the instance base.
                const basePath = jenkinsUrl.replace(/\/$/, '');
                let viewPath = v.url;
                if (v.url.startsWith(basePath)) {
                    viewPath = v.url.substring(basePath.length).replace(/^\//, '').replace(/\/$/, '');
                }
                const opt = document.createElement('option');
                opt.value = viewPath;
                opt.textContent = v.name;
                opt.dataset.instanceId = instanceId;
                viewSelect.appendChild(opt);
            });
        } else {
            viewSelect.innerHTML = '<option value="">No views found on this instance</option>';
        }

        viewSelect.disabled = false;
    } catch (err) {
        viewsTimer.stop();
        viewSelect.innerHTML = '<option value="">Error loading views</option>';
        viewSelect.disabled = false;
        document.getElementById('cfg-view-error').textContent = 'Failed to load Jenkins views: ' + err.message;
        document.getElementById('cfg-view-error').style.display = 'block';
        reportFetchError('Views', 'Failed to discover Jenkins views', '/api/discover-views', err);
    }

    populateJobListDropdown();
}

// Join a relative view path to the instance base URL.
function resolveViewUrl(viewPath) {
    if (!viewPath) return { viewUrl: '', viewPath: '' };
    const jenkinsUrl = appState.authCredentials ? appState.authCredentials.jenkins_url : '';
    if (!jenkinsUrl) return { viewUrl: '', viewPath: viewPath };
    const base = jenkinsUrl.replace(/\/$/, '');
    const normalized = viewPath.replace(/^\//, '').replace(/\/$/, '');
    return { viewUrl: base + '/' + normalized + '/', viewPath: normalized };
}

// Populate the Custom Job List dropdown from two sources, deduped:
//   1. Predefined lists tied to the selected instance (contexts.json).
//   2. Every .json under config/job_lists/ (via /api/list-available-job-lists),
//      skipping any already shown above.
// The directory scan is fire-and-forget; if it fails the predefined section still shows.
function populateJobListDropdown() {
    const select = document.getElementById('cfg-joblist-select');
    if (!select) return;
    select.innerHTML = '<option value="">Select a job list...</option>';
    const instanceId = appState.selectedInstance ? appState.selectedInstance.id : '';
    const predefinedPaths = new Set();

    // Group 1: predefined for this instance.
    if (appState.selectedInstance && Array.isArray(appState.selectedInstance.predefined_job_lists) && appState.selectedInstance.predefined_job_lists.length > 0) {
        const group = document.createElement('optgroup');
        group.label = 'Predefined for this instance';
        appState.selectedInstance.predefined_job_lists.forEach(jl => {
            const opt = document.createElement('option');
            opt.value = jl.job_list_file;
            opt.textContent = jl.name;
            if (jl.environment) opt.dataset.environment = jl.environment;
            if (jl.id)          opt.dataset.listId = jl.id;
            opt.dataset.instanceId = instanceId;
            group.appendChild(opt);
            predefinedPaths.add(jl.job_list_file);
        });
        select.appendChild(group);
    }

    // Group 2: all on-disk lists. Fetched async so the dropdown opens without delay.
    apiFetch('/api/list-available-job-lists')
        .then(r => r.ok ? r.json() : { lists: [] })
        .then(data => {
            const lists = (data && data.lists) || [];
            const customLists = lists.filter(l => !predefinedPaths.has(l.file));
            if (customLists.length === 0) return;
            const group = document.createElement('optgroup');
            group.label = 'All custom lists';
            customLists.forEach(l => {
                const opt = document.createElement('option');
                opt.value = l.file;
                opt.textContent = `${l.name}  (${l.count} jobs)`;
                opt.dataset.fromFilesystem = '1';
                group.appendChild(opt);
            });
            select.appendChild(group);
        })
        .catch(err => {
            if (typeof diagLog === 'function') {
                diagLog('warning', 'Config', 'Failed to list available job lists: ' + (err && err.message));
            }
        });
}

// Switch between view-mode and job-list-mode tabs; reset whichever mode is being left.
function switchSourceMode(mode) {
    appState.sourceMode = mode;

    document.getElementById('tab-view').classList.toggle('active', mode === 'view');
    document.getElementById('tab-joblist').classList.toggle('active', mode === 'job_list');

    $id('panel-view').classList.toggle('hidden', mode !== 'view');
    $id('panel-joblist').classList.toggle('hidden', mode !== 'job_list');

    if (mode === 'view') {
        document.getElementById('cfg-joblist-select').value = '';
        hide('joblist-job-count');
        appState.customJobList = null;
    } else {
        document.getElementById('cfg-view-select').value = '';
        hide('view-job-count');
        appState._resolvedViewUrl = '';
    }

    const viewStep = document.getElementById('step-view');
    viewStep.classList.remove('step-complete');
    viewStep.classList.add('step-active');
    hide('view-badge');
    hideError('cfg-view-error');

    updateFetchButton();
    updateConfigChips();
}

// Load a predefined job list from the server and stash it in app state.
async function onJobListChange() {
    const select = document.getElementById('cfg-joblist-select');
    const filePath = select.value;
    const countEl = document.getElementById('joblist-job-count');

    document.getElementById('cfg-view-error').style.display = 'none';
    countEl.style.display = 'none';

    if (!filePath) {
        appState.customJobList = null;
        updateFetchButton();
        updateConfigChips();
        return;
    }

    try {
        const resp = await apiFetch('/api/load-job-list', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ job_list_file: filePath })
        });
        const data = await resp.json();

        if (data.error) {
            document.getElementById('cfg-view-error').textContent = data.error;
            document.getElementById('cfg-view-error').style.display = 'block';
            appState.customJobList = null;
            return;
        }

        // Prefer the dropdown's human label (from contexts.json) over the route's
        // file-basename fallback — keeps the predefined list looking friendly.
        const selectedOption = select.options[select.selectedIndex];
        const humanName = (selectedOption && selectedOption.textContent) || data.name;

        appState.customJobList = { jobs: data.jobs, name: humanName };
        // humanName is Jenkins-supplied — escape it; coerce the count.
        countEl.innerHTML = '<strong>' + Number(data.count) + ' jobs</strong> in ' + escapeHtml(humanName);
        countEl.style.display = 'block';

        // Restore the env's stored promotion time so the per-env baseline
        // returns automatically. Falls back to the parent instance's env.
        const instanceEnv = (appState.selectedInstance && appState.selectedInstance.environment) || '';
        const env = (selectedOption && selectedOption.dataset.environment) || instanceEnv;
        if (env) {
            appState._selectedEnvironment = env;
            if (typeof loadPromotionTimeForCurrentEnv === 'function') {
                loadPromotionTimeForCurrentEnv();
            }
        }

        const viewStep = document.getElementById('step-view');
        viewStep.classList.remove('step-active');
        viewStep.classList.add('step-complete');
        document.getElementById('view-badge').textContent = humanName;
        document.getElementById('view-badge').style.display = '';

    } catch (err) {
        document.getElementById('cfg-view-error').textContent = err.message;
        document.getElementById('cfg-view-error').style.display = 'block';
        appState.customJobList = null;
        reportFetchError('JobList', 'Failed to load job list', '/api/load-job-list', err);
    }

    updateFetchButton();
    updateConfigChips();
}

// Parse a user-uploaded JSON job list and validate its entries.
function onJobListUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = JSON.parse(e.target.result);
            let jobs = data.jobs || [];

            // Validate: jobs must be an array of non-empty strings; dedupe.
            if (!Array.isArray(jobs)) {
                throw new Error('"jobs" field must be an array');
            }
            jobs = jobs.filter(j => typeof j === 'string' && j.trim().length > 0);
            if (jobs.length === 0) {
                throw new Error('No valid job entries found in file');
            }
            jobs = [...new Set(jobs)];

            const name = data.name || file.name.replace('.json', '');

            appState.customJobList = { jobs, name };

            const countEl = document.getElementById('joblist-job-count');
            countEl.innerHTML = '<strong>' + Number(jobs.length) + ' jobs</strong> from uploaded file';
            countEl.style.display = 'block';

            document.getElementById('cfg-joblist-select').value = '';

            const viewStep = document.getElementById('step-view');
            viewStep.classList.remove('step-active');
            viewStep.classList.add('step-complete');
            document.getElementById('view-badge').textContent = name;
            document.getElementById('view-badge').style.display = '';

            updateFetchButton();
            updateConfigChips();
        } catch (err) {
            document.getElementById('cfg-view-error').textContent = 'Invalid JSON file: ' + err.message;
            document.getElementById('cfg-view-error').style.display = 'block';
            diagLog('warning', 'JobList', 'Invalid JSON file upload', { raw: err.message });
        }
    };
    reader.readAsText(file);
    // Reset the input so the same file can be re-uploaded.
    event.target.value = '';
}

// Validate a selected Jenkins view and show its job count.
async function onViewChange() {
    const select = document.getElementById('cfg-view-select');
    const selectedPath = select.value;

    document.getElementById('cfg-view-error').style.display = 'none';
    document.getElementById('view-job-count').style.display = 'none';

    if (!selectedPath) {
        appState._resolvedViewUrl = '';
        updateFetchButton();
        updateConfigChips();
        return;
    }

    const resolved = resolveViewUrl(selectedPath);
    appState._resolvedViewUrl = resolved.viewUrl;

    const viewStepEarly = document.getElementById('step-view');
    viewStepEarly.classList.remove('step-active');
    viewStepEarly.classList.add('step-complete');
    const viewNameEarly = select.options[select.selectedIndex].text;
    document.getElementById('view-badge').textContent = viewNameEarly;
    document.getElementById('view-badge').style.display = '';
    updateConfigChips();
    updateFetchButton();

    if (appState.authCredentials) {
        // Show a "Counting…" placeholder right away so the user sees activity.
        const countEl = document.getElementById('view-job-count');
        const viewName = select.options[select.selectedIndex].text;
        countEl.textContent = 'Counting jobs in ' + viewName + '…';
        countEl.style.display = 'block';
        const countTimer = _runElapsedTimer(countEl, 'Counting jobs in ' + viewName + '…');

        try {
            const resp = await apiFetch('/api/discover-view-jobs-count', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...appState.authCredentials,
                    view_path: resolved.viewPath,
                    view_url: resolved.viewUrl
                })
            });
            countTimer.stop();
            const data = await resp.json();

            if (data.error) {
                countEl.style.display = 'none';
                document.getElementById('cfg-view-error').textContent = data.error;
                document.getElementById('cfg-view-error').style.display = 'block';
                return;
            }

            // view_name is Jenkins-supplied — escape it; coerce the count.
            countEl.innerHTML = '<strong>' + Number(data.count) + ' jobs</strong> in ' + escapeHtml(data.view_name || 'this view');
        } catch (err) {
            countTimer.stop();
            countEl.style.display = 'none';
            // Count display is non-blocking — silently skip on error.
        }
    }

}

// Reset the view-selection step back to locked and clear its inputs.
function resetViewStep() {
    const step = document.getElementById('step-view');
    step.classList.remove('step-active', 'step-complete');
    step.classList.add('step-locked');

    hide('view-badge');
    document.getElementById('cfg-view-select').innerHTML = '<option value="">Authenticate first...</option>';
    hide('view-job-count');
    hideError('cfg-view-error');

    document.getElementById('cfg-joblist-select').innerHTML = '<option value="">Select a job list...</option>';
    hide('joblist-job-count');
    appState.customJobList = null;

    // Default back to view mode on reset.
    appState.sourceMode = 'view';
    document.getElementById('tab-view').classList.add('active');
    document.getElementById('tab-joblist').classList.remove('active');
    $id('panel-view').classList.remove('hidden');
    $id('panel-joblist').classList.add('hidden');
}

// Render the auth/source summary chips shown above the toolbar.
function updateConfigChips() {
    const chips = document.getElementById('config-chips');
    let html = '';

    if (appState.authCredentials) {
        let displayHost;
        try { displayHost = new URL(appState.authCredentials.jenkins_url).hostname; }
        catch { displayHost = appState.authCredentials.jenkins_url; }
        // Username (user-supplied) and host (Jenkins-derived) both need escaping.
        html += '<span class="config-chip chip-auth-ok"><span class="chip-dot"></span>' + escapeHtml(appState.authCredentials.username) + '@' + escapeHtml(displayHost) + '</span>';
    } else {
        html += '<span class="config-chip chip-auth-none"><span class="chip-dot"></span>Not authenticated</span>';
    }

    if (appState.sourceMode === 'view') {
        const viewSelect = document.getElementById('cfg-view-select');
        if (viewSelect.value && viewSelect.value !== '') {
            // viewName comes from Jenkins via <select> options.
            const viewName = viewSelect.options[viewSelect.selectedIndex].text;
            html += '<span class="config-chip chip-view"><span class="chip-dot"></span>' + escapeHtml(viewName) + '</span>';
        }
    } else if (appState.sourceMode === 'job_list' && appState.customJobList) {
        // customJobList.name comes from the uploaded JSON.
        html += '<span class="config-chip chip-view"><span class="chip-dot"></span>' + escapeHtml(appState.customJobList.name) + ' (' + Number(appState.customJobList.jobs.length) + ' jobs)</span>';
    }

    chips.innerHTML = html;
}

// Compute readiness flags for the Fetch button (auth + source + same-source detection).
function getFetchSourceState() {
    let sourceReady = false;
    let sourceName = '';
    if (appState.sourceMode === 'view') {
        const resolvedUrl = appState._resolvedViewUrl;
        const viewSelect = $id('cfg-view-select');
        if (resolvedUrl && viewSelect.value && viewSelect.value !== '') {
            sourceReady = true;
            sourceName = viewSelect.options[viewSelect.selectedIndex].text;
        }
    } else if (appState.sourceMode === 'job_list') {
        if (appState.customJobList && appState.customJobList.jobs.length > 0) {
            sourceReady = true;
            sourceName = appState.customJobList.name + ' (' + appState.customJobList.jobs.length + ' jobs)';
        }
    }
    const hasJobs = appState.jobs.size > 0;
    const hasFailed = Array.from(appState.jobs.values()).some(j => j.latest_status === 'FAILURE');
    const resolvedViewUrl = appState._resolvedViewUrl;
    const sameSource = (appState.sourceMode === 'view' && resolvedViewUrl && appState.currentViewUrl === resolvedViewUrl) ||
                       (appState.sourceMode === 'job_list' && appState.customJobList && appState.currentViewUrl === 'job_list:' + appState.customJobList.name);
    return { sourceReady, sourceName, hasJobs, hasFailed, sameSource };
}

// Flip the Fetch button between "Fetch Jobs" and "Full Refresh" based on state.
function updateFetchButtonState(btn, btnRefresh, btnRefreshFailed, state) {
    if (appState.authCredentials && state.sourceReady) {
        if (state.hasJobs && state.sameSource) {
            btn.textContent = 'Full Refresh';
            btn.disabled = false;
            btnRefresh.style.display = '';
            btnRefresh.disabled = false;
        } else {
            btn.textContent = 'Fetch Jobs';
            btn.disabled = false;
            btnRefresh.style.display = 'none';
        }
        btnRefreshFailed.style.display = state.hasFailed ? '' : 'none';
    } else {
        btn.disabled = true;
        btn.textContent = 'Fetch Jobs';
        btnRefresh.style.display = 'none';
        btnRefreshFailed.style.display = 'none';
    }
}

function updateFetchSummary(summary, state) {
    if (appState.authCredentials && state.sourceReady) {
        // sourceName chains through Jenkins / user-uploaded job list.
        summary.innerHTML = 'Ready to fetch from <strong>' + escapeHtml(state.sourceName) + '</strong>';
    } else if (appState.authCredentials) {
        summary.textContent = appState.sourceMode === 'view' ? 'Select a Jenkins view to continue' : 'Select a job list to continue';
    } else {
        summary.textContent = 'Complete the steps above to begin analysis';
    }
}

function updateFetchButton() {
    const btn = $id('btn-fetch');
    const btnRefresh = $id('btn-update');
    const btnRefreshFailed = $id('btn-refresh-failed');
    const summary = $id('fetch-summary');
    const state = getFetchSourceState();
    updateFetchButtonState(btn, btnRefresh, btnRefreshFailed, state);
    updateFetchSummary(summary, state);
}

// Reset the auth wizard and clear its form fields.
function resetConfigPanel() {
    unlockAuth();
    resetViewStep();
    ['cfg-jenkins-url', 'cfg-username', 'cfg-token', 'cfg-environment'].forEach(id => {
        const el = $id(id);
        if (el) el.value = '';
    });
}

// User-confirmed full wipe: jobs, credentials, filters, sort, selections, timers, then reset UI.
function clearSession() {
    if (!confirm('Clear all credentials and job data?')) return;

    appState.jobs.clear();
    appState.expandedRows.clear();
    appState.selectedJobs.clear();
    appState.statusTransitions.clear();
    appState.rerunStates.clear();
    appState.lastRefreshTimes.clear();
    appState.authCredentials = null;
    appState.currentViewUrl = null;
    appState.promotionTime = null;
    appState._resolvedViewUrl = '';
    appState._selectedEnvironment = '';
    appState.filters = {
        status: null,
        searchText: ''
    };

    // Wipe persistent stores too
    try {
        localStorage.removeItem('race.saved_views');
        localStorage.removeItem('auto_refresh_enabled');
        sessionStorage.removeItem('promotion_times');
    } catch (_) { /* private mode or storage disabled */ }

    if (appState._fetchAbortController) {
        appState._fetchAbortController.abort();
        appState._fetchAbortController = null;
    }
    appState.activeOperationId = null;
    appState._fetchErrorCount = 0;

    currentSortKey = null;
    currentSortDir = null;
    document.querySelectorAll('th[data-sortable]').forEach(th => {
        th.removeAttribute('data-sort-dir');
        const icon = th.querySelector('.th-sort-icon');
        if (icon) icon.textContent = '⇅';
    });

    if (_filterSortRaf) {
        cancelAnimationFrame(_filterSortRaf);
        _filterSortRaf = null;
    }

    if (staleCheckInterval) { clearInterval(staleCheckInterval); staleCheckInterval = null; }

    const promoInput = document.getElementById('promotion-datetime');
    if (promoInput) promoInput.value = '';

    resetConfigPanel();
    document.querySelector('tbody').innerHTML = '';
    applyPromotionTime();
    updateSummaryBar();
    updateEmptyState();
    updateConfigChips();
    updateFetchButton();
    showToast('Session cleared', 'success');
}

// Switch between Detail and Summary view modes; the button label always names the DESTINATION mode.
function switchViewMode(mode) {
    appState.viewMode = mode;
    const table = document.getElementById('job-table');
    const rows = Array.from(document.querySelectorAll('tbody tr[data-job-id]'));

    if (mode === 'detail') {
        table.classList.add('mode-detail');
        rows.forEach(row => row.classList.add('detail-mode'));
        showLogAnalysisFilter();
    } else {
        table.classList.remove('mode-detail');
        rows.forEach(row => row.classList.remove('detail-mode'));
        hideLogAnalysisFilter();
    }

    const label = document.getElementById('view-mode-label');
    if (label) label.textContent = (mode === 'detail') ? 'Summary' : 'Detail';
    const btn = document.getElementById('btn-view-mode');
    if (btn) {
        btn.setAttribute('aria-label', mode === 'detail' ? 'Switch to summary view' : 'Switch to detail view');
        btn.setAttribute('title', mode === 'detail' ? 'Switch to summary view' : 'Switch to detail view');
    }
}

// Current credentials or an empty placeholder.
function getCredentials() {
    return appState.authCredentials || { jenkins_url: '', username: '', api_token: '' };
}

// Return credentials, or null after toasting if any field is missing.
function ensureCredentials(toastMsg) {
    var c = getCredentials();
    if (!c.jenkins_url || !c.username || !c.api_token) {
        showToast(toastMsg || 'Missing Jenkins credentials. Please configure first.', 'error');
        return null;
    }
    return c;
}
