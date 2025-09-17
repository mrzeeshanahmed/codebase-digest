;(function () {
  'use strict';
  if (typeof window === 'undefined') { return; }

  // Consolidated single registration for 'previewDelta' to avoid duplicate
  // registrations which caused nondeterministic test behavior.
  var previewDeltaHandler = function (msg) {
    try {
      const d = msg && msg.delta ? msg.delta : {};
  // invocation

      // Update fileTree first (if present) so subscribers that depend on tree
      // state observe the latest structure before preview is set.
      if (d && d.fileTree && window.store && window.store.setFileTree) {
        try { window.store.setFileTree(d.fileTree, Array.isArray(d.selectedPaths) ? d.selectedPaths : []); } catch (e) { console.warn('previewDeltaHandler: setFileTree failed', e); }
  // after setFileTree
      }

      // Push delta to store so subscribers can react to preview changes
      if (window.store && typeof window.store.setPreviewDelta === 'function') {
        try { window.store.setPreviewDelta(d); } catch (e) { console.warn('previewDeltaHandler: setPreviewDelta failed', e); }
      }

      // If UI helper functions are present in the webview scope, call them
      // for immediate feedback. Subscribers will also receive the store update.
      try { if (typeof renderPreviewDelta === 'function') { renderPreviewDelta(d); } } catch (e) { /* ignore UI helper failures */ }
      try { if (typeof renderTree === 'function') { const st = window.store && window.store.getState ? window.store.getState() : null; renderTree((st && st.aligned) || st, typeof expandedSet !== 'undefined' ? expandedSet : null); } } catch (e) { /* ignore */ }

    } catch (e) { console.warn('previewDeltaHandler error', e); }
  };

  // Register using the standard hook if available
  if (typeof window.__registerHandler === 'function') {
    try { window.__registerHandler('previewDelta', previewDeltaHandler); } catch (e) { /* ignore */ }
  }


  // Also be friendly to lightweight test harnesses that expect a simple map
  // on window.__registeredHandlers and to the commandRegistry which uses
  // window.__commandRegistry.
  try {
    if (!window.__registeredHandlers) { window.__registeredHandlers = {}; }
    try {
      Object.defineProperty(window.__registeredHandlers, 'previewDelta', { value: previewDeltaHandler, writable: false, configurable: true });
    } catch (e) {
      window.__registeredHandlers['previewDelta'] = previewDeltaHandler;
    }
  // attached to __registeredHandlers
  } catch (e) { /* ignore */ }

  try {
    if (!window.__commandRegistry) { window.__commandRegistry = {}; }
    try {
      Object.defineProperty(window.__commandRegistry, 'previewDelta', { value: previewDeltaHandler, writable: false, configurable: true });
    } catch (e) {
      window.__commandRegistry['previewDelta'] = previewDeltaHandler;
    }
  // attached to __commandRegistry
  } catch (e) { /* ignore */ }
})();