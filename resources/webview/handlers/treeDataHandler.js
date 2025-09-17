;(function () {
  'use strict';
  if (typeof window === 'undefined') { return; }

  /**
   * Handler for updateTree command — updates the webview store's treeData
   * payload shape: { type: 'updateTree', tree: <tree data> }
   */
  const treeDataHandler = function (msg) {
    try {
      const tree = msg && (msg.tree || msg.fileTree) ? (msg.tree || msg.fileTree) : null;
      if (window.store && typeof window.store.setTreeData === 'function') {
        try { window.store.setTreeData(tree); } catch (e) { console && console.warn && console.warn('treeDataHandler: setTreeData failed', e); }
      }
    } catch (e) { console && console.warn && console.warn('treeDataHandler error', e); }
  };

  var cmd = (window.COMMANDS && window.COMMANDS.updateTree) ? window.COMMANDS.updateTree : (window.__commandNames && window.__commandNames.updateTree) ? window.__commandNames.updateTree : 'updateTree';
  if (typeof window.__registerHandler === 'function') {
    try { window.__registerHandler(cmd, treeDataHandler); } catch (e) { }
  }
  try { if (!window.__registeredHandlers) { window.__registeredHandlers = {}; } window.__registeredHandlers[cmd] = treeDataHandler; } catch (e) {}
  try { if (!window.__commandRegistry) { window.__commandRegistry = {}; } window.__commandRegistry[cmd] = treeDataHandler; } catch (e) {}
})();
