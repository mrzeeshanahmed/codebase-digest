import { registerHandler } from '../commandRegistry.js';
import { WEBVIEW_COMMANDS } from '../constants.js';

/**
 * Handle a full `state` snapshot message from the extension host.
 *
 * Expected message shape:
 * { type: 'state', state: { ... } }
 *
 * Side effects:
 * - writes the snapshot into `window.store` using `setState` (merge semantics)
 * - updates UI pause controls via `updatePauseButton` if present
 *
 * The handler is defensive and will not throw when store or helpers are absent.
 *
 * @param {{type?:string, state?:Object}} msg
 */
function stateHandler(msg) {
    try {
        const s = msg && msg.state ? msg.state : {};
        // Pure state update only: push incoming state into the store
        try {
            if (window.store && typeof window.store.setState === 'function') { window.store.setState(s); }
            // Also set the treeData if present on the snapshot for sidebar rendering
            try {
                const tree = s && (s.fileTree || s.tree || s.fileTree === null ? s.fileTree : null);
                if (typeof window.store.setTreeData === 'function') {
                    // Prefer explicit fileTree when provided, otherwise pass the whole state
                    window.store.setTreeData(s.fileTree || s);
                }
            } catch (e) { /* ignore tree set errors */ }
        } catch (e) { console.warn('stateHandler: store.setState failed', e); }

        // Update pause button if present
        try {
            if (typeof s.paused !== 'undefined' && typeof updatePauseButton === 'function') {
                paused = !!s.paused; updatePauseButton();
            }
        } catch (e) { }
    } catch (e) { console.warn('stateHandler error', e); }
};

registerHandler(WEBVIEW_COMMANDS.state, stateHandler);