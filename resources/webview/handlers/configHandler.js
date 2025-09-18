/* configHandler: register via centralized command registry and export handler */
"use strict";

function configHandler(msg) {
  try {
    try { if (typeof window !== 'undefined') { try { window.currentFolderPath = msg.folderPath || msg.workspaceFolder || window.currentFolderPath; } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/configHandler.js', function: 'assign currentFolderPath' }); } } } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/configHandler.js', context: 'window assignment' }); }
    // Push settings into store so subscribers can populate settings UI
    try { if (typeof window !== 'undefined' && window.store && typeof window.store.setState === 'function') { window.store.setState({ settings: msg.settings || {} }); } } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/configHandler.js', function: 'setState' }); }

    try {
      const settings = msg.settings || {};
      let activeList = [];
      const asArray = (v) => { if (Array.isArray(v)) { return v.slice(); } if (typeof v === 'string' && v.trim()) { return v.split(',').map(s => s.trim()).filter(Boolean); } return []; };
      const fp = asArray(settings.filterPresets);
      if (fp.length > 0) { activeList = fp; } else { const legacy = asArray(settings.presets); if (legacy.length > 0) { activeList = legacy; } }
      const activePreset = (activeList.length > 0) ? String(activeList[0]) : null;
  // Let subscribers or uiRenderer pick up the settings from the store and
  // update the UI. Avoid direct DOM mutation from handlers for easier testing.
  } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/configHandler.js', context: 'presets parsing' }); }
  } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/configHandler.js' }); }
}

// Determine command name defensively (works in node test env where window may be undefined)
const cmd = (typeof window !== 'undefined' && window.COMMANDS && window.COMMANDS.config) ? window.COMMANDS.config : (typeof window !== 'undefined' && window.__commandNames && window.__commandNames.config) ? window.__commandNames.config : 'config';

// Register via centralized registry when available
try {
  const registry = require('../commandRegistry');
  if (registry && typeof registry.registerCommand === 'function') {
    try { registry.registerCommand(cmd, configHandler, { allowMultiple: false }); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/configHandler.js', command: cmd }); }
  }
} catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/configHandler.js', command: cmd }); }

// Also expose via window.registerCommand for unbundled consumers/tests
try {
    if (typeof window !== 'undefined') {
    if (typeof window.registerCommand === 'function') {
      try { window.registerCommand(cmd, configHandler); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/configHandler.js', command: cmd }); }
    } else if (typeof window.__registerHandler === 'function') {
      try { window.__registerHandler(cmd, configHandler); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/configHandler.js', command: cmd }); }
    }
  }
} catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/configHandler.js', command: cmd }); }

module.exports = { configHandler };