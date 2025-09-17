// Test previewDelta handler updates the store appropriately

// Provide a minimal global/window and a mock register function
(global as any).window = {};

// Import a fresh store instance to attach to window
const wvStore: any = require('../../resources/webview/store.js');
(global as any).window.store = wvStore;

// Simple registry to capture handlers
(global as any).window.__registeredHandlers = {};
(global as any).window.__registerHandler = function (type: string, fn: any) {
  (global as any).window.__registeredHandlers[type] = fn;
};

// Register and test the handler
describe('previewDeltaHandler', () => {
  beforeEach(() => {
    // Reset store and registry
    wvStore.setState({ fileTree: {}, previewDelta: null, selectedPaths: [] });
    (global as any).window.__registeredHandlers = {};
    (global as any).window.__registerHandler = function (type: string, fn: any) {
      (global as any).window.__registeredHandlers[type] = fn;
    };
  // Clear require cache then require the handler file so it registers itself into our registry
  try { delete require.cache[require.resolve('../../resources/webview/handlers/previewDeltaHandler.js')]; } catch (e) {}
  require('../../resources/webview/handlers/previewDeltaHandler.js');
  });

  test('handler is registered', () => {
    const reg = (global as any).window;
    const h = (reg.__registeredHandlers && reg.__registeredHandlers['previewDelta']) ||
              (reg.__commandRegistry && reg.__commandRegistry['previewDelta']) ||
              (reg.__commandRegistryApi && typeof reg.__commandRegistryApi.getHandler === 'function' && reg.__commandRegistryApi.getHandler('previewDelta'));
    expect(typeof h).toBe('function');
  });

  test('invoking handler sets preview delta and fileTree', () => {
    const reg = (global as any).window;
    const handler = (reg.__registeredHandlers && reg.__registeredHandlers['previewDelta']) ||
                    (reg.__commandRegistry && reg.__commandRegistry['previewDelta']) ||
                    (reg.__commandRegistryApi && typeof reg.__commandRegistryApi.getHandler === 'function' && reg.__commandRegistryApi.getHandler('previewDelta'));
    // Defensive: if handler isn't a function, print debug info to help diagnose
    if (typeof handler !== 'function') {
      console.error('previewDelta handler not a function; registry keys:', Object.keys(reg.__registeredHandlers || {}));
    }
    const delta = { tokenEstimate: 123, fileTree: { a: { __isFile: true, path: 'a' } }, selectedPaths: ['a'] };
    handler({ delta });
    const s = (global as any).window.store && (global as any).window.store.getState ? (global as any).window.store.getState() : wvStore.getState();
    expect(s.previewDelta).toEqual(delta);
    expect(s.fileTree).toEqual(delta.fileTree);
    expect(Array.isArray(s.selectedPaths) && s.selectedPaths[0] === 'a').toBe(true);
  });
});
