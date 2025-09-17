;(function () {
  'use strict';
  if (typeof window === 'undefined') { return; }

  var stateHandler = function (msg) {
    try {
      const s = msg && msg.state ? msg.state : {};
      // Pure state update only: push incoming state into the store
      try { if (window.store && typeof window.store.setState === 'function') { window.store.setState(s); } } catch (e) { console.warn('stateHandler: store.setState failed', e); }

      // Update pause button if present
      try {
        if (typeof s.paused !== 'undefined' && typeof updatePauseButton === 'function') {
          paused = !!s.paused; updatePauseButton();
        }
      } catch (e) {}
    } catch (e) { console.warn('stateHandler error', e); }
  };

  if (typeof window.__registerHandler === 'function') {
    try { window.__registerHandler('state', stateHandler); } catch (e) { }
  }
  try { if (!window.__registeredHandlers) { window.__registeredHandlers = {}; } window.__registeredHandlers['state'] = stateHandler; } catch (e) {}
  try { if (!window.__commandRegistry) { window.__commandRegistry = {}; } window.__commandRegistry['state'] = stateHandler; } catch (e) {}
})();