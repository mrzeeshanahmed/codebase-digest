;(function () {
  'use strict';
  if (typeof window === 'undefined') { return; }

  /**
   * Handle `restoredState` messages which provide persisted UI state to reapply
   * after a webview restore.
   *
   * Expected message shape:
   * { type: 'restoredState', state: { selectedFiles?: string[], focusIndex?: number } }
   *
   * Side effects:
   * - writes a pending persisted selection into `window.store` via `setPendingPersistedSelection`
   *   so subscribers may apply the selection once the tree has been hydrated.
   *
   * @param {{type?:string, state?:{selectedFiles?:string[], focusIndex?:number}}} msg
   */
  var restoredStateHandler = function (msg) {
    try {
      const s = msg && msg.state ? msg.state : {};
      try { if (window.store && typeof window.store.setPendingPersistedSelection === 'function') { window.store.setPendingPersistedSelection(Array.isArray(s.selectedFiles) ? s.selectedFiles.slice() : null, typeof s.focusIndex === 'number' ? s.focusIndex : undefined); } } catch (e) { console.warn('restoredStateHandler: setPendingPersistedSelection failed', e); }
      if (Array.isArray(s.selectedFiles) && s.selectedFiles.length > 0) {
        const sel = s.selectedFiles.slice();
        try { window.store && window.store.setPendingPersistedSelection && window.store.setPendingPersistedSelection(sel, typeof s.focusIndex === 'number' ? s.focusIndex : undefined); } catch (e) {}
      }
      if (s.focusIndex !== undefined && typeof s.focusIndex === 'number') {
        try { window.store && window.store.setPendingPersistedSelection && window.store.setPendingPersistedSelection(null, s.focusIndex); } catch (e) {}
      }
    } catch (e) { console.warn('restoredStateHandler error', e); }
  };

  var cmd = (window.COMMANDS && window.COMMANDS.restoredState) ? window.COMMANDS.restoredState : (window.__commandNames && window.__commandNames.restoredState) ? window.__commandNames.restoredState : 'restoredState';
  if (typeof window.__registerHandler === 'function') { try { window.__registerHandler(cmd, restoredStateHandler); } catch (e) {} }
  try { if (!window.__registeredHandlers) { window.__registeredHandlers = {}; } window.__registeredHandlers[cmd] = restoredStateHandler; } catch (e) {}
  try { if (!window.__commandRegistry) { window.__commandRegistry = {}; } window.__commandRegistry[cmd] = restoredStateHandler; } catch (e) {}
})();