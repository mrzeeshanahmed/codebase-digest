import { registerHandler } from '../commandRegistry.js';
import { WEBVIEW_COMMANDS } from '../constants.js';

/**
 * Handle `config` messages delivering workspace or folder settings.
 *
 * Expected message shape:
 * { type: 'config', folderPath?: string, workspaceFolder?: string, settings: Object }
 *
 * Side effects:
 * - updates `window.currentFolderPath` for context
 * - writes `settings` into `window.store` via `setState({ settings })`
 * - optionally calls UI helpers to populate settings and active preset UI
 *
 * @param {{type?:string, folderPath?:string, workspaceFolder?:string, settings?:Object}} msg
 */
function configHandler(msg) {
    try {
        try { window.currentFolderPath = msg.folderPath || msg.workspaceFolder || window.currentFolderPath; } catch (e) { }
        // Push settings into store so subscribers can populate settings UI
        try { if (window.store && typeof window.store.setState === 'function') { window.store.setState({ settings: msg.settings || {} }); } } catch (e) { console.warn('configHandler: store.setState failed', e); }
    } catch (e) { console.warn('configHandler error', e); }
};

registerHandler(WEBVIEW_COMMANDS.config, configHandler);