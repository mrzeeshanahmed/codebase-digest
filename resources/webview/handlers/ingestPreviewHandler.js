;(function () {
  'use strict';
  if (typeof window === 'undefined') { return; }

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
  var ingestPreviewHandler = function (msg) {
    try {
      const payload = msg && msg.payload ? msg.payload : {};
      // Only update store; subscribers will update DOM/UI
      try { if (window.store && typeof window.store.setPreview === 'function') { window.store.setPreview(payload); } } catch (e) { console.warn('ingestPreviewHandler: setPreview failed', e); }

      // Maintain existing DOM behavior if helpers exist
      try {
        const previewRoot = (typeof nodes !== 'undefined' && nodes.ingestPreviewRoot) ? nodes.ingestPreviewRoot : document.getElementById('ingest-preview');
        const textEl = (typeof nodes !== 'undefined' && nodes.ingestPreviewText) ? nodes.ingestPreviewText : document.getElementById('ingest-preview-text');
        const spinner = (typeof nodes !== 'undefined' && nodes.ingestSpinner) ? nodes.ingestSpinner : document.getElementById('ingest-spinner');
        if (previewRoot) { previewRoot.classList.remove('loading'); }
        if (spinner) { spinner.hidden = true; spinner.setAttribute('aria-hidden', 'true'); }
        if (textEl) {
          const p = payload.preview;
          if (p) { textEl.textContent = (p.summary || '') + '\n\n' + (p.tree || ''); }
          else if (payload.output) { textEl.textContent = String(payload.output).slice(0, 2000); }
          else { textEl.textContent = 'No preview available'; }
        }
      } catch (e) { console.warn('ingestPreview DOM update failed', e); }
    } catch (e) { console.warn('ingestPreviewHandler error', e); }
  };

  var cmd = (window.COMMANDS && window.COMMANDS.ingestPreview) ? window.COMMANDS.ingestPreview : (window.__commandNames && window.__commandNames.ingestPreview) ? window.__commandNames.ingestPreview : 'ingestPreview';
  if (typeof window.__registerHandler === 'function') { try { window.__registerHandler(cmd, ingestPreviewHandler); } catch (e) {} }
  try { if (!window.__registeredHandlers) { window.__registeredHandlers = {}; } window.__registeredHandlers[cmd] = ingestPreviewHandler; } catch (e) {}
  try { if (!window.__commandRegistry) { window.__commandRegistry = {}; } window.__commandRegistry[cmd] = ingestPreviewHandler; } catch (e) {}
})();