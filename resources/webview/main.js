// Initialize VS Code API and the shared store.
// Prefer an existing webview-provided store (window.store), then try to require the
// packaged `store.js` module. Only if neither is available, create a minimal
// fallback compatible with the small subset of the zustand-like API this webview uses.
const vscode = acquireVsCodeApi();
let store;
(function initStore() {
    // 1) Prefer window.store when the webview preload has injected it
    try {
        if (typeof window !== 'undefined' && window.store) {
            store = window.store;
            return;
        }
    } catch (e) { /* ignore */ }

    // 2) Try requiring the runtime store module (bundled case)
    try {
        if (typeof require === 'function') {
            const required = require('./store');
            if (required) { store = required; return; }
        }
    } catch (e) { /* ignore require failures */ }

    // 3) Fallback: minimal vanilla store helper compatible with a tiny subset of zustand's API
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

    // create a local store instance with the minimal action surface required by this file
    store = create((set) => ({
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

    // expose fallback store on window for compatibility with other modules expecting it
    try { if (typeof window !== 'undefined' && !window.store) { window.store = store; } } catch (e) {}
})();
// Small lifecycle tracker: track timers and observers so tests and unload handlers
// can clear them and avoid lingering handles. Exposes minimal API on window.__cbd_lifecycle
;(function lifecycleTracker(){
    try {
        const timers = new Set();
        const observers = new Set();
        const registerTimer = (t) => { try { if (t) { timers.add(t); } } catch (e) {} };
        const unregisterTimer = (t) => { try { if (t) { timers.delete(t); } } catch (e) {} };
        const registerObserver = (o) => { try { if (o) { observers.add(o); } } catch (e) {} };
        const unregisterObserver = (o) => { try { if (o) { observers.delete(o); } } catch (e) {} };
        const cleanup = () => {
            try {
                for (const t of Array.from(timers)) {
                    try { clearTimeout(t); } catch (e) {}
                    try { clearInterval(t); } catch (e) {}
                    try { if (typeof t.unref === 'function') { t.unref(); } } catch (e) {}
                }
            } catch (e) {}
            try {
                for (const o of Array.from(observers)) {
                    try { if (o && typeof o.disconnect === 'function') { o.disconnect(); } } catch (e) {}
                }
            } catch (e) {}
            try { timers.clear(); observers.clear(); } catch (e) {}
        };
        try { if (typeof window !== 'undefined') { window.__cbd_lifecycle = Object.assign(window.__cbd_lifecycle || {}, { registerTimer, unregisterTimer, registerObserver, unregisterObserver, cleanup }); window.addEventListener && window.addEventListener('unload', cleanup); } } catch (e) {}
    } catch (e) {}
})();
// Small helpers to register/unregister timers with the lifecycle tracker.
// Keeps calls short and defensive (used throughout this file after setTimeout/setInterval creations).
function _registerTimerHandle(t) {
    try {
        if (typeof window !== 'undefined' && window.__cbd_lifecycle && typeof window.__cbd_lifecycle.registerTimer === 'function') {
            window.__cbd_lifecycle.registerTimer(t);
        }
    } catch (e) {}
}
function _unregisterTimerHandle(t) {
    try {
        if (typeof window !== 'undefined' && window.__cbd_lifecycle && typeof window.__cbd_lifecycle.unregisterTimer === 'function') {
            window.__cbd_lifecycle.unregisterTimer(t);
        }
    } catch (e) {}
}
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
    // If the host provided a serialized tree snapshot, prefer applying that to the fileTree
    try {
        if (typeof st.treeData !== 'undefined' && st.treeData !== null) {
            // If the user is currently interacting with the UI, defer applying incoming trees
            if (userInteracting) {
                pendingIncomingTree = st.treeData;
                pendingIncomingSelectedPaths = Array.isArray(st.selectedPaths) ? st.selectedPaths.slice() : null;
            } else {
                try { if (store.setFileTree) { store.setFileTree(st.treeData, Array.isArray(st.selectedPaths) ? st.selectedPaths.slice() : []); } } catch (e) { /* swallow */ }
            }
        }
    } catch (e) {}
    // Rerender file list whenever fileTree or selectedPaths changes.
    try {
        // Prefer a debounced renderer exposed by the centralized uiRenderer when present
        // (keeps a single rendering path for tests). Fall back to the local debounced
        // implementation when absent.
        try {
            const r = (typeof window !== 'undefined' && window.__UI_RENDERER__);
            if (r && typeof r.debouncedRender === 'function') { try { r.debouncedRender(); } catch (e) { debouncedRenderFileList(); } }
            else { debouncedRenderFileList(); }
        } catch (e) { debouncedRenderFileList(); }
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
    try {
        // Prefer centralized nodes module if present (lazy, test-friendly)
        const impl = (typeof window !== 'undefined' && window.__CBD_NODES__) ? window.__CBD_NODES__ : null;
        if (!impl) {
            try {
                // attempt to require the runtime nodes helper when bundling
                const runtime = require('./nodes');
                if (runtime && typeof runtime.getById === 'function') {
                    const el = runtime.getById(id);
                    if (el) { return el; }
                }
            } catch (e) {
                // ignore require failures and fall back to legacy behavior
            }
        } else {
            const getterName = 'get' + id.split('-').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('');
            if (typeof impl[getterName] === 'function') {
                const el = impl[getterName]();
                if (el) { return el; }
            }
            // generic fallback
            const byId = impl.getById && impl.getById(id);
            if (byId) { return byId; }
        }
    } catch (e) { /* best-effort */ }
    // return cached node if present, otherwise fall back to live query
    return nodes[id] || (typeof document !== 'undefined' ? document.getElementById(id) : null);
}

// Centralized lightweight logger for webview diagnostics. Use the injected
// webview logger when present (window.__cbd_logger), otherwise fall back to console.warn.
function logWarn(context, err) {
    try { _webviewLog('warn', context, err); } catch (e) { /* best-effort logging only */ }
}

// Small helper to access webview logger with defensive fallbacks for all levels.
function _webviewLog(level, msg /*, ...args */) {
    const args = Array.prototype.slice.call(arguments, 1);
    const logger = (typeof window !== 'undefined' && window.__cbd_logger) ? window.__cbd_logger : null;
    if (logger && typeof logger[level] === 'function') {
        try { logger[level].apply(null, args); return; } catch (e) { /* fallthrough to console */ }
    }
    // console fallback
    try { const c = console || {}; if (c[level]) { c[level].apply(c, args); } else if (c.log) { c.log.apply(c, args); } } catch (e) {}
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
    try { vscode.postMessage(sanitizePayload(base)); } catch (e) { _webviewLog('warn', '[main] postAction postMessage failed', e); }
}

function postConfig(action, payload) {
    const base = Object.assign({ type: 'config', action }, payload || {});
    if (currentFolderPath) { base.folderPath = currentFolderPath; }
    try { vscode.postMessage(sanitizePayload(base)); } catch (e) { _webviewLog('warn', '[main] postConfig postMessage failed', e); }
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
        const r = (typeof window !== 'undefined' && window.__UI_RENDERER__);
        if (r && typeof r.openModal === 'function') { try { r.openModal(element); return; } catch (e) { /* fallthrough to local impl */ } }
        __focusState.lastFocused = document.activeElement;
        element.hidden = false;
        try { element.removeAttribute('aria-hidden'); } catch (e) {}
        // focus first control
    try { var __cbd_focus_to = setTimeout(() => { try { const first = element.querySelector('input,button,select,textarea,[tabindex]'); if (first && typeof first.focus === 'function') { first.focus(); } } finally { _unregisterTimerHandle(__cbd_focus_to); } }, 0); _registerTimerHandle(__cbd_focus_to); if (__cbd_focus_to && typeof __cbd_focus_to.unref === 'function') { try { __cbd_focus_to.unref(); } catch (e) {} } } catch (e) {}
        // basic trap: capture Tab key and keep focus inside modal
        element.addEventListener('keydown', modalKeyHandler);
    } catch (e) { logWarn('openModal failed', e); }
}
function closeModal(element) {
    try {
        const r = (typeof window !== 'undefined' && window.__UI_RENDERER__);
        if (r && typeof r.closeModal === 'function') { try { r.closeModal(element); return; } catch (e) { /* fallthrough to local impl */ } }
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
    try { if (tid && typeof tid.unref === 'function') { try { tid.unref(); } catch (e) {} } } catch (e) {}
    try { if (tid && typeof tid.unref === 'function') { try { tid.unref(); } catch (e) {} } } catch (e) {}
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
    // Prefer centralized uiRenderer's implementation to avoid duplicate DOM wiring.
    try {
        const r = (typeof window !== 'undefined' && window.__UI_RENDERER__);
        if (r && typeof r.renderFileList === 'function') { try { r.renderFileList(state); return; } catch (err) { logWarn('uiRenderer.renderFileList failed', err); } }
    } catch (e) { /* swallow */ }
    // Minimal fallback: do nothing (renderer-less environments should rely on legacy bundle or tests)
    try {
        const root = document.getElementById('file-list'); if (root) { while (root.firstChild) { root.removeChild(root.firstChild); } }
    } catch (e) { /* swallow */ }
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
    // Call render synchronously for immediate feedback. Prefer centralized ui renderer
    // when available; fall back to local renderFileList implementation.
    try {
        const r = (typeof window !== 'undefined' && window.__UI_RENDERER__);
        if (r && typeof r.renderTree === 'function') {
            try { r.renderTree(state, newExpandedSet); return; } catch (err) { logWarn('uiRenderer.renderTree failed', err); }
        }
        renderFileList(state);
    } catch (e) { logWarn('renderTree renderFileList failed', e); }
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
    try {
        // Prefer a handler registered under the centralized command name map when present.
        // This allows migrating literal strings to a single source of truth while remaining
        // backwards compatible with the existing registry maps.
        const cmdName = (window.__commandNames && msg && msg.type && window.__commandNames[msg.type]) ? window.__commandNames[msg.type] : (msg && msg.type);
        if (cmdName && window.__commandRegistry && typeof window.__commandRegistry[cmdName] === 'function') {
            try { window.__commandRegistry[cmdName](msg); } catch (e) { try { _webviewLog('warn', 'commandRegistry handler error', e); } catch (err) {} }
            return;
        }
        // Fallback: if no registry entry found by mapped name, try legacy direct lookup using msg.type
        if (msg && msg.type && window.__commandRegistry && typeof window.__commandRegistry[msg.type] === 'function') {
            try { window.__commandRegistry[msg.type](msg); } catch (e) { try { _webviewLog('warn', 'commandRegistry handler error (legacy)', e); } catch (err) {} }
            return;
        }
    } catch (e) { /* swallow dispatch errors and fall back to legacy handling below */ }
    // Legacy inline handlers have been moved to modular handler files under
    // resources/webview/handlers and are registered via the command registry.
    // If a message reaches this point it is unhandled by the registry and may
    // represent a rare legacy case. For now, just log it for debugging.
    try {
    try { _webviewLog('debug', '[codebase-digest][webview] unhandled message type:', msg && msg.type); } catch (e) {}
    } catch (e) {}
});

function renderPreviewDelta(delta) {
    try {
        const r = (typeof window !== 'undefined' && window.__UI_RENDERER__);
        if (r && typeof r.renderPreviewDelta === 'function') { try { r.renderPreviewDelta(delta); return; } catch (e) { logWarn('uiRenderer.renderPreviewDelta failed', e); } }
    } catch (e) {}
    // Fallback to legacy implementation when uiRenderer not present or fails
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
    try {
        const r = (typeof window !== 'undefined' && window.__UI_RENDERER__);
        if (r && typeof r.renderProgress === 'function') { try { r.renderProgress(e); return; } catch (ex) { logWarn('uiRenderer.renderProgress failed', ex); } }
    } catch (ex) {}
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
    try { var __cbd_bar_to = setTimeout(() => { try { bar.style.width = '0%'; } finally { _unregisterTimerHandle(__cbd_bar_to); } }, 600); _registerTimerHandle(__cbd_bar_to); if (__cbd_bar_to && typeof __cbd_bar_to.unref === 'function') { try { __cbd_bar_to.unref(); } catch (e) {} } } catch (e) {}
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
    try {
        const r = (typeof window !== 'undefined' && window.__UI_RENDERER__);
        if (r && typeof r.updatePauseButton === 'function') { try { r.updatePauseButton(paused); return; } catch (ex) { logWarn('uiRenderer.updatePauseButton failed', ex); } }
    } catch (ex) {}
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
    try {
        const r = (typeof window !== 'undefined' && window.__UI_RENDERER__);
        if (r && typeof r.renderScanStats === 'function') { try { r.renderScanStats(e); return; } catch (err) { logWarn('uiRenderer.renderScanStats failed', err); } }
    } catch (err) { /* swallow */ }
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
    try {
        const r = (typeof window !== 'undefined' && window.__UI_RENDERER__);
        if (r && typeof r.showToast === 'function') { try { r.showToast(msg, kind, ttl); return; } catch (ex) { logWarn('uiRenderer.showToast failed', ex); } }
    } catch (ex) {}
    const root = document.getElementById('toast-root');
    if (!root) { return; }
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    const m = document.createElement('div'); m.className = 'msg'; m.textContent = msg; t.appendChild(m);
    root.appendChild(t);
    try { var __cbd_toa = setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(6px)'; _unregisterTimerHandle(__cbd_toa); }, ttl - 300); _registerTimerHandle(__cbd_toa); if (__cbd_toa && typeof __cbd_toa.unref === 'function') { try { __cbd_toa.unref(); } catch (e) {} } } catch (e) {}
    try { var __cbd_tob = setTimeout(() => { try { t.remove(); } finally { _unregisterTimerHandle(__cbd_tob); } }, ttl); _registerTimerHandle(__cbd_tob); if (__cbd_tob && typeof __cbd_tob.unref === 'function') { try { __cbd_tob.unref(); } catch (e) {} } } catch (e) {}
}

// Request initial state
window.onload = function() {
    try { try { _webviewLog('debug', '[codebase-digest][webview] window.onload: requesting state'); } catch (e) {} } catch (e) {}
    vscode.postMessage({ type: 'getState' });
    // If no state arrives quickly (race with host), retry a couple of times to ensure provider responds
    let retries = 0;
    const retryGetState = () => {
        try {
            retries += 1;
            if (retries > 5) { return; }
            try { try { _webviewLog('debug', '[codebase-digest][webview] retrying getState attempt', retries); } catch (e) {} } catch (e) {}
            vscode.postMessage({ type: 'getState' });
            try { var __cbd_retry_inner_to = setTimeout(retryGetState, 400 * retries); _registerTimerHandle(__cbd_retry_inner_to); if (__cbd_retry_inner_to && typeof __cbd_retry_inner_to.unref === 'function') { try { __cbd_retry_inner_to.unref(); } catch (e) {} } } catch (e) {}
        } catch (e) { /* swallow */ }
    };
    var __cbd_retry_to = setTimeout(() => { try { retryGetState(); } finally { _unregisterTimerHandle(__cbd_retry_to); } }, 300); _registerTimerHandle(__cbd_retry_to); if (__cbd_retry_to && typeof __cbd_retry_to.unref === 'function') { try { __cbd_retry_to.unref(); } catch (e) {} }
    // Populate node cache for frequently used elements. When a centralized
    // uiRenderer is present we prefer it and avoid duplicating DOM wiring here.
    try {
        const hasRenderer = (typeof window !== 'undefined' && window.__UI_RENDERER__);
        if (!hasRenderer) {
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
        }
    } catch (e) { /* ignore cache wiring errors */ }

    // Sidebar button wiring: explicit listeners for common top-level actions
    try {
        const btnRefresh = document.getElementById('btn-refresh');
        if (btnRefresh) {
            btnRefresh.addEventListener('click', (ev) => {
                try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
                // Use postAction so payload is sanitized and includes folderPath
                try { postAction('refresh'); } catch (e) { try { _webviewLog('warn', 'btn-refresh postAction failed', e); } catch (err) {} }
            });
        }

        // Primary generate button (may appear in multiple places); prefer data-action selector
        const genBtn = document.querySelector('[data-action="generateDigest"]');
        if (genBtn) {
            genBtn.addEventListener('click', (ev) => {
                try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
                const payload = {};
                if (overrideDisableRedaction) {
                    payload.overrides = { showRedacted: true };
                    pendingOverrideUsed = true;
                }
                try { postAction('generateDigest', payload); } catch (e) { try { _webviewLog('warn', 'generateDigest postAction failed', e); } catch (err) {} }
            });
        }
        // Toolbar controls are handled by the delegated data-action listeners below.
        // Prefer centralized data-action handling which uses store-first operations and
        // uiRenderer when available. Retain this lightweight comment as guidance.
    } catch (e) { /* swallow wiring errors */ }

    // Attach light-weight interaction listeners to detect when the user is manipulating
    // the file list. Use capture-phase pointer events so we catch interactions early
    // before the label/checkbox default behaviours occur.
    try {
        const listRoot = nodes.fileListRoot || document.getElementById('file-list');
        const markInteraction = () => {
            try {
                userInteracting = true;
                if (interactionTimeout) { try { clearTimeout(interactionTimeout); } catch (e) {} try { _unregisterTimerHandle(interactionTimeout); } catch (e) {} interactionTimeout = null; }
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
                _registerTimerHandle(interactionTimeout);
                try { if (interactionTimeout && typeof interactionTimeout.unref === 'function') { try { interactionTimeout.unref(); } catch (e) {} } } catch (e) {}
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
                // Prefer renderer-provided applyPreset to centralize DOM updates and keep
                // a single UI mutation surface. If the renderer doesn't expose it, fall
                // back to the existing optimistic UI and local apply logic.
                try {
                    const r = (typeof window !== 'undefined' && window.__UI_RENDERER__);
                    if (r && typeof r.applyPreset === 'function') {
                        try { r.applyPreset(preset); } catch (err) { logWarn('uiRenderer.applyPreset failed', err); }
                        // Notify host so it can persist/apply the preset globally
                        sendCmd('applyPreset', { preset });
                        return;
                    }
                } catch (e) { /* swallow renderer probe errors */ }

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

            // Select all / clear selection operate on the rendered tree DOM (prefer store)
            if (action === 'selectAll' || action === 'clearSelection') {
                const shouldSelect = action === 'selectAll';
                try {
                    // Prefer a renderer-provided action to centralize DOM updates
                    const r = (typeof window !== 'undefined' && window.__UI_RENDERER__);
                    if (r && typeof r[shouldSelect ? 'selectAll' : 'clearSelection'] === 'function') {
                        try { r[shouldSelect ? 'selectAll' : 'clearSelection'](); return; } catch (err) { logWarn('uiRenderer selectAll/clearSelection failed', err); }
                    }
                    // Prefer store-backed operations: compute selection from store.fileTree when possible
                    const st = store.getState ? store.getState() : null;
                    if (shouldSelect && st && st.fileTree) {
                        try {
                            const all = collectLeaves(st.fileTree);
                            try { store.setSelection && store.setSelection(all); } catch (e) {}
                            postAction('setSelection', { relPaths: all });
                            return;
                        } catch (e) { /* fallback to DOM */ }
                    }
                    // Clear selection via store when possible
                    if (!shouldSelect) {
                        try { store.clearSelection && store.clearSelection(); } catch (e) {}
                        postAction('setSelection', { relPaths: [] });
                        return;
                    }
                    // Fallback: compute list via DOM traversal (legacy behaviour)
                    const fileCheckboxes = document.querySelectorAll('#file-list li.file-item .file-checkbox');
                    const filePaths = Array.from(fileCheckboxes).map(cb => {
                        try { const a = cb.getAttribute && cb.getAttribute('data-path'); return a ? decodeFromDataAttribute(a) : null; } catch (e) { return null; }
                    }).filter(Boolean);
                    try { store.setSelection && store.setSelection(filePaths); } catch (e) {}
                    postAction('setSelection', { relPaths: filePaths });
                } catch (e) { /* swallow DOM errors */ }
                return;
            }
            // Expand/Collapse all operate on the rendered tree DOM immediately for instant feedback (prefer store)
            if (action === 'expandAll' || action === 'collapseAll') {
                const shouldExpand = action === 'expandAll';
                try {
                    // Prefer a renderer method to centralize the expand/collapse DOM changes
                    const r = (typeof window !== 'undefined' && window.__UI_RENDERER__);
                    if (r && typeof r[shouldExpand ? 'expandAll' : 'collapseAll'] === 'function') {
                        try { r[shouldExpand ? 'expandAll' : 'collapseAll'](); return; } catch (err) { logWarn('uiRenderer expandAll/collapseAll failed', err); }
                    }
                    // Prefer to compute expanded paths from the store's fileTree
                    const st = store.getState ? store.getState() : null;
                    if (st && st.fileTree) {
                        const allFolders = [];
                        // gather folder paths by walking the tree
                        function walkFolders(node, prefix = '') {
                            for (const k of Object.keys(node || {})) {
                                const n = node[k];
                                const rel = n && n.relPath ? n.relPath : (n && n.path ? n.path : `${prefix}${k}`);
                                if (n && n.__isFile) { continue; }
                                allFolders.push(rel);
                                walkFolders(n, `${rel}/`);
                            }
                        }
                        walkFolders(st.fileTree, '');
                        try {
                            if (shouldExpand) { allFolders.forEach(p => expandedSet.add(p)); }
                            else { allFolders.forEach(p => expandedSet.delete(p)); }
                            try { store.setExpandedPaths && store.setExpandedPaths(Array.from(expandedSet)); } catch (e) {}
                        } catch (e) {}
                    } else {
                        // Fallback: operate on the DOM
                        const folderItems = document.querySelectorAll('#file-list li.folder-item');
                        folderItems.forEach(fi => {
                            try {
                                const pathAttr = fi.getAttribute && fi.getAttribute('data-path');
                                const decodedPath = pathAttr ? decodeFromDataAttribute(pathAttr) : null;
                                if (shouldExpand) { fi.classList.add('expanded'); if (decodedPath) { expandedSet.add(decodedPath); } }
                                else { fi.classList.remove('expanded'); if (decodedPath) { expandedSet.delete(decodedPath); } }
                            } catch (e) { /* ignore per-node errors */ }
                        });
                        try { store.setExpandedPaths && store.setExpandedPaths(Array.from(expandedSet)); } catch (e) {}
                    }
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
                try { var __cbd_settings_focus_to = setTimeout(() => { const first = settingsEl && settingsEl.querySelector ? settingsEl.querySelector('input,select,textarea,button') : null; if (first && typeof first.focus === 'function') { first.focus(); } }, 0); if (__cbd_settings_focus_to && typeof __cbd_settings_focus_to.unref === 'function') { try { __cbd_settings_focus_to.unref(); } catch (e) {} } } catch (e) {}
                return;
            }
            if (action === 'ingestRemote') {
                const m = document.getElementById('ingestModal');
                if (m) { openModal(m); }
                try { var __cbd_ingest_focus_to = setTimeout(() => { const repo = document.getElementById('ingest-repo'); if (repo && typeof repo.focus === 'function') { repo.focus(); } }, 0); if (__cbd_ingest_focus_to && typeof __cbd_ingest_focus_to.unref === 'function') { try { __cbd_ingest_focus_to.unref(); } catch (e) {} } } catch (e) {}
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
                try { var __cbd_ingest_focus_to2 = setTimeout(() => { const repo = document.getElementById('ingest-repo'); if (repo && typeof repo.focus === 'function') { repo.focus(); } }, 0); if (__cbd_ingest_focus_to2 && typeof __cbd_ingest_focus_to2.unref === 'function') { try { __cbd_ingest_focus_to2.unref(); } catch (e) {} } } catch (e) {}
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
                try { var __cbd_settings_focus_to2 = setTimeout(() => { const first = settingsEl && settingsEl.querySelector ? settingsEl.querySelector('input,select,textarea,button') : null; if (first && typeof first.focus === 'function') { first.focus(); } }, 0); if (__cbd_settings_focus_to2 && typeof __cbd_settings_focus_to2.unref === 'function') { try { __cbd_settings_focus_to2.unref(); } catch (e) {} } } catch (e) {}
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
    // Preset popup wiring: prefer uiRenderer when available (it wires menu behaviors)
    try {
        const r = (typeof window !== 'undefined' && window.__UI_RENDERER__);
        // If the renderer exposes a preset wiring helper, prefer it so the UI
        // behavior is centralized. Otherwise, fall back to the inline wiring.
        if (r && typeof r.wirePresetMenu === 'function') {
            try { r.wirePresetMenu(); }
            catch (err) { logWarn('uiRenderer.wirePresetMenu failed', err); }
        } else {
            // Toggle handlers for the preset menu button and menu items (fallback)
            const presetBtn = document.getElementById('preset-btn');
            const presetMenu = document.getElementById('preset-menu');
            function openPresetMenu() {
                if (!presetBtn || !presetMenu) { return; }
                presetBtn.setAttribute('aria-expanded', 'true');
                presetMenu.removeAttribute('hidden');
                presetMenu.setAttribute('aria-hidden', 'false');
                const first = presetMenu.querySelector('[role="option"]');
                if (first) { try { first.setAttribute('tabindex', '0'); first.focus(); } catch (e) {} }
                var __cbd_preset_click_to = setTimeout(() => { try { window.addEventListener('click', onWindowClickForPreset); } finally { _unregisterTimerHandle(__cbd_preset_click_to); } }, 0); _registerTimerHandle(__cbd_preset_click_to); if (__cbd_preset_click_to && typeof __cbd_preset_click_to.unref === 'function') { try { __cbd_preset_click_to.unref(); } catch (e) {} }
            }
            function closePresetMenu() {
                if (!presetBtn || !presetMenu) { return; }
                presetBtn.setAttribute('aria-expanded', 'false');
                presetMenu.setAttribute('aria-hidden', 'true');
                presetMenu.setAttribute('hidden', '');
                window.removeEventListener('click', onWindowClickForPreset);
                try {
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
                nodes.presetBtn.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePresetMenu(); } });
            }
            if (nodes.presetMenu) {
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
                nodes.presetMenu.addEventListener('keydown', (ev) => {
                    const options = Array.from(nodes.presetMenu.querySelectorAll('[role="option"]'));
                    const current = ev.target && ev.target.closest ? ev.target.closest('[role="option"]') : null;
                    const idx = current ? options.indexOf(current) : -1;
                    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); if (current) { current.click(); } }
                    else if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') { ev.preventDefault(); const next = options[Math.min(options.length - 1, Math.max(0, idx + 1))]; if (next) { try { options.forEach(o => o.setAttribute('tabindex', '-1')); next.setAttribute('tabindex', '0'); next.focus(); } catch (e) {} } }
                    else if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') { ev.preventDefault(); const prev = options[Math.max(0, idx - 1)]; if (prev) { try { options.forEach(o => o.setAttribute('tabindex', '-1')); prev.setAttribute('tabindex', '0'); prev.focus(); } catch (e) {} } }
                    else if (ev.key === 'Escape') { closePresetMenu(); }
                });
            }
        }
    } catch (e) { /* swallow preset wiring errors */ }
    document.getElementById('ingest-cancel')?.addEventListener('click', () => { const m = document.getElementById('ingestModal'); if (m) { closeModal(m); } });
    // Helper to update ingest preview UI; prefers uiRenderer when present and falls back to local DOM updates
    function setIngestPreviewState({ loading = false, text = null } = {}) {
        try {
            const r = (typeof window !== 'undefined' && window.__UI_RENDERER__);
            if (r && typeof r.setIngestPreviewState === 'function') { try { r.setIngestPreviewState({ loading, text }); return; } catch (e) { /* fallthrough */ } }
        } catch (e) {}
        try {
            if (loading) {
                if (nodes.ingestPreviewRoot) { nodes.ingestPreviewRoot.classList.add('loading'); }
                if (nodes.ingestSpinner) { nodes.ingestSpinner.hidden = false; nodes.ingestSpinner.removeAttribute('aria-hidden'); }
                if (nodes.ingestPreviewText && typeof text === 'string') { nodes.ingestPreviewText.textContent = text; nodes.ingestPreviewText.classList.add('loading-placeholder'); }
            } else {
                if (nodes.ingestPreviewRoot) { nodes.ingestPreviewRoot.classList.remove('loading'); }
                if (nodes.ingestSpinner) { nodes.ingestSpinner.hidden = true; nodes.ingestSpinner.setAttribute('aria-hidden', 'true'); }
                if (nodes.ingestPreviewText && typeof text === 'string') { nodes.ingestPreviewText.textContent = text; nodes.ingestPreviewText.classList.remove('loading-placeholder'); }
            }
        } catch (e) { /* swallow UI errors */ }
    }
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
    // show cloning state (delegate to renderer when available)
    setIngestPreviewState({ loading: true, text: 'Cloning repository...' });
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
            // set loading state (delegate to renderer when available)
            setIngestPreviewState({ loading: true, text: 'Starting ingest...' });
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

        // Forward selection events emitted by the uiRenderer to the host
        try {
            window.addEventListener('cbd:setSelection', (ev) => {
                try {
                    const detail = ev && ev.detail ? ev.detail : null;
                    if (!detail || !Array.isArray(detail.relPaths)) { return; }
                    postAction('setSelection', { relPaths: detail.relPaths });
                } catch (e) { /* swallow */ }
            });
        } catch (e) { /* swallow */ }
};

function populateSettings(settings) {
    try {
        const r = (typeof window !== 'undefined' && window.__UI_RENDERER__);
        if (r && typeof r.populateSettings === 'function') { try { r.populateSettings(settings); return; } catch (e) { /* fallthrough to local impl */ } }
    } catch (e) {}
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
        const r = (typeof window !== 'undefined' && window.__UI_RENDERER__);
        if (r && typeof r.togglePresetSelectionUI === 'function') { try { r.togglePresetSelectionUI(presetName); return; } catch (e) { /* fallthrough */ } }
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
    try {
        const r = (typeof window !== 'undefined' && window.__UI_RENDERER__);
        if (r && typeof r.populateRedactionFields === 'function') { try { r.populateRedactionFields(settings); return; } catch (e) { /* fallthrough */ } }
    } catch (e) {}
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
