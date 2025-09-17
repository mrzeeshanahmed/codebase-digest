// Verify that webview handlers register under the centralized command names

(global as any).window = {};

// Load the commands constants which should initialize window.__commandNames
require('../../resources/webview/commands.js');

// Minimal command registry surfaces used by handlers
(global as any).window.__commandRegistry = {};
(global as any).window.__registerHandler = function (type: string, fn: any) {
  (global as any).window.__commandRegistry[type] = fn;
};

// Load one handler module that registers itself
try { delete require.cache[require.resolve('../../resources/webview/handlers/previewDeltaHandler.js')]; } catch (e) {}
require('../../resources/webview/handlers/previewDeltaHandler.js');

describe('webview command constants and handler registration', () => {
  test('commands.js defines __commandNames on window', () => {
    expect((global as any).window.__commandNames).toBeDefined();
    expect(typeof (global as any).window.__commandNames.previewDelta).toBe('string');
  });

  test('previewDeltaHandler registers under command constant', () => {
    const cmd = (global as any).window.__commandNames.previewDelta;
    expect(typeof cmd).toBe('string');
    expect(typeof (global as any).window.__commandRegistry[cmd]).toBe('function');
  });
});
