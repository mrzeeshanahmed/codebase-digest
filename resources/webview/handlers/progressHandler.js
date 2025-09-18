import { registerHandler } from '../commandRegistry.js';
import { WEBVIEW_COMMANDS } from '../constants.js';

/**
 * Handle `progress` events describing long-running operations.
 *
 * Expected message shape:
 * { type: 'progress', event: { op: string, mode: 'start'|'update'|'end', percent?: number } }
 *
 * Side effects:
 * - updates `window.store.loading[op]` via `setLoading` (true for start/update, false for end)
 * - optionally delegates to legacy UI hooks (`window.__handleProgress` or `handleProgress`) for immediate handling
 *
 * @param {{type?:string, event?:{op?:string, mode?:string, percent?:number}}} msg
 */
function progressHandler(msg) {
    try {
        const e = msg && msg.event ? msg.event : null;
        if (window.store && e) {
            window.store.setProgress(e);
        }
    } catch (err) { console.warn('progressHandler error', err); }
};

registerHandler(WEBVIEW_COMMANDS.progress, progressHandler);