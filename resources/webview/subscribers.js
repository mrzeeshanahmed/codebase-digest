;(function () {
  'use strict';
  if (typeof window === 'undefined') { return; }
  // Ensure the common lifecycle tracker exists so subscribers can register timers/observers
  try {
    if (!window.__cbd_lifecycle) {
      (function lifecycleTracker(){
        try {
          const timers = new Set();
          const observers = new Set();
          const registerTimer = (t) => { try { if (t) { timers.add(t); } } catch (e) {} };
          const unregisterTimer = (t) => { try { if (t) { timers.delete(t); } } catch (e) {} };
          const registerObserver = (o) => { try { if (o) { observers.add(o); } } catch (e) {} };
          const unregisterObserver = (o) => { try { if (o) { observers.delete(o); } } catch (e) {} };
          const cleanup = () => {
            try { for (const t of Array.from(timers)) { try { clearTimeout(t); } catch (e) {} try { clearInterval(t); } catch (e) {} try { if (typeof t.unref === 'function') { t.unref(); } } catch (e) {} } } catch (e) {}
            try { for (const o of Array.from(observers)) { try { if (o && typeof o.disconnect === 'function') { o.disconnect(); } } catch (e) {} } } catch (e) {}
            try { timers.clear(); observers.clear(); } catch (e) {}
          };
          window.__cbd_lifecycle = Object.assign({}, { registerTimer, unregisterTimer, registerObserver, unregisterObserver, cleanup });
          try { window.addEventListener && window.addEventListener('unload', cleanup); } catch (e) {}
        } catch (e) {}
      })();
    }
  } catch (e) {}

  // Helpers to register/unregister timers and observers with lifecycle tracker
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
  function _registerObserver(o) {
    try {
      if (typeof window !== 'undefined' && window.__cbd_lifecycle && typeof window.__cbd_lifecycle.registerObserver === 'function') {
        window.__cbd_lifecycle.registerObserver(o);
      }
    } catch (e) {}
  }
  function _unregisterObserver(o) {
    try {
      if (typeof window !== 'undefined' && window.__cbd_lifecycle && typeof window.__cbd_lifecycle.unregisterObserver === 'function') {
        window.__cbd_lifecycle.unregisterObserver(o);
      }
    } catch (e) {}
  }

  // Guard until store is present
  function ensureStore() {
    return (window.store && typeof window.store.getState === 'function' && typeof window.store.subscribe === 'function') ? window.store : null;
  }

  function safe(fn) { return function () { try { return fn.apply(null, arguments); } catch (e) { console.warn('subscriber safe handler error', e); } }; }

  // Render helper: prefer centralized `window.__UI_RENDERER__` when present.
  // If not available, fall back to a minimal, safe DOM renderer.
  function renderSidebarFromTreeData(treeData, selectedPaths) {
    try {
      // If a central uiRenderer exists, delegate entirely to it.
      if (typeof window !== 'undefined' && window.__UI_RENDERER__ && typeof window.__UI_RENDERER__.renderFileList === 'function') {
        try {
          const state = { fileTree: treeData, selectedPaths: Array.isArray(selectedPaths) ? selectedPaths.slice() : [] };
          return window.__UI_RENDERER__.renderFileList(state);
        } catch (e) { /* fallthrough to fallback below */ }
      }

      // Minimal fallback: safe, DOM-light rendering
      const fileListRoot = (typeof document !== 'undefined') ? document.getElementById('file-list') : null;
      if (!fileListRoot) { return; }
      const isEmpty = !treeData || (typeof treeData === 'object' && Object.keys(treeData).length === 0);
      if (isEmpty) {
        while (fileListRoot.firstChild) { fileListRoot.removeChild(fileListRoot.firstChild); }
        const msg = document.createElement('div');
        msg.className = 'file-row-message';
        msg.textContent = 'No files to display.';
        fileListRoot.appendChild(msg);
        return;
      }

      while (fileListRoot.firstChild) { fileListRoot.removeChild(fileListRoot.firstChild); }
      const stack = [{ node: treeData, prefix: '' }];
      while (stack.length) {
        const item = stack.pop();
        const node = item.node || {};
        const prefix = item.prefix || '';
        for (const k of Object.keys(node).sort()) {
          const n = node[k];
          const relPath = (n && n.relPath) || (n && n.path) || (prefix + k);
          if (n && n.__isFile) {
            const li = document.createElement('div');
            li.className = 'file-row file-item';
            li.textContent = relPath;
            if (Array.isArray(selectedPaths) && selectedPaths.indexOf(relPath) !== -1) { li.classList.add('selected'); }
            fileListRoot.appendChild(li);
          } else {
            stack.push({ node: n || {}, prefix: relPath + '/' });
          }
        }
      }
    } catch (e) { console.warn('renderSidebarFromTreeData failed', e); }
  }

  // Subscribe once store exists; if not present yet, poll briefly
  function init() {
    const s = ensureStore();
  if (!s) { var __to = setTimeout(init, 120); _registerTimerHandle(__to); if (__to && typeof __to.unref === 'function') { try { __to.unref(); } catch (e) {} } return; }

    // Keep last seen values to diff changes
    let last = Object.assign({}, s.getState());

    s.subscribe(safe((st) => {
      try {
        // fileTree / aligned / selectedPaths -> renderTree
        if (st.fileTree !== last.fileTree || st.selectedPaths !== last.selectedPaths || st.aligned !== last.aligned) {
          try { if (typeof renderTree === 'function') { renderTree((st && st.aligned) || st, typeof expandedSet !== 'undefined' ? expandedSet : null); } } catch (e) {}
        }

        // treeData -> render sidebar (host-provided serialized snapshot)
        if (st.treeData !== last.treeData) {
          try { renderSidebarFromTreeData(st.treeData, st.selectedPaths); } catch (e) { console.warn('treeData subscriber failed', e); }
        }

            // previewDelta -> renderPreviewDelta (let uiRenderer handle preview/progress if present)
            if (st.previewDelta !== last.previewDelta) {
              try {
                if (typeof window !== 'undefined' && window.__UI_RENDERER__ && typeof window.__UI_RENDERER__.renderPreviewDelta === 'function') {
                  try { window.__UI_RENDERER__.renderPreviewDelta(st.previewDelta); } catch (e) {}
                } else {
                  try { if (typeof renderPreviewDelta === 'function') { renderPreviewDelta(st.previewDelta); } } catch (e) {}
                }
              } catch (e) {}
            }

            // preview -> ingest preview area (defer to uiRenderer when present)
            if (st.preview !== last.preview) {
              try {
                if (typeof window !== 'undefined' && window.__UI_RENDERER__ && typeof window.__UI_RENDERER__.renderPreview === 'function') {
                  try { window.__UI_RENDERER__.renderPreview(st.preview); } catch (e) {}
                } else {
                  try {
                    const payload = st.preview || {};
                    const n = (typeof window !== 'undefined' && window.__CBD_NODES__) ? window.__CBD_NODES__ : null;
                    const previewRoot = (n && typeof n.getIngestPreviewRoot === 'function') ? n.getIngestPreviewRoot() : document.getElementById('ingest-preview');
                    const textEl = (n && typeof n.getIngestPreviewText === 'function') ? n.getIngestPreviewText() : document.getElementById('ingest-preview-text');
                    const spinner = (n && typeof n.getIngestSpinner === 'function') ? n.getIngestSpinner() : document.getElementById('ingest-spinner');
                    if (previewRoot) { try { previewRoot.classList.remove('loading'); } catch (e) {} }
                    if (spinner) { try { spinner.hidden = true; spinner.setAttribute('aria-hidden', 'true'); } catch (e) {} }
                    if (textEl) {
                      const p = payload && payload.preview;
                      if (p) { textEl.textContent = (p.summary || '') + '\n\n' + (p.tree || ''); }
                      else if (payload && payload.output) { textEl.textContent = String(payload.output).slice(0, 2000); }
                      else { textEl.textContent = 'No preview available'; }
                    }
                  } catch (e) {}
                }
              } catch (e) {}
            }

        // errors -> show toasts
        if (st.errors !== last.errors) {
          try {
            const errs = Array.isArray(st.errors) ? st.errors.slice() : [];
            errs.forEach(err => { try {
              if (typeof window !== 'undefined' && window.__UI_RENDERER__ && typeof window.__UI_RENDERER__.showToast === 'function') {
                window.__UI_RENDERER__.showToast(String(err), 'error', 6000);
              } else { showToast && showToast(String(err), 'error', 6000); }
            } catch (e) {} });
          } catch (e) {}
        }

        // loading -> progress UI updates
        if (st.loading !== last.loading) {
          try {
            const load = st.loading || {};
            if (typeof window !== 'undefined' && window.__UI_RENDERER__ && typeof window.__UI_RENDERER__.renderProgress === 'function') {
              try { window.__UI_RENDERER__.renderProgress(load); } catch (e) {}
            } else {
              // simple mapping: show/hide progress container
              const container = nodes.progressContainer || document.getElementById('progress-container');
              const bar = nodes.progressBar || document.getElementById('progress-bar');
              if (load && Object.keys(load).length > 0) {
                try { if (container) { container.classList.remove('hidden'); } } catch (e) {}
                // If percent present, update bar
                try { if (bar && typeof load.percent === 'number') { bar.style.width = (load.percent || 0) + '%'; bar.setAttribute('aria-valuenow', String(Math.round(load.percent || 0))); } } catch (e) {}
              } else {
                try { if (container) { container.classList.add('hidden'); } } catch (e) {}
              }
            }
          } catch (e) {}
        }

        // loadedRepoTmpPath -> ingest modal buttons
        if (st.loadedRepoTmpPath !== last.loadedRepoTmpPath) {
          try {
            const tmp = st.loadedRepoTmpPath || null;
            if (tmp) {
              try {
                if (typeof window !== 'undefined' && window.__UI_RENDERER__ && typeof window.__UI_RENDERER__.renderPreview === 'function') {
                  // Let uiRenderer handle the "repository loaded" message in preview area
                  try { window.__UI_RENDERER__.renderPreview({ preview: { summary: `Repository loaded: ${String(tmp)}` } }); } catch (e) {}
                } else {
                  try { const n = (typeof window !== 'undefined' && window.__CBD_NODES__) ? window.__CBD_NODES__ : null; const textEl = (n && typeof n.getIngestPreviewText === 'function') ? n.getIngestPreviewText() : document.getElementById('ingest-preview-text'); if (textEl) { textEl.textContent = `Repository loaded: ${String(tmp)}`; } } catch (e) {}
                }
              } catch (e) {}
              try { const loadBtn = document.getElementById('ingest-load-repo'); const startBtn = document.getElementById('ingest-submit'); if (loadBtn) { loadBtn.hidden = true; loadBtn.setAttribute('aria-hidden', 'true'); } if (startBtn) { startBtn.hidden = false; startBtn.removeAttribute('aria-hidden'); startBtn.focus && startBtn.focus(); } } catch (e) {}
            }
          } catch (e) {}
        }

        // generation result -> show toast or errors
        if (st.lastGenerationResult !== last.lastGenerationResult) {
          try {
            const res = st.lastGenerationResult || {};
            if (res.redactionApplied) { try { showToast && showToast('Output contained redacted content (masked). Toggle "Show redacted" in Settings to reveal.', 'warn', 6000); } catch (e) {} }
            if (res && res.error) { try { showToast && showToast(String(res.error), 'warn', 6000); } catch (e) {} }
          } catch (e) {}
        }

        // pending persisted selection: if present and tree has files, post selection
        try {
          const pending = st.pendingPersistedSelection || null;
          const idx = typeof st.pendingPersistedFocusIndex !== 'undefined' ? st.pendingPersistedFocusIndex : undefined;
          const totalFiles = (st.totalFiles || 0) || (Array.isArray(st.selectedPaths) ? st.selectedPaths.length : 0);
          if (pending && pending.length > 0 && totalFiles > 0) {
            try { postAction('setSelection', { relPaths: pending }); } catch (e) {}
            try { vscode.postMessage && vscode.postMessage(sanitizePayload({ type: 'persistState', state: { selectedFiles: pending, focusIndex: idx } })); } catch (e) {}
            try { window.store && window.store.setPendingPersistedSelection && window.store.setPendingPersistedSelection(null, undefined); } catch (e) {}
          }
        } catch (e) {}

        // snapshot last
        last = Object.assign({}, st);
      } catch (e) { console.warn('store subscriber encountered error', e); }
    }));
  }

  init();
})();
