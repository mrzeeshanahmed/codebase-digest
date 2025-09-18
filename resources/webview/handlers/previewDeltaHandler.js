import { registerHandler } from '../commandRegistry.js';
import { WEBVIEW_COMMANDS } from '../constants.js';

/**
 * Handle `previewDelta` messages from the extension host.
 *
 * Expected message shape:
 * {
 *   type: 'previewDelta',
 *   delta: {
 *     // optional fileTree object to replace current tree
 *     fileTree?: Object,
 *     // optional array of selectedPaths to apply with the tree
 *     selectedPaths?: string[],
 *     // quick preview properties such as tokenEstimate, selectedCount, etc.
 *   }
 * }
 *
 * Side effects:
 * - writes `fileTree` and `selectedPaths` to `window.store` via `setFileTree` if present
 * - writes the compact delta to `window.store.setPreviewDelta` so subscribers react
 * - calls optional UI helpers `renderPreviewDelta` and `renderTree` for immediate feedback
 *
 * The handler registers itself on `window.__registerHandler`, `window.__registeredHandlers`
 * and `window.__commandRegistry` for compatibility with lightweight test harnesses.
 *
 * The function is defensive: it checks for the presence of `window.store` and helper
 * functions and logs warnings on failures without throwing.
 *
 * @param {{type?:string, delta?:Object}} msg
 */
function previewDeltaHandler(msg) {
    try {
        const d = msg && msg.delta ? msg.delta : {};
        // invocation

        // Update fileTree first (if present) so subscribers that depend on tree
        // state observe the latest structure before preview is set.
        if (d && d.fileTree && window.store && window.store.setFileTree) {
            try { window.store.setFileTree(d.fileTree, Array.isArray(d.selectedPaths) ? d.selectedPaths : []); } catch (e) { console.warn('previewDeltaHandler: setFileTree failed', e); }
            // after setFileTree
        }

        // Push delta to store so subscribers can react to preview changes
        if (window.store && typeof window.store.setPreviewDelta === 'function') {
            try { window.store.setPreviewDelta(d); } catch (e) { console.warn('previewDeltaHandler: setPreviewDelta failed', e); }
        }

    } catch (e) { console.warn('previewDeltaHandler error', e); }
};

registerHandler(WEBVIEW_COMMANDS.previewDelta, previewDeltaHandler);