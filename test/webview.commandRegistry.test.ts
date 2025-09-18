import path from 'path';

// The registry is a plain JS module used by the webview bundle. Tests will require it
// from the built resources path where it's available during test runs.
// We'll resolve the module path relative to the repository root.

const registryPath = path.resolve(__dirname, '..', 'resources', 'webview', 'commandRegistry.js');

function reloadRegistry() {
  // Clear from require cache and re-require a fresh copy for isolation between tests
  delete require.cache[registryPath];
  return require(registryPath);
}

describe('webview commandRegistry', () => {
  test('duplicate registration without allowMultiple throws', () => {
    const registry = reloadRegistry();
    const cmd = 'testDup';
    const handler = () => {};
    registry.registerCommand(cmd, handler);

    expect(() => {
      registry.registerCommand(cmd, handler);
    }).toThrow();

    // cleanup
    registry.resetRegistry && registry.resetRegistry();
  });

  test('allowMultiple permits duplicate handlers and preserves order on dispatch', () => {
    const registry = reloadRegistry();
    const cmd = 'multi';
    const calls: string[] = [];

    const h1 = () => calls.push('h1');
    const h2 = () => calls.push('h2');
    const h3 = () => calls.push('h3');

    registry.registerCommand(cmd, h1, { allowMultiple: true });
    registry.registerCommand(cmd, h2, { allowMultiple: true });
    registry.registerCommand(cmd, h3, { allowMultiple: true });

    // dispatch should call handlers in registration order
    registry.dispatch(cmd, { hello: 'world' });
    expect(calls).toEqual(['h1', 'h2', 'h3']);

    // getHandlers returns array in same order
    const handlers = registry.getHandlers(cmd);
    expect(Array.isArray(handlers)).toBe(true);
    expect(handlers.length).toBe(3);
    expect(handlers[0]).toBe(h1);
    expect(handlers[1]).toBe(h2);
    expect(handlers[2]).toBe(h3);

    // cleanup
    registry.resetRegistry && registry.resetRegistry();
  });

  test('unregisterCommand removes specific handler and others remain', () => {
    const registry = reloadRegistry();
    const cmd = 'unreg';

    const calls: string[] = [];
    const h1 = () => calls.push('h1');
    const h2 = () => calls.push('h2');

    registry.registerCommand(cmd, h1, { allowMultiple: true });
    registry.registerCommand(cmd, h2, { allowMultiple: true });

    registry.unregisterCommand(cmd, h1);

    registry.dispatch(cmd, {});
    expect(calls).toEqual(['h2']);

    // cleanup
    registry.resetRegistry && registry.resetRegistry();
  });

  test('getHandlers returns empty array for unknown command', () => {
    const registry = reloadRegistry();
    const arr = registry.getHandlers('no-such-cmd');
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBe(0);
  });
});
