const vscode = acquireVsCodeApi();
// track the current folder path (populated from incoming state/config)
let currentFolderPath = null;
// transient override for next generation only
let overrideDisableRedaction = false;
// Track whether a transient override was used for an in-flight generate request
let pendingOverrideUsed = false;
// Visual row height / basic list state
const ITEM_HEIGHT = 28; // The height of each file row in pixels
let filesCache = [];
let selectedSet = new Set();
let pendingPersistedSelection = null;
let pendingPersistedFocusIndex = undefined;
// Pause state (moved up so message handlers can reference it safely)
let paused = false;

// Lightweight DOM cache for frequently accessed nodes to avoid repeated queries
const nodes = {
    toolbar: null,
    settings: null,
    presetBtn: null,
    presetMenu: null,
    toastRoot: null,
    ingestPreviewRoot: null,
    ingestSpinner: null,
    ingestPreviewText: null,
    fileListRoot: null,
    asciiTree: null,
    chartContainer: null,
    stats: null,
    chips: null,
    progressContainer: null,
    progressBar: null,
    cancelWriteBtn: null,
    pauseBtn: null
};

function node(id) {
    // return cached node if present, otherwise fall back to live query
    return nodes[id] || document.getElementById(id);
}

function postAction(actionType, payload) {
    const msg = Object.assign({ type: 'action', actionType }, payload || {});
    if (currentFolderPath) { msg.folderPath = currentFolderPath; }
    vscode.postMessage(msg);
}

function postConfig(action, payload) {
    const msg = Object.assign({ type: 'config', action }, payload || {});
    if (currentFolderPath) { msg.folderPath = currentFolderPath; }
    vscode.postMessage(msg);
}

function renderFileList(state) {
    const fileListRoot = document.getElementById('file-list');
    if (!fileListRoot) { return; }

    fileListRoot.innerHTML = ''; // Clear previous content

    const fileTree = state.fileTree || {};
    // Use selectedPaths from the state, which is an array of strings
    const selectedPaths = new Set(state.selectedPaths || []);

    if (Object.keys(fileTree).length === 0) {
        fileListRoot.innerHTML = '<div class="file-row-message">No files to display.</div>';
        return;
    }

    // This function will be called when a checkbox state changes.
    const handleSelectionChange = () => {
        const allCheckboxes = fileListRoot.querySelectorAll('.file-checkbox');
        const newSelectedPaths = [];
        allCheckboxes.forEach(cb => {
            if (cb.checked) {
                const path = cb.getAttribute('data-path');
                // Only add file paths to the selection, not folders
                const li = cb.closest('li.file-item');
                if (li && path) {
                    newSelectedPaths.push(path);
                }
            }
        });
        postAction('setSelection', { relPaths: newSelectedPaths });
    };

    // Recursive function to build the tree HTML and attach listeners
    function createTreeHtml(node, pathPrefix = '') {
        const ul = document.createElement('ul');
        ul.className = 'file-tree-ul';

        const entries = Object.keys(node).sort((a, b) => {
            const aIsFile = node[a].__isFile;
            const bIsFile = node[b].__isFile;
            if (aIsFile && !bIsFile) { return 1; }
            if (!aIsFile && bIsFile) { return -1; }
            return a.localeCompare(b);
        });

        for (const key of entries) {
            const currentNode = node[key];
            const isFile = !!currentNode.__isFile;
            const fullPath = currentNode.path || `${pathPrefix}${key}`;

            const li = document.createElement('li');
            li.className = isFile ? 'file-tree-li file-item' : 'file-tree-li folder-item';
            li.setAttribute('data-path', fullPath);

            const label = document.createElement('label');
            label.className = 'file-tree-label';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'file-checkbox';
            checkbox.checked = selectedPaths.has(fullPath);
            checkbox.setAttribute('data-path', fullPath);

            // *** ADDING CHECKBOX INTERACTIVITY ***
            checkbox.addEventListener('change', () => {
                const isChecked = checkbox.checked;
                // If a folder is checked/unchecked, apply the same state to all children
                if (!isFile) {
                    const descendantCheckboxes = li.querySelectorAll('.file-checkbox');
                    descendantCheckboxes.forEach(descCb => {
                        descCb.checked = isChecked;
                    });
                }
                handleSelectionChange();
            });
            
            const icon = document.createElement('span');
            icon.className = 'file-tree-icon';

            const name = document.createElement('span');
            name.className = 'file-tree-name';
            name.textContent = key;
            
            // *** ADDING EXPAND/COLLAPSE INTERACTIVITY ***
            if (!isFile) {
                // Clicking the name/icon of a folder toggles its expanded state
                name.addEventListener('click', () => li.classList.toggle('expanded'));
                icon.addEventListener('click', () => li.classList.toggle('expanded'));
            }

            label.appendChild(checkbox);
            label.appendChild(icon);
            label.appendChild(name);
            li.appendChild(label);

            if (!isFile) {
                li.appendChild(createTreeHtml(currentNode, `${fullPath}/`));
            }
            ul.appendChild(li);
        }
        return ul;
    }

    fileListRoot.appendChild(createTreeHtml(fileTree));
}

