;(function () {
  'use strict';
  if (typeof window === 'undefined') { return; }

  /**
   * Handle a full `state` snapshot message from the extension host.
   *
   * Expected message shape:
   * { type: 'state', state: { ... } }
   *
   * Side effects:
   * - writes the snapshot into `window.store` using `setState` (merge semantics)
   * - updates UI pause controls via `updatePauseButton` if present
   *
   * The handler is defensive and will not throw when store or helpers are absent.
   *
   * @param {{type?:string, state?:Object}} msg
   */
  var stateHandler = function (msg) {
    try {
      const s = msg && msg.state ? msg.state : {};
      // Pure state update only: push incoming state into the store
      try {
        if (window.store && typeof window.store.setState === 'function') { window.store.setState(s); }
        // Also set the treeData if present on the snapshot for sidebar rendering
        try {
          const tree = s && (s.fileTree || s.tree || s.fileTree === null ? s.fileTree : null);
          if (typeof window.store.setTreeData === 'function') {
            // Prefer explicit fileTree when provided, otherwise pass the whole state
            window.store.setTreeData(s.fileTree || s);
          }
        } catch (e) { /* ignore tree set errors */ }
      } catch (e) { console.warn('stateHandler: store.setState failed', e); }

      // Update pause button if present
      try {
        if (typeof s.paused !== 'undefined' && typeof updatePauseButton === 'function') {
          paused = !!s.paused; updatePauseButton();
        }
      } catch (e) {}
    } catch (e) { console.warn('stateHandler error', e); }
  };

  var cmd = (window.COMMANDS && window.COMMANDS.state) ? window.COMMANDS.state : (window.__commandNames && window.__commandNames.state) ? window.__commandNames.state : 'state';
  if (typeof window.__registerHandler === 'function') {
    try { window.__registerHandler(cmd, stateHandler); } catch (e) { }
  }
  try { if (!window.__registeredHandlers) { window.__registeredHandlers = {}; } window.__registeredHandlers[cmd] = stateHandler; } catch (e) {}
  try { if (!window.__commandRegistry) { window.__commandRegistry = {}; } window.__commandRegistry[cmd] = stateHandler; } catch (e) {}
})();