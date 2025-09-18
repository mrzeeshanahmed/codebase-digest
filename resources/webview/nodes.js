;(function(){
  'use strict';
  // Safe, lazy node accessors centralised in one module. Designed to be small and
  // defensive so it can be required from bundled or unbundled runtime and used
  // by tests where document may be undefined.

  function getById(id) {
    try {
      if (typeof document === 'undefined' || !id) { return null; }
      return document.getElementById(id);
    } catch (e) { return null; }
  }

  const api = {
    getById,
    getFileListRoot: () => getById('file-list'),
    getToastRoot: () => getById('toast-root'),
    getIngestPreviewRoot: () => getById('ingest-preview'),
    getIngestSpinner: () => getById('ingest-spinner'),
    getIngestPreviewText: () => getById('ingest-preview-text'),
    getProgressContainer: () => getById('progress-container'),
    getProgressBar: () => getById('progress-bar'),
    getStats: () => getById('stats'),
    getChips: () => getById('status-chips'),
    getCancelWriteBtn: () => getById('btn-cancel-write'),
    getPauseBtn: () => getById('btn-pause-resume'),
    getToolbar: () => getById('toolbar'),
    getSettings: () => getById('settings'),
    getPresetBtn: () => getById('preset-btn'),
    getPresetMenu: () => getById('preset-menu')
  };

  // Attach to window for quick lookup by main.js and tests
  try { if (typeof window !== 'undefined') { window.__CBD_NODES__ = Object.assign({}, window.__CBD_NODES__ || {}, api); } } catch (e) {}

  // CommonJS export for bundlers / require() in tests
  try { if (typeof module !== 'undefined' && module.exports) { module.exports = api; } } catch (e) {}
})();
// Lazily resolve DOM node references for the webview UI.
// Returns null if document is not available or the element does not exist.

(function () {
  'use strict';

  function safeGet(id) {
    try {
      if (typeof document === 'undefined') { return null; }
      return document.getElementById(id) || null;
    } catch (e) {
      return null;
    }
  }

  const cache = Object.create(null);

  function getter(id) {
    return function () {
      if (!(id in cache)) {
        cache[id] = safeGet(id);
      }
      return cache[id];
    };
  }

  const api = {
    getIngestPreviewRoot: getter('ingest-preview'),
    getIngestPreviewText: getter('ingest-preview-text'),
    getIngestSpinner: getter('ingest-spinner'),
    getProgressContainer: getter('progress-container'),
    getProgressBar: getter('progress-bar'),
    getDisableRedactionBtn: getter('btn-disable-redaction'),
    getIngestLoadRepoBtn: getter('ingest-load-repo'),
    getIngestSubmitBtn: getter('ingest-submit'),
    getFileListRoot: getter('file-list'),
    // Generic getter if a handler needs a different id at runtime
    getById: function (id) { return safeGet(id); },

    // Reset cache (useful in tests when DOM changes)
    reset: function () { for (const k of Object.keys(cache)) { delete cache[k]; } }
  };

  try { if (typeof module !== 'undefined' && module.exports) { module.exports = api; } } catch (e) {}
  try { if (typeof window !== 'undefined') { window.__CBD_NODES__ = api; } } catch (e) {}

})();
