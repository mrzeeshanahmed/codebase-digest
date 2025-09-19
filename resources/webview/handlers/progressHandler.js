;(function () {
  'use strict';
  if (typeof window === 'undefined') { return; }

  const logger = require('../logger');

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
  function progressHandler(msg) {
    try {
      if (!msg) { return; }
      const e = msg && msg.event ? msg.event : null;
  try { if (typeof window !== 'undefined' && window.store && typeof window.store.setLoading === 'function' && e && e.op) { window.store.setLoading(e.op, e.mode !== 'end'); } } catch (err) { try { if (typeof window !== 'undefined' && window.__cbd_logger && typeof window.__cbd_logger.warn === 'function') { window.__cbd_logger.warn('progressHandler: store.setLoading failed', err); } else { console && console.warn && console.warn('progressHandler: store.setLoading failed', err); } } catch (e) {} }
  // Prefer store-driven updates. Keep legacy immediate hook as non-essential.
  // Prefer store-driven updates only. Legacy immediate UI hook removed so
  // handlers remain side-effect free and the renderer/subscribers react to
  // store changes to update the DOM. If immediate UI feedback is required,
  // the uiRenderer should subscribe to store or expose its own API.
  } catch (err) { try { logger.warn('progressHandler error', err); } catch (e) {} }
  }

  var cmd = (window.COMMANDS && window.COMMANDS.progress) ? window.COMMANDS.progress : (window.__commandNames && window.__commandNames.progress) ? window.__commandNames.progress : 'progress';
  try {
    if (typeof window !== 'undefined') {
      if (typeof window.registerCommand === 'function') {
        try { window.registerCommand(cmd, progressHandler); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/progressHandler.js', command: cmd }); }
      } else if (typeof window.__registerHandler === 'function') {
        try { window.__registerHandler(cmd, progressHandler); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/progressHandler.js', command: cmd }); }
      }
    }
  } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/progressHandler.js', command: cmd }); }
  try {
    const registry = require('../commandRegistry');
    if (registry && typeof registry.registerCommand === 'function') {
      registry.registerCommand(cmd, progressHandler, { allowMultiple: false });
    }
  } catch (e) {}
  
  module.exports = { progressHandler };
})();