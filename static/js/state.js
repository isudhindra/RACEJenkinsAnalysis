// state.js — Central application state container.
// All shared runtime data lives on window.appState so every module can read/write it.
'use strict';

// Single source of truth for the entire dashboard UI
window.appState = {
    jobs: new Map(),               // jobId → job record returned by the backend
    viewMode: 'summary',           // 'summary' (card grid) or 'detail' (full table)
    expandedRows: new Set(),       // job IDs whose detail rows are currently open
    filters: {
        status: null,              // active status filter (e.g. 'FAILURE') or null for all
        searchText: '',            // free-text search query from the toolbar input
        logAnalysisLabel: null     // selected log-analysis label filter
    },
    // Sort state is managed by module-scoped currentSortKey/currentSortDir
    selectedJobs: new Set(),       // job IDs the user has checked for bulk actions
    activeOperationId: null,       // UUID of the currently running SSE fetch operation
    statusTransitions: new Map(),  // tracks status changes for visual transition animations
    contextsData: null,            // Jenkins instance/context list loaded from contexts.json
    rerunStates: new Map(),        // jobId → rerun badge state (Triggered, TriggerFailed, etc.)
    lastRefreshTimes: new Map(),   // jobId → timestamp of last single-job refresh
    authCredentials: null,         // { jenkins_url, username, api_token } once authenticated
    selectedInstance: null,        // the Jenkins instance object chosen in the config panel
    currentViewUrl: null,          // resolved URL of the selected Jenkins view
    sourceMode: 'view',           // 'view' or 'job_list' — how jobs are discovered
    customJobList: null,           // user-uploaded job list (array of URLs) if sourceMode is 'job_list'
    promotionTime: null,           // ISO datetime string for release-validation baseline
    _resolvedViewUrl: '',          // internal: fully resolved view URL used during fetch
    _selectedEnvironment: '',      // internal: environment label for the selected context
    _fetchAbortController: null,   // internal: AbortController for the active SSE stream
    _fetchErrorCount: 0            // internal: consecutive fetch errors (drives retry logic)
};

// Interval handle for the stale-data highlight timer (set/cleared by filters.js)
let staleCheckInterval = null;
