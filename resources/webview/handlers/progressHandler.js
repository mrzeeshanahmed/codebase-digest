;(function () {
  'use strict';
  if (typeof window === 'undefined') { return; }

  /**
   * Handle `progress` events describing long-running operations.
   *
   * Expected message shape:
   * { type: 'progress', event: { op: string, mode: 'start'|'update'|'end', percent?: number } }
   *
   * Side effects:
   * - updates `window.store.loading[op]` via `setLoading` (true for start/update, false for end)
   * - optionally delegates to legacy UI hooks (`window.__handleProgress` or `handleProgress`) for immediate handling
   *
   * @param {{type?:string, event?:{op?:string, mode?:string, percent?:number}}} msg
   */
  var progressHandler = function (msg) {
    try {
      const e = msg && msg.event ? msg.event : null;
      try { if (window.store && typeof window.store.setLoading === 'function' && e && e.op) { window.store.setLoading(e.op, e.mode !== 'end'); } } catch (err) { console.warn('progressHandler: store.setLoading failed', err); }
      // Do NOT directly call UI progress impl; subscribers will observe store and update UI.
      try { if (typeof window.__handleProgress === 'function') { window.__handleProgress(msg.event); } else if (typeof handleProgress === 'function') { handleProgress(msg.event); } } catch (e) { /* ignore UI hook failures */ }
    } catch (err) { console.warn('progressHandler error', err); }
  };

  var cmd = (window.COMMANDS && window.COMMANDS.progress) ? window.COMMANDS.progress : (window.__commandNames && window.__commandNames.progress) ? window.__commandNames.progress : 'progress';
  if (typeof window.__registerHandler === 'function') { try { window.__registerHandler(cmd, progressHandler); } catch (e) {} }
  try { if (!window.__registeredHandlers) { window.__registeredHandlers = {}; } window.__registeredHandlers[cmd] = progressHandler; } catch (e) {}
  try { if (!window.__commandRegistry) { window.__commandRegistry = {}; } window.__commandRegistry[cmd] = progressHandler; } catch (e) {}
})();