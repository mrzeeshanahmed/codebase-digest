;(function () {
  'use strict';
  if (typeof window === 'undefined') { return; }

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

  if (typeof window.__registerHandler === 'function') { try { window.__registerHandler('restoredState', restoredStateHandler); } catch (e) {} }
  try { if (!window.__registeredHandlers) { window.__registeredHandlers = {}; } window.__registeredHandlers['restoredState'] = restoredStateHandler; } catch (e) {}
  try { if (!window.__commandRegistry) { window.__commandRegistry = {}; } window.__commandRegistry['restoredState'] = restoredStateHandler; } catch (e) {}
})();