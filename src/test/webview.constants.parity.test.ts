/**
 * Ensure runtime webview COMMANDS (resources/webview/constants.js) match the
 * typed map exported from src/types/webview.ts so host and webview stay in sync.
 */

describe('webview command constants parity', () => {
  test('resources/webview/constants.js and src/types/webview.ts have same keys/values', () => {
    // Load the runtime constants (will attach to window if executed in JSDOM)
    jest.resetModules();
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    (global as any).window = dom.window;
    (global as any).document = dom.window.document;

    // Require the constants file which sets window.COMMANDS and exports the object
    const runtimeCommands = require('../../resources/webview/constants.js');

    // Import the TypeScript exported map
    // Use require on the compiled TS via ts-node/ts-jest transform support in jest
    const typed = require('../../src/types/webview.ts');
    const typedMap = typed.WebviewCommands;

    // Basic shape checks
    expect(runtimeCommands).toBeDefined();
    expect(typedMap).toBeDefined();

    const runtimeKeys = Object.keys(runtimeCommands).sort();
    const typedKeys = Object.keys(typedMap).sort();
    expect(runtimeKeys).toEqual(typedKeys);

    // Ensure all values match for each key
    runtimeKeys.forEach((k) => {
      expect(runtimeCommands[k]).toBe(typedMap[k]);
    });
  });
});
