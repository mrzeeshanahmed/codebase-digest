"use strict";

const logger = require('../logger');

function remoteRepoLoadedHandler(msg) {
  try {
    const payload = msg && msg.payload ? msg.payload : {};
    const tmp = payload.tmpPath || null;
  // Push into store so subscribers can update ingest modal/UI
  try { if (typeof window !== 'undefined' && window.store && typeof window.store.setState === 'function') { try { window.store.setState({ loadedRepoTmpPath: tmp }); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/remoteRepoLoadedHandler.js', function: 'setState' }); } } } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/remoteRepoLoadedHandler.js', context: 'store setState' }); }

    if (tmp && typeof window !== 'undefined') {
  try { if (window.store && typeof window.store.setState === 'function') { try { window.store.setState({ loadedRepoTmpPath: tmp }); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/remoteRepoLoadedHandler.js', function: 'setState' }); } } } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/remoteRepoLoadedHandler.js', context: 'store setState (tmp)' }); }
    } else {
  try { if (window.store && typeof window.store.addError === 'function') { try { window.store.addError('Failed to load repository'); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/remoteRepoLoadedHandler.js', function: 'addError' }); } } } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/remoteRepoLoadedHandler.js', context: 'addError' }); }
    }
  } catch (e) { try { logger.warn('remoteRepoLoadedHandler error', e); } catch (_) {} const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/remoteRepoLoadedHandler.js' }); }
}

const cmd = (typeof window !== 'undefined' && window.COMMANDS && window.COMMANDS.remoteRepoLoaded) ? window.COMMANDS.remoteRepoLoaded : (typeof window !== 'undefined' && window.__commandNames && window.__commandNames.remoteRepoLoaded) ? window.__commandNames.remoteRepoLoaded : 'remoteRepoLoaded';

try {
  const registry = require('../commandRegistry');
  if (registry && typeof registry.registerCommand === 'function') {
    try { registry.registerCommand(cmd, remoteRepoLoadedHandler, { allowMultiple: false }); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/remoteRepoLoadedHandler.js', command: cmd }); }
  }
} catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/remoteRepoLoadedHandler.js', command: cmd }); }

  try {
  if (typeof window !== 'undefined') {
    if (typeof window.registerCommand === 'function') { try { window.registerCommand(cmd, remoteRepoLoadedHandler); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/remoteRepoLoadedHandler.js', command: cmd }); } }
    else if (typeof window.__registerHandler === 'function') { try { window.__registerHandler(cmd, remoteRepoLoadedHandler); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/remoteRepoLoadedHandler.js', command: cmd }); } }
  }
} catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/remoteRepoLoadedHandler.js', command: cmd }); }

module.exports = { remoteRepoLoadedHandler };