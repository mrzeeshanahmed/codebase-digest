import { registerHandler } from '../commandRegistry.js';
import { WEBVIEW_COMMANDS } from '../constants.js';

/**
 * Handle `restoredState` messages which provide persisted UI state to reapply
 * after a webview restore.
 *
 * Expected message shape:
 * { type: 'restoredState', state: { selectedFiles?: string[], focusIndex?: number } }
 *
 * Side effects:
 * - writes a pending persisted selection into `window.store` via `setPendingPersistedSelection`
 *   so subscribers may apply the selection once the tree has been hydrated.
 *
 * @param {{type?:string, state?:{selectedFiles?:string[], focusIndex?:number}}} msg
 */
function restoredStateHandler(msg) {
    try {
        const s = msg && msg.state ? msg.state : {};
        try { if (window.store && typeof window.store.setPendingPersistedSelection === 'function') { window.store.setPendingPersistedSelection(Array.isArray(s.selectedFiles) ? s.selectedFiles.slice() : null, typeof s.focusIndex === 'number' ? s.focusIndex : undefined); } } catch (e) { console.warn('restoredStateHandler: setPendingPersistedSelection failed', e); }
        if (Array.isArray(s.selectedFiles) && s.selectedFiles.length > 0) {
            const sel = s.selectedFiles.slice();
            try { window.store && window.store.setPendingPersistedSelection && window.store.setPendingPersistedSelection(sel, typeof s.focusIndex === 'number' ? s.focusIndex : undefined); } catch (e) { }
        }
        if (s.focusIndex !== undefined && typeof s.focusIndex === 'number') {
            try { window.store && window.store.setPendingPersistedSelection && window.store.setPendingPersistedSelection(null, s.focusIndex); } catch (e) { }
        }
    } catch (e) { console.warn('restoredStateHandler error', e); }
};

registerHandler(WEBVIEW_COMMANDS.restoredState, restoredStateHandler);