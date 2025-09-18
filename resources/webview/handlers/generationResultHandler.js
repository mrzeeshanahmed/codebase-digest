"use strict";

function generationResultHandler(msg) {
  try {
    const res = msg && msg.result ? msg.result : {};
    // Store generation result metadata so subscribers can show toasts / update UI
    try { if (typeof window !== 'undefined' && window.store && typeof window.store.setState === 'function') { window.store.setState({ lastGenerationResult: res }); } } catch (e) { console.warn('generationResultHandler: store.setState failed', e); }
    // Track errors via store so subscribers can display toasts / update UI
    try {
      if (res && res.error && window.store && typeof window.store.addError === 'function') {
        try { window.store.addError(String(res.error)); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/generationResultHandler.js', function: 'addError' }); }
      }
    } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/generationResultHandler.js', context: 'addError check' }); }

    // Record the generation result in store; subscribers will surface messages/toasts
    try {
      if (window.store && typeof window.store.setState === 'function') {
        window.store.setState({ lastGenerationResult: res });
      }
  } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/generationResultHandler.js', function: 'setState' }); }
  } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/generationResultHandler.js' }); }
}

const cmd = (typeof window !== 'undefined' && window.COMMANDS && window.COMMANDS.generationResult) ? window.COMMANDS.generationResult : (typeof window !== 'undefined' && window.__commandNames && window.__commandNames.generationResult) ? window.__commandNames.generationResult : 'generationResult';

try {
  const registry = require('../commandRegistry');
  if (registry && typeof registry.registerCommand === 'function') {
    try { registry.registerCommand(cmd, generationResultHandler, { allowMultiple: false }); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/generationResultHandler.js', command: cmd }); }
  }
} catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/generationResultHandler.js', command: cmd }); }

try {
    if (typeof window !== 'undefined') {
    if (typeof window.registerCommand === 'function') {
      try { window.registerCommand(cmd, generationResultHandler); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/generationResultHandler.js', command: cmd }); }
    } else if (typeof window.__registerHandler === 'function') {
      try { window.__registerHandler(cmd, generationResultHandler); } catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/generationResultHandler.js', command: cmd }); }
    }
  }
} catch (e) { const { reportError } = require('../utils/errorReporter'); reportError(e, { file: 'handlers/generationResultHandler.js', command: cmd }); }

module.exports = { generationResultHandler };