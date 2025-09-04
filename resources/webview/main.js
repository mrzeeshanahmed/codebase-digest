const vscode = acquireVsCodeApi();
// track the current folder path (populated from incoming state/config)
let currentFolderPath = null;
// transient override for next generation only
let overrideDisableRedaction = false;

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

window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type === 'restoredState') {
        try {
            const s = msg.state || {};
            // If the extension has a persisted selection, apply it
            if (Array.isArray(s.selectedFiles) && s.selectedFiles.length > 0) {
                // Request the extension to set selection to persisted relPaths
                postAction('setSelection', { relPaths: s.selectedFiles });
            }
            // Also accept persisted viewport/focus info if provided
            if (s.focusIndex !== undefined && typeof s.focusIndex === 'number') {
                focusedIndex = s.focusIndex;
            }
        } catch (e) { /* swallow */ }
    }
    if (msg.type === 'state') {
        renderFileList(msg.state);
        // Also populate the compact chips from the full state so the sidebar shows counts immediately
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
    // update current folderPath and show workspace slug if available
    try {
        currentFolderPath = msg.state && (msg.state.folderPath || msg.state.workspaceFolder || msg.state.rootPath || msg.state.workspaceSlug) || null;
        const slugEl = document.getElementById('workspace-slug'); if (slugEl) { const wf = msg.state && (msg.state.workspaceFolder || msg.state.workspaceSlug || msg.state.rootPath || msg.state.folderPath); slugEl.textContent = wf ? String(wf) : wf === undefined ? '' : String(wf); }
    } catch (e) {}
    } else if (msg.type === 'previewDelta') {
        renderPreviewDelta(msg.delta);
    } else if (msg.type === 'ingestPreview') {
        const p = document.getElementById('ingest-preview'); if (p) { p.textContent = msg.payload && msg.payload.preview ? (msg.payload.preview.summary || '') + '\n\n' + (msg.payload.preview.tree || '') : (msg.payload && msg.payload.output ? msg.payload.output.slice(0, 2000) : 'No preview'); }
    } else if (msg.type === 'ingestError') {
        showToast('Ingest failed: ' + (msg.error || 'unknown'), 'error', 6000);
    } else if (msg.type === 'config') {
    // config may include folderPath or workspace info
    try { currentFolderPath = msg.folderPath || msg.workspaceFolder || currentFolderPath; } catch (e) {}
    populateSettings(msg.settings);
    } else if (msg.type === 'progress') {
        (window.__handleProgress || handleProgress)(msg.event);
    } else if (msg.type === 'generationResult') {
        try {
            const res = msg.result || {};
            if (res.redactionApplied) {
                showToast('Output contained redacted content (masked). Toggle "Show redacted" in Settings to reveal.', 'warn', 6000);
            }
        } catch (e) {}
    }
});

// Simple virtualization parameters
const ITEM_HEIGHT = 28; // px
const OVERSCAN = 5;
let filesCache = [];
let selectedSet = new Set();
let focusedIndex = 0;

