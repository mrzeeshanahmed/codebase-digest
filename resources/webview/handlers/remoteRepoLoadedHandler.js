;(function () {
  'use strict';
  if (typeof window === 'undefined') { return; }

  /**
   * Handle `remoteRepoLoaded` messages emitted by the extension when a remote
   * repository has been cloned/loaded to a temporary path for subsequent ingest.
   *
   * Expected message shape:
   * {
   *   type: 'remoteRepoLoaded',
   *   payload: {
   *     tmpPath?: string | null
   *   }
   * }
   *
   * Side effects:
   * - writes `loadedRepoTmpPath` into the webview `window.store` (via setState)
   *   so subscribers can update the ingest dialog/UI.
   * - sets `window.loadedRepoTmpPath` as a transient holder for the loaded path.
   * - performs small DOM updates for the ingest modal (preview text, hide/show
   *   Load/Start buttons) when the relevant nodes are available.
   * - on failure, shows a toast (if showToast is available).
   *
   * The handler is defensive: it checks for the presence of `window.store`, DOM
   * nodes and helper functions and logs warnings instead of throwing.
   *
   * @param {{type?:string, payload?:{tmpPath?:string|null}}} msg
   */
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

  var cmd = (window.COMMANDS && window.COMMANDS.remoteRepoLoaded) ? window.COMMANDS.remoteRepoLoaded : (window.__commandNames && window.__commandNames.remoteRepoLoaded) ? window.__commandNames.remoteRepoLoaded : 'remoteRepoLoaded';
  if (typeof window.__registerHandler === 'function') { try { window.__registerHandler(cmd, remoteRepoLoadedHandler); } catch (e) {} }
  try { if (!window.__registeredHandlers) { window.__registeredHandlers = {}; } window.__registeredHandlers[cmd] = remoteRepoLoadedHandler; } catch (e) {}
  try { if (!window.__commandRegistry) { window.__commandRegistry = {}; } window.__commandRegistry[cmd] = remoteRepoLoadedHandler; } catch (e) {}
})();