// Lightweight message router: forward a few key message types to the UI functions
window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type === 'restoredState') {
        try {
            const s = msg.state || {};
            if (Array.isArray(s.selectedFiles) && s.selectedFiles.length > 0) {
                pendingPersistedSelection = s.selectedFiles.slice();
            }
            if (s.focusIndex !== undefined && typeof s.focusIndex === 'number') {
                pendingPersistedFocusIndex = s.focusIndex;
            }
        } catch (e) { /* swallow */ }
    }
    if (msg.type === 'state') {
        renderFileList(msg.state);
        try {
            const s = msg.state || {};
            if (typeof s.paused !== 'undefined') {
                paused = !!s.paused;
                updatePauseButton();
            }
        } catch (e) { /* swallow */ }
        try {
            const s = msg.state || {};
            // Derive a sensible totalFiles value: prefer explicit totalFiles, otherwise
            // infer from selectedPaths length, otherwise count leaves in fileTree.
            let totalFiles = (typeof s.totalFiles === 'number') ? s.totalFiles : 0;
            if ((!totalFiles || totalFiles === 0) && Array.isArray(s.selectedPaths) && s.selectedPaths.length > 0) {
                totalFiles = s.selectedPaths.length;
            }
            if ((!totalFiles || totalFiles === 0) && s.fileTree && typeof s.fileTree === 'object') {
                // count leaves in fileTree quickly
                const countLeaves = (node) => {
                    if (!node || typeof node !== 'object') { return 0; }
                    let c = 0;
                    for (const k of Object.keys(node)) {
                        if (node[k] && node[k].__isFile) { c += 1; }
                        if (node[k] && !node[k].__isFile) { c += countLeaves(node[k]); }
                    }
                    return c;
                };
                try { totalFiles = countLeaves(s.fileTree); } catch (e) { /* ignore counting errors */ }
            }
            if (pendingPersistedSelection && totalFiles > 0) {
                postAction('setSelection', { relPaths: pendingPersistedSelection });
                try {
                    const persist = { selectedFiles: pendingPersistedSelection, focusIndex: pendingPersistedFocusIndex };
                    vscode.postMessage({ type: 'persistState', state: persist });
                } catch (e) {}
                pendingPersistedSelection = null;
                pendingPersistedFocusIndex = undefined;
            }
        } catch (e) { /* swallow */ }
        try {
            const s = msg.state || {};
            const delta = {
                selectedCount: s.selectedCount || (Array.isArray(s.selectedFiles) ? s.selectedFiles.length : (s.selectedCount || 0)),
                totalFiles: s.totalFiles || 0,
                selectedSize: s.selectedSize || 0,
                tokenEstimate: s.tokenEstimate || (s.stats && s.stats.tokenEstimate) || 0,
                contextLimit: (s && typeof s.contextLimit !== 'undefined') ? s.contextLimit : undefined
            };
            renderPreviewDelta(delta);
        } catch (e) {}
        try {
            currentFolderPath = msg.state && (msg.state.folderPath || msg.state.workspaceFolder || msg.state.rootPath || msg.state.workspaceSlug) || null;
            const slugEl = node('workspace-slug');
            if (slugEl) {
                const wf = msg.state && (msg.state.workspaceFolder || msg.state.workspaceSlug || msg.state.rootPath || msg.state.folderPath);
                slugEl.textContent = wf ? String(wf) : '';
            }
        } catch (e) {}
    } else if (msg.type === 'previewDelta') {
        // This is the core of the fix. We now call renderFileList from here.
        renderPreviewDelta(msg.delta); // Update the chips
        if (msg.delta && msg.delta.fileTree) {
            // Construct a minimal state object for the rendering function using fileTree/selectedPaths
            const syntheticState = {
                fileTree: msg.delta.fileTree,
                selectedPaths: Array.isArray(msg.delta.selectedPaths) ? msg.delta.selectedPaths : [],
                minimalSelectedTreeLines: msg.delta.minimalSelectedTreeLines
            };
            renderFileList(syntheticState); // Re-render the file list
        }
    } else if (msg.type === 'ingestPreview') {
        const previewRoot = nodes.ingestPreviewRoot || document.getElementById('ingest-preview');
        const textEl = nodes.ingestPreviewText || document.getElementById('ingest-preview-text');
        const spinner = nodes.ingestSpinner || document.getElementById('ingest-spinner');
        if (previewRoot) { previewRoot.classList.remove('loading'); }
        if (spinner) { spinner.hidden = true; spinner.setAttribute('aria-hidden', 'true'); }
        if (textEl) {
            const payload = msg.payload || {};
            const p = payload.preview;
            if (p) {
                textEl.textContent = (p.summary || '') + '\n\n' + (p.tree || '');
            } else if (payload.output) {
                textEl.textContent = String(payload.output).slice(0, 2000);
            } else {
                textEl.textContent = 'No preview available';
            }
        }
    } else if (msg.type === 'ingestError') {
        const previewRoot = nodes.ingestPreviewRoot || document.getElementById('ingest-preview');
        const spinner = nodes.ingestSpinner || document.getElementById('ingest-spinner');
        const textEl = nodes.ingestPreviewText || document.getElementById('ingest-preview-text');
        if (previewRoot) { previewRoot.classList.remove('loading'); }
        if (spinner) { spinner.hidden = true; spinner.setAttribute('aria-hidden', 'true'); }
        if (textEl) { textEl.textContent = ''; }
        showToast('Ingest failed: ' + (msg.error || 'unknown'), 'error', 6000);
    } else if (msg.type === 'config') {
        try { currentFolderPath = msg.folderPath || msg.workspaceFolder || currentFolderPath; } catch (e) {}
        populateSettings(msg.settings);
        try {
            const settings = msg.settings || {};
            const active = settings.filterPresets || settings.presets || null;
            let activePreset = null;
            if (Array.isArray(active) && active.length > 0) { activePreset = String(active[0]); }
            else if (typeof active === 'string' && active.trim()) { activePreset = active.trim(); }
            togglePresetSelectionUI(activePreset);
        } catch (e) { /* swallow */ }
    } else if (msg.type === 'progress') {
        (window.__handleProgress || handleProgress)(msg.event);
    } else if (msg.type === 'generationResult') {
        try {
            const res = msg.result || {};
            if (res.redactionApplied) {
                showToast('Output contained redacted content (masked). Toggle "Show redacted" in Settings to reveal.', 'warn', 6000);
            }
            if (res && res.error) {
                showToast(String(res.error), 'warn', 6000);
                if (pendingOverrideUsed) {
                    overrideDisableRedaction = true;
                    const rb = document.getElementById('btn-disable-redaction');
                    if (rb) { rb.setAttribute('aria-pressed', 'true'); rb.classList.add('active'); }
                }
            } else {
                pendingOverrideUsed = false;
            }
        } catch (e) {}
    }
});