function renderFileList(state) {
    const fileList = document.getElementById('file-list');
    if (!fileList) { return; }
    fileList.innerHTML = '';
    if (!state) { filesCache = []; return; }
    // Render ASCII tree
    const asciiTree = document.getElementById('ascii-tree');
    if (asciiTree) {
        // Keep ASCII tree compact: show head + ellipsis + tail when long
        function compactLines(lines, head = 6, tail = 3) {
            if (!Array.isArray(lines)) { return ''; }
            if (lines.length <= head + tail + 1) { return lines.join('\n'); }
            const headLines = lines.slice(0, head);
            const tailLines = lines.slice(lines.length - tail);
            return headLines.concat(['...']).concat(tailLines).join('\n');
        }
        asciiTree.textContent = compactLines(state.minimalSelectedTreeLines || []);
        // expose full content for copy or hover via title attribute
        if (Array.isArray(state.minimalSelectedTreeLines) && state.minimalSelectedTreeLines.length > 0) {
            asciiTree.title = state.minimalSelectedTreeLines.join('\n');
        } else {
            asciiTree.title = '';
        }
    }
    // Render virtual group badges if present
    const groups = Array.isArray(state.virtualGroups) ? state.virtualGroups : [];
    const groupBarContainer = document.getElementById('group-bar');
    if (groupBarContainer) { groupBarContainer.remove(); }
    if (groups.length > 0) {
        const gb = document.createElement('div');
        gb.id = 'group-bar';
        gb.className = 'group-bar';
        const formatSize = (size) => {
            if (!size || typeof size !== 'number') { return ''; }
            if (size < 1024) { return `${size} B`; }
            if (size < 1024 * 1024) { return `${(size / 1024).toFixed(1)} KB`; }
            if (size < 1024 * 1024 * 1024) { return `${(size / (1024 * 1024)).toFixed(1)} MB`; }
            return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
        };
            groups.forEach(g => {
            const pill = document.createElement('button');
            pill.className = 'group-pill';
            pill.type = 'button';
            const sizeStr = g.totalSize ? ` · ${formatSize(g.totalSize)}` : '';
            pill.textContent = `${g.name} (${g.count})${sizeStr}`;
            pill.onclick = () => {
                postAction('selectGroup', { groupName: g.name });
            };
            gb.appendChild(pill);
        });
        // Insert before the file list
        const fileListRoot = document.getElementById('file-list');
        if (fileListRoot && fileListRoot.parentNode) {
            fileListRoot.parentNode.insertBefore(gb, fileListRoot);
        }
    }
    // Files list (strings of relPath)
    const files = Array.isArray(state.selectedFiles) ? state.selectedFiles : (state.fileIndex ? Object.keys(state.fileIndex) : []);
    filesCache = files;
    selectedSet = new Set(Array.isArray(state.selectedFiles) ? state.selectedFiles : []);

    // Create a viewport container
    const viewport = document.createElement('div');
    viewport.className = 'virtual-viewport';
    viewport.style.position = 'relative';
    viewport.style.height = '400px';
    viewport.style.overflow = 'auto';
    viewport.setAttribute('role', 'tree');

    const spacer = document.createElement('div');
    spacer.style.height = (files.length * ITEM_HEIGHT) + 'px';
    spacer.className = 'virtual-spacer';
    viewport.appendChild(spacer);
    fileList.appendChild(viewport);

    const renderWindow = () => {
        const scrollTop = viewport.scrollTop;
        const clientHeight = viewport.clientHeight;
        const startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - OVERSCAN);
        const endIndex = Math.min(files.length - 1, Math.ceil((scrollTop + clientHeight) / ITEM_HEIGHT) + OVERSCAN);

        // Remove existing rendered window if any
        const existing = viewport.querySelector('.virtual-window');
    if (existing) { existing.remove(); }

        const windowEl = document.createElement('div');
        windowEl.className = 'virtual-window';
        windowEl.style.position = 'absolute';
        windowEl.style.top = (startIndex * ITEM_HEIGHT) + 'px';
        windowEl.style.left = '0';
        windowEl.style.right = '0';

        for (let i = startIndex; i <= endIndex; i++) {
            const rel = files[i];
            const row = document.createElement('div');
            row.className = 'file-row';
            row.setAttribute('data-index', String(i));
            row.setAttribute('data-rel', rel);
            row.setAttribute('role', 'treeitem');
            row.setAttribute('tabindex', i === focusedIndex ? '0' : '-1');
            row.style.height = ITEM_HEIGHT + 'px';
            row.style.lineHeight = ITEM_HEIGHT + 'px';
            row.textContent = rel;
            if (selectedSet.has(rel)) { row.classList.add('selected'); row.setAttribute('aria-selected', 'true'); } else { row.setAttribute('aria-selected', 'false'); }

            row.onclick = (e) => {
                e.preventDefault();
                toggleSelectionAt(i);
                focusIndex(i);
            };
            row.onkeydown = (e) => handleKeydown(e, i);
            row.onfocus = () => { focusedIndex = i; updateTabIndices(); };
            windowEl.appendChild(row);
        }

        viewport.appendChild(windowEl);
    };

    const focusIndex = (i) => {
        focusedIndex = Math.max(0, Math.min(files.length - 1, i));
        updateTabIndices();
        const el = viewport.querySelector(`[data-index='${focusedIndex}']`);
    if (el && typeof el.focus === 'function') { el.focus(); }
    };

    const updateTabIndices = () => {
        const rows = viewport.querySelectorAll('[data-index]');
        rows.forEach(r => {
            const idx = Number(r.getAttribute('data-index'));
            r.setAttribute('tabindex', idx === focusedIndex ? '0' : '-1');
        });
    };

    const toggleSelectionAt = (i) => {
        const rel = filesCache[i];
        const currentlySelected = selectedSet.has(rel);
        const newSelection = Array.from(selectedSet);
        if (currentlySelected) {
            // remove
            const idx = newSelection.indexOf(rel);
            if (idx >= 0) { newSelection.splice(idx, 1); }
        } else {
            newSelection.push(rel);
        }
    postAction('setSelection', { relPaths: newSelection });
    // Persist a lightweight UI state to the extension so it can be restored
    try {
        const persist = { selectedFiles: newSelection, focusIndex: focusedIndex };
        vscode.postMessage({ type: 'persistState', state: persist });
    } catch (e) { /* ignore */ }
    };

    const handleKeydown = (e, index) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            focusIndex(index + 1);
            scrollIntoViewIfNeeded(index + 1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            focusIndex(index - 1);
            scrollIntoViewIfNeeded(index - 1);
        } else if (e.key === ' ') {
            e.preventDefault();
            toggleSelectionAt(index);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            // Toggle expand for this relPath; include folderPath
            const rel = filesCache[index];
            postAction('toggleExpand', { relPath: rel });
        }
    };

    const scrollIntoViewIfNeeded = (i) => {
        const top = i * ITEM_HEIGHT;
        const bottom = top + ITEM_HEIGHT;
    if (viewport.scrollTop > top) { viewport.scrollTop = top; }
    if (viewport.scrollTop + viewport.clientHeight < bottom) { viewport.scrollTop = bottom - viewport.clientHeight; }
    };

    viewport.addEventListener('scroll', () => { renderWindow(); });
    // initial render
    renderWindow();
    // ensure focused element exists
    setTimeout(() => focusIndex(focusedIndex), 0);

    // Chart rendering compatibility (unchanged)
    const chartStats = state.chartStats || {};
    const chartContainer = document.getElementById('chart-container');
    if (chartContainer) { chartContainer.innerHTML = ''; }
    if (typeof window.Chart === 'function') {
        // Chart.js is present, render charts (stub)
    } else {
        function renderTable(title, data) {
            const table = document.createElement('table');
            table.className = 'chart-table';
            const caption = document.createElement('caption');
            caption.textContent = title;
            table.appendChild(caption);
            const tbody = document.createElement('tbody');
            Object.entries(data).forEach(([key, value]) => {
                const tr = document.createElement('tr');
                const tdKey = document.createElement('td');
                tdKey.textContent = key;
                const tdVal = document.createElement('td');
                tdVal.textContent = value;
                tr.appendChild(tdKey);
                tr.appendChild(tdVal);
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);
            return table;
        }
        if (chartContainer) {
            chartContainer.appendChild(renderTable('Extension Counts', chartStats.extCounts || {}));
            chartContainer.appendChild(renderTable('Size Buckets', chartStats.sizeBuckets || {}));
            chartContainer.appendChild(renderTable('Language Counts', chartStats.langCounts || {}));
        }
    }
}

