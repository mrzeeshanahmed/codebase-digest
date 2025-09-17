;(function () {
  'use strict';
  if (typeof window === 'undefined') { return; }

  var progressHandler = function (msg) {
    try {
      const e = msg && msg.event ? msg.event : null;
      try { if (window.store && typeof window.store.setLoading === 'function' && e && e.op) { window.store.setLoading(e.op, e.mode !== 'end'); } } catch (err) { console.warn('progressHandler: store.setLoading failed', err); }
      // Do NOT directly call UI progress impl; subscribers will observe store and update UI.
      try { if (typeof window.__handleProgress === 'function') { window.__handleProgress(msg.event); } else if (typeof handleProgress === 'function') { handleProgress(msg.event); } } catch (e) { /* ignore UI hook failures */ }
    } catch (err) { console.warn('progressHandler error', err); }
  };

  if (typeof window.__registerHandler === 'function') { try { window.__registerHandler('progress', progressHandler); } catch (e) {} }
  try { if (!window.__registeredHandlers) { window.__registeredHandlers = {}; } window.__registeredHandlers['progress'] = progressHandler; } catch (e) {}
  try { if (!window.__commandRegistry) { window.__commandRegistry = {}; } window.__commandRegistry['progress'] = progressHandler; } catch (e) {}
})();