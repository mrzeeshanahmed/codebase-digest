import { registerHandler } from '../commandRegistry.js';
import { WEBVIEW_COMMANDS } from '../constants.js';

/**
 * Handle `ingestError` messages reported by the host when ingest fails.
 *
 * Expected message shape:
 * { type: 'ingestError', error: string }
 *
 * Side effects:
 * - appends the error message to `window.store.errors` via `addError`
 * - attempts to clear the ingest preview UI (spinner/text) and show a toast
 *
 * @param {{type?:string, error?:string}} msg
 */
function ingestErrorHandler(msg) {
    try {
        // Push error into store; subscribers may show toast / update ingest UI
        try { if (window.store && typeof window.store.addError === 'function') { window.store.addError(msg.error || 'Ingest failed'); } } catch (e) { console.warn('ingestErrorHandler: addError failed', e); }
    } catch (e) { console.warn('ingestErrorHandler error', e); }
};

registerHandler(WEBVIEW_COMMANDS.ingestError, ingestErrorHandler);