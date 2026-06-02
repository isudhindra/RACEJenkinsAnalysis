// Jenkins Dashboard configuration module
// Handles Jenkins authentication, view/job list discovery, credentials validation, and step-by-step wizard UI state

'use strict';

// Shared visibility helper
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

// Show or hide the configuration panel with a toggle animation
function toggleConfigPanel() {
    const panel = document.getElementById('config-panel');
    panel.classList.toggle('expanded');
}

// Update UI and app state when user switches Jenkins instances in the dropdown
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
        // Clear custom field state when switching away
        customInput.value = '';
        customInput.classList.remove('cfg-input-valid', 'cfg-input-invalid');
        document.getElementById('cfg-custom-url-valid').classList.remove('visible');
        hideError('cfg-url-error');
        // Cache instance metadata
        if (appState.contextsData && appState.contextsData.instances) {
            appState.selectedInstance = appState.contextsData.instances.find(i => i.jenkins_url === select.value) || null;
            // Pre-fill username if available
            if (appState.selectedInstance && appState.selectedInstance.default_username) {
                document.getElementById('cfg-username').value = appState.selectedInstance.default_username;
            }
        }
    }

    // Reset downstream steps if instance changes
    resetViewStep();
    updateConfigChips();
    updateFetchButton();
}

// Validate that a Jenkins URL is properly formatted (http/https with valid hostname)
function isValidJenkinsUrl(url) {
    if (!url) return false;
    try {
        var parsed = new URL(url);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0;
    } catch (e) {
        return false;
    }
}

// Set up real-time validation on custom Jenkins URL input with debouncing
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

        // Strip whitespace on blur, re-validate
        input.addEventListener('blur', function() {
            var val = input.value.trim();
            // Remove trailing slash for consistency
            if (val.endsWith('/')) val = val.replace(/\/+$/, '');
            input.value = val;
            if (val.length > 0 && !isValidJenkinsUrl(val)) {
                showError('cfg-url-error', 'Enter a valid URL (e.g. https://jenkins.company.com)');
            }
        });
    });
})();

// Get the active Jenkins URL from either the preset dropdown or custom input field
function getActiveJenkinsUrl() {
    const select = document.getElementById('cfg-jenkins-url');
    if (select.value === '__custom__') {
        return document.getElementById('cfg-custom-url').value.trim().replace(/\/+$/, '');
    }
    return select.value;
}

