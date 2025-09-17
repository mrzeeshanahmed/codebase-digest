// Test ingestPreviewHandler updates the store and DOM preview text

(global as any).window = {};

// Setup minimal DOM for the ingest preview text
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="ingest-preview"><div id="ingest-preview-text"></div><div id="ingest-spinner"></div></div></body></html>');
(global as any).document = dom.window.document;
(global as any).window.document = dom.window.document;

// Provide lightweight nodes map used by handlers and registry surfaces
(global as any).window.__registeredHandlers = {};
(global as any).window.__registerHandler = function (type: string, fn: any) {
  (global as any).window.__registeredHandlers[type] = fn;
};

// Load handler module (it should register itself) after we attach store in beforeEach
describe('ingestPreviewHandler', () => {
  let wvStoreLocal: any;
  beforeEach(() => {
    try { delete require.cache[require.resolve('../../resources/webview/store.js')]; } catch (e) {}
    wvStoreLocal = require('../../resources/webview/store.js');
    (global as any).window.store = wvStoreLocal;
    // set nodes map used by handler
    (global as any).nodes = { ingestPreviewRoot: document.getElementById('ingest-preview'), ingestPreviewText: document.getElementById('ingest-preview-text'), ingestSpinner: document.getElementById('ingest-spinner') };
    // reset state and DOM
    try { wvStoreLocal.setState({ ingestPreview: null }); } catch (e) {}
    document.getElementById('ingest-preview-text')!.textContent = '';
    try { delete require.cache[require.resolve('../../resources/webview/handlers/ingestPreviewHandler.js')]; } catch (e) {}
    require('../../resources/webview/handlers/ingestPreviewHandler.js');
  });

  test('handler is registered and updates store and DOM', () => {
    const handler = (global as any).window.__registeredHandlers['ingestPreview'] || (global as any).window.__commandRegistry && (global as any).window.__commandRegistry['ingestPreview'];
    expect(typeof handler).toBe('function');
    const payload = { preview: { summary: 'OK', tree: 'a/b/c' }, output: 'out' };
    handler({ payload });
    const s = (global as any).window.store.getState();
    expect(s.ingestPreview).toBeDefined();
    const text = document.getElementById('ingest-preview-text')!.textContent;
    expect(text).toMatch(/OK/);
  });
});
