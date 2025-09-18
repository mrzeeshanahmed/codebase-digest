var ingestPreviewHandler;
;(function () {
  'use strict';
  if (typeof window === 'undefined') { return; }

  /**
   * Handle `ingestPreview` messages containing a richer preview payload used
   * by the ingest modal or preview panel.
   *
   * Expected message shape:
   * { type: 'ingestPreview', payload: { preview?: { summary?:string, tree?:string }, output?: any, ... } }
   *
   * Side effects:
   * - writes the payload to `window.store.setPreview` so subscribers can react
   * - attempts minimal DOM updates (preview root, text and spinner) for immediate feedback
   *
   * @param {{type?:string, payload?:Object}} msg
   */
  ingestPreviewHandler = function ingestPreviewHandler(msg) {
    try {
      if (!msg || !msg.payload) { return; }
      const payload = msg.payload || {};
      // Only update store; subscribers will update DOM/UI via a single renderer.
      try {
        if (window.store && typeof window.store.setState === 'function') {
          try { window.store.setState(() => ({ ingestPreview: payload })); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/ingestPreviewHandler.js', function: 'setState' }); }
        } else if (window.store && typeof window.store.setPreview === 'function') {
          try { window.store.setPreview(payload); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/ingestPreviewHandler.js', function: 'setPreview' }); }
        }
      } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/ingestPreviewHandler.js', context: 'store apply' }); }
    } catch (e) { console.warn('ingestPreviewHandler error', e); }
  };

  var cmd = (window.COMMANDS && window.COMMANDS.ingestPreview) ? window.COMMANDS.ingestPreview : (window.__commandNames && window.__commandNames.ingestPreview) ? window.__commandNames.ingestPreview : 'ingestPreview';
  try {
    if (typeof window !== 'undefined') {
      if (typeof window.registerCommand === 'function') {
        try { window.registerCommand(cmd, ingestPreviewHandler); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/ingestPreviewHandler.js', command: cmd }); }
      } else if (typeof window.__registerHandler === 'function') {
        try { window.__registerHandler(cmd, ingestPreviewHandler); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/ingestPreviewHandler.js', command: cmd }); }
      }
    }
  } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/ingestPreviewHandler.js', command: cmd }); }
})();
try {
  const registry = require('../commandRegistry');
  if (registry && typeof registry.registerCommand === 'function') {
    registry.registerCommand(cmd, ingestPreviewHandler, { allowMultiple: false });
  }
} catch (e) {}

module.exports = { ingestPreviewHandler };