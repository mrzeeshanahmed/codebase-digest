import { registerHandler } from '../commandRegistry.js';
import { WEBVIEW_COMMANDS } from '../constants.js';

/**
 * Handle `generationResult` messages produced after a digest generation run.
 *
 * Expected message shape:
 * { type: 'generationResult', result: { redactionApplied?: boolean, error?: string, ... } }
 *
 * Side effects:
 * - writes `lastGenerationResult` into the store (so subscribers can show warnings)
 * - appends errors to `store.errors` and shows toasts as appropriate
 * - clears transient UI override flags used for disabling redaction
 *
 * @param {{type?:string, result?:Object}} msg
 */
function generationResultHandler(msg) {
    try {
        const res = msg && msg.result ? msg.result : {};
        // Store generation result metadata so subscribers can show toasts / update UI
        try {
            if (window.store && typeof window.store.setState === 'function') {
                window.store.setState({
                    lastGenerationResult: res,
                    pendingOverrideUsed: false,
                    overrideDisableRedaction: false,
                });
            }
        } catch (e) { console.warn('generationResultHandler: store.setState failed', e); }
        // Track transient override flags in store so UI subscribers can clear UI state
        try { if (res && res.error) { window.store && window.store.addError && window.store.addError(String(res.error)); } } catch (e) { }
    } catch (e) { console.warn('generationResultHandler error', e); }
};

registerHandler(WEBVIEW_COMMANDS.generationResult, generationResultHandler);