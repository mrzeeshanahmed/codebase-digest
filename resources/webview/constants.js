;(function () {
  'use strict';
  if (typeof window === 'undefined') { return; }

  // Centralized command name constants for the webview.
  // Keep the keys identical to the runtime message.type values used by the
  // command registry and handlers. This file intentionally does not attempt
  // to infer names at runtime; it provides a stable reference for code that
  // wants to avoid magic strings.
  var COMMANDS = Object.freeze({
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
  });

  try { window.COMMANDS = COMMANDS; } catch (e) { /* ignore */ }
  try { if (typeof module !== 'undefined' && module.exports) { module.exports = COMMANDS; } } catch (e) {}
})();