function renderPreviewDelta(delta) {
    const statsTarget = nodes.stats || document.getElementById('stats');
    const chipsTarget = nodes.chips || document.getElementById('status-chips');
    if (statsTarget === null && chipsTarget === null) { return; }

    // Small helpers
    function fmtSize(n) {
        if (n === undefined || n === null) {
            return '';
        }
        if (n < 1024) {
            return `${n} B`;
        }
        if (n < 1024 * 1024) {
            return `${(n / 1024).toFixed(1)} KB`;
        }
        return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    }

    const parts = [];
    if (delta && delta.selectedCount !== undefined && delta.selectedCount !== null) {
        parts.push(`${delta.selectedCount} selected`);
    }
    if (delta && delta.totalFiles !== undefined && delta.totalFiles !== null) {
        parts.push(`${delta.totalFiles} files`);
    }
    if (delta && delta.selectedSize !== undefined && delta.selectedSize !== null) {
        parts.push(fmtSize(delta.selectedSize));
    }
    if (delta && delta.tokenEstimate !== undefined && delta.tokenEstimate !== null) {
        parts.push(`${Math.round(delta.tokenEstimate)} tokens`);
    }

    // Preserve legacy #stats text
    if (statsTarget !== null) { statsTarget.textContent = parts.join(' · '); }

    // Render compact chips
    if (chipsTarget !== null) {
        const chips = [];
        if (delta && delta.selectedCount !== undefined && delta.selectedCount !== null) {
            chips.push({ label: 'Selected', value: String(delta.selectedCount) });
        }
        if (delta && delta.totalFiles !== undefined && delta.totalFiles !== null) {
            chips.push({ label: 'Files', value: String(delta.totalFiles) });
        }
        if (delta && delta.selectedSize !== undefined && delta.selectedSize !== null) {
            chips.push({ label: 'Size', value: fmtSize(delta.selectedSize) });
        }
        if (delta && delta.tokenEstimate !== undefined && delta.tokenEstimate !== null) {
            chips.push({ label: 'Tokens', value: String(Math.round(delta.tokenEstimate)) });
        }

        const overLimit = delta && delta.tokenEstimate !== undefined && delta.contextLimit !== undefined && delta.tokenEstimate > delta.contextLimit;

    chipsTarget.innerHTML = chips
            .map(function (c) {
                return (
                    '<div class="status-chip' + (overLimit ? ' over-limit' : '') + '">' +
                        '<span class="label">' + c.label + '</span>' +
                        '<span class="value">' + c.value + '</span>' +
                    '</div>'
                );
            })
            .join('');

        // Persistent accessible banner when token estimate exceeds context limit
        try {
            const bannerId = 'over-limit-banner';
            let banner = document.getElementById(bannerId);
            if (overLimit) {
                const message = 'Token estimate exceeds configured context limit — output may be truncated or incomplete.';
                if (!banner) {
                    banner = document.createElement('div');
                    banner.id = bannerId;
                    banner.className = 'over-limit-banner';
                    banner.setAttribute('role', 'status');
                    banner.setAttribute('aria-live', 'assertive');
                    banner.setAttribute('aria-atomic', 'true');
                    const text = document.createElement('span');
                    text.className = 'over-limit-text';
                    banner.appendChild(text);
                    // Insert the banner above the chips target for visual prominence
                    if (chipsTarget && chipsTarget.parentNode) { chipsTarget.parentNode.insertBefore(banner, chipsTarget); }
                    else { document.body.insertBefore(banner, document.body.firstChild); }
                }
                const txt = banner.querySelector('.over-limit-text'); if (txt) { txt.textContent = message; }
            } else { if (banner && banner.parentNode) { banner.parentNode.removeChild(banner); } }
        } catch (e) { /* swallow DOM errors to avoid breaking the webview */ }
    }
}

