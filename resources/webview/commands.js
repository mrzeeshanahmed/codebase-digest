// Central place for webview command name constants.
// Handlers may reference window.__commandNames if available; this file
// initializes it to provide a single source of truth for command strings.
(function () {
  'use strict';
  if (typeof window === 'undefined') { return; }

  if (!window.__commandNames) {
    Object.defineProperty(window, '__commandNames', {
      value: {
        state: 'state',
        previewDelta: 'previewDelta',
        ingestPreview: 'ingestPreview',
        ingestError: 'ingestError',
        progress: 'progress',
        remoteRepoLoaded: 'remoteRepoLoaded',
        generationResult: 'generationResult',
        restoredState: 'restoredState',
        config: 'config',
        diagnostic: 'diagnostic',
        test: 'test'
      },
      writable: true,
      configurable: true,
      enumerable: false
    });
  }

  // Export for common module systems when present.
  try { if (typeof module !== 'undefined' && module.exports) { module.exports = window.__commandNames; } } catch (e) {}
  try { if (typeof define === 'function' && define.amd) { define(function () { return window.__commandNames; }); } } catch (e) {}
})();
