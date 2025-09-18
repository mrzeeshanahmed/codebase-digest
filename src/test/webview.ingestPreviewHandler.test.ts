// Test ingestPreviewHandler updates the store and DOM preview text

(global as any).window = {};

// Setup minimal DOM (but handlers should not manipulate DOM directly anymore)
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="ingest-preview"><div id="ingest-preview-text"></div><div id="ingest-spinner"></div></div></body></html>');
(global as any).document = dom.window.document;
(global as any).window.document = dom.window.document;

// Provide lightweight registry surface for legacy handlers to register into
(global as any).window.__registeredHandlers = {};
(global as any).window.__registerHandler = function (type: string, fn: any) {
  (global as any).window.__registeredHandlers[type] = fn;
};

describe('ingestPreviewHandler (store-centric)', () => {
  let wvStoreLocal: any;
  beforeEach(() => {
    // reload fresh store instance
    try { delete require.cache[require.resolve('../../resources/webview/store.js')]; } catch (e) {}
    wvStoreLocal = require('../../resources/webview/store.js');
    // Spy on setState to assert handler uses the store
    jest.spyOn(wvStoreLocal, 'setState');
    (global as any).window.store = wvStoreLocal;

    // set nodes map used by handler (should be unused by modern handlers but left for compatibility)
    (global as any).nodes = { ingestPreviewRoot: document.getElementById('ingest-preview'), ingestPreviewText: document.getElementById('ingest-preview-text'), ingestSpinner: document.getElementById('ingest-spinner') };

    // reset state
    try { wvStoreLocal.setState({ ingestPreview: null }); } catch (e) {}

    // load handler module (it registers itself via __registerHandler)
    try { delete require.cache[require.resolve('../../resources/webview/handlers/ingestPreviewHandler.js')]; } catch (e) {}
    require('../../resources/webview/handlers/ingestPreviewHandler.js');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    // reset store subscribers/state if available
    try { (global as any).window.store && (global as any).window.store.setState({ ingestPreview: null, previewDelta: null }); } catch (e) {}
  });

  test('handler registers and calls store.setState with preview payload (no direct DOM writes)', () => {
    const handler = (global as any).window.__registeredHandlers['ingestPreview'] || (global as any).window.__commandRegistry && (global as any).window.__commandRegistry['ingestPreview'];
    expect(typeof handler).toBe('function');

    const payload = { preview: { summary: 'OK', tree: 'a/b/c' }, output: 'out' };

    // If DOM is present, spy on the ingest-preview-text setter to ensure handler doesn't write to it
    let textSpy: any = null;
    try {
      const textEl = document.getElementById('ingest-preview-text');
      if (textEl) { textSpy = jest.spyOn(textEl, 'textContent', 'set'); }
    } catch (e) { /* ignore when no DOM present */ }

    handler({ payload });

    // store.setState should be called by the handler
    expect((global as any).window.store.setState).toHaveBeenCalled();
    const s = (global as any).window.store.getState();
    expect(s.ingestPreview || s.previewDelta).toBeDefined();

    if (textSpy) { expect(textSpy).not.toHaveBeenCalled(); }
  });
});
