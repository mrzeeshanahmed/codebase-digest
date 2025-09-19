var treeDataHandler;
;(function () {
  'use strict';
  if (typeof window === 'undefined') { return; }

  const logger = require('../logger');

  /**
   * Handler for updateTree command — updates the webview store's treeData
   * payload shape: { type: 'updateTree', tree: <tree data> }
   */
  treeDataHandler = function (msg) {
    try {
      if (!msg) { return; }
      const payload = msg.payload || null;
  try { if (typeof window !== 'undefined' && window.store && typeof window.store.setTreeData === 'function') { window.store.setTreeData(payload); } } catch (e) { try { logger.warn('treeDataHandler: setTreeData failed', e); } catch (err) {} }
  try { if (typeof window !== 'undefined' && window.store && typeof window.store.setLoading === 'function') { window.store.setLoading(false); } } catch (e) { try { logger.warn('treeDataHandler: setLoading failed', e); } catch (err) {} }
  } catch (e) { try { logger.warn('treeDataHandler error', e); } catch (err) {} }
  };

  var cmd = (window.COMMANDS && window.COMMANDS.updateTree) ? window.COMMANDS.updateTree : (window.__commandNames && window.__commandNames.updateTree) ? window.__commandNames.updateTree : 'updateTree';
  try {
    if (typeof window !== 'undefined') {
      if (typeof window.registerCommand === 'function') {
          try { window.registerCommand(cmd, treeDataHandler); } catch (e) {
              const { reportError } = require('../utils/errorReporter');
              reportError(e, { file: 'handlers/treeDataHandler.js', command: cmd });
              // registration failure is likely critical - rethrow to surface during dev/tests
              throw e;
          }
      } else if (typeof window.__registerHandler === 'function') {
        try { window.__registerHandler(cmd, treeDataHandler); } catch (e) { /* ignore */ }
      }
    }
  } catch (e) {}
})();
try {
  const registry = require('../commandRegistry');
  if (registry && typeof registry.registerCommand === 'function') {
    registry.registerCommand(cmd, treeDataHandler, { allowMultiple: false });
  }
} catch (e) {}

module.exports = { treeDataHandler };
