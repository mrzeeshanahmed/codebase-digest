;(function () {
  'use strict';
  if (typeof window === 'undefined') { return; }

  // Guard until store is present
  function ensureStore() {
    return (window.store && typeof window.store.getState === 'function' && typeof window.store.subscribe === 'function') ? window.store : null;
  }

  function safe(fn) { return function () { try { return fn.apply(null, arguments); } catch (e) { console.warn('subscriber safe handler error', e); } }; }

  // Subscribe once store exists; if not present yet, poll briefly
  function init() {
    const s = ensureStore();
    if (!s) { setTimeout(init, 120); return; }

    // Keep last seen values to diff changes
    let last = Object.assign({}, s.getState());

    s.subscribe(safe((st) => {
      try {
        // fileTree / aligned / selectedPaths -> renderTree
        if (st.fileTree !== last.fileTree || st.selectedPaths !== last.selectedPaths || st.aligned !== last.aligned) {
          try { if (typeof renderTree === 'function') { renderTree((st && st.aligned) || st, typeof expandedSet !== 'undefined' ? expandedSet : null); } } catch (e) {}
        }

        // previewDelta -> renderPreviewDelta
        if (st.previewDelta !== last.previewDelta) {
          try { if (typeof renderPreviewDelta === 'function') { renderPreviewDelta(st.previewDelta); } } catch (e) {}
        }

        // preview -> ingest preview area
        if (st.preview !== last.preview) {
          try {
            const payload = st.preview || {};
            const previewRoot = (typeof nodes !== 'undefined' && nodes.ingestPreviewRoot) ? nodes.ingestPreviewRoot : document.getElementById('ingest-preview');
            const textEl = (typeof nodes !== 'undefined' && nodes.ingestPreviewText) ? nodes.ingestPreviewText : document.getElementById('ingest-preview-text');
            const spinner = (typeof nodes !== 'undefined' && nodes.ingestSpinner) ? nodes.ingestSpinner : document.getElementById('ingest-spinner');
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

        // errors -> show toasts
        if (st.errors !== last.errors) {
          try {
            const errs = Array.isArray(st.errors) ? st.errors.slice() : [];
            errs.forEach(err => { try { showToast && showToast(String(err), 'error', 6000); } catch (e) {} });
          } catch (e) {}
        }

        // loading -> progress UI updates
        if (st.loading !== last.loading) {
          try {
            const load = st.loading || {};
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
          } catch (e) {}
        }

        // loadedRepoTmpPath -> ingest modal buttons
        if (st.loadedRepoTmpPath !== last.loadedRepoTmpPath) {
          try {
            const tmp = st.loadedRepoTmpPath || null;
            if (tmp) {
              try { const textEl = nodes.ingestPreviewText || document.getElementById('ingest-preview-text'); if (textEl) { textEl.textContent = `Repository loaded: ${String(tmp)}`; } } catch (e) {}
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
