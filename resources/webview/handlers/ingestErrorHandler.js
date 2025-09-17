;(function () {
  'use strict';
  if (typeof window === 'undefined') { return; }

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
  var ingestErrorHandler = function (msg) {
    try {
      // Push error into store; subscribers may show toast / update ingest UI
      try { if (window.store && typeof window.store.addError === 'function') { window.store.addError(msg.error || 'Ingest failed'); } } catch (e) { console.warn('ingestErrorHandler: addError failed', e); }

      if (window.store && window.store.addError) {
        try { window.store.addError(msg.error || 'Ingest error'); } catch (e) {}
      }
      try {
        const previewRoot = (typeof nodes !== 'undefined' && nodes.ingestPreviewRoot) ? nodes.ingestPreviewRoot : document.getElementById('ingest-preview');
        const spinner = (typeof nodes !== 'undefined' && nodes.ingestSpinner) ? nodes.ingestSpinner : document.getElementById('ingest-spinner');
        const textEl = (typeof nodes !== 'undefined' && nodes.ingestPreviewText) ? nodes.ingestPreviewText : document.getElementById('ingest-preview-text');
        if (previewRoot) { previewRoot.classList.remove('loading'); }
        if (spinner) { spinner.hidden = true; spinner.setAttribute('aria-hidden', 'true'); }
        if (textEl) { textEl.textContent = ''; }
        if (typeof showToast === 'function') { showToast('Ingest failed: ' + (msg.error || 'unknown'), 'error', 6000); }
      } catch (e) { console.warn('ingestError DOM update failed', e); }
    } catch (e) { console.warn('ingestErrorHandler error', e); }
  };

  var cmd = (window.COMMANDS && window.COMMANDS.ingestError) ? window.COMMANDS.ingestError : (window.__commandNames && window.__commandNames.ingestError) ? window.__commandNames.ingestError : 'ingestError';
  if (typeof window.__registerHandler === 'function') { try { window.__registerHandler(cmd, ingestErrorHandler); } catch (e) {} }
  try { if (!window.__registeredHandlers) { window.__registeredHandlers = {}; } window.__registeredHandlers[cmd] = ingestErrorHandler; } catch (e) {}
  try { if (!window.__commandRegistry) { window.__commandRegistry = {}; } window.__commandRegistry[cmd] = ingestErrorHandler; } catch (e) {}
})();