// Progress & toast helpers
const progressContainer = () => nodes.progressContainer || document.getElementById('progress-container');
const progressBar = () => nodes.progressBar || document.getElementById('progress-bar');
function handleProgress(e) {
    if (!e) { return; }
    const container = progressContainer();
    const bar = progressBar();
    if (!container || !bar) { return; }
    // Also update inline progress stats for generation as well as scan
        try {
            const progressStats = document.querySelector('.progress-stats');
            if (progressStats) {
            const pParts = [];
            if (typeof e.totalFiles === 'number') { pParts.push(`${e.totalFiles} files`); }
            if (typeof e.totalSize === 'number') {
                const s = e.totalSize;
                let sizeStr = '';
                if (s < 1024) { sizeStr = `${s} B`; }
                else if (s < 1024 * 1024) { sizeStr = `${(s/1024).toFixed(1)} KB`; }
                else if (s < 1024 * 1024 * 1024) { sizeStr = `${(s/(1024*1024)).toFixed(1)} MB`; }
                else { sizeStr = `${(s/(1024*1024*1024)).toFixed(1)} GB`; }
                pParts.push(sizeStr);
            }
            if (typeof e.tokenEstimate === 'number') { pParts.push(`~${Math.round(e.tokenEstimate)} tokens`); }
            progressStats.textContent = pParts.join(' · ');
        }
    } catch (ex) {
        // swallow
    }
    if (e.mode === 'start') {
        if (e.determinate) {
            container.classList.remove('indeterminate');
            bar.style.width = (e.percent || 0) + '%';
            bar.setAttribute('aria-valuenow', String(Math.round(e.percent || 0)));
        } else {
            container.classList.add('indeterminate');
            bar.style.width = '40%';
            bar.removeAttribute('aria-valuenow');
        }
        showToast(e.message || (e.op + ' started'));
        // If a write operation starts, reveal the Cancel write affordance
    try { if (e.op === 'write') { const cw = nodes.cancelWriteBtn || document.getElementById('btn-cancel-write'); if (cw) { cw.hidden = false; cw.removeAttribute('aria-hidden'); } } } catch (ex) {}
    } else if (e.mode === 'progress') {
        container.classList.remove('indeterminate');
        bar.style.width = (e.percent || 0) + '%';
        bar.setAttribute('aria-valuenow', String(Math.round(e.percent || 0)));
    } else if (e.mode === 'end') {
        container.classList.remove('indeterminate');
        bar.style.width = '100%';
        bar.setAttribute('aria-valuenow', '100');
        setTimeout(() => { bar.style.width = '0%'; }, 600);
        showToast(e.message || (e.op + ' finished'), 'success');
    // hide cancel affordance when write ends
    try { if (e.op === 'write') { const cw = nodes.cancelWriteBtn || document.getElementById('btn-cancel-write'); if (cw) { cw.hidden = true; cw.setAttribute('aria-hidden', 'true'); } } } catch (ex) {}
    }
}

// Pause/Resume UI wiring
const pauseBtn = () => nodes.pauseBtn || document.getElementById('btn-pause-resume');
function updatePauseButton() {
    const b = pauseBtn();
    if (!b) { return; }
    // Update text, pressed state and CSS class for accessibility and styling
    b.textContent = paused ? 'Resume' : 'Pause';
    try { b.setAttribute('aria-pressed', String(!!paused)); } catch (e) {}
    try { b.classList.toggle('paused', !!paused); } catch (e) {}
}

