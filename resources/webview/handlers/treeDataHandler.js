import { registerHandler } from '../commandRegistry.js';
import { WEBVIEW_COMMANDS } from '../constants.js';

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

registerHandler(WEBVIEW_COMMANDS.updateTree, treeDataHandler);