// Validate credentials by sending them to the backend, then discover available views if valid
async function authenticateCredentials() {
    const jenkinsUrl = getActiveJenkinsUrl();
    const username = document.getElementById('cfg-username').value.trim();
    const token = document.getElementById('cfg-token').value.trim();

    // Clear previous messages
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
        const resp = await fetch('/api/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jenkins_url: jenkinsUrl, username, api_token: token })
        });
        timer.stop();
        const data = await resp.json();

        if (data.valid) {
            // Lock auth step
            lockAuthStep(jenkinsUrl, username, token);
            // Move to view discovery
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

// Check if environment credentials are available and inject a one-click auth button if they are
async function checkEnvCredentials() {
    try {
        const resp = await fetch('/api/env-credentials-check');
        const data = await resp.json();
        if (!data.available) return;

        // Inject CSS if not already present
        if (!document.getElementById('env-auth-styles')) {
            const style = document.createElement('style');
            style.id = 'env-auth-styles';
            style.textContent =
                '.env-auth-section{display:block;margin-top:12px;padding:10px 14px;background:#F0FDFA;border:1px solid #CCFBF1;border-radius:8px}' +
                '.env-auth-label{font-size:11px;font-weight:600;color:#115E59;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px;display:flex;align-items:center;gap:6px}' +
                '.env-auth-label svg{flex-shrink:0}' +
                '.env-auth-hint{font-size:11.5px;color:#5F7A76;margin-top:6px;line-height:1.4}' +
                '.env-auth-hint code{font-size:10.5px;background:#E0F2FE;padding:1px 4px;border-radius:3px}' +
                '.env-auth-divider{display:flex;align-items:center;gap:12px;margin:14px 0 2px;font-size:11px;font-weight:500;color:#94A3B8;text-transform:uppercase;letter-spacing:.06em}' +
                '.env-auth-divider::before,.env-auth-divider::after{content:"";flex:1;height:1px;background:#E2E8F0}' +
                '.cfg-btn-env{display:inline-flex;align-items:center;gap:6px;padding:7px 16px;font-size:12.5px;font-weight:600;border-radius:6px;cursor:pointer;transition:all .15s;border:1px solid #0F766E;background:linear-gradient(180deg,#0D9488,#0F766E);color:#fff;box-shadow:0 1px 2px rgba(15,118,110,.2),inset 0 1px 0 rgba(255,255,255,.15)}' +
                '.cfg-btn-env:hover{background:linear-gradient(180deg,#0F766E,#115E59);border-color:#115E59;box-shadow:0 2px 6px rgba(15,118,110,.3),inset 0 1px 0 rgba(255,255,255,.1)}' +
                '.cfg-btn-env:disabled{background:#99F6E4;border-color:#99F6E4;color:rgba(255,255,255,.7);cursor:not-allowed}';
            document.head.appendChild(style);
        }

        // Build the env-auth section dynamically
        const authActions = document.getElementById('auth-actions');
        if (!authActions) return;

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
            '<div class="env-auth-hint">Credentials sourced from <code>JENKINS_NP_USERNAME</code> and <code>JENKINS_NP_API_KEY1</code>. The API key is never displayed.</div>' +
            '<div class="env-auth-divider">or authenticate manually</div>';

        authActions.parentElement.insertBefore(section, authActions);
    } catch (_) {
        // Network error or env vars not available — no env-auth option
    }
}

// Authenticate using server-side environment variables and lock the auth step on success
async function authenticateWithEnvCredentials() {
    const jenkinsUrl = getActiveJenkinsUrl();

    // Clear previous messages
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
        const resp = await fetch('/api/env-validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jenkins_url: jenkinsUrl })
        });
        timer.stop();
        const data = await resp.json();

        if (data.valid) {
            // Env-auth succeeded — lock the auth step
            // Use the returned username; token is kept server-side
            const envUsername = data.username || 'env-user';
            lockAuthStep(jenkinsUrl, envUsername, '••••••••');
            // Move to view discovery using env credentials via the same endpoint
            await discoverViews(jenkinsUrl, envUsername, '••••••••');
        } else {
            // Env-auth failed — show error, keep manual auth available
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

// Lock the auth step UI after credentials are validated, store them in app state
function lockAuthStep(jenkinsUrl, username, token) {
    const step = document.getElementById('step-auth');
    step.classList.remove('step-active');
    step.classList.add('step-complete', 'step-locked');

    show('auth-badge');
    hide('auth-actions');
    show('auth-lock-overlay');

    // Hide the env-auth section when locked
    const envSection = document.getElementById('env-auth-section');
    if (envSection) envSection.style.display = 'none';

    // Update header context
    const instName = appState.selectedInstance ? appState.selectedInstance.display_name : '';
    const envLabel = document.getElementById('header-env-label');
    if (envLabel && instName) envLabel.textContent = instName;

    // Store in appState
    appState.authCredentials = { jenkins_url: jenkinsUrl, username, api_token: token };

    updateConfigChips();
}

// Unlock the auth step and restore the input fields for re-entry
function unlockAuth(e) {
    if (e) e.stopPropagation();
    const step = document.getElementById('step-auth');
    step.classList.remove('step-complete', 'step-locked');
    step.classList.add('step-active');

    hide('auth-badge');
    show('auth-actions');
    hide('auth-lock-overlay');

    // Restore env-auth section and reset its button
    const envSection = document.getElementById('env-auth-section');
    if (envSection) {
        envSection.style.display = 'block';
        const envBtn = document.getElementById('btn-env-authenticate');
        if (envBtn) {
            envBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>Authenticate using Environment Variables';
            envBtn.disabled = false;
        }
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

// Fetch and populate the Jenkins views dropdown after successful authentication
async function discoverViews(jenkinsUrl, username, token) {
    const viewStep = document.getElementById('step-view');
    viewStep.classList.remove('step-locked');
    viewStep.classList.add('step-active');

    const viewSelect = document.getElementById('cfg-view-select');
    viewSelect.innerHTML = '<option value="">Loading views from Jenkins…</option>';
    viewSelect.disabled = true;

    // Elapsed-time visibility — if Jenkins is slow, the user sees "…(8s)"
    // updating instead of a silent dropdown.
    const loadingOption = viewSelect.options[0];
    const viewsTimer = _runElapsedTimer(loadingOption, 'Loading views from Jenkins…');

    const instanceId = appState.selectedInstance ? appState.selectedInstance.id : '';

    try {
        // Always discover views dynamically from the authenticated Jenkins instance
        const resp = await fetch('/api/discover-views', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jenkins_url: jenkinsUrl, username, api_token: token })
        });
        viewsTimer.stop();
        const data = await resp.json();

        viewSelect.innerHTML = '<option value="">Select a view...</option>';

        if (data.views && data.views.length > 0) {
            data.views.forEach(v => {
                // Extract relative path from full URL
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

    // Also populate the job list dropdown from config
    populateJobListDropdown();
}

// Convert a Jenkins view path to its full URL using the instance base URL
function resolveViewUrl(viewPath) {
    if (!viewPath) return { viewUrl: '', viewPath: '' };
    const jenkinsUrl = appState.authCredentials ? appState.authCredentials.jenkins_url : '';
    if (!jenkinsUrl) return { viewUrl: '', viewPath: viewPath };
    const base = jenkinsUrl.replace(/\/$/, '');
    const normalized = viewPath.replace(/^\//, '').replace(/\/$/, '');
    return { viewUrl: base + '/' + normalized + '/', viewPath: normalized };
}

// Populate the predefined job list dropdown from the selected instance's configuration
function populateJobListDropdown() {
    const select = document.getElementById('cfg-joblist-select');
    select.innerHTML = '<option value="">Select a job list...</option>';
    const instanceId = appState.selectedInstance ? appState.selectedInstance.id : '';

    if (appState.selectedInstance && appState.selectedInstance.predefined_job_lists) {
        appState.selectedInstance.predefined_job_lists.forEach(jl => {
            const opt = document.createElement('option');
            opt.value = jl.job_list_file;
            opt.textContent = jl.name;
            opt.dataset.environment = jl.environment || '';
            opt.dataset.listId = jl.id;
            opt.dataset.instanceId = instanceId;
            select.appendChild(opt);
        });
    }
}

// Switch between view and job list source modes, reset the other mode's selection
function switchSourceMode(mode) {
    appState.sourceMode = mode;

    // Update tabs
    document.getElementById('tab-view').classList.toggle('active', mode === 'view');
    document.getElementById('tab-joblist').classList.toggle('active', mode === 'job_list');

    // Show/hide panels
    $id('panel-view').classList.toggle('hidden', mode !== 'view');
    $id('panel-joblist').classList.toggle('hidden', mode !== 'job_list');

    // Clear the other mode's selection
    if (mode === 'view') {
        // Reset job list selection
        document.getElementById('cfg-joblist-select').value = '';
        hide('joblist-job-count');
        appState.customJobList = null;
    } else {
        // Reset view selection
        document.getElementById('cfg-view-select').value = '';
        hide('view-job-count');
        appState._resolvedViewUrl = '';
    }

    // Reset step state
    const viewStep = document.getElementById('step-view');
    viewStep.classList.remove('step-complete');
    viewStep.classList.add('step-active');
    hide('view-badge');
    hideError('cfg-view-error');

    updateFetchButton();
    updateConfigChips();
}

// Load a predefined job list from server and store it in app state
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
        const resp = await fetch('/api/load-job-list', {
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

        appState.customJobList = { jobs: data.jobs, name: data.name };
        countEl.innerHTML = '<strong>' + data.count + ' jobs</strong> in ' + data.name;
        countEl.style.display = 'block';

        // Derive environment + restore that env's stored promotion time so
        // the user gets their per-environment baseline back automatically.
        const selectedOption = select.options[select.selectedIndex];
        if (selectedOption.dataset.environment) {
            appState._selectedEnvironment = selectedOption.dataset.environment;
            if (typeof loadPromotionTimeForCurrentEnv === 'function') {
                loadPromotionTimeForCurrentEnv();
            }
        }

        // Mark step complete
        const viewStep = document.getElementById('step-view');
        viewStep.classList.remove('step-active');
        viewStep.classList.add('step-complete');
        document.getElementById('view-badge').textContent = data.name;
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

// Parse a JSON job list file from user upload and validate the job entries
function onJobListUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = JSON.parse(e.target.result);
            let jobs = data.jobs || [];

            // Validate: jobs must be an array of non-empty strings
            if (!Array.isArray(jobs)) {
                throw new Error('"jobs" field must be an array');
            }
            jobs = jobs.filter(j => typeof j === 'string' && j.trim().length > 0);
            if (jobs.length === 0) {
                throw new Error('No valid job entries found in file');
            }
            // Deduplicate
            jobs = [...new Set(jobs)];

            const name = data.name || file.name.replace('.json', '');

            appState.customJobList = { jobs, name };

            const countEl = document.getElementById('joblist-job-count');
            countEl.innerHTML = '<strong>' + jobs.length + ' jobs</strong> from uploaded file';
            countEl.style.display = 'block';

            // Clear predefined dropdown
            document.getElementById('cfg-joblist-select').value = '';

            // Mark step complete
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
    // Reset input so same file can be re-uploaded
    event.target.value = '';
}

// Validate a selected Jenkins view and fetch the job count for display
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

    // Resolve view_path → full view_url from instance base URL
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

    // Validate view and get job count — send both view_path and view_url
    if (appState.authCredentials) {
        // Show the count element immediately with a "Counting…" placeholder
        // so users see something happening while Jenkins is queried.
        const countEl = document.getElementById('view-job-count');
        const viewName = select.options[select.selectedIndex].text;
        countEl.textContent = 'Counting jobs in ' + viewName + '…';
        countEl.style.display = 'block';
        const countTimer = _runElapsedTimer(countEl, 'Counting jobs in ' + viewName + '…');

        try {
            const resp = await fetch('/api/discover-view-jobs-count', {
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

            countEl.innerHTML = '<strong>' + data.count + ' jobs</strong> in ' + (data.view_name || 'this view');
        } catch (err) {
            countTimer.stop();
            countEl.style.display = 'none';
            // Non-blocking — just skip count display
        }
    }

}

// Reset the view selection step to locked state and clear all view-related selections
function resetViewStep() {
    const step = document.getElementById('step-view');
    step.classList.remove('step-active', 'step-complete');
    step.classList.add('step-locked');

    hide('view-badge');
    document.getElementById('cfg-view-select').innerHTML = '<option value="">Authenticate first...</option>';
    hide('view-job-count');
    hideError('cfg-view-error');

    // Reset job list state
    document.getElementById('cfg-joblist-select').innerHTML = '<option value="">Select a job list...</option>';
    hide('joblist-job-count');
    appState.customJobList = null;

    // Reset source mode tabs to default (view)
    appState.sourceMode = 'view';
    document.getElementById('tab-view').classList.add('active');
    document.getElementById('tab-joblist').classList.remove('active');
    $id('panel-view').classList.remove('hidden');
    $id('panel-joblist').classList.add('hidden');
}

// Render summary chips showing current auth, source, and job list configuration
function updateConfigChips() {
    const chips = document.getElementById('config-chips');
    let html = '';

    if (appState.authCredentials) {
        let displayHost;
        try { displayHost = new URL(appState.authCredentials.jenkins_url).hostname; }
        catch { displayHost = appState.authCredentials.jenkins_url; }
        html += '<span class="config-chip chip-auth-ok"><span class="chip-dot"></span>' + appState.authCredentials.username + '@' + displayHost + '</span>';
    } else {
        html += '<span class="config-chip chip-auth-none"><span class="chip-dot"></span>Not authenticated</span>';
    }

    if (appState.sourceMode === 'view') {
        const viewSelect = document.getElementById('cfg-view-select');
        if (viewSelect.value && viewSelect.value !== '') {
            const viewName = viewSelect.options[viewSelect.selectedIndex].text;
            html += '<span class="config-chip chip-view"><span class="chip-dot"></span>' + viewName + '</span>';
        }
    } else if (appState.sourceMode === 'job_list' && appState.customJobList) {
        html += '<span class="config-chip chip-view"><span class="chip-dot"></span>' + appState.customJobList.name + ' (' + appState.customJobList.jobs.length + ' jobs)</span>';
    }

    chips.innerHTML = html;
}

// Check auth and source readiness, determine fetch button state
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

// Update fetch button text and state based on auth and source readiness
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

// Update the summary message below the fetch button based on current state
function updateFetchSummary(summary, state) {
    if (appState.authCredentials && state.sourceReady) {
        summary.innerHTML = 'Ready to fetch from <strong>' + state.sourceName + '</strong>';
    } else if (appState.authCredentials) {
        summary.textContent = appState.sourceMode === 'view' ? 'Select a Jenkins view to continue' : 'Select a job list to continue';
    } else {
        summary.textContent = 'Complete the steps above to begin analysis';
    }
}

// Orchestrate fetch button updates: check state, update button text, update summary
function updateFetchButton() {
    const btn = $id('btn-fetch');
    const btnRefresh = $id('btn-update');
    const btnRefreshFailed = $id('btn-refresh-failed');
    const summary = $id('fetch-summary');
    const state = getFetchSourceState();
    updateFetchButtonState(btn, btnRefresh, btnRefreshFailed, state);
    updateFetchSummary(summary, state);
}

// Reset auth and view selections, clear form fields
function resetConfigPanel() {
    unlockAuth();
    resetViewStep();
    // Clear all form fields
    ['cfg-jenkins-url', 'cfg-username', 'cfg-token', 'cfg-environment'].forEach(id => {
        const el = $id(id);
        if (el) el.value = '';
    });
}

// Clear all session data: jobs, credentials, filters, state machines, and reset UI
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

    // Abort any in-flight fetch (F3)
    if (appState._fetchAbortController) {
        appState._fetchAbortController.abort();
        appState._fetchAbortController = null;
    }
    appState.activeOperationId = null;
    appState._fetchErrorCount = 0;

    // Reset sort state (F2)
    currentSortKey = null;
    currentSortDir = null;
    document.querySelectorAll('th[data-sortable]').forEach(th => {
        th.removeAttribute('data-sort-dir');
        const icon = th.querySelector('.th-sort-icon');
        if (icon) icon.textContent = '⇅';
    });

    // Cancel pending RAF from SSE debouncing (F6)
    if (_filterSortRaf) {
        cancelAnimationFrame(_filterSortRaf);
        _filterSortRaf = null;
    }

    // Clear stale-row detection interval
    if (staleCheckInterval) { clearInterval(staleCheckInterval); staleCheckInterval = null; }

    // Clear promotion time input and downstream state
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

// Switch between detail and summary view modes, update table classes and UI labels
function switchViewMode(mode) {
    appState.viewMode = mode;
    const table = document.getElementById('job-table');
    const rows = Array.from(document.querySelectorAll('tbody tr[data-job-id]'));

    if (mode === 'detail') {
        table.classList.add('mode-detail');
        rows.forEach(row => row.classList.add('detail-mode'));
        document.getElementById('view-mode-label').textContent = 'Switch to Summary';
        showLogAnalysisFilter();
    } else {
        table.classList.remove('mode-detail');
        rows.forEach(row => row.classList.remove('detail-mode'));
        document.getElementById('view-mode-label').textContent = 'Switch to Detail';
        hideLogAnalysisFilter();
    }
}

// Return the current credentials or an empty credential object
function getCredentials() {
    return appState.authCredentials || { jenkins_url: '', username: '', api_token: '' };
}

// Check that credentials are complete, show toast if missing, return credentials or null
function ensureCredentials(toastMsg) {
    var c = getCredentials();
    if (!c.jenkins_url || !c.username || !c.api_token) {
        showToast(toastMsg || 'Missing Jenkins credentials. Please configure first.', 'error');
        return null;
    }
    return c;
}