// Listen for scan progress stats to update small status area
function handleScanStats(e) {
    if (!e || e.op !== 'scan') { return; }
    const statsEl = nodes.stats || document.getElementById('stats');
    if (!statsEl) { return; }
    const parts = [];
    if (typeof e.totalFiles === 'number') { parts.push(`Scanned: ${e.totalFiles}`); }
    if (typeof e.totalSize === 'number') { parts.push(`Size: ${e.totalSize} B`); }
    statsEl.textContent = parts.join(' · ');
    // Also update inline progress stats next to the progress bar
    const progressStats = document.querySelector('.progress-stats');
    if (progressStats) {
        const pParts = [];
        if (typeof e.totalFiles === 'number') { pParts.push(`${e.totalFiles} files`); }
        if (typeof e.totalSize === 'number') {
            const s = e.totalSize;
            let sizeStr = '';
            if (s < 1024) { sizeStr = `${s} B`; }
            else if (s < 1024 * 1024) { sizeStr = `${(s/1024).toFixed(1)} KB`; }
            else if (s < 1024 * 1024 * 1024) { sizeStr = `${(s/(1024*1024)).toFixed(1)} MB`; }
            else { sizeStr = `${(s/(1024*1024*1024)).toFixed(1)} GB`; }
            pParts.push(sizeStr);
        }
        if (typeof e.tokenEstimate === 'number') { pParts.push(`~${Math.round(e.tokenEstimate)} tokens`); }
        progressStats.textContent = pParts.join(' · ');
    }
}

// augment handleProgress to also call handleScanStats
const origHandleProgress = handleProgress;
function handleProgressWrapper(e) {
    origHandleProgress(e);
    handleScanStats(e);
}
// replace handler reference used by message listener
window.__handleProgress = handleProgressWrapper;

function showToast(msg, kind='info', ttl=4000) {
    const root = document.getElementById('toast-root');
    if (!root) { return; }
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    const m = document.createElement('div'); m.className = 'msg'; m.textContent = msg; t.appendChild(m);
    root.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(6px)'; }, ttl - 300);
    setTimeout(() => { t.remove(); }, ttl);
}

