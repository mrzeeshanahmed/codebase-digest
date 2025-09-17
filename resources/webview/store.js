// Small Zustand-like store for the Codebase Digest webview.
// Exposes a simple API: getState(), setState(patch), subscribe(cb) plus action helpers.
// Designed to be used directly in the webview via a <script> load before main.js,
// or via bundler requiring `./store.js`.

(function () {
  'use strict';

  function createStore(initializer) {
    let state = {};
    const listeners = new Set();

    function notify() {
      for (const l of Array.from(listeners)) {
        try { l(state); } catch (err) { console && console.warn && console.warn('store subscriber error', err); }
      }
    }

    function set(partial) {
      let next;
      if (typeof partial === 'function') {
        // Merge the partial state returned by updater with the current state
        // to avoid unintentionally discarding other keys when handlers
        // use the functional form like `set(() => ({ previewDelta: d }))`.
        try {
          const patch = partial(state) || {};
          next = Object.assign({}, state, patch);
        } catch (err) {
          // If the updater throws, keep the previous state
          next = state;
          throw err;
        }
      } else {
        next = Object.assign({}, state, partial);
      }
      state = next;
      notify();
      return state;
    }

    function get() { return state; }

    function subscribe(cb) {
      listeners.add(cb);
      // return unsubscribe
      return function () { listeners.delete(cb); };
    }

    const api = initializer(set, get);

    return Object.assign(api || {}, {
      setState: set,
      getState: get,
      subscribe
    });
  }

  function collectLeaves(tree) {
    const out = [];

    function walk(node, pathPrefix = '') {
      if (!node || typeof node !== 'object') { return; }
      for (const key of Object.keys(node)) {
        const n = node[key];
        const path = n && n.path ? n.path : (pathPrefix ? `${pathPrefix}/${key}` : key);
        if (n && n.__isFile) { out.push(path); }
        else { walk(n, path); }
      }
    }

    walk(tree, '');
    return out;
  }

  const store = createStore((set, get) => ({
    // State
    fileTree: {},
    treeData: null,
    selectedPaths: [],
    expandedPaths: [],
    paused: false,
    pendingPersistedSelection: null,
    pendingPersistedFocusIndex: undefined,

    ingestPreview: null,
    previewDelta: null,
    previewState: null,

    toasts: [],
    errors: [],
    loading: {},

    // Actions
    setFileTree: (tree, selectedPaths) => set(() => ({
      fileTree: tree || {},
      selectedPaths: Array.isArray(selectedPaths) ? selectedPaths.slice() : get().selectedPaths || []
    })),

    // Update the tree data used by the sidebar; keep it separate from fileTree
    // so we can manage a compact serializable representation if needed.
    setTreeData: (data) => set(() => ({ treeData: typeof data === 'undefined' ? null : data })),

    setSelection: (paths) => set(() => ({ selectedPaths: Array.isArray(paths) ? paths.slice() : [] })),

    clearSelection: () => set(() => ({ selectedPaths: [] })),

    selectAllFiles: () => set((s) => ({ selectedPaths: collectLeaves(s.fileTree) })),

    togglePause: (p) => set(() => ({ paused: typeof p === 'undefined' ? !get().paused : !!p })),

    setExpandedPaths: (arr) => set(() => ({ expandedPaths: Array.isArray(arr) ? arr.slice() : [] })),

    setPendingPersistedSelection: (sel, idx) => set(() => ({ pendingPersistedSelection: sel || null, pendingPersistedFocusIndex: typeof idx === 'number' ? idx : undefined })),

    setPreview: (previewObj) => set(() => ({ ingestPreview: previewObj })),

    setPreviewDelta: (delta) => set(() => ({ previewDelta: delta })),

    setPreviewState: (stateObj) => set(() => ({ previewState: stateObj })),

    addToast: (toast) => set((s) => {
      const id = Date.now() + Math.floor(Math.random() * 1000);
      const t = Object.assign({ id }, toast);
      return { toasts: (s.toasts || []).concat(t) };
    }),

    removeToast: (id) => set((s) => ({ toasts: (s.toasts || []).filter(t => t.id !== id) })),

    addError: (msg) => set((s) => ({ errors: (s.errors || []).concat(String(msg)) })),

    clearErrors: () => set(() => ({ errors: [] })),

    setLoading: (key, val) => set((s) => ({ loading: Object.assign({}, s.loading || {}, { [key]: !!val }) }))
  }));

  // Expose as CommonJS/ES module if available
  try {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = store;
    }
  } catch (e) { /* ignore */ }

  // Also attach to window for webview scripts
  try {
    if (typeof window !== 'undefined') {
      window.store = store;
      window.__CBD_STORE__ = store; // friendly debug alias
    }
  } catch (e) { /* ignore */ }

})();
