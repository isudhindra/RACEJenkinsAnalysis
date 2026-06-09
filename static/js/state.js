// state.js — Central application state container shared across modules via window.appState.
'use strict';

// Single source of truth for the dashboard UI.
window.appState = {
    jobs: new Map(),               // jobId → job record from the backend
    rowEls: new Map(),             // jobId → primary <tr>; perf cache populated in renderJobRow, cleared in resetDashboardState
    detailRowEls: new Map(),       // jobId → detail <tr> when expanded
    viewMode: 'summary',           // 'summary' (card grid) or 'detail' (full table)
    expandedRows: new Set(),       // job IDs whose detail rows are open
    filters: {
        status: null,              // active status filter or null for all
        searchText: '',            // free-text search query
        logAnalysisLabels: [],     // selected log-analysis labels
        releaseStatus: null        // active release-status filter or null
    },
    selectedJobs: new Set(),       // job IDs checked for bulk actions
    activeOperationId: null,       // UUID of the running SSE fetch
    statusTransitions: new Map(),  // tracks status changes for transition animations
    contextsData: null,            // Jenkins instance/context list loaded from contexts.json
    rerunStates: new Map(),        // jobId → rerun badge state (Triggered, TriggerFailed, etc.)
    lastRefreshTimes: new Map(),   // jobId → timestamp of last single-job refresh
    authCredentials: null,         // { jenkins_url, username, api_token } once authenticated
    selectedInstance: null,        // Jenkins instance chosen in the config panel
    currentViewUrl: null,          // resolved URL of the selected Jenkins view
    sourceMode: 'view',            // 'view' or 'job_list' — how jobs are discovered
    customJobList: null,           // user-uploaded job list when sourceMode is 'job_list'
    promotionTime: null,           // ISO datetime baseline for release validation
    _resolvedViewUrl: '',
    _selectedEnvironment: '',
    _fetchAbortController: null,   // AbortController for the active SSE stream
    _fetchErrorCount: 0            // consecutive fetch errors (drives retry logic)
};

// Handle for the stale-data highlight timer (set/cleared by filters.js).
let staleCheckInterval = null;
