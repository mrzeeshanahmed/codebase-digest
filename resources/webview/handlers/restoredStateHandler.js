"use strict";

function restoredStateHandler(msg) {
  try {
    const s = msg && msg.state ? msg.state : {};
  try { if (typeof window !== 'undefined' && window.store && typeof window.store.setPendingPersistedSelection === 'function') { try { window.store.setPendingPersistedSelection(Array.isArray(s.selectedFiles) ? s.selectedFiles.slice() : null, typeof s.focusIndex === 'number' ? s.focusIndex : undefined); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/restoredStateHandler.js', function: 'setPendingPersistedSelection' }); } } } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/restoredStateHandler.js', context: 'initial setPendingPersistedSelection' }); }
    if (Array.isArray(s.selectedFiles) && s.selectedFiles.length > 0) {
  const sel = s.selectedFiles.slice();
  try { if (typeof window !== 'undefined' && window.store && typeof window.store.setPendingPersistedSelection === 'function') { try { window.store.setPendingPersistedSelection(sel, typeof s.focusIndex === 'number' ? s.focusIndex : undefined); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/restoredStateHandler.js', function: 'setPendingPersistedSelection (selectedFiles)' }); } } } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/restoredStateHandler.js', context: 'selectedFiles branch' }); }
    }
    if (s.focusIndex !== undefined && typeof s.focusIndex === 'number') {
  try { if (typeof window !== 'undefined' && window.store && typeof window.store.setPendingPersistedSelection === 'function') { try { window.store.setPendingPersistedSelection(null, s.focusIndex); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/restoredStateHandler.js', function: 'setPendingPersistedSelection (focusIndex)' }); } } } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/restoredStateHandler.js', context: 'focusIndex branch' }); }
    }
  } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/restoredStateHandler.js' }); }
}

const cmd = (typeof window !== 'undefined' && window.COMMANDS && window.COMMANDS.restoredState) ? window.COMMANDS.restoredState : (typeof window !== 'undefined' && window.__commandNames && window.__commandNames.restoredState) ? window.__commandNames.restoredState : 'restoredState';

try {
  const registry = require('../commandRegistry');
  if (registry && typeof registry.registerCommand === 'function') {
    try { registry.registerCommand(cmd, restoredStateHandler, { allowMultiple: false }); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/restoredStateHandler.js', command: cmd }); }
  }
} catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/restoredStateHandler.js', command: cmd }); }

  try {
    if (typeof window !== 'undefined') {
      if (typeof window.registerCommand === 'function') { try { window.registerCommand(cmd, restoredStateHandler); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/restoredStateHandler.js', command: cmd }); } }
      else if (typeof window.__registerHandler === 'function') { try { window.__registerHandler(cmd, restoredStateHandler); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/restoredStateHandler.js', command: cmd }); } }
    }
  } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/restoredStateHandler.js', command: cmd }); }

module.exports = { restoredStateHandler };