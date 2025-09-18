"use strict";

function stateHandler(msg) {
  try {
    const s = msg && msg.state ? msg.state : {};
    // Pure state update only: push incoming state into the store
    try {
      if (typeof window !== 'undefined' && window.store && typeof window.store.setState === 'function') { try { window.store.setState(s); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/stateHandler.js', function: 'setState' }); } }
      // Also set the treeData if present on the snapshot for sidebar rendering
      try {
        const tree = s && (s.fileTree || s.tree || s.fileTree === null ? s.fileTree : null);
        if (typeof window !== 'undefined' && typeof window.store !== 'undefined' && typeof window.store.setTreeData === 'function') {
          // Prefer explicit fileTree when provided, otherwise pass the whole state
          try { window.store.setTreeData(s.fileTree || s); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/stateHandler.js', function: 'setTreeData' }); }
        }
      } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/stateHandler.js', context: 'tree set check' }); }
    } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/stateHandler.js', context: 'store setState' }); }

    // Update pause button if present
    // Do not directly update UI from handlers. The renderer/subscribers should
    // react to store changes (including paused) and update the DOM. Keep
    // handlers side-effect free besides writing to the store for testability.
  } catch (e) { console.warn('stateHandler error', e); }
}

const cmd = (typeof window !== 'undefined' && window.COMMANDS && window.COMMANDS.state) ? window.COMMANDS.state : (typeof window !== 'undefined' && window.__commandNames && window.__commandNames.state) ? window.__commandNames.state : 'state';

  try {
    if (typeof window !== 'undefined') {
      if (typeof window.registerCommand === 'function') { try { window.registerCommand(cmd, stateHandler); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/stateHandler.js', command: cmd }); } }
      else if (typeof window.__registerHandler === 'function') { try { window.__registerHandler(cmd, stateHandler); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/stateHandler.js', command: cmd }); } }
    }
  } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/stateHandler.js', command: cmd }); }

  try {
    const registry = require('../commandRegistry');
    if (registry && typeof registry.registerCommand === 'function') {
      try { registry.registerCommand(cmd, stateHandler, { allowMultiple: false }); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/stateHandler.js', command: cmd }); }
    }
  } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/stateHandler.js', command: cmd }); }

// Also register on legacy window.__registerHandler if present (some tests use it)
  try {
    if (typeof window !== 'undefined' && typeof window.__registerHandler === 'function') {
      try { window.__registerHandler(cmd, stateHandler); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/stateHandler.js', command: cmd }); }
    }
  } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/stateHandler.js', command: cmd }); }

// Also ensure __registeredHandlers and __commandRegistry expose the handler for tests that inspect them directly
  try {
    if (typeof window !== 'undefined') {
      try { if (!window.__registeredHandlers) { window.__registeredHandlers = {}; } window.__registeredHandlers[cmd] = stateHandler; } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/stateHandler.js', context: 'populate __registeredHandlers' }); }
      try { if (!window.__commandRegistry) { window.__commandRegistry = {}; } window.__commandRegistry[cmd] = stateHandler; } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/stateHandler.js', context: 'populate __commandRegistry' }); }
    }
  } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/stateHandler.js', context: 'legacy globals population' }); }
// Also mirror onto global.__commandRegistry for test environments where global and window differ
try {
  if (typeof global !== 'undefined' && typeof window !== 'undefined') {
    try { if (!global.__commandRegistry) { global.__commandRegistry = window.__commandRegistry || {}; } if (global.__commandRegistry && !global.__commandRegistry[cmd]) { global.__commandRegistry[cmd] = stateHandler; } } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/stateHandler.js', context: 'populate global.__commandRegistry' }); }
  }
} catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/stateHandler.js', context: 'global legacy mirror' }); }

module.exports = { stateHandler };