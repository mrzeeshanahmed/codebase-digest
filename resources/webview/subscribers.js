;(function () {
  'use strict';
  if (typeof window === 'undefined') { return; }

  // Guard until store is present
  function ensureStore() {
    return (window.store && typeof window.store.getState === 'function' && typeof window.store.subscribe === 'function') ? window.store : null;
  }

  function safe(fn) { return function () { try { return fn.apply(null, arguments); } catch (e) { console.warn('subscriber safe handler error', e); } }; }

  // Render helper: given a serialized tree payload from the host, render the
  // sidebar. Prefer using the global renderTree helper when available so
  // DOM building stays centralized; otherwise perform a minimal fallback.
  function renderSidebarFromTreeData(treeData, selectedPaths) {
    try {
      const fileListRoot = document.getElementById('file-list');
      // If there's no root element, nothing to render
      if (!fileListRoot) { return; }
      // If no tree data or empty, show friendly empty message
      const isEmpty = !treeData || (typeof treeData === 'object' && Object.keys(treeData).length === 0);
      if (isEmpty) {
        while (fileListRoot.firstChild) { fileListRoot.removeChild(fileListRoot.firstChild); }
        const msg = document.createElement('div');
        msg.className = 'file-row-message';
        msg.textContent = 'No files to display.';
        fileListRoot.appendChild(msg);
        return;
      }

      // If the main webview exposes renderTree, delegate to it so we keep one
      // canonical tree rendering implementation.
      if (typeof renderTree === 'function') {
        try {
          const state = { fileTree: treeData, selectedPaths: Array.isArray(selectedPaths) ? selectedPaths.slice() : [] };
          // expandedSet is maintained by the main UI; pass through if present
          return renderTree(state, (typeof expandedSet !== 'undefined') ? expandedSet : null);
        } catch (e) { /* fallthrough to fallback rendering */ }
      }

      // Fallback naive renderer: build a simple flat list of leaves for minimal UX
      try {
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
              // push children to stack with updated prefix
              stack.push({ node: n || {}, prefix: relPath + '/' });
            }
          }
        }
      } catch (e) { console.warn('fallback sidebar render failed', e); }
    } catch (e) { console.warn('renderSidebarFromTreeData failed', e); }
  }

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

        // treeData -> render sidebar (host-provided serialized snapshot)
        if (st.treeData !== last.treeData) {
          try { renderSidebarFromTreeData(st.treeData, st.selectedPaths); } catch (e) { console.warn('treeData subscriber failed', e); }
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
                if (res && res.error) {
                    try { showToast && showToast(String(res.error), 'warn', 6000); } catch (e) {}
                } else if (res && res.success && res.result) {
                    const resultsContainer = document.getElementById('results-container');
                    const resultsContent = document.getElementById('results-content');
                    if (resultsContainer && resultsContent) {
                        resultsContent.textContent = res.result;
                        resultsContainer.hidden = false;
                        const dashboard = document.getElementById('dashboard');
                        if (dashboard) {
                            dashboard.hidden = true;
                        }
                    }
                }
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

    // Progress handling
    const progressContainer = () => (typeof nodes !== 'undefined' && nodes.progressContainer) || document.getElementById('progress-container');
    const progressBar = () => (typeof nodes !== 'undefined' && nodes.progressBar) || document.getElementById('progress-bar');

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
            try { if (e.op === 'write') { const cw = (typeof nodes !== 'undefined' && nodes.cancelWriteBtn) || document.getElementById('btn-cancel-write'); if (cw) { cw.hidden = false; cw.removeAttribute('aria-hidden'); } } } catch (ex) {}
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
            try { if (e.op === 'write') { const cw = (typeof nodes !== 'undefined' && nodes.cancelWriteBtn) || document.getElementById('btn-cancel-write'); if (cw) { cw.hidden = true; cw.setAttribute('aria-hidden', 'true'); } } } catch (ex) {}
        }
        // Clear busy when no longer active (end or if determinate but percent at 100)
        try {
            if (e.mode === 'end' || (e.determinate && Number(e.percent) === 100)) { const c = progressContainer(); if (c) { c.setAttribute('aria-busy', 'false'); } }
        } catch (ex) {}
    }

    let lastProgress = null;
    ensureStore().subscribe((st) => {
        if (st.progress && st.progress !== lastProgress) {
            handleProgress(st.progress);
            lastProgress = st.progress;
        }
    });

})();
