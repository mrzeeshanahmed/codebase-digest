;(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  const logger = require('../logger');

  function previewDeltaHandler(msg) {
    if (!msg || !msg.delta) { return; }

    try {
      if (typeof window !== 'undefined' && window.store) {
        if (typeof window.store.setPreviewDelta === 'function') {
          window.store.setPreviewDelta(msg.delta);
        }

        if (msg.delta && typeof msg.delta.fileTree !== 'undefined' && typeof window.store.setFileTree === 'function') {
          window.store.setFileTree(msg.delta.fileTree, msg.delta.selectedPaths);
        }

        if (msg.delta && Array.isArray(msg.delta.selectedPaths) && typeof window.store.setSelection === 'function') {
          window.store.setSelection(msg.delta.selectedPaths);
        }
      }
    } catch (e) {
      try { logger.warn('previewDeltaHandler: store apply failed', e); } catch (_) {}
    }

    try {
      if (typeof window !== 'undefined' && window.store && typeof window.store.setLoading === 'function') {
        window.store.setLoading(false);
      }
    } catch (e) {
      try { logger.warn('previewDeltaHandler: setLoading failed', e); } catch (_) {}
    }
  }

  var cmd = (window.COMMANDS && window.COMMANDS.previewDelta) ? window.COMMANDS.previewDelta : (window.__commandNames && window.__commandNames.previewDelta) ? window.__commandNames.previewDelta : 'previewDelta';

  try {
    if (typeof window !== 'undefined') {
      if (typeof window.registerCommand === 'function') {
        window.registerCommand(cmd, previewDeltaHandler);
      } else if (typeof window.__registerHandler === 'function') {
        window.__registerHandler(cmd, previewDeltaHandler);
      }
    }
  } catch (e) {
    try { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/previewDeltaHandler.js', command: cmd }); } catch (_) {}
  }

  try {
    const registry = require('../commandRegistry');
    if (registry && typeof registry.registerCommand === 'function') {
      registry.registerCommand(cmd, previewDeltaHandler, { allowMultiple: false });
    }
  } catch (e) {}

  module.exports = { previewDeltaHandler };
})();