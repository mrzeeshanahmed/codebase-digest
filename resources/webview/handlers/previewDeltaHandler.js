;(function () {
  'use strict';
  if (typeof window === 'undefined') { return; }

  /**
   * Handle `previewDelta` messages from the extension host.
   *
   * Expected message shape:
   * {
   *   type: 'previewDelta',
   *   delta: {
   *     // optional fileTree object to replace current tree
   *     fileTree?: Object,
   *     // optional array of selectedPaths to apply with the tree
   *     selectedPaths?: string[],
   *     // quick preview properties such as tokenEstimate, selectedCount, etc.
   *   }
   * }
   *
   * Side effects:
   * - writes `fileTree` and `selectedPaths` to `window.store` via `setFileTree` if present
   * - writes the compact delta to `window.store.setPreviewDelta` so subscribers react
   * - calls optional UI helpers `renderPreviewDelta` and `renderTree` for immediate feedback
   *
   * The handler registers itself on `window.__registerHandler`, `window.__registeredHandlers`
   * and `window.__commandRegistry` for compatibility with lightweight test harnesses.
   *
   * The function is defensive: it checks for the presence of `window.store` and helper
   * functions and logs warnings on failures without throwing.
   *
   * @param {{type?:string, delta?:Object}} msg
   */
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
  // Prefer centralized command names if available, fall back to literal.
  var cmd = (window.COMMANDS && window.COMMANDS.previewDelta) ? window.COMMANDS.previewDelta : (window.__commandNames && window.__commandNames.previewDelta) ? window.__commandNames.previewDelta : 'previewDelta';
  if (typeof window.__registerHandler === 'function') {
    try { window.__registerHandler(cmd, previewDeltaHandler); } catch (e) { /* ignore */ }
  }


  // Also be friendly to lightweight test harnesses that expect a simple map
  // on window.__registeredHandlers and to the commandRegistry which uses
  // window.__commandRegistry.
    try {
      if (!window.__registeredHandlers) { window.__registeredHandlers = {}; }
      try {
        Object.defineProperty(window.__registeredHandlers, cmd, { value: previewDeltaHandler, writable: false, configurable: true });
      } catch (e) {
        window.__registeredHandlers[cmd] = previewDeltaHandler;
      }
  // attached to __registeredHandlers
  } catch (e) { /* ignore */ }

    try {
      if (!window.__commandRegistry) { window.__commandRegistry = {}; }
      try {
        Object.defineProperty(window.__commandRegistry, cmd, { value: previewDeltaHandler, writable: false, configurable: true });
      } catch (e) {
        window.__commandRegistry[cmd] = previewDeltaHandler;
      }
  // attached to __commandRegistry
  } catch (e) { /* ignore */ }
})();