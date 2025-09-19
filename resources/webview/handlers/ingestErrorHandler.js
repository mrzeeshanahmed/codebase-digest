"use strict";

const logger = require('../logger');

function ingestErrorHandler(msg) {
  try {
    // Push error into store; subscribers may show toast / update ingest UI
    try {
      if (typeof window !== 'undefined' && window.store && typeof window.store.addError === 'function') {
        try { window.store.addError(msg.error || 'Ingest failed'); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/ingestErrorHandler.js', function: 'addError' }); }
      }
    } catch (e) { try { logger.warn('ingestErrorHandler store addError failed', e); } catch (_) {} const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/ingestErrorHandler.js', context: 'store addError' }); }
  } catch (e) { try { logger.warn('ingestErrorHandler error', e); } catch (_) {} const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/ingestErrorHandler.js' }); }

}

const cmd = (typeof window !== 'undefined' && window.COMMANDS && window.COMMANDS.ingestError) ? window.COMMANDS.ingestError : (typeof window !== 'undefined' && window.__commandNames && window.__commandNames.ingestError) ? window.__commandNames.ingestError : 'ingestError';

try {
  const registry = require('../commandRegistry');
  if (registry && typeof registry.registerCommand === 'function') {
    try { registry.registerCommand(cmd, ingestErrorHandler, { allowMultiple: false }); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/ingestErrorHandler.js', command: cmd }); }
  }
} catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/ingestErrorHandler.js', command: cmd }); }

try {
    if (typeof window !== 'undefined') {
    if (typeof window.registerCommand === 'function') {
      try { window.registerCommand(cmd, ingestErrorHandler); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/ingestErrorHandler.js', command: cmd }); }
    } else if (typeof window.__registerHandler === 'function') {
      try { window.__registerHandler(cmd, ingestErrorHandler); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/ingestErrorHandler.js', command: cmd }); }
    }
  }
} catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/ingestErrorHandler.js', command: cmd }); }

module.exports = { ingestErrorHandler };