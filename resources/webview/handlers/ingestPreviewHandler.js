import { registerHandler } from '../commandRegistry.js';
import { WEBVIEW_COMMANDS } from '../constants.js';

/**
 * Handle `ingestPreview` messages containing a richer preview payload used
 * by the ingest modal or preview panel.
 *
 * Expected message shape:
 * { type: 'ingestPreview', payload: { preview?: { summary?:string, tree?:string }, output?: any, ... } }
 *
 * Side effects:
 * - writes the payload to `window.store.setPreview` so subscribers can react
 * - attempts minimal DOM updates (preview root, text and spinner) for immediate feedback
 *
 * @param {{type?:string, payload?:Object}} msg
 */
function ingestPreviewHandler(msg) {
    try {
        const payload = msg && msg.payload ? msg.payload : {};
        // Only update store; subscribers will update DOM/UI
        try {
            if (window.store && typeof window.store.setPreview === 'function') {
                window.store.setPreview(payload);
            }
        } catch (e) {
            console.warn('ingestPreviewHandler: setPreview failed', e);
        }
    } catch (e) {
        console.warn('ingestPreviewHandler error', e);
    }
};

registerHandler(WEBVIEW_COMMANDS.ingestPreview, ingestPreviewHandler);