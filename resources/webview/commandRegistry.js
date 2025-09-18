/*
 * Centralized command registry for the webview.
 *
 * Provides a deterministic, testable API:
 * - registerCommand(name, handler, { allowMultiple: false|true })
 * - unregisterCommand(name, handler?)
 * - getHandlers(name) -> Array<function>
 * - dispatch(name, payload) -> handler result(s)
 * - resetRegistry() -> clear all handlers (useful for tests)
 *
 * Backwards compatibility: exposes a non-enumerable read-only
 * `window.__commandRegistry` proxy and a `window.__registerHandler`
 * helper that appends handlers.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') { return; }

  const INTERNAL_KEY = '__cbd_command_registry_internal_v1__';

  if (!window[INTERNAL_KEY]) {
    window[INTERNAL_KEY] = {
      map: new Map(),
      knownKeys: typeof window.COMMANDS === 'object' ? Object.assign({}, window.COMMANDS) : (typeof window.__commandNames === 'object' ? Object.assign({}, window.__commandNames) : {})
    };
  }

  const internal = window[INTERNAL_KEY];

  const logger = {
    warn: (msg, ...args) => { try { console && console.warn && console.warn('[commandRegistry] ' + msg, ...args); } catch (e) {} },
    error: (msg, ...args) => { try { console && console.error && console.error('[commandRegistry] ' + msg, ...args); } catch (e) {} }
  };

  function ensureHandlersArray(name) {
    if (!internal.map.has(name)) { internal.map.set(name, []); }
    return internal.map.get(name);
  }

  function registerCommand(name, handler, opts) {
    if (!name || typeof handler !== 'function') { throw new TypeError('registerCommand requires (name, function)'); }
    const options = Object.assign({ allowMultiple: false }, opts || {});
    const handlers = ensureHandlersArray(name);
    if (!options.allowMultiple) {
      internal.map.set(name, [handler]);
      // Also populate legacy globals so unbundled/test code can introspect handlers
      try {
        if (typeof window !== 'undefined') {
          try {
            if (!window.__registeredHandlers) { window.__registeredHandlers = {}; }
            if (options.nonEnumerable) {
              try { Object.defineProperty(window.__registeredHandlers, String(name), { value: handler, writable: false, configurable: true, enumerable: false }); }
              catch (e) { window.__registeredHandlers[String(name)] = handler; }
            } else {
              window.__registeredHandlers[String(name)] = handler;
            }
          } catch (e) { /* ignore */ }
          try {
            if (!window.__commandRegistry) { window.__commandRegistry = {}; }
            if (options.nonEnumerable) {
              try { Object.defineProperty(window.__commandRegistry, String(name), { value: handler, writable: false, configurable: true, enumerable: false }); }
              catch (e) { window.__commandRegistry[String(name)] = handler; }
            } else {
              window.__commandRegistry[String(name)] = handler;
            }
          } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }
      return;
    }
    if (!handlers.includes(handler)) { handlers.push(handler); }
    // For allowMultiple case also populate legacy globals (last-registered wins for legacy lookup)
    try {
      if (typeof window !== 'undefined') {
        try { if (!window.__registeredHandlers) { window.__registeredHandlers = {}; } window.__registeredHandlers[String(name)] = handler; } catch (e) {}
        try { if (!window.__commandRegistry) { window.__commandRegistry = {}; } window.__commandRegistry[String(name)] = handler; } catch (e) {}
      }
    } catch (e) {}
  }

  function unregisterCommand(name, handler) {
    if (!name) { return; }
    if (!internal.map.has(name)) { return; }
    if (!handler) {
      internal.map.delete(name);
      return;
    }
    const arr = internal.map.get(name).filter(h => h !== handler);
    if (arr.length === 0) { internal.map.delete(name); }
    else { internal.map.set(name, arr); }
  }

  function getHandlers(name) {
    if (!name) { return []; }
    const arr = internal.map.get(name);
    return Array.isArray(arr) ? arr.slice() : [];
  }

  function dispatch(name, payload) {
    if (!name) { throw new TypeError('dispatch requires a command name'); }
    const handlers = getHandlers(name);
    if (!handlers || handlers.length === 0) {
      logger.warn('dispatch called for unknown/unregistered command:', name);
      return undefined;
    }
    const results = [];
    for (const h of handlers) {
      try {
        results.push(h(payload));
      } catch (e) {
        logger.error('handler threw for command ' + name + ':', e);
      }
    }
    return results.length === 1 ? results[0] : results;
  }

  function resetRegistry() {
    internal.map.clear();
  }

  // Backing target for legacy proxy so handlers can set properties directly
  const legacyTarget = {};
  const legacyProxy = new Proxy(legacyTarget, {
    get(target, prop) {
      try {
        const key = String(prop);
        // If the target has an explicit own property, return it (allows handlers to set handlers directly)
        if (Object.prototype.hasOwnProperty.call(target, key)) { return Reflect.get(target, key); }
        // pre-populate known keys on demand
        if (internal.knownKeys && internal.knownKeys[key] && !internal.map.has(key)) { ensureHandlersArray(key); }
        // Return a function that will dispatch to registered handlers when invoked.
        return function (payload) {
          try { return dispatch(key, payload); } catch (e) { logger.error('legacy proxy dispatch error for ' + key + ':', e); }
        };
      } catch (e) { logger.error('legacy proxy get error', e); return undefined; }
    },
    set(target, prop, value) {
      try {
        const key = String(prop);
        // If a function is assigned, treat it as registering a single handler (replace semantics)
        if (typeof value === 'function') {
          registerCommand(key, value, { allowMultiple: false });
          // also keep a reference on the legacy target for introspection
          return Reflect.set(target, prop, value);
        }
        // For non-functions, just store the value on the target
        return Reflect.set(target, prop, value);
      } catch (e) { logger.error('legacy proxy set error', e); return false; }
    },
    defineProperty(target, prop, descriptor) {
      try {
        // If descriptor.value is a function, register it as a handler
        if (descriptor && typeof descriptor.value === 'function') {
          registerCommand(String(prop), descriptor.value, { allowMultiple: false });
        }
        return Reflect.defineProperty(target, prop, descriptor);
      } catch (e) { logger.error('legacy proxy defineProperty error', e); return false; }
    },
    ownKeys() {
      return Array.from(new Set([...internal.map.keys(), ...Object.keys(internal.knownKeys || {}), ...Object.getOwnPropertyNames(legacyTarget)]));
    },
    getOwnPropertyDescriptor(target, prop) {
      if (Object.prototype.hasOwnProperty.call(target, prop)) {
        return Reflect.getOwnPropertyDescriptor(target, prop);
      }
      // expose synthetic descriptor so enumeration works
      return { configurable: true, enumerable: true, value: legacyProxy[prop] };
    }
  });

  try {
    if (!Object.prototype.hasOwnProperty.call(window, '__commandRegistry')) {
      Object.defineProperty(window, '__commandRegistry', {
        value: legacyProxy,
        writable: false,
        configurable: false,
        enumerable: false
      });
    }
  } catch (e) { /* continue even if defineProperty fails */ }

  try {
    if (!Object.prototype.hasOwnProperty.call(window, '__registerHandler')) {
      Object.defineProperty(window, '__registerHandler', {
        value: function (type, fn) {
          try {
            if (!type || typeof fn !== 'function') { return; }
            registerCommand(type, fn, { allowMultiple: true });
          } catch (e) { logger.error('window.__registerHandler failed', e); }
        },
        writable: false,
        configurable: false,
        enumerable: false
      });
    }
  } catch (e) { /* ignore define failures */ }

  const api = { registerCommand, unregisterCommand, getHandlers, dispatch, resetRegistry };

  try { if (typeof module !== 'undefined' && module.exports) { module.exports = api; } } catch (e) {}
  try { if (typeof define === 'function' && define.amd) { define(function () { return api; }); } } catch (e) {}

  // Expose a small, explicit global helper for legacy/unbundled code paths.
  // Prefer calling the centralized registerCommand but also populate the
  // lightweight legacy globals used by tests and older bundles. By default
  // this helper performs plain object inserts for maximum compatibility. If
  // a caller passes { nonEnumerable: true } we will attempt to define the
  // property as non-enumerable as a best-effort (fallbacks to plain assign
  // when defineProperty is unavailable or throws).
  try {
    if (typeof window !== 'undefined' && typeof window.registerCommand !== 'function') {
      window.registerCommand = function (name, fn, opts) {
        try {
          // Ensure the canonical internal registry is updated first
          try { registerCommand(name, fn, opts); } catch (e) { /* swallow */ }
          const options = opts || {};
          // Populate __registeredHandlers for tests / introspection
          try {
            if (!window.__registeredHandlers) { window.__registeredHandlers = {}; }
            if (options.nonEnumerable) {
              try { Object.defineProperty(window.__registeredHandlers, String(name), { value: fn, writable: false, configurable: true, enumerable: false }); }
              catch (e) { window.__registeredHandlers[String(name)] = fn; }
            } else {
              window.__registeredHandlers[String(name)] = fn;
            }
          } catch (e) { /* ignore global wiring failures */ }

          // Populate __commandRegistry for legacy consumers (plain assignment by default)
          try {
            if (!window.__commandRegistry) { window.__commandRegistry = {}; }
            if (options.nonEnumerable) {
              try { Object.defineProperty(window.__commandRegistry, String(name), { value: fn, writable: false, configurable: true, enumerable: false }); }
              catch (e) { window.__commandRegistry[String(name)] = fn; }
            } else {
              window.__commandRegistry[String(name)] = fn;
            }
          } catch (e) { /* ignore */ }

        } catch (e) {
          try { console && console.warn && console.warn('[commandRegistry] window.registerCommand failed', e); } catch (ex) {}
        }
      };
    }
  } catch (e) { /* ignore exposure failures */ }

  try {
    if (typeof require === 'function') {
      try { require('./handlers/treeDataHandler.js'); } catch (e) { try { require('./handlers/treeDataHandler'); } catch (ex) {} }
    }
  } catch (e) {}
  try { if (typeof importScripts === 'function') { try { importScripts('handlers/treeDataHandler.js'); } catch (e) {} } } catch (e) {}

})();