;(function () {
  'use strict';
  if (typeof window === 'undefined') { return; }

  var remoteRepoLoadedHandler = function (msg) {
    try {
      const payload = msg && msg.payload ? msg.payload : {};
      const tmp = payload.tmpPath || null;
      // Push into store so subscribers can update ingest modal/UI
      try { if (window.store && typeof window.store.setState === 'function') { window.store.setState({ loadedRepoTmpPath: tmp }); } } catch (e) { console.warn('remoteRepoLoadedHandler: store.setState failed', e); }

      if (tmp && window) {
        try { window.loadedRepoTmpPath = tmp; } catch (e) {}
        try {
          const textEl = (typeof nodes !== 'undefined' && nodes.ingestPreviewText) ? nodes.ingestPreviewText : document.getElementById('ingest-preview-text');
          if (textEl) { textEl.textContent = `Repository loaded: ${String(tmp)}`; }
          const loadBtn = document.getElementById('ingest-load-repo');
          const startBtn = document.getElementById('ingest-submit');
          try { if (loadBtn) { loadBtn.hidden = true; loadBtn.setAttribute('aria-hidden', 'true'); } } catch (e) {}
          try { if (startBtn) { startBtn.hidden = false; startBtn.removeAttribute('aria-hidden'); startBtn.focus(); } } catch (e) {}
        } catch (e) { console.warn('remoteRepoLoaded DOM updates failed', e); }
      } else {
        if (typeof showToast === 'function') { showToast('Failed to load repository', 'error'); }
      }
    } catch (e) { console.warn('remoteRepoLoadedHandler error', e); }
  };

  if (typeof window.__registerHandler === 'function') { try { window.__registerHandler('remoteRepoLoaded', remoteRepoLoadedHandler); } catch (e) {} }
  try { if (!window.__registeredHandlers) { window.__registeredHandlers = {}; } window.__registeredHandlers['remoteRepoLoaded'] = remoteRepoLoadedHandler; } catch (e) {}
  try { if (!window.__commandRegistry) { window.__commandRegistry = {}; } window.__commandRegistry['remoteRepoLoaded'] = remoteRepoLoadedHandler; } catch (e) {}
})();