// Request initial state
window.onload = function() {
    vscode.postMessage({ type: 'getState' });
    // Populate node cache for frequently used elements
    try {
        nodes.toolbar = document.getElementById('toolbar');
        nodes.settings = document.getElementById('settings');
        nodes.presetBtn = document.getElementById('preset-btn');
        nodes.presetMenu = document.getElementById('preset-menu');
        nodes.toastRoot = document.getElementById('toast-root');
        nodes.ingestPreviewRoot = document.getElementById('ingest-preview');
        nodes.ingestSpinner = document.getElementById('ingest-spinner');
        nodes.ingestPreviewText = document.getElementById('ingest-preview-text');
        nodes.fileListRoot = document.getElementById('file-list');
        nodes.asciiTree = document.getElementById('ascii-tree');
        nodes.chartContainer = document.getElementById('chart-container');
        nodes.stats = document.getElementById('stats');
        nodes.chips = document.getElementById('status-chips');
        nodes.progressContainer = document.getElementById('progress-container');
        nodes.progressBar = document.getElementById('progress-bar');
        nodes.cancelWriteBtn = document.getElementById('btn-cancel-write');
        nodes.pauseBtn = document.getElementById('btn-pause-resume');
    } catch (e) { /* ignore cache wiring errors */ }

    // Delegate toolbar clicks to buttons with data-action attributes (simpler aria-friendly wiring)
    const toolbar = nodes.toolbar || document.getElementById('toolbar');
    function sendCmd(cmd, payload) { postAction(cmd, payload); }
    // Restore paused state from localStorage if present
    try {
        const p = window.localStorage.getItem('cbd_paused');
        if (p !== null) { paused = p === '1' || p === 'true'; }
    } catch (e) {}
    // Ensure the pause button reflects current state
    updatePauseButton();
    if (toolbar) {
        toolbar.addEventListener('click', (ev) => {
            const btn = ev.target && (ev.target.closest ? ev.target.closest('button') : null);
            if (!btn) { return; }
            const action = btn.getAttribute('data-action');
            if (!action) { return; }
            // handle parameterized actions like applyPreset
            if (action === 'applyPreset') {
                const preset = btn.getAttribute('data-preset');
                sendCmd('applyPreset', { preset });
                // Immediately update UI to reflect user's choice (optimistic)
                try { togglePresetSelectionUI(preset); } catch (e) {}
                return;
            }

            // Select all / clear selection operate on the rendered tree DOM
            if (action === 'selectAll' || action === 'clearSelection') {
                const shouldSelect = action === 'selectAll';
                try {
                    const checkboxes = document.querySelectorAll('#file-list .file-checkbox');
                    const allPaths = Array.from(checkboxes).map(cb => cb.getAttribute('data-path'));
                    postAction('setSelection', { relPaths: shouldSelect ? allPaths : [] });
                } catch (e) { /* swallow DOM errors */ }
                return;
            }
            if (action === 'togglePause') {
                paused = !paused;
                try { window.localStorage.setItem('cbd_paused', paused ? '1' : '0'); } catch (e) {}
                updatePauseButton();
                postAction(paused ? 'pauseScan' : 'resumeScan');
                return;
            }
            if (action === 'openSettings') {
                const settingsEl = document.getElementById('settings');
                if (settingsEl) { settingsEl.hidden = false; }
                // Request latest config from the extension for the settings UI
                postAction('configRequest');
                return;
            }
            if (action === 'ingestRemote') {
                const m = document.getElementById('ingestModal');
                if (m) { m.hidden = false; }
                return;
            }
            // One-shot toggle button is not part of data-action; handle explicit button
            if (btn.id === 'btn-disable-redaction') {
                overrideDisableRedaction = !overrideDisableRedaction;
                btn.setAttribute('aria-pressed', String(overrideDisableRedaction));
                btn.classList.toggle('active', overrideDisableRedaction);
                showToast(overrideDisableRedaction ? 'Redaction disabled for next run' : 'Redaction override cleared', 'info', 1800);
                return;
            }
            // default simple command
            // include transient override when generating
                    if (action === 'generateDigest') {
                        // If the user toggled the transient "Disable redaction for this run" button,
                        // the webview includes a one-shot overrides object which signals the
                        // extension to bypass redaction for this generation only. We then immediately
                        // clear the transient flag so it cannot be reused accidentally.
                        const payload = {};
                        if (overrideDisableRedaction) {
                            payload.overrides = { showRedacted: true };
                            // mark that we used an override for this in-flight generation; do NOT
                            // clear the UI immediately — only clear on success, and restore on error.
                            pendingOverrideUsed = true;
                        }
                        postAction(action, payload);
                        return;
                    }
            sendCmd(action);
        });
    }
    // Also wire the explicit pause button if present (some DOM variants
    // may render a dedicated pause button without data-action wiring).
    try {
        const explicitPause = nodes.pauseBtn || document.getElementById('btn-pause-resume');
        if (explicitPause) {
            explicitPause.addEventListener('click', (ev) => {
                ev.preventDefault(); ev.stopPropagation();
                paused = !paused;
                try { window.localStorage.setItem('cbd_paused', paused ? '1' : '0'); } catch (e) {}
                updatePauseButton();
                postAction(paused ? 'pauseScan' : 'resumeScan');
            });
        }
    } catch (e) { /* swallow */ }
    // Cancel write button wiring (posts cancelWrite action to extension)
    const cancelWriteBtn = nodes.cancelWriteBtn || document.getElementById('btn-cancel-write');
    if (cancelWriteBtn) {
        cancelWriteBtn.addEventListener('click', (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            postAction('cancelWrite');
            // hide the button immediately to give immediate feedback
            cancelWriteBtn.hidden = true; cancelWriteBtn.setAttribute('aria-hidden', 'true');
            showToast('Canceling write...', 'info', 2000);
        });
    }
    // Preset popup wiring: keep the popup markup but wire it to postAction('applyPreset', { preset })
    // Toggle handlers for the preset menu button and menu items
    const presetBtn = document.getElementById('preset-btn');
    const presetMenu = document.getElementById('preset-menu');
    function openPresetMenu() {
        if (!presetBtn || !presetMenu) { return; }
        presetBtn.setAttribute('aria-expanded', 'true');
        presetMenu.removeAttribute('hidden');
        presetMenu.setAttribute('aria-hidden', 'false');
        // focus first menuitem for keyboard users
        const first = presetMenu.querySelector('[role="menuitem"]');
        if (first && typeof first.focus === 'function') { first.focus(); }
        // capture outside clicks to close
        setTimeout(() => { window.addEventListener('click', onWindowClickForPreset); }, 0);
    }
    function closePresetMenu() {
        if (!presetBtn || !presetMenu) { return; }
        presetBtn.setAttribute('aria-expanded', 'false');
        presetMenu.setAttribute('aria-hidden', 'true');
        presetMenu.setAttribute('hidden', '');
        window.removeEventListener('click', onWindowClickForPreset);
        // return focus to the button
        if (typeof presetBtn.focus === 'function') { presetBtn.focus(); }
    }
    function togglePresetMenu() {
        if (!presetBtn || !presetMenu) { return; }
        const expanded = presetBtn.getAttribute('aria-expanded') === 'true';
        if (expanded) { closePresetMenu(); } else { openPresetMenu(); }
    }
    function onWindowClickForPreset(ev) {
        const tgt = ev.target;
        if (!presetMenu || !presetBtn) { return; }
        if (tgt === presetBtn || presetBtn.contains && presetBtn.contains(tgt)) { return; }
        if (presetMenu.contains && presetMenu.contains(tgt)) { return; }
        closePresetMenu();
    }
    if (nodes.presetBtn) {
        nodes.presetBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePresetMenu(); });
        // close on Escape when the button has focus
        nodes.presetBtn.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePresetMenu(); } });
    }
    if (nodes.presetMenu) {
        // Use a small delegation for menu items to avoid per-item wiring
        nodes.presetMenu.addEventListener('click', (ev) => {
            const it = ev.target && ev.target.closest ? ev.target.closest('[role="menuitem"][data-preset]') : null;
            if (!it) { return; }
            ev.preventDefault(); ev.stopPropagation();
            const preset = it.getAttribute('data-preset');
            if (preset) { postAction('applyPreset', { preset }); }
            closePresetMenu();
        });
        nodes.presetMenu.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); const it = ev.target && ev.target.closest ? ev.target.closest('[role="menuitem"][data-preset]') : null; if (it) { it.click(); } }
            if (ev.key === 'Escape') { closePresetMenu(); }
        });
    }
    document.getElementById('ingest-cancel')?.addEventListener('click', () => { const m = document.getElementById('ingestModal'); if (m) { m.hidden = true; } });
    document.getElementById('ingest-submit')?.addEventListener('click', () => {
        const repo = (document.getElementById('ingest-repo') || {}).value || '';
        const ref = (document.getElementById('ingest-ref') || {}).value || '';
        const subpath = (document.getElementById('ingest-subpath') || {}).value || '';
        const includeSubmodules = !!(document.getElementById('ingest-submodules') && document.getElementById('ingest-submodules').checked);
        if (!repo || repo.trim().length === 0) { showToast('Please enter a repo URL or owner/repo slug', 'error'); return; }
        // simple client-side validation
        const slugLike = /^[^\/]+\/[^\/]+$/.test(repo.trim()) || /github\.com\//.test(repo);
        if (!slugLike) { showToast('Invalid repo format', 'error'); return; }
    // send to extension
    postAction('ingestRemote', { repo: repo.trim(), ref: ref.trim() || undefined, subpath: subpath.trim() || undefined, includeSubmodules });
    // set loading state in modal so users get immediate feedback
    if (nodes.ingestPreviewRoot) { nodes.ingestPreviewRoot.classList.add('loading'); }
    if (nodes.ingestSpinner) { nodes.ingestSpinner.hidden = false; nodes.ingestSpinner.removeAttribute('aria-hidden'); }
    if (nodes.ingestPreviewText) { nodes.ingestPreviewText.textContent = 'Starting ingest...'; nodes.ingestPreviewText.classList.add('loading-placeholder'); }
    });
};

function populateSettings(settings) {
    const form = document.getElementById('settingsForm');
    if (!form) { return; }
    const getEl = (name) => form.querySelector(`[name="${name}"]`);
    // Support both legacy and normalized keys
    const gitignoreEl = getEl('gitignore');
    const respectGitignoreVal = (typeof settings.respectGitignore !== 'undefined') ? settings.respectGitignore : settings.gitignore;
    if (gitignoreEl) { gitignoreEl.checked = !!respectGitignoreVal; }
    const outEl = getEl('outputFormat'); if (outEl) { outEl.value = settings.outputFormat || 'text'; }
    const modelEl = getEl('tokenModel'); if (modelEl) { modelEl.value = settings.tokenModel || 'chars-approx'; }
    const binEl = getEl('binaryPolicy'); const binaryFilePolicyVal = (settings.binaryFilePolicy !== undefined) ? settings.binaryFilePolicy : settings.binaryPolicy; if (binEl) { binEl.value = binaryFilePolicyVal || 'skip'; }
    // New slider + number inputs for limits
    const maxFilesNumber = document.getElementById('maxFilesNumber');
    const maxFilesRange = document.getElementById('maxFilesRange');
    const maxTotalSizeNumber = document.getElementById('maxTotalSizeNumber');
    const maxTotalSizeRange = document.getElementById('maxTotalSizeRange');
    const tokenLimitNumber = document.getElementById('tokenLimitNumber');
    const tokenLimitRange = document.getElementById('tokenLimitRange');
    const defaults = { maxFiles: 25000, maxTotalSizeBytes: 536870912, tokenLimit: 32000 };
    // thresholds may be provided normalized (flat) or as thresholds object
    const cfgThresholds = settings.thresholds || {};
    const maxFilesVal = (typeof settings.maxFiles !== 'undefined') ? settings.maxFiles : (cfgThresholds.maxFiles || defaults.maxFiles);
    const maxTotalSizeVal = (typeof settings.maxTotalSizeBytes !== 'undefined') ? settings.maxTotalSizeBytes : (cfgThresholds.maxTotalSizeBytes || defaults.maxTotalSizeBytes);
    const tokenLimitVal = (typeof settings.tokenLimit !== 'undefined') ? settings.tokenLimit : (cfgThresholds.tokenLimit || defaults.tokenLimit);
    if (maxFilesNumber) { maxFilesNumber.value = String(maxFilesVal); }
    if (maxFilesRange) { maxFilesRange.value = String(Math.max(100, Math.min(50000, maxFilesVal))); }
    if (maxTotalSizeNumber) { maxTotalSizeNumber.value = String(maxTotalSizeVal); }
    // Range uses MB for ergonomics
    if (maxTotalSizeRange) { maxTotalSizeRange.value = String(Math.max(1, Math.min(4096, Math.round(maxTotalSizeVal / (1024 * 1024))))); }
    if (tokenLimitNumber) { tokenLimitNumber.value = String(tokenLimitVal); }
    if (tokenLimitRange) { tokenLimitRange.value = String(Math.max(256, Math.min(200000, tokenLimitVal))); }

    // Wire slider <-> number sync
    function wireRangeNumber(rangeEl, numberEl, toNumber = (v)=>v, fromNumber = (v)=>v) {
        if (!rangeEl || !numberEl) { return; }
        rangeEl.addEventListener('input', () => { numberEl.value = String(fromNumber(Number(rangeEl.value))); });
        numberEl.addEventListener('change', () => { const nv = Number(numberEl.value) || 0; rangeEl.value = String(toNumber(nv)); });
    }
    wireRangeNumber(maxFilesRange, maxFilesNumber, v=>Math.max(100, Math.min(50000, v)), v=>Math.max(100, Math.min(50000, v)));
    wireRangeNumber(maxTotalSizeRange, maxTotalSizeNumber, v=>Math.max(1, Math.min(4096, Math.round(v / (1024*1024)))), v=>v * (1024*1024));
    wireRangeNumber(tokenLimitRange, tokenLimitNumber, v=>Math.max(256, Math.min(200000, v)), v=>Math.max(256, Math.min(200000, v)));
    const presetsEl = getEl('presets'); if (presetsEl) { presetsEl.value = Array.isArray(settings.presets) ? settings.presets.join(',') : (settings.presets || ''); }

    // populate redaction-specific fields
    populateRedactionFields(settings);

    const save = document.getElementById('saveSettings');
    const cancel = document.getElementById('cancelSettings');
    if (save) {
        save.onclick = () => {
            const changes = {};
            // Save normalized key names
            changes.respectGitignore = !!(getEl('gitignore') && getEl('gitignore').checked);
            changes.outputFormat = (getEl('outputFormat') && getEl('outputFormat').value) || 'text';
            changes.tokenModel = (getEl('tokenModel') && getEl('tokenModel').value) || 'chars-approx';
            changes.binaryFilePolicy = (getEl('binaryPolicy') && getEl('binaryPolicy').value) || 'skip';
            // Redaction settings
            const showRedactedEl = getEl('showRedacted');
            const redactionPatternsEl = getEl('redactionPatterns');
            const redactionPlaceholderEl = getEl('redactionPlaceholder');
            const showRedacted = !!(showRedactedEl && showRedactedEl.checked);
            let redactionPatterns = [];
            if (redactionPatternsEl) {
                const raw = redactionPatternsEl.value || '';
                // split by newline or comma
                redactionPatterns = raw.split(/\r?\n|,/).map(s => s.trim()).filter(Boolean);
            }
            const redactionPlaceholder = (redactionPlaceholderEl && redactionPlaceholderEl.value) || undefined;
            // Read new limit controls
            const maxFiles = Number((document.getElementById('maxFilesNumber') || {}).value) || defaults.maxFiles;
            const maxTotalSizeBytes = Number((document.getElementById('maxTotalSizeNumber') || {}).value) || defaults.maxTotalSizeBytes;
            const tokenLimit = Number((document.getElementById('tokenLimitNumber') || {}).value) || defaults.tokenLimit;
            // Persist flattened threshold keys for simpler runtime access
            changes.maxFiles = maxFiles;
            changes.maxTotalSizeBytes = maxTotalSizeBytes;
            changes.tokenLimit = tokenLimit;
            const pv = (getEl('presets') && getEl('presets').value) || '';
            changes.presets = pv.trim() ? pv.split(',').map(s => s.trim()).filter(Boolean) : [];
            // include redaction keys at top-level settings
            const cfgChanges = Object.assign({}, changes);
            cfgChanges.showRedacted = showRedacted;
            cfgChanges.redactionPatterns = redactionPatterns;
            if (typeof redactionPlaceholder !== 'undefined') { cfgChanges.redactionPlaceholder = redactionPlaceholder; }
            postConfig('set', { changes: cfgChanges });
            const settingsEl = document.getElementById('settings'); if (settingsEl) { settingsEl.hidden = true; }
        };
    }
    if (cancel) { cancel.onclick = () => { const settingsEl = document.getElementById('settings'); if (settingsEl) { settingsEl.hidden = true; } }; }
}

function populateRedactionFields(settings) {
    const form = document.getElementById('settingsForm');
    if (!form) { return; }
    const getEl = (name) => form.querySelector(`[name="${name}"]`);
    const showRedactedEl = getEl('showRedacted');
    const redactionPatternsEl = getEl('redactionPatterns');
    const redactionPlaceholderEl = getEl('redactionPlaceholder');
    if (showRedactedEl) { showRedactedEl.checked = !!settings.showRedacted; }
    if (redactionPatternsEl) {
        if (Array.isArray(settings.redactionPatterns)) { redactionPatternsEl.value = settings.redactionPatterns.join('\n'); }
        else if (typeof settings.redactionPatterns === 'string') { redactionPatternsEl.value = settings.redactionPatterns; }
        else { redactionPatternsEl.value = ''; }
    }
    if (redactionPlaceholderEl) { redactionPlaceholderEl.value = settings.redactionPlaceholder || ''; }
}