function renderPreviewDelta(delta) {
    const statsTarget = document.getElementById('stats');
    const chipsTarget = document.getElementById('status-chips');
    if (statsTarget === null && chipsTarget === null) {
        return;
    }

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
    if (statsTarget !== null) {
        statsTarget.textContent = parts.join(' · ');
    }

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
                    // Use an assertive live region to ensure immediate announcement by screen readers
                    banner.setAttribute('role', 'status');
                    banner.setAttribute('aria-live', 'assertive');
                    banner.setAttribute('aria-atomic', 'true');
                    const text = document.createElement('span');
                    text.className = 'over-limit-text';
                    banner.appendChild(text);
                    // Insert the banner above the chips target for visual prominence
                    if (chipsTarget && chipsTarget.parentNode) {
                        chipsTarget.parentNode.insertBefore(banner, chipsTarget);
                    } else {
                        document.body.insertBefore(banner, document.body.firstChild);
                    }
                }
                // Update text content (keeps same DOM node for a11y)
                const txt = banner.querySelector('.over-limit-text');
                if (txt) { txt.textContent = message; }
            } else {
                if (banner && banner.parentNode) { banner.parentNode.removeChild(banner); }
            }
        } catch (e) { /* swallow DOM errors to avoid breaking the webview */ }
    }
}

