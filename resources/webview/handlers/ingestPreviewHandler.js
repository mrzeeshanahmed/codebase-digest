;(function () {
  'use strict';
  if (typeof window === 'undefined') { return; }

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

  if (typeof window.__registerHandler === 'function') { try { window.__registerHandler('ingestPreview', ingestPreviewHandler); } catch (e) {} }
  try { if (!window.__registeredHandlers) { window.__registeredHandlers = {}; } window.__registeredHandlers['ingestPreview'] = ingestPreviewHandler; } catch (e) {}
  try { if (!window.__commandRegistry) { window.__commandRegistry = {}; } window.__commandRegistry['ingestPreview'] = ingestPreviewHandler; } catch (e) {}
})();