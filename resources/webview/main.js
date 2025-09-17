// Minimal vanilla store helper compatible with a tiny subset of zustand's API
function create(fn) {
    let state = {};
    const listeners = new Set();
    const set = (updater) => {
        const next = typeof updater === 'function' ? updater(state) : Object.assign({}, state, updater);
        state = next;
        listeners.forEach(l => { try { l(state); } catch (e) {} });
    };
    const getState = () => state;
    const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
    const api = fn((patch) => set((s) => Object.assign({}, s, patch)), getState, { set, subscribe });
    return Object.assign(api || {}, { setState: (patch) => set(patch), getState, subscribe });
}

const vscode = acquireVsCodeApi();
// track the current folder path (populated from incoming state/config)
let currentFolderPath = null;
// transient override for next generation only
let overrideDisableRedaction = false;
// Track whether a transient override was used for an in-flight generate request
let pendingOverrideUsed = false;
// Visual row height / basic list state
const ITEM_HEIGHT = 28; // The height of each file row in pixels
// filesCache was unused; remove to reduce memory footprint
// (previously had an unused selectedSet which was confusing)
let pendingPersistedSelection = null;
let pendingPersistedFocusIndex = undefined;
// Temporary holder for a repo path returned by the host after loading
let loadedRepoTmpPath = null;
// Track the last preset we asked the host to apply for the currently-rendered tree
let lastAppliedPresetForTree = null;
// Pause state: canonical value is stored in `store`; keep a local mirror for performance
let paused = false;
// Track expanded folder paths: canonical array lives in `store`; keep a Set locally and sync
let expandedSet = new Set();

// User interaction guard: when the user is interacting with the file list (clicking,
// keyboard navigation, etc.) we temporarily suspend applying incoming fileTree updates
// to avoid jarring re-renders that collapse the tree. Incoming updates are queued
// and applied after a short idle period.
let userInteracting = false;
let interactionTimeout = null;
let pendingIncomingTree = null;
let pendingIncomingSelectedPaths = null;

// Zustand-like store for centralizing file tree + selection state in the webview.
// We expose a small action surface so UI code and message handlers can call
// intentful actions rather than mutating transient variables directly.
const store = create((set) => ({
    // core state
    fileTree: {},
    selectedPaths: [],
    expandedPaths: [],
    paused: false,
    pendingPersistedSelection: null,
    pendingPersistedFocusIndex: undefined,
    // actions: intentful APIs for updating state
    setState: (patch) => set((s) => Object.assign({}, s, patch)),
    setFileTree: (tree, selectedPaths) => set((s) => Object.assign({}, s, { fileTree: tree || {}, selectedPaths: Array.isArray(selectedPaths) ? selectedPaths.slice() : (s.selectedPaths || []) })),
    setSelection: (paths) => set(() => ({ selectedPaths: Array.isArray(paths) ? paths.slice() : [] })),
    clearSelection: () => set(() => ({ selectedPaths: [] })),
    // collectLeaves is declared below and referenced here to avoid inlining
    selectAllFiles: () => set((s) => ({ selectedPaths: collectLeaves(s.fileTree) })),
    togglePause: (p) => set(() => ({ paused: typeof p === 'undefined' ? !(store.getState().paused) : !!p })),
    setExpandedPaths: (arr) => set(() => ({ expandedPaths: Array.isArray(arr) ? arr.slice() : [] })),
    setPendingPersistedSelection: (sel, idx) => set(() => ({ pendingPersistedSelection: sel || null, pendingPersistedFocusIndex: typeof idx === 'number' ? idx : undefined }))
}));

// Helper used by the store action selectAllFiles to collect leaf file paths
function collectLeaves(node, prefix = '') {
    const out = [];
    if (!node || typeof node !== 'object') { return out; }
    for (const k of Object.keys(node)) {
        const n = node[k];
        const full = n && n.path ? n.path : `${prefix}${k}`;
        if (n && n.__isFile) { out.push(full); }
        else { out.push(...collectLeaves(n, `${full}/`)); }
    }
    return out;
}

// Initialize local mirrors from store and subscribe to updates to keep the UI
// and local transient mirrors in sync. We intentionally keep a small set of
// mirrors (paused, expandedPaths, pendingPersistedSelection) for performance
// in hot paths like checkbox wiring and expand/collapse handlers.
try {
    const s = store.getState();
    paused = !!s.paused;
    expandedSet = new Set(Array.isArray(s.expandedPaths) ? s.expandedPaths : []);
    pendingPersistedSelection = s.pendingPersistedSelection || null;
    pendingPersistedFocusIndex = typeof s.pendingPersistedFocusIndex !== 'undefined' ? s.pendingPersistedFocusIndex : undefined;
} catch (e) { /* best-effort */ }

store.subscribe((st) => {
    try {
        if (typeof st.paused !== 'undefined' && paused !== !!st.paused) { paused = !!st.paused; updatePauseButton(); }
    } catch (e) {}
    try {
        const newExpanded = Array.isArray(st.expandedPaths) ? st.expandedPaths : [];
        expandedSet = new Set(newExpanded);
    } catch (e) {}
    try {
        pendingPersistedSelection = st.pendingPersistedSelection || null;
        pendingPersistedFocusIndex = typeof st.pendingPersistedFocusIndex !== 'undefined' ? st.pendingPersistedFocusIndex : undefined;
    } catch (e) {}
    // Rerender file list whenever fileTree or selectedPaths changes.
    try {
        debouncedRenderFileList();
    } catch (e) {}
});

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

// Centralized lightweight logger for webview diagnostics. Use sparingly to avoid
// overwhelming the console in normal operation.
function logWarn(context, err) {
    try {
        if (err) { console.warn('[Code Ingest][webview] ' + context, err); }
        else { console.warn('[Code Ingest][webview] ' + context); }
    } catch (e) { /* best-effort logging only */ }
}

// Encode/decode helpers for safely storing file paths in data-* attributes.
// Uses base64url encoding via btoa/atob with safe character replacements.
function encodeForDataAttribute(s) {
    if (s === null || s === undefined) { return ''; }
    try {
        const b = btoa(unescape(encodeURIComponent(String(s))));
        return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    } catch (e) {
        try { return encodeURIComponent(String(s)); } catch (ex) { return String(s); }
    }
}

function decodeFromDataAttribute(v) {
    if (!v) { return ''; }
    try {
        const pad = v.length % 4 === 0 ? '' : '='.repeat(4 - (v.length % 4));
        const b = (v || '').replace(/-/g, '+').replace(/_/g, '/') + pad;
        return decodeURIComponent(escape(atob(b)));
    } catch (e) {
        try { return decodeURIComponent(String(v)); } catch (ex) { return String(v); }
    }
}

function postAction(actionType, payload) {
    const base = Object.assign({ type: 'action', actionType }, payload || {});
    if (currentFolderPath) { base.folderPath = currentFolderPath; }
    try { vscode.postMessage(sanitizePayload(base)); } catch (e) { console.warn('postAction postMessage failed', e); }
}

function postConfig(action, payload) {
    const base = Object.assign({ type: 'config', action }, payload || {});
    if (currentFolderPath) { base.folderPath = currentFolderPath; }
    try { vscode.postMessage(sanitizePayload(base)); } catch (e) { console.warn('postConfig postMessage failed', e); }
}

