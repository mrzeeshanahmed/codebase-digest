;(function () {
  'use strict';
  if (typeof window === 'undefined') { return; }

  var generationResultHandler = function (msg) {
    try {
      const res = msg && msg.result ? msg.result : {};
      // Store generation result metadata so subscribers can show toasts / update UI
      try { if (window.store && typeof window.store.setState === 'function') { window.store.setState({ lastGenerationResult: res }); } } catch (e) { console.warn('generationResultHandler: store.setState failed', e); }
      // Track transient override flags in store so UI subscribers can clear UI state
      try { if (res && res.error) { window.store && window.store.addError && window.store.addError(String(res.error)); } } catch (e) {}

      if (res.redactionApplied && typeof showToast === 'function') {
        showToast('Output contained redacted content (masked). Toggle "Show redacted" in Settings to reveal.', 'warn', 6000);
      }
      if (res && res.error) {
        if (typeof showToast === 'function') { showToast(String(res.error), 'warn', 6000); }
        // clear transient override state in UI
        try {
          if (window.pendingOverrideUsed) { window.pendingOverrideUsed = false; }
          window.overrideDisableRedaction = false;
          const rb = document.getElementById('btn-disable-redaction');
          if (rb) { try { rb.setAttribute('aria-pressed', 'false'); } catch (e) {} try { rb.classList.remove('active'); } catch (e) {} }
        } catch (e) {}
      } else {
        try { window.pendingOverrideUsed = false; window.overrideDisableRedaction = false; const rb = document.getElementById('btn-disable-redaction'); if (rb) { try { rb.setAttribute('aria-pressed', 'false'); } catch (ex) {} try { rb.classList.remove('active'); } catch (ex) {} try { rb.removeAttribute('data-pending-override'); } catch (ex) {} } } catch (e) {}
      }
    } catch (e) { console.warn('generationResultHandler error', e); }
  };

  if (typeof window.__registerHandler === 'function') { try { window.__registerHandler('generationResult', generationResultHandler); } catch (e) {} }
  try { if (!window.__registeredHandlers) { window.__registeredHandlers = {}; } window.__registeredHandlers['generationResult'] = generationResultHandler; } catch (e) {}
  try { if (!window.__commandRegistry) { window.__commandRegistry = {}; } window.__commandRegistry['generationResult'] = generationResultHandler; } catch (e) {}
})();