// Progress & toast helpers
const progressContainer = () => document.getElementById('progress-container');
const progressBar = () => document.getElementById('progress-bar');
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
        try {
            if (e.op === 'write') {
                const cw = document.getElementById('btn-cancel-write');
                if (cw) { cw.hidden = false; cw.removeAttribute('aria-hidden'); }
            }
        } catch (ex) {}
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
    try { if (e.op === 'write') { const cw = document.getElementById('btn-cancel-write'); if (cw) { cw.hidden = true; cw.setAttribute('aria-hidden', 'true'); } } } catch (ex) {}
    }
}

// Pause/Resume UI wiring
let paused = false;
const pauseBtn = () => document.getElementById('btn-pause-resume');
function updatePauseButton() {
    const b = pauseBtn();
    if (!b) { return; }
    b.textContent = paused ? 'Resume' : 'Pause';
}

// Listen for scan progress stats to update small status area
function handleScanStats(e) {
    if (!e || e.op !== 'scan') { return; }
    const statsEl = document.getElementById('stats');
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
    // Delegate toolbar clicks to buttons with data-action attributes (simpler aria-friendly wiring)
    const toolbar = document.getElementById('toolbar');
    function sendCmd(cmd, payload) { postAction(cmd, payload); }
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
                return;
            }
            if (action === 'togglePause') {
                paused = !paused;
                updatePauseButton();
                sendCmd(paused ? 'pauseScan' : 'resumeScan');
                return;
            }
            if (action === 'openSettings') {
                const settingsEl = document.getElementById('settings');
                if (settingsEl) { settingsEl.hidden = false; }
                sendCmd('configRequest');
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
                        }
                        // reset one-shot override after using it (UI reflects the transient nature)
                        if (overrideDisableRedaction) { overrideDisableRedaction = false; const rb = document.getElementById('btn-disable-redaction'); if (rb) { rb.setAttribute('aria-pressed','false'); rb.classList.remove('active'); } }
                        postAction(action, payload);
                        return;
                    }
            sendCmd(action);
        });
    }
    // Cancel write button wiring (posts cancelWrite action to extension)
    const cancelWriteBtn = document.getElementById('btn-cancel-write');
    if (cancelWriteBtn) {
        cancelWriteBtn.addEventListener('click', (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            // post a cancelWrite action which the extension translates to emitProgress({op:'write', mode:'cancel'})
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
    if (presetBtn) {
        presetBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePresetMenu(); });
        // close on Escape when the button has focus
        presetBtn.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePresetMenu(); } });
    }
    if (presetMenu) {
        // Wire each menuitem to post an applyPreset action and then close the menu
        const items = Array.from(presetMenu.querySelectorAll('[role="menuitem"][data-preset]'));
        items.forEach(it => {
            it.addEventListener('click', (ev) => {
                ev.preventDefault(); ev.stopPropagation();
                const preset = it.getAttribute('data-preset');
                if (preset) {
                    postAction('applyPreset', { preset });
                }
                closePresetMenu();
            });
            // allow keyboard activation
            it.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); it.click(); }
                if (ev.key === 'Escape') { closePresetMenu(); }
            });
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
        const previewEl = document.getElementById('ingest-preview'); if (previewEl) { previewEl.textContent = 'Starting ingest...'; }
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
