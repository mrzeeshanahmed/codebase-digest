;(function () {
  'use strict';
  if (typeof window === 'undefined') { return; }

  // Prefer an existing authoritative map if present (set by commands.js or
  // injected by the extension during HTML construction). Otherwise, create
  // a small runtime COMMANDS object to keep code using window.COMMANDS working
  // in pure-JS builds.
  var runtime = (typeof window.__commandNames === 'object' && window.__commandNames) ? window.__commandNames : Object.freeze({
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
   ,
   updateTree: 'updateTree',
   refreshTree: 'refreshTree'
  });

  try { window.COMMANDS = runtime; } catch (e) { /* ignore */ }
  try { if (typeof module !== 'undefined' && module.exports) { module.exports = runtime; } } catch (e) {}
})();