// Sanitize payloads sent from the webview to the extension host
function sanitizePayload(obj) {
    // NOTE: This sanitizer shallowly serializes objects and preserves nested arrays of
    // simple scalars at one level only. Deeply nested objects/arrays will be stringified
    // or truncated; this is intentional to avoid sending large or complex structures
    // from the webview to the extension host.
    try {
        const copy = {};
        // Keys whose array values should be transmitted as-is (no trimming/coercion)
        const passthroughArrayKeys = new Set(['relPaths', 'selectedPaths', 'selectedFiles']);
        for (const k of Object.keys(obj || {})) {
            const v = obj[k];
            // Allow simple scalars and arrays of scalars only
            if (v === null || v === undefined) { copy[k] = v; continue; }
            if (typeof v === 'string') {
                // trim and remove control characters
                const s = v.trim().replace(/[\x00-\x1F\x7F]/g, '');
                // clamp length for general strings
                copy[k] = (s.length > 2000) ? s.slice(0, 2000) : s;
                continue;
            }
            if (typeof v === 'number' || typeof v === 'boolean') { copy[k] = v; continue; }
            if (Array.isArray(v)) {
                // Preserve arrays for known selection-like keys without trimming
                if (passthroughArrayKeys.has(k)) {
                    try {
                        copy[k] = v.filter(x => (x === null || x === undefined) || typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean');
                    } catch (e) { copy[k] = []; }
                    continue;
                }
                // For other arrays, preserve scalar elements but trim long strings
                try {
                    copy[k] = v.map(x => {
                        if (x === null || x === undefined) { return x; }
                        if (typeof x === 'string') { const s = x.trim().replace(/[\x00-\x1F\x7F]/g, ''); return s.length > 2000 ? s.slice(0, 2000) : s; }
                        if (typeof x === 'number' || typeof x === 'boolean') { return x; }
                        // drop complex/non-scalar entries rather than coercing them to strings
                        return undefined;
                    }).filter(x => typeof x !== 'undefined');
                } catch (e) { copy[k] = []; }
                continue;
            }
            // For objects, try to shallow-serialize simple key:scalar entries
            if (typeof v === 'object') {
                const o = {};
                for (const kk of Object.keys(v)) {
                    const vv = v[kk];
                    if (vv === null || vv === undefined) { o[kk] = vv; }
                    else if (typeof vv === 'string') { const s = vv.trim().replace(/[\x00-\x1F\x7F]/g, ''); o[kk] = s.length > 500 ? s.slice(0, 500) : s; }
                    else if (Array.isArray(vv)) {
                        try {
                            o[kk] = vv.map(x => {
                                if (x === null || x === undefined) { return x; }
                                if (typeof x === 'string') { const s = x.trim().replace(/[\x00-\x1F\x7F]/g, ''); return s.length > 500 ? s.slice(0, 500) : s; }
                                if (typeof x === 'number' || typeof x === 'boolean') { return x; }
                                return undefined; // drop non-scalars
                            }).filter(x => typeof x !== 'undefined');
                        } catch (e) { o[kk] = []; }
                    } else if (typeof vv === 'number' || typeof vv === 'boolean') { o[kk] = vv; }
                }
                copy[k] = o;
                continue;
            }
            // For any remaining non-scalar types (functions, symbols, etc.) avoid coercion; set to null
            copy[k] = null;
        }
        return copy;
    } catch (e) { return obj; }
}

// Client-side input sanitizers for common user-provided fields (defence-in-depth).
// These perform a simple allowlist of characters typically found in GitHub
// repository URLs/slugs, git refs and repository subpaths. They return either
// a cleaned string or null when the input contains disallowed characters.
function sanitizeRepoInput(s) {
    if (!s && s !== '') { return null; }
    try {
        const cleaned = String(s).trim().replace(/[\x00-\x1F\x7F]/g, '');
        // Allow common URL and SCP forms and owner/repo slugs. Disallow shell metacharacters
        // like ; | & ` $ < > and line breaks. Characters allowed: alnum, - _ . / : @ ? & % = + #
        const allowed = /^[A-Za-z0-9\-._\/:@?&%=+#]+$/;
        if (!cleaned || !allowed.test(cleaned)) { return null; }
        // Clamp length to a reasonable max to avoid huge payloads
        if (cleaned.length > 2000) { return null; }
        return cleaned;
    } catch (e) { return null; }
}

function sanitizeRefName(s) {
    if (!s && s !== '') { return null; }
    try {
        const cleaned = String(s).trim().replace(/[\x00-\x1F\x7F]/g, '');
        // Git refs typically contain alphanumerics, dots, dashes and slashes.
        const allowed = /^[A-Za-z0-9\-._\/]+$/;
        if (cleaned === '') { return '';} // empty ref is acceptable (means use default)
        if (!allowed.test(cleaned)) { return null; }
        if (cleaned.length > 500) { return null; }
        return cleaned;
    } catch (e) { return null; }
}

function sanitizeSubpath(s) {
    if (!s && s !== '') { return null; }
    try {
        const cleaned = String(s).trim().replace(/[\x00-\x1F\x7F]/g, '');
        // Subpaths are like filesystem paths within the repo; allow alnum, - _ . and /
        const allowed = /^[A-Za-z0-9\-._\/]+$/;
        if (cleaned === '') { return '';} // empty subpath is acceptable
        if (!allowed.test(cleaned)) { return null; }
        if (cleaned.length > 1000) { return null; }
        return cleaned;
    } catch (e) { return null; }
}

// Modal focus-trap & restore helpers
const __focusState = { lastFocused: null };
function openModal(element) {
    try {
        __focusState.lastFocused = document.activeElement;
    element.hidden = false;
    try { element.removeAttribute('aria-hidden'); } catch (e) {}
        // focus first control
        setTimeout(() => { const first = element.querySelector('input,button,select,textarea,[tabindex]'); if (first && typeof first.focus === 'function') { first.focus(); } }, 0);
        // basic trap: capture Tab key and keep focus inside modal
        element.addEventListener('keydown', modalKeyHandler);
    } catch (e) { logWarn('openModal failed', e); }
}
function closeModal(element) {
    try {
    element.hidden = true;
    try { element.setAttribute('aria-hidden', 'true'); } catch (e) {}
        element.removeEventListener('keydown', modalKeyHandler);
        if (__focusState.lastFocused && typeof __focusState.lastFocused.focus === 'function') { __focusState.lastFocused.focus(); }
    } catch (e) { logWarn('closeModal failed', e); }
}
function modalKeyHandler(e) {
    // Allow Escape to close the modal locally (keeps behaviour consistent with global handler
    // but scoped to the active modal so focus restore works reliably).
    if (e.key === 'Escape') {
        try {
            const modal = e.currentTarget;
            modal.hidden = true;
            try { modal.setAttribute('aria-hidden', 'true'); } catch (e) {}
            modal.removeEventListener('keydown', modalKeyHandler);
            if (__focusState.lastFocused && typeof __focusState.lastFocused.focus === 'function') { __focusState.lastFocused.focus(); }
        } catch (ex) { /* swallow */ }
        return;
    }
    if (e.key !== 'Tab') { return; }
    const modal = e.currentTarget;
    // Exclude any overlay elements from the focusable list (some DOM variants render the
    // overlay inside the modal wrapper and it could be picked up by queries). Also exclude
    // elements that are effectively hidden or disabled.
    const focusable = Array.from(modal.querySelectorAll('input,button,select,textarea,a[href],[tabindex]:not([tabindex="-1"])')).filter((el) => {
        if (!el) { return false; }
        if (el.disabled) { return false; }
        if (el.offsetParent === null) { return false; }
        // exclude overlay/backdrop elements which may be focusable in some browsers
        if (el.classList && el.classList.contains('modal-overlay')) { return false; }
        // exclude any element that is inside an overlay element
        if (el.closest && el.closest('.modal-overlay')) { return false; }
        return true;
    });
    if (focusable.length === 0) { e.preventDefault(); return; }
    const idx = focusable.indexOf(document.activeElement);
    if (e.shiftKey) {
        if (idx <= 0) { focusable[focusable.length - 1].focus(); e.preventDefault(); }
    } else {
        if (idx === focusable.length - 1) { focusable[0].focus(); e.preventDefault(); }
    }
}

// Debounce wrapper for renderFileList to avoid double-render churn when 'state' and 'previewDelta' arrive quickly.
function debounce(fn, wait) {
    let tid = null;
    let lastArgs = null;
    return function() {
        lastArgs = arguments;
        if (tid) { clearTimeout(tid); }
        tid = setTimeout(() => { tid = null; fn.apply(this, lastArgs); }, wait);
    };
}

// Shared byte-size formatter used across the webview so all size labels match.
// Uses binary units (1024 base) and 1 decimal place for KB/MB/GB for readability.
function formatBytes(n) {
    if (n === undefined || n === null) { return ''; }
    const num = Number(n) || 0;
    if (num < 1024) { return `${num} B`; }
    if (num < 1024 * 1024) { return `${(num / 1024).toFixed(1)} KB`; }
    if (num < 1024 * 1024 * 1024) { return `${(num / (1024 * 1024)).toFixed(1)} MB`; }
    return `${(num / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// Robust lookup helper: find a <li> with a given data-path without using
// querySelector with interpolated selectors (which can break on paths
// containing quotes or other CSS-special characters). This iterates
// the rendered nodes and compares attributes directly.
function findLiByDataPath(root, path) {
    if (!root || !path) { return null; }
    try {
        const nodes = root.querySelectorAll('li[data-path]');
        for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i];
            try {
                if (!n.getAttribute) { continue; }
                const attr = n.getAttribute('data-path');
                const decoded = attr ? decodeFromDataAttribute(attr) : null;
                if (decoded === path) { return n; }
            } catch (e) { logWarn('findLiByDataPath node read failed', e); }
        }
    } catch (e) { /* swallow */ }
    return null;
}

function renderFileList(state) {
    // If caller doesn't pass a state, read from the centralized store
    if (!state) {
        try { state = store.getState(); } catch (e) { state = { fileTree: {}, selectedPaths: [] }; }
    }
    const fileListRoot = document.getElementById('file-list');
    if (!fileListRoot) { return; }

    // Clear previous content without using innerHTML for safety
    while (fileListRoot.firstChild) { fileListRoot.removeChild(fileListRoot.firstChild); }

    const fileTree = state.fileTree || {};
    // Use selectedPaths from the state, which is an array of strings
    const selectedPaths = new Set(state.selectedPaths || []);

    if (Object.keys(fileTree).length === 0) {
    const msg = document.createElement('div');
    msg.className = 'file-row-message';
    msg.textContent = 'No files to display.';
    fileListRoot.appendChild(msg);
        return;
    }

            // This function will be called when a checkbox state changes.
    const handleSelectionChange = () => {
        // Only consider checkboxes that are children of leaf file list items to avoid
        // processing folder-level checkboxes (which are used for tri-state UI only).
        // This reduces DOM work and prevents accidental double-processing.
        let checkboxes = fileListRoot.querySelectorAll('li.file-item .file-checkbox');
        // Fallback for environments where li.file-item may not be present
        if (!checkboxes || checkboxes.length === 0) {
            checkboxes = fileListRoot.querySelectorAll('.file-checkbox');
        }
        const newSelectedPaths = [];
        checkboxes.forEach(cb => {
            if (!cb) { return; }
            if (cb.checked) {
                try {
                    const attr = cb.getAttribute && cb.getAttribute('data-path');
                    const path = attr ? decodeFromDataAttribute(attr) : null;
                    if (path) { newSelectedPaths.push(path); }
                } catch (e) { /* ignore per-node read failures */ }
            }
        });
        postAction('setSelection', { relPaths: newSelectedPaths });
    };

    // Helper: update ancestor folder checkbox indeterminate/checked state based on descendants
    function updateAncestorStates(startLi) {
        try {
            let current = startLi;
            while (current) {
                const parentUl = current.parentElement;
                if (!parentUl) { break; }
                const parentLi = parentUl.closest('li.folder-item');
                if (!parentLi) { break; }
                // Only consider checkboxes that belong to leaf file items in the descendant subtree
                // (exclude folder-level checkboxes so folder vs file boxes are not mixed).
                const descendantCheckboxes = parentLi.querySelectorAll(':scope ul li.file-item .file-checkbox');
                let total = 0, checked = 0;
                descendantCheckboxes.forEach(cb => { total++; if (cb.checked) { checked++; } });
                const parentCb = parentLi.querySelector('input.file-checkbox');
                if (parentCb) {
                    if (checked === 0) { parentCb.checked = false; parentCb.indeterminate = false; }
                    else if (checked === total) { parentCb.checked = true; parentCb.indeterminate = false; }
                    else { parentCb.checked = false; parentCb.indeterminate = true; }
                }
                current = parentLi;
            }
    } catch (e) { logWarn('updateAncestorStates DOM traversal failed', e); }
    }

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
            // Prefer explicit relPath when available (nodes commonly expose relPath),
            // fall back to path or constructed prefix so existing callers keep working.
            const relPath = currentNode.relPath || currentNode.path || `${pathPrefix}${key}`;

            const li = document.createElement('li');
            li.className = isFile ? 'file-tree-li file-item' : 'file-tree-li folder-item';
            li.setAttribute('data-path', encodeForDataAttribute(relPath));

            const label = document.createElement('label');
            label.className = 'file-tree-label';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'file-checkbox';
            checkbox.checked = selectedPaths.has(relPath);
            checkbox.setAttribute('data-path', encodeForDataAttribute(relPath));

            // *** ADDING CHECKBOX INTERACTIVITY ***
            checkbox.addEventListener('change', () => {
                const isChecked = checkbox.checked;
                // If a folder is checked/unchecked, apply the same state to all children
                if (!isFile) {
                    // Only target leaf file checkboxes in the child subtree (exclude folder-level checkboxes)
                    const descendantCheckboxes = li.querySelectorAll(':scope ul li.file-item .file-checkbox');
                    descendantCheckboxes.forEach(descCb => {
                        descCb.checked = isChecked;
                        try { descCb.indeterminate = false; } catch (e) { logWarn('setting indeterminate failed', e); }
                    });
                }
                // Update ancestor folders once after any change (folder or leaf)
                try { updateAncestorStates(li); } catch (e) {}
                handleSelectionChange();
            });
            
            const icon = document.createElement('span');
            icon.className = 'file-tree-icon';

            const name = document.createElement('span');
            name.className = 'file-tree-name';
            name.textContent = key;
            
            // *** ADDING EXPAND/COLLAPSE INTERACTIVITY ***
            if (!isFile) {
                // Determine expanded state from expandedSet
                const expanded = expandedSet.has(relPath);
                if (expanded) { li.classList.add('expanded'); } else { li.classList.remove('expanded'); }

                // Clicking the folder icon toggles its expanded state and re-renders.
                // Attach the handler to the icon only so clicks on the label/text don't toggle expansion.
                const toggleExpand = (e) => {
                    try {
                        if (expandedSet.has(relPath)) {
                            expandedSet.delete(relPath);
                            li.classList.remove('expanded');
                        } else {
                            expandedSet.add(relPath);
                            li.classList.add('expanded');
                        }
                        // persist array form into store
                        if (store.setExpandedPaths) { try { store.setExpandedPaths(Array.from(expandedSet)); } catch (ex) { /* swallow */ } }
                        // Re-render using aligned state if available
                        try { const st = store.getState ? store.getState() : null; renderTree((st && st.aligned) || st, expandedSet); } catch (ex) { /* swallow */ }
                    } catch (err) { logWarn('toggleExpand failed', err); }
                };

                // Provide keyboard access and semantics on the icon only
                try {
                    icon.setAttribute('role', 'button');
                    icon.setAttribute('tabindex', '0');
                    try { icon.setAttribute('aria-expanded', String(expanded)); } catch (e) {}
                } catch (e) {}

                // Attach a capture-phase listener on the label that only reacts when
                // the click target is the icon (icon remains inside the label per requirement).
                // Using capture ensures we can prevent the default label -> checkbox activation
                // before the browser toggles the checkbox.
                try {
                    label.addEventListener('click', (ev) => {
                        try {
                            if (ev && ev.target && (ev.target === icon || icon.contains(ev.target))) {
                                try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
                                toggleExpand(ev);
                                try { icon.setAttribute('aria-expanded', String(expandedSet.has(relPath))); } catch (e) {}
                            }
                        } catch (e) { /* swallow per-node errors */ }
                    }, true);
                } catch (e) { /* swallow */ }

                // Keep keyboard activation on the icon for accessibility
                icon.addEventListener('keydown', (ev) => {
                    try {
                        if (ev.key === 'Enter' || ev.key === ' ') {
                            try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
                            toggleExpand(ev);
                            try { icon.setAttribute('aria-expanded', String(expandedSet.has(relPath))); } catch (e) {}
                        }
                    } catch (e) { /* swallow */ }
                });
            }

            label.appendChild(checkbox);
            label.appendChild(icon);
            label.appendChild(name);
            li.appendChild(label);

            if (!isFile) {
                li.appendChild(createTreeHtml(currentNode, `${relPath}/`));
            }
            ul.appendChild(li);
        }
        return ul;
    }

    fileListRoot.appendChild(createTreeHtml(fileTree));
    // After rendering, reapply previously stored expanded state so folders the user opened
    // remain expanded across debounced re-renders.
                try {
                    if (expandedSet.size > 0) {
                        expandedSet.forEach(p => {
                            try {
                                const li = findLiByDataPath(fileListRoot, p);
                                if (li) { li.classList.add('expanded'); }
                            } catch (e) { logWarn('createTreeHtml per-node handler failed', e); }
                        });
                    }
                } catch (e) { logWarn('renderFileList restore expandedSet failed', e); }
    // After initial render, ensure folder checkboxes reflect tri-state based on current selections
    try {
        const folderItems = fileListRoot.querySelectorAll('li.folder-item');
        folderItems.forEach(fi => {
            try {
                // Only consider descendant leaf file-checkboxes in the subtree (exclude the parent's own checkbox)
                const descendantCheckboxes = fi.querySelectorAll(':scope ul li.file-item .file-checkbox');
                let total = 0, checked = 0;
                descendantCheckboxes.forEach(cb => { total++; if (cb.checked) { checked++; } });
                const parentCb = fi.querySelector('input.file-checkbox');
                if (parentCb) {
                    if (checked === 0) { parentCb.checked = false; parentCb.indeterminate = false; }
                    else if (checked === total) { parentCb.checked = true; parentCb.indeterminate = false; }
                    else { parentCb.checked = false; parentCb.indeterminate = true; }
                }
            } catch (e) { logWarn('renderFileList folder tri-state calculation failed for a folder', e); }
        });
    } catch (e) {}
}

// Replace direct calls with debounced version in callers
// Synchronous render entry used when the user toggles a folder so the UI updates immediately.
function renderTree(state, newExpandedSet) {
    try {
        if (newExpandedSet) {
            if (Array.isArray(newExpandedSet)) { expandedSet = new Set(newExpandedSet); }
            else if (newExpandedSet instanceof Set) { expandedSet = new Set(Array.from(newExpandedSet)); }
            else { /* ignore */ }
        }
    } catch (e) { logWarn('renderTree update expandedSet failed', e); }
    // Call render synchronously for immediate feedback
    try { renderFileList(state); } catch (e) { logWarn('renderTree renderFileList failed', e); }
}

const debouncedRenderFileList = debounce(renderFileList, 80);

// Model → context metadata map. Prefer this authoritative mapping when formatting
// model options in the settings UI. Values are numeric context lengths (tokens)
// where known. Keep missing entries omitted so fallback parsing still applies.
const MODEL_CONTEXT_MAP = Object.freeze({
    'o200k': 200000,
    'gpt-4o-mini-16k': 16000,
    'gpt-4o-mini-8k': 8000,
    // add explicit entries for other common models when known
    // 'gpt-4o': 0, // unknown default
    // 'gpt-3.5': 0,
    // 'claude-3.5': 0,
    // 'o1': 0,
});

// Lightweight message router: forward a few key message types to the UI functions
window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type === 'restoredState') {
        try {
            const s = msg.state || {};
            if (Array.isArray(s.selectedFiles) && s.selectedFiles.length > 0) {
                const sel = s.selectedFiles.slice();
                try { store.setPendingPersistedSelection && store.setPendingPersistedSelection(sel, typeof s.focusIndex === 'number' ? s.focusIndex : undefined); } catch (e) {}
            }
            if (s.focusIndex !== undefined && typeof s.focusIndex === 'number') {
                try { store.setPendingPersistedSelection && store.setPendingPersistedSelection(null, s.focusIndex); } catch (e) {}
            }
        } catch (e) { /* swallow */ }
    }
    if (msg.type === 'state') {
    try { store.setState && store.setState(msg.state || {}); } catch (e) {}
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
            try {
                const stPending = store.getState ? store.getState().pendingPersistedSelection : pendingPersistedSelection;
                const stPendingIdx = store.getState ? store.getState().pendingPersistedFocusIndex : pendingPersistedFocusIndex;
                if (stPending && stPending.length > 0 && totalFiles > 0) {
                    postAction('setSelection', { relPaths: stPending });
                    try {
                        const persist = { selectedFiles: stPending, focusIndex: stPendingIdx };
                        try { vscode.postMessage(sanitizePayload({ type: 'persistState', state: persist })); } catch (e) { console.warn('persistState postMessage failed', e); }
                    } catch (e) {}
                    try { store.setPendingPersistedSelection && store.setPendingPersistedSelection(null, undefined); } catch (e) {}
                }
            } catch (e) { /* swallow */ }
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
        // If the incoming state includes a configured preset and we haven't applied it
        try {
            const presets = (msg.state && msg.state.filterPresets) || (msg.state && msg.state.presets) || [];
            const first = Array.isArray(presets) && presets.length > 0 ? String(presets[0]) : null;
                if (first && lastAppliedPresetForTree !== first) {
                try { togglePresetSelectionUI(first); } catch (e) {}
                try { postAction('applyPreset', { preset: first }); } catch (e) {}
                // Optimistic UI: attempt a local aligned render using the current store
                try {
                    const st = store.getState ? store.getState() : null;
                    const files = st && st.fileTree ? st.fileTree : {};
                    if (typeof applyPreset === 'function') {
                        try {
                            const aligned = applyPreset(first, files);
                            try { store.setState && store.setState({ aligned }); } catch (e) {}
                            try { renderTree(aligned, expandedSet); } catch (e) {}
                        } catch (e) { /* swallow */ }
                    }
                } catch (e) { /* swallow */ }
                lastAppliedPresetForTree = first;
            }
        } catch (e) {}
    } else if (msg.type === 'previewDelta') {
        // Update the chips
        renderPreviewDelta(msg.delta);
                if (msg.delta && msg.delta.fileTree) {
                try {
                    const incomingTree = msg.delta.fileTree;
                    const incomingSelection = Array.isArray(msg.delta.selectedPaths) ? msg.delta.selectedPaths : [];
                    if (userInteracting) {
                        // defer applying the incoming tree until user is idle to avoid collapsing
                        pendingIncomingTree = incomingTree;
                        pendingIncomingSelectedPaths = incomingSelection;
                    } else {
                        try { store.setFileTree && store.setFileTree(incomingTree, incomingSelection); } catch (e) {}
                        // Ensure the tree is rendered immediately after the store is populated so
                        // the UI populates on initial scan completion without requiring user action.
                        try { const st = store.getState ? store.getState() : null; renderTree((st && st.aligned) || st, expandedSet); } catch (e) {}
                    }
                } catch (e) { /* swallow to avoid breaking message handler */ }
                // If previewDelta supplies preset metadata, apply once per new tree
                try {
                    const presets = (msg.delta && msg.delta.filterPresets) || (msg.delta && msg.delta.presets) || [];
                    const first = Array.isArray(presets) && presets.length > 0 ? String(presets[0]) : null;
                    if (first && lastAppliedPresetForTree !== first) {
                        try { togglePresetSelectionUI(first); } catch (e) {}
                        try { postAction('applyPreset', { preset: first }); } catch (e) {}
                        // Optimistic UI update: apply preset locally and re-render immediately
                        try {
                            const st = store.getState ? store.getState() : null;
                            const files = st && st.fileTree ? st.fileTree : {};
                            if (typeof applyPreset === 'function') {
                                try {
                                    const aligned = applyPreset(first, files);
                                    try { store.setState && store.setState({ aligned }); } catch (e) {}
                                    try { renderTree(aligned, expandedSet); } catch (e) {}
                                } catch (e) { /* swallow */ }
                            }
                        } catch (e) { /* swallow */ }
                        lastAppliedPresetForTree = first;
                    }
                } catch (e) { /* swallow */ }
                // After loading files into the store, compute an aligned view using the
                // currently-selected preset so the file tree shown to the user reflects
                // any preset-based categorization immediately. We do this locally for
                // optimistic UI updates and also to avoid waiting for the host roundtrip.
                try {
                    const st = store.getState();
                    // state.files is a thin alias for the fileTree used by older code paths
                    const files = st && st.fileTree ? st.fileTree : {};
                    // determine preset: prefer explicit currentPreset on state, otherwise
                    // fall back to the lastAppliedPresetForTree (from metadata) or null
                    const preset = (st && st.currentPreset) ? st.currentPreset : (lastAppliedPresetForTree || null);
                    if (typeof applyPreset === 'function') {
                        try {
                            const aligned = applyPreset(preset, files);
                            // store aligned result for callers that expect state.aligned
                            try { store.setState && store.setState({ aligned }); } catch (e) {}
                            // render using our local expandedSet mirror for immediate feedback
                            try { renderTree(aligned, expandedSet); } catch (e) {}
                        } catch (e) { /* swallow applyPreset errors */ }
                    }
                } catch (e) { /* swallow */ }
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
            // Normalize presets: prefer a non-empty filterPresets (new key) but
            // gracefully fall back to legacy presets. Accept either arrays or
            // comma-separated strings and normalize to an array for selection.
            let activeList = [];
            const asArray = (v) => {
                if (Array.isArray(v)) { return v.slice(); }
                if (typeof v === 'string' && v.trim()) { return v.split(',').map(s => s.trim()).filter(Boolean); }
                return [];
            };
            const fp = asArray(settings.filterPresets);
            if (fp.length > 0) { activeList = fp; }
            else {
                const legacy = asArray(settings.presets);
                if (legacy.length > 0) { activeList = legacy; }
            }
            const activePreset = (activeList.length > 0) ? String(activeList[0]) : null;
            togglePresetSelectionUI(activePreset);
        } catch (e) { /* swallow */ }
    } else if (msg.type === 'progress') {
        (window.__handleProgress || handleProgress)(msg.event);
    } else if (msg.type === 'remoteRepoLoaded') {
        // Host responded that the remote repo was cloned/loaded. msg.payload.tmpPath should
        // contain the temporary filesystem path that the host created. Store it locally
        // and update the modal UI to allow the user to start the ingest.
        try {
            const payload = msg.payload || {};
            const tmp = payload.tmpPath || null;
            if (tmp) {
                loadedRepoTmpPath = tmp;
                const textEl = nodes.ingestPreviewText || document.getElementById('ingest-preview-text');
                if (textEl) { textEl.textContent = `Repository loaded: ${String(tmp)}`; }
                // swap buttons: hide Load Repo, show Start Ingest
                const loadBtn = document.getElementById('ingest-load-repo');
                const startBtn = document.getElementById('ingest-submit');
                try { if (loadBtn) { loadBtn.hidden = true; loadBtn.setAttribute('aria-hidden', 'true'); } } catch (e) {}
                try { if (startBtn) { startBtn.hidden = false; startBtn.removeAttribute('aria-hidden'); startBtn.focus(); } } catch (e) {}
            } else {
                showToast('Failed to load repository', 'error');
            }
        } catch (e) { /* swallow to avoid breaking other handlers */ }
    } else if (msg.type === 'generationResult') {
        try {
            const res = msg.result || {};
            if (res.redactionApplied) {
                showToast('Output contained redacted content (masked). Toggle "Show redacted" in Settings to reveal.', 'warn', 6000);
            }
            if (res && res.error) {
                showToast(String(res.error), 'warn', 6000);
                // The redaction override is a one-shot transient flag. If the generation
                // failed, do NOT persist the disable-redaction state — clear transient
                // flags and update the UI so the override is not sticky.
                try {
                    if (pendingOverrideUsed) {
                        pendingOverrideUsed = false;
                    }
                    overrideDisableRedaction = false;
                    const rb = document.getElementById('btn-disable-redaction');
                    if (rb) { try { rb.setAttribute('aria-pressed', 'false'); } catch (e) {}
                        try { rb.classList.remove('active'); } catch (e) {} }
                } catch (e) { /* ignore UI errors */ }
            } else {
                // generation succeeded: explicitly clear transient override flags and UI state
                // so the redaction toggle does not remain active accidentally. Be defensive
                // in DOM manipulation so any partial state is removed.
                try {
                    pendingOverrideUsed = false;
                } catch (e) { pendingOverrideUsed = false; }
                try {
                    overrideDisableRedaction = false;
                } catch (e) { overrideDisableRedaction = false; }
                try {
                    const rb = document.getElementById('btn-disable-redaction');
                    if (rb) {
                        try { rb.setAttribute('aria-pressed', 'false'); } catch (ex) {}
                        try { rb.classList.remove('active'); } catch (ex) {}
                        try { rb.removeAttribute('data-pending-override'); } catch (ex) {}
                    }
                } catch (e) { /* ignore DOM errors */ }
            }
        } catch (e) {}
    }
});

function renderPreviewDelta(delta) {
    const statsTarget = nodes.stats || document.getElementById('stats');
    const chipsTarget = nodes.chips || document.getElementById('status-chips');
    if (statsTarget === null && chipsTarget === null) { return; }

    // Small helpers
    const fmtSize = formatBytes;

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

        // Build chips DOM without innerHTML
        while (chipsTarget.firstChild) { chipsTarget.removeChild(chipsTarget.firstChild); }
        for (let i = 0; i < chips.length; i++) {
            const c = chips[i];
            const chip = document.createElement('div');
            chip.className = 'status-chip' + (overLimit ? ' over-limit' : '');
            const lab = document.createElement('span'); lab.className = 'label'; lab.textContent = c.label;
            const val = document.createElement('span'); val.className = 'value'; val.textContent = c.value;
            chip.appendChild(lab); chip.appendChild(val);
            chipsTarget.appendChild(chip);
        }

        // Persistent accessible banner when token estimate exceeds context limit
        try {
            const bannerId = 'over-limit-banner';
            let banner = document.getElementById(bannerId);
            if (overLimit) {
                const message = 'Token estimate exceeds configured context limit — output may be truncated or incomplete.';
                if (!banner) {
                    // Create banner only once
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
                    try {
                        if (chipsTarget && chipsTarget.parentNode) { chipsTarget.parentNode.insertBefore(banner, chipsTarget); }
                        else { document.body.insertBefore(banner, document.body.firstChild); }
                    } catch (e) { /* ignore insertion errors */ }
                } else {
                    // If banner exists but is orphaned or in the wrong place, try to reparent it
                    try {
                        if (chipsTarget && chipsTarget.parentNode && banner.parentNode !== chipsTarget.parentNode) {
                            if (banner.parentNode) { banner.parentNode.removeChild(banner); }
                            chipsTarget.parentNode.insertBefore(banner, chipsTarget);
                        }
                    } catch (e) { /* ignore reparenting errors */ }
                }
                try { const txt = banner.querySelector('.over-limit-text'); if (txt) { txt.textContent = message; } } catch (e) {}
            } else {
                // If no longer over limit, remove banner if present and attached
                try { if (banner && banner.parentNode) { banner.parentNode.removeChild(banner); } } catch (e) { /* ignore removal errors */ }
            }
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
            if (typeof e.totalSize === 'number') { pParts.push(formatBytes(e.totalSize)); }
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
            // Accessible text for assistive tech
            try { container.setAttribute('aria-busy', 'true'); } catch (ex) {}
            try { bar.setAttribute('aria-valuetext', `${Math.round(e.percent || 0)}%`); } catch (ex) {}
            try { const s = document.getElementById('progress-status'); if (s) { s.textContent = `Progress ${Math.round(e.percent || 0)}%`; } } catch (ex) {}
        } else {
            container.classList.add('indeterminate');
            bar.style.width = '40%';
            bar.removeAttribute('aria-valuenow');
            try { container.setAttribute('aria-busy', 'true'); } catch (ex) {}
            try { bar.removeAttribute('aria-valuetext'); } catch (ex) {}
            try { const s = document.getElementById('progress-status'); if (s) { s.textContent = e.message || 'Working'; } } catch (ex) {}
        }
        showToast(e.message || (e.op + ' started'));
        // If a write operation starts, reveal the Cancel write affordance
    try { if (e.op === 'write') { const cw = nodes.cancelWriteBtn || document.getElementById('btn-cancel-write'); if (cw) { cw.hidden = false; cw.removeAttribute('aria-hidden'); } } } catch (ex) {}
    } else if (e.mode === 'progress') {
        container.classList.remove('indeterminate');
        bar.style.width = (e.percent || 0) + '%';
        bar.setAttribute('aria-valuenow', String(Math.round(e.percent || 0)));
    try { bar.setAttribute('aria-valuetext', `${Math.round(e.percent || 0)}%`); } catch (ex) {}
    try { const s = document.getElementById('progress-status'); if (s) { s.textContent = `Progress ${Math.round(e.percent || 0)}%`; } } catch (ex) {}
    } else if (e.mode === 'end') {
        container.classList.remove('indeterminate');
        bar.style.width = '100%';
        bar.setAttribute('aria-valuenow', '100');
    try { bar.setAttribute('aria-valuetext', 'Complete'); } catch (ex) {}
    try { const s = document.getElementById('progress-status'); if (s) { s.textContent = 'Complete'; } } catch (ex) {}
        setTimeout(() => { bar.style.width = '0%'; }, 600);
        showToast(e.message || (e.op + ' finished'), 'success');
    // hide cancel affordance when write ends
    try { if (e.op === 'write') { const cw = nodes.cancelWriteBtn || document.getElementById('btn-cancel-write'); if (cw) { cw.hidden = true; cw.setAttribute('aria-hidden', 'true'); } } } catch (ex) {}
    }
    // Clear busy when no longer active (end or if determinate but percent at 100)
    try {
        if (e.mode === 'end' || (e.determinate && Number(e.percent) === 100)) { const c = progressContainer(); if (c) { c.setAttribute('aria-busy', 'false'); } }
    } catch (ex) {}
}

// Pause/Resume UI wiring
const pauseBtn = () => nodes.pauseBtn || document.getElementById('btn-pause-resume');
function updatePauseButton() {
    const b = pauseBtn();
    if (!b) { return; }
    // Update text, pressed state and CSS class for accessibility and styling
    // Avoid replacing button children (icons). Update or create a small label node.
    try {
        let label = b.querySelector('.pause-label');
        if (!label) {
            label = document.createElement('span');
            label.className = 'pause-label';
            // append label after existing children so icons remain intact
            b.appendChild(label);
        }
        label.textContent = paused ? 'Resume' : 'Pause';
        // Keep an accessible name in sync as well
        try { b.setAttribute('aria-label', paused ? 'Resume' : 'Pause'); } catch (e) {}
    } catch (e) { try { b.textContent = paused ? 'Resume' : 'Pause'; } catch (ex) {} }
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
    // Use shared formatter for consistency with other UI areas
    if (typeof e.totalSize === 'number') { parts.push(`Size: ${formatBytes(e.totalSize)}`); }
    statsEl.textContent = parts.join(' · ');
    // Also update inline progress stats next to the progress bar
    const progressStats = document.querySelector('.progress-stats');
    if (progressStats) {
        const pParts = [];
        if (typeof e.totalFiles === 'number') { pParts.push(`${e.totalFiles} files`); }
    if (typeof e.totalSize === 'number') { pParts.push(formatBytes(e.totalSize)); }
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
    try { console.debug && console.debug('[codebase-digest][webview] window.onload: requesting state'); } catch (e) {}
    vscode.postMessage({ type: 'getState' });
    // If no state arrives quickly (race with host), retry a couple of times to ensure provider responds
    let retries = 0;
    const retryGetState = () => {
        try {
            retries += 1;
            if (retries > 5) { return; }
            try { console.debug && console.debug('[codebase-digest][webview] retrying getState attempt', retries); } catch (e) {}
            vscode.postMessage({ type: 'getState' });
            setTimeout(retryGetState, 400 * retries);
        } catch (e) { /* swallow */ }
    };
    setTimeout(() => { retryGetState(); }, 300);
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

    // Attach light-weight interaction listeners to detect when the user is manipulating
    // the file list. Use capture-phase pointer events so we catch interactions early
    // before the label/checkbox default behaviours occur.
    try {
        const listRoot = nodes.fileListRoot || document.getElementById('file-list');
        const markInteraction = () => {
            try {
                userInteracting = true;
                if (interactionTimeout) { clearTimeout(interactionTimeout); interactionTimeout = null; }
                // after 700ms of inactivity, consider interaction finished and flush pending update
                interactionTimeout = setTimeout(() => {
                    try {
                        userInteracting = false;
                        interactionTimeout = null;
                        if (pendingIncomingTree) {
                            try { store.setFileTree && store.setFileTree(pendingIncomingTree, pendingIncomingSelectedPaths || []); } catch (e) {}
                            try { const st = store.getState ? store.getState() : null; renderTree((st && st.aligned) || st, expandedSet); } catch (e) {}
                            pendingIncomingTree = null; pendingIncomingSelectedPaths = null;
                        }
                    } catch (e) { /* swallow */ }
                }, 700);
            } catch (e) { /* swallow */ }
        };
        if (listRoot) {
            listRoot.addEventListener('pointerdown', markInteraction, { capture: true });
            listRoot.addEventListener('focusin', markInteraction, { capture: true });
            listRoot.addEventListener('keydown', markInteraction, { capture: true });
        }
    } catch (e) { /* swallow */ }

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
                // Optimistically update local UI and aligned state for immediate feedback
                try { togglePresetSelectionUI(preset); } catch (e) {}
                try {
                    // persist the current preset selection into our store so subsequent
                    // renders and logic can reference it. This mirrors the host-side
                    // notion of currentPreset but keeps the webview responsive.
                    try { store.setState && store.setState({ currentPreset: preset }); } catch (e) {}
                    const st = store.getState ? store.getState() : {};
                    const files = st && st.fileTree ? st.fileTree : {};
                    if (typeof applyPreset === 'function') {
                        try {
                            const aligned = applyPreset(preset, files);
                            try { store.setState && store.setState({ aligned }); } catch (e) {}
                            try { renderTree(aligned, expandedSet); } catch (e) {}
                        } catch (e) { /* swallow */ }
                    }
                } catch (e) { /* swallow */ }
                // Also notify the host so it can persist/apply the preset globally
                sendCmd('applyPreset', { preset });
                return;
            }

            // Select all / clear selection operate on the rendered tree DOM
            if (action === 'selectAll' || action === 'clearSelection') {
                const shouldSelect = action === 'selectAll';
                try {
                    // Only include file (leaf) items — selector targets checkboxes that are children of li.file-item
                    const fileCheckboxes = document.querySelectorAll('#file-list li.file-item .file-checkbox');
                    const filePaths = Array.from(fileCheckboxes).map(cb => {
                        try { const a = cb.getAttribute && cb.getAttribute('data-path'); return a ? decodeFromDataAttribute(a) : null; } catch (e) { return null; }
                    }).filter(Boolean);
                    postAction('setSelection', { relPaths: shouldSelect ? filePaths : [] });
                } catch (e) { /* swallow DOM errors */ }
                return;
            }
            // Expand/Collapse all operate on the rendered tree DOM immediately for instant feedback
            if (action === 'expandAll' || action === 'collapseAll') {
                const shouldExpand = action === 'expandAll';
                try {
                    const folderItems = document.querySelectorAll('#file-list li.folder-item');
                    folderItems.forEach(fi => {
                        try {
                            const pathAttr = fi.getAttribute && fi.getAttribute('data-path');
                            const decodedPath = pathAttr ? decodeFromDataAttribute(pathAttr) : null;
                            if (shouldExpand) {
                                        fi.classList.add('expanded');
                                        if (decodedPath) { try { expandedSet.add(decodedPath); } catch (e) {} }
                                    } else {
                                        fi.classList.remove('expanded');
                                        if (decodedPath) { try { expandedSet.delete(decodedPath); } catch (e) {} }
                                    }
                        } catch (e) { /* ignore per-node errors */ }
                    });
                    // persist expandedPaths to store after batch update
                    try { store.setExpandedPaths && store.setExpandedPaths(Array.from(expandedSet)); } catch (e) {}
                } catch (e) { /* swallow DOM errors */ }
                // Also notify the host so provider/tree state stays in sync
                postAction(action);
                return;
            }
            if (action === 'togglePause') {
                paused = !paused;
                try { window.localStorage.setItem('cbd_paused', paused ? '1' : '0'); } catch (e) {}
                try { store.togglePause && store.togglePause(paused); } catch (e) {}
                updatePauseButton();
                postAction(paused ? 'pauseScan' : 'resumeScan');
                return;
            }
            if (action === 'openSettings') {
                const settingsEl = document.getElementById('settings');
                if (settingsEl) { openModal(settingsEl); }
                // Request latest config from the extension for the settings UI
                postAction('configRequest');
                // focus first input in settings for keyboard users
                try { setTimeout(() => { const first = settingsEl && settingsEl.querySelector ? settingsEl.querySelector('input,select,textarea,button') : null; if (first && typeof first.focus === 'function') { first.focus(); } }, 0); } catch (e) {}
                return;
            }
            if (action === 'ingestRemote') {
                const m = document.getElementById('ingestModal');
                if (m) { openModal(m); }
                try { setTimeout(() => { const repo = document.getElementById('ingest-repo'); if (repo && typeof repo.focus === 'function') { repo.focus(); } }, 0); } catch (e) {}
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
    // Also delegate clicks from the top action-bar so buttons placed outside
    // the #toolbar (for layout reasons) still invoke data-action handlers.
    try {
        const actionBarEl = document.querySelector('.action-bar');
        if (actionBarEl) {
            actionBarEl.addEventListener('click', (ev) => {
                const btn = ev.target && (ev.target.closest ? ev.target.closest('button') : null);
                if (!btn) { return; }
                const action = btn.getAttribute('data-action');
                if (!action) { return; }
                // special-case generation so we include transient overrides like the toolbar does
                if (action === 'generateDigest') {
                    ev.preventDefault(); ev.stopPropagation();
                    const payload = {};
                    if (overrideDisableRedaction) {
                        payload.overrides = { showRedacted: true };
                        pendingOverrideUsed = true;
                    }
                    postAction(action, payload);
                    return;
                }
                // fallback to normal command routing
                sendCmd(action);
            });
        }
    } catch (e) { /* swallow */ }
    // Header buttons live outside the toolbar node; wire them explicitly so
    // clicking the header ingest/settings buttons opens the corresponding modals.
    try {
        const headerIngest = document.getElementById('btn-ingest-remote');
        if (headerIngest) {
            headerIngest.addEventListener('click', (ev) => {
                ev.preventDefault(); ev.stopPropagation();
                const m = document.getElementById('ingestModal');
                if (m) { openModal(m); }
                try { setTimeout(() => { const repo = document.getElementById('ingest-repo'); if (repo && typeof repo.focus === 'function') { repo.focus(); } }, 0); } catch (e) {}
            });
        }
    
        // Also wire header settings button explicitly (header UI lives outside #toolbar)
        const headerSettings = document.getElementById('openSettings');
        if (headerSettings) {
            headerSettings.addEventListener('click', (ev) => {
                ev.preventDefault(); ev.stopPropagation();
                const settingsEl = document.getElementById('settings');
                if (settingsEl) { openModal(settingsEl); }
                // Request latest config from the extension for the settings UI
                postAction('configRequest');
                // focus first input in settings for keyboard users
                try { setTimeout(() => { const first = settingsEl && settingsEl.querySelector ? settingsEl.querySelector('input,select,textarea,button') : null; if (first && typeof first.focus === 'function') { first.focus(); } }, 0); } catch (e) {}
            });
        }
    } catch (e) { /* swallow header wiring errors */ }
    try {
        const explicitPause = nodes.pauseBtn || document.getElementById('btn-pause-resume');
        if (explicitPause) {
            explicitPause.addEventListener('click', (ev) => {
                ev.preventDefault(); ev.stopPropagation();
                paused = !paused;
                try { window.localStorage.setItem('cbd_paused', paused ? '1' : '0'); } catch (e) {}
                try { store.togglePause && store.togglePause(paused); } catch (e) {}
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
        // focus first option for keyboard users
        const first = presetMenu.querySelector('[role="option"]');
        if (first) { try { first.setAttribute('tabindex', '0'); first.focus(); } catch (e) {} }
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
        try {
            // Reset option tabindex to -1 so keyboard navigation doesn't trap focus
            const options = presetMenu.querySelectorAll('[role="option"]');
            options.forEach(o => { try { o.setAttribute('tabindex', '-1'); } catch (e) {} });
        } catch (e) {}
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
        // Use a small delegation for option clicks to avoid per-item wiring
        nodes.presetMenu.addEventListener('click', (ev) => {
            const it = ev.target && ev.target.closest ? ev.target.closest('[role="option"][data-preset]') : null;
            if (!it) { return; }
            ev.preventDefault(); ev.stopPropagation();
            const preset = it.getAttribute('data-preset');
            if (preset) {
                try { togglePresetSelectionUI(preset); } catch (e) {}
                try { store.setState && store.setState({ currentPreset: preset }); } catch (e) {}
                try {
                    const st = store.getState ? store.getState() : {};
                    const files = st && st.fileTree ? st.fileTree : {};
                    if (typeof applyPreset === 'function') {
                        try {
                            const aligned = applyPreset(preset, files);
                            try { store.setState && store.setState({ aligned }); } catch (e) {}
                            try { renderTree(aligned, expandedSet); } catch (e) {}
                        } catch (e) {}
                    }
                } catch (e) {}
                postAction('applyPreset', { preset });
            }
            closePresetMenu();
        });
        // Keyboard navigation: Enter/Space to activate, Arrow keys to move focus
        nodes.presetMenu.addEventListener('keydown', (ev) => {
            const options = Array.from(nodes.presetMenu.querySelectorAll('[role="option"]'));
            const current = ev.target && ev.target.closest ? ev.target.closest('[role="option"]') : null;
            const idx = current ? options.indexOf(current) : -1;
            if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault(); if (current) { current.click(); }
            } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') {
                ev.preventDefault(); const next = options[Math.min(options.length - 1, Math.max(0, idx + 1))]; if (next) { try { options.forEach(o => o.setAttribute('tabindex', '-1')); next.setAttribute('tabindex', '0'); next.focus(); } catch (e) {} }
            } else if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') {
                ev.preventDefault(); const prev = options[Math.max(0, idx - 1)]; if (prev) { try { options.forEach(o => o.setAttribute('tabindex', '-1')); prev.setAttribute('tabindex', '0'); prev.focus(); } catch (e) {} }
            } else if (ev.key === 'Escape') { closePresetMenu(); }
        });
    }
    document.getElementById('ingest-cancel')?.addEventListener('click', () => { const m = document.getElementById('ingestModal'); if (m) { closeModal(m); } });
    // Two-stage ingest flow: Load repo first, then start ingest on the loaded repo
    document.getElementById('ingest-load-repo')?.addEventListener('click', () => {
        const repoRaw = (document.getElementById('ingest-repo') || {}).value || '';
        const refRaw = (document.getElementById('ingest-ref') || {}).value || '';
        const subpathRaw = (document.getElementById('ingest-subpath') || {}).value || '';
            const includeSubmodules = !!(document.getElementById('ingest-submodules') && document.getElementById('ingest-submodules').checked);
            if (!repoRaw || repoRaw.trim().length === 0) { showToast('Please enter a repo URL or owner/repo slug', 'error'); return; }
            // Normalize common URL/SSH forms to the owner/repo slug used by the host.
            // Accepts: owner/repo, https://github.com/owner/repo, http(s) with www, git@github.com:owner/repo.git, and similar.
            // Use the declared variable `repoRaw` (was previously `repo`, which can be undefined)
            const raw = repoRaw.trim();
            let normalized = raw;
            let lookedLikeRemote = false;
            try {
                // Quick heuristic to know whether the user entered a remote-style string
                if (/^https?:\/\//i.test(raw) || /^git@/i.test(raw) || /github\.com/i.test(raw)) { lookedLikeRemote = true; }
                // If it's a proper URL, parse and extract the first two path segments
                if (/^https?:\/\//i.test(raw)) {
                    try {
                        const u = new URL(raw);
                        const path = (u.pathname || '').replace(/^\/+|\/+$/g, '');
                        const parts = path.split('/').filter(Boolean);
                        if (parts.length >= 2) { normalized = `${parts[0]}/${parts[1]}`; }
                    } catch (e) { /* ignore URL parse errors */ }
                }
                // git@github.com:owner/repo.git forms
                const m1 = raw.match(/^git@github\.com:([^\/\s]+)\/([^\/\s]+)(?:\.git)?$/i);
                if (m1 && m1[1] && m1[2]) { normalized = `${m1[1]}/${m1[2]}`; }
                // ssh://git@github.com/owner/repo.git
                const m2 = raw.match(/^ssh:\/\/git@github\.com\/([^\/\s]+)\/([^\/\s]+)(?:\.git)?$/i);
                if (m2 && m2[1] && m2[2]) { normalized = `${m2[1]}/${m2[2]}`; }
                // Any github.com/.../... occurrence (covers www.github.com and lacking protocol)
                const m3 = raw.match(/(?:github\.com[:\/]|www\.github\.com[:\/])([^\/\s]+)\/([^\/\s]+)(?:\.git)?/i) || raw.match(/github\.com\/([^\/\s]+)\/([^\/\s]+)(?:\.git)?/i);
                if (m3 && m3[1] && m3[2]) { normalized = `${m3[1]}/${m3[2]}`; }
            } catch (e) { /* ignore normalization errors */ }
            const slugLike = /^[^\/\s]+\/[^\/\s]+$/.test(normalized);
            if (!slugLike) {
                const hint = lookedLikeRemote
                    ? 'Ensure the URL includes both owner and repository (e.g. https://github.com/owner/repo).' 
                    : 'Expected owner/repo or full GitHub URL (https://github.com/owner/repo or git@github.com:owner/repo.git).';
                showToast('Invalid repo format; ' + hint, 'error');
                return;
            }
        // show cloning state
        if (nodes.ingestPreviewRoot) { nodes.ingestPreviewRoot.classList.add('loading'); }
        if (nodes.ingestSpinner) { nodes.ingestSpinner.hidden = false; nodes.ingestSpinner.removeAttribute('aria-hidden'); }
        if (nodes.ingestPreviewText) { nodes.ingestPreviewText.textContent = 'Cloning repository...'; nodes.ingestPreviewText.classList.add('loading-placeholder'); }
        // Client-side sanitize the fields as a defence-in-depth measure before sending
        const sanitizedRepo = sanitizeRepoInput(normalized);
        const sanitizedRef = sanitizeRefName(refRaw);
        const sanitizedSubpath = sanitizeSubpath(subpathRaw);
        if (!sanitizedRepo) {
            showToast('Repository input contains disallowed characters and was rejected.', 'error');
            if (nodes.ingestPreviewRoot) { nodes.ingestPreviewRoot.classList.remove('loading'); }
            if (nodes.ingestSpinner) { nodes.ingestSpinner.hidden = true; nodes.ingestSpinner.setAttribute('aria-hidden', 'true'); }
            return;
        }
        if (sanitizedRef === null) {
            showToast('Ref input contains disallowed characters and was rejected.', 'error');
            if (nodes.ingestPreviewRoot) { nodes.ingestPreviewRoot.classList.remove('loading'); }
            if (nodes.ingestSpinner) { nodes.ingestSpinner.hidden = true; nodes.ingestSpinner.setAttribute('aria-hidden', 'true'); }
            return;
        }
        if (sanitizedSubpath === null) {
            showToast('Subpath input contains disallowed characters and was rejected.', 'error');
            if (nodes.ingestPreviewRoot) { nodes.ingestPreviewRoot.classList.remove('loading'); }
            if (nodes.ingestSpinner) { nodes.ingestSpinner.hidden = true; nodes.ingestSpinner.setAttribute('aria-hidden', 'true'); }
            return;
        }
        // send loadRemoteRepo action to host with sanitized values
        postAction('loadRemoteRepo', { repo: sanitizedRepo, ref: sanitizedRef || undefined, subpath: sanitizedSubpath || undefined, includeSubmodules });
    });

    // Start ingest of a previously-loaded repository. The host should have returned
    // a temporary path via the 'remoteRepoLoaded' message which we store in loadedRepoTmpPath.
    document.getElementById('ingest-submit')?.addEventListener('click', () => {
            if (!loadedRepoTmpPath) { showToast('No loaded repository available. Click Load Repo first.', 'error'); return; }
            // send ingestLoadedRepo with the temporary path
            postAction('ingestLoadedRepo', { tmpPath: loadedRepoTmpPath });
            // set loading state
            if (nodes.ingestPreviewRoot) { nodes.ingestPreviewRoot.classList.add('loading'); }
            if (nodes.ingestSpinner) { nodes.ingestSpinner.hidden = false; nodes.ingestSpinner.removeAttribute('aria-hidden'); }
            if (nodes.ingestPreviewText) { nodes.ingestPreviewText.textContent = 'Starting ingest...'; nodes.ingestPreviewText.classList.add('loading-placeholder'); }
    });
    // also wire the top-right close buttons for the two modals
    document.getElementById('ingest-close')?.addEventListener('click', () => { const m = document.getElementById('ingestModal'); if (m) { closeModal(m); } });
    document.getElementById('settings-close')?.addEventListener('click', () => { const m = document.getElementById('settings'); if (m) { closeModal(m); } });

    // clicking the overlay should cancel/close the modal as well
    document.getElementById('ingest-cancel-overlay')?.addEventListener('click', () => { const m = document.getElementById('ingestModal'); if (m) { closeModal(m); } });
    document.getElementById('settings-cancel-overlay')?.addEventListener('click', () => { const m = document.getElementById('settings'); if (m) { closeModal(m); } });

    // close modals on Escape key
    document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') {
            try {
                const im = document.getElementById('ingestModal');
                const se = document.getElementById('settings');
                if (im && !im.hidden) { closeModal(im); }
                if (se && !se.hidden) { closeModal(se); }
                // also close preset menu if open
                try { if (typeof closePresetMenu === 'function') { closePresetMenu(); } } catch (e) {}
            } catch (e) { /* swallow */ }
        }
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
    const modelEl = getEl('tokenModel');
    if (modelEl) {
        try {
            // Read existing options as the authoritative list of model values
            const existingOptions = Array.from(modelEl.querySelectorAll('option')).map((opt, idx) => ({ value: opt.value, text: (opt.textContent || opt.innerText || opt.value), index: idx }));

            // Parse numeric context from a token model id or label (e.g. '16k', '200k', '16000')
            function parseContext(s) {
                if (!s) { return null; }
                try {
                    const str = String(s);
                    // look for a number with optional k/m suffix (e.g. 8k, 16k, 200k, 16000)
                    const m = str.match(/(\d+)([kKmM])?/);
                    if (!m) { return null; }
                    const n = Number(m[1]);
                    if (Number.isNaN(n)) { return null; }
                    const unit = m[2] ? m[2].toLowerCase() : '';
                    const value = unit === 'k' ? n * 1000 : unit === 'm' ? n * 1000000 : n;
                    const raw = unit ? `${m[1]}${unit}` : `${m[1]}`;
                    return { raw, value };
                } catch (e) { return null; }
            }

            const enriched = existingOptions.map(o => {
                // Prefer explicit metadata map when present
                const metaValue = (o.value && MODEL_CONTEXT_MAP[o.value]) ? MODEL_CONTEXT_MAP[o.value] : null;
                if (metaValue) {
                    return Object.assign({}, o, { contextRaw: String(metaValue), contextValue: Number(metaValue) });
                }
                const byVal = parseContext(o.value);
                const byText = parseContext(o.text);
                const ctx = byVal || byText || null;
                return Object.assign({}, o, { contextRaw: ctx ? ctx.raw : null, contextValue: ctx ? ctx.value : 0 });
            });

            // Sort by numeric context descending, fallback to original order for ties / unknowns
            enriched.sort((a, b) => {
                if (a.contextValue !== b.contextValue) { return b.contextValue - a.contextValue; }
                return a.index - b.index;
            });

            // Rebuild the select options preserving canonical values but updating visible labels
            while (modelEl.firstChild) { modelEl.removeChild(modelEl.firstChild); }
            enriched.forEach(o => {
                const opt = document.createElement('option');
                opt.value = o.value;
                const modelName = o.text || o.value;
                opt.textContent = o.contextRaw ? `${o.contextRaw} — ${modelName}` : modelName;
                modelEl.appendChild(opt);
            });

            // Restore selected value (fall back sensibly if not present)
            const desired = settings.tokenModel || 'chars-approx';
            const found = Array.from(modelEl.options).some(opt => opt.value === desired);
            modelEl.value = found ? desired : (modelEl.options[0] && modelEl.options[0].value) || desired;
        } catch (e) {
            // If anything goes wrong, fall back to the previous behaviour
            try { modelEl.value = settings.tokenModel || 'chars-approx'; } catch (ex) {}
        }
    }
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
    // maxTotalSizeVal is stored in bytes in settings; convert to MB for UI
    const maxTotalSizeVal = (typeof settings.maxTotalSizeBytes !== 'undefined') ? settings.maxTotalSizeBytes : (cfgThresholds.maxTotalSizeBytes || defaults.maxTotalSizeBytes);
    const tokenLimitVal = (typeof settings.tokenLimit !== 'undefined') ? settings.tokenLimit : (cfgThresholds.tokenLimit || defaults.tokenLimit);
    if (maxFilesNumber) { maxFilesNumber.value = String(maxFilesVal); }
    if (maxFilesRange) { maxFilesRange.value = String(Math.max(100, Math.min(50000, maxFilesVal))); }
    // Display the number input in MB for user clarity
    if (maxTotalSizeNumber) { maxTotalSizeNumber.value = String(Math.max(1, Math.round(maxTotalSizeVal / (1024 * 1024)))); }
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
    // Keep both range and number in MB; persist as bytes when saving
    wireRangeNumber(maxTotalSizeRange, maxTotalSizeNumber, v => Math.max(1, Math.min(4096, v)), v => Math.max(1, Math.min(4096, v)));
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
            // maxTotalSizeNumber is presented to users in MB; convert to bytes for storage
            const maxTotalSizeMB = Number((document.getElementById('maxTotalSizeNumber') || {}).value) || Math.round(defaults.maxTotalSizeBytes / (1024 * 1024));
            const maxTotalSizeBytes = Math.max(1, Math.min(4096, Math.round(maxTotalSizeMB))) * (1024 * 1024);
            const tokenLimit = Number((document.getElementById('tokenLimitNumber') || {}).value) || defaults.tokenLimit;
            // Persist flattened threshold keys for simpler runtime access
            changes.maxFiles = maxFiles;
            changes.maxTotalSizeBytes = maxTotalSizeBytes;
            changes.tokenLimit = tokenLimit;
            const pv = (getEl('presets') && getEl('presets').value) || '';
            // Normalize UI 'presets' input to the runtime key 'filterPresets' so the
            // host immediately uses them for scanning/filtering without a second-step sync.
            changes.filterPresets = pv.trim() ? pv.split(',').map(s => s.trim()).filter(Boolean) : [];
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
// Toggle visual selection state for preset buttons/menu items in the UI.
// This is intentionally idempotent and defensive: calling with null clears selection.
function togglePresetSelectionUI(presetName) {
    try {
        // Clear any previously marked items
        const buttons = document.querySelectorAll('[data-action="applyPreset"], [role="option"][data-preset]');
        buttons.forEach(b => {
            try { b.classList.remove('selected'); b.removeAttribute('aria-pressed'); } catch (e) {}
        });
        if (!presetName) { return; }
        // Mark matching controls (both popup options and toolbar buttons)
        const selector = `[data-action="applyPreset"][data-preset="${presetName}"], [role="option"][data-preset="${presetName}"]`;
        const matches = document.querySelectorAll(selector);
        matches.forEach(m => { try { m.classList.add('selected'); m.setAttribute('aria-pressed', 'true'); } catch (e) {} });
    } catch (e) { /* swallow */ }
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
