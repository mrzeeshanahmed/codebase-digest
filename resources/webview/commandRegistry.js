// Lightweight command registry aggregator for webview handlers.
// Handlers are expected to call window.__registerHandler(type, fn) when loaded.
(function () {
  'use strict';
  // Ensure a shared registry object exists on window so both handler scripts
  // and the main webview can access the same map regardless of load order.
  if (typeof window === 'undefined') { return; }

  if (!window.__commandRegistry) {
    // If a canonical COMMANDS map exists, prefer that for registry keys
    // and expose it as __commandNames for backward compatibility with
    // handler code that expects window.__commandNames.
    try {
      if (window.COMMANDS && !window.__commandNames) { window.__commandNames = window.COMMANDS; }
    } catch (e) {}

    // Initialize the registry object and pre-populate known command keys
    const initialRegistry = {};
    try {
      const names = window.__commandNames || {};
      Object.keys(names).forEach(function (k) {
        try { initialRegistry[names[k]] = initialRegistry[names[k]] || undefined; } catch (e) {}
      });
    } catch (e) {}

    Object.defineProperty(window, '__commandRegistry', {
      value: initialRegistry,
      writable: true,
      configurable: true,
      enumerable: false
    });
  }

  // Helper used by handlers to register themselves. Handlers may be loaded
  // in any order; this function ensures the last registration wins for a key.
  if (!window.__registerHandler) {
    window.__registerHandler = function (type, fn) {
      try {
        if (!type || typeof fn !== 'function') { return; }
        window.__commandRegistry[type] = fn;
      } catch (e) { console.warn('commandRegistry register failed', e); }
    };
  }

  // Expose a small API for other modules that want to introspect the registry
  // or programmatically register handlers. This file intentionally does not
  // attempt to import handler modules (webview bundling varies); instead it
  // provides a stable runtime registry surface that handler scripts call.
  const api = {
    registry: window.__commandRegistry,
    register: window.__registerHandler,
    getHandler: function (type) { return (window.__commandRegistry || {})[type]; }
  };

  // Export for module systems if present (CommonJS/AMD/ESM); otherwise leave global.
  try { if (typeof module !== 'undefined' && module.exports) { module.exports = api; } } catch (e) {}
  try { if (typeof define === 'function' && define.amd) { define(function () { return api; }); } } catch (e) {}
  try { if (typeof window !== 'undefined') { window.__commandRegistryApi = api; } } catch (e) {}
})();
// Simple command registry for the webview handlers.
// Handlers register themselves onto window.__commandRegistry by message.type.
(function () {
  'use strict';
  if (typeof window === 'undefined') { return; }
  // Ensure the registry exists and pre-populate any known keys from
  // the canonical COMMANDS map (or legacy __commandNames) so handlers have
  // deterministic keys to attach to even before any registration.
  window.__commandRegistry = window.__commandRegistry || {};
  try {
    var known = (window.COMMANDS || window.__commandNames) || {};
    Object.keys(known).forEach(function (k) {
      try { if (!window.__commandRegistry[known[k]]) { window.__commandRegistry[known[k]] = undefined; } } catch (e) {}
    });
    // keep backward-compatible alias
    if (window.COMMANDS && !window.__commandNames) { window.__commandNames = window.COMMANDS; }
  } catch (e) {}
  // Utility to register a handler (defensive against accidental overrides)
  window.__registerHandler = function (type, fn) {
    try {
      if (!type || typeof fn !== 'function') { return; }
      if (window.__commandRegistry[type]) {
        // do not overwrite an existing handler; allow multiple by wrapping
        const prev = window.__commandRegistry[type];
        window.__commandRegistry[type] = function (msg) {
          try { prev(msg); } catch (e) { console.warn('previous handler failed for', type, e); }
          try { fn(msg); } catch (e) { console.warn('handler failed for', type, e); }
        };
      } else {
        window.__commandRegistry[type] = fn;
      }
    } catch (e) { console.warn('registerHandler failed', e); }
  };
})();