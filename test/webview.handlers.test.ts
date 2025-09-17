describe('webview handlers (stateHandler, progressHandler)', () => {
  beforeEach(() => {
    // reset global window for each test
    (global as any).window = {};
    (global as any).window.__registeredHandlers = {};
    (global as any).window.__commandRegistry = {};
  });

  test('stateHandler writes state to store.setState', () => {
    // prepare mock store
    const mockSetState = jest.fn();
    const mockStore = { setState: mockSetState };
    (global as any).window.store = mockStore;

    // ensure command name resolution prefers COMMANDS
    (global as any).window.COMMANDS = { state: 'state' };

    // load handler freshly
    try { delete require.cache[require.resolve('../resources/webview/handlers/stateHandler.js')]; } catch (e) {}
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../resources/webview/handlers/stateHandler.js');

    const handler = (global as any).window.__registeredHandlers['state'] || (global as any).window.__commandRegistry && (global as any).window.__commandRegistry['state'];
    expect(typeof handler).toBe('function');

    const payload = { state: { foo: 'bar', paused: true } };
    handler(payload);

    expect(mockSetState).toHaveBeenCalledTimes(1);
    expect(mockSetState).toHaveBeenCalledWith(payload.state);
  });

  test('progressHandler calls store.setLoading with correct values', () => {
    const mockSetLoading = jest.fn();
    const mockStore = { setLoading: mockSetLoading };
    (global as any).window.store = mockStore;
    (global as any).window.COMMANDS = { progress: 'progress' };

    try { delete require.cache[require.resolve('../resources/webview/handlers/progressHandler.js')]; } catch (e) {}
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../resources/webview/handlers/progressHandler.js');

    const handler = (global as any).window.__registeredHandlers['progress'] || (global as any).window.__commandRegistry && (global as any).window.__commandRegistry['progress'];
    expect(typeof handler).toBe('function');

    handler({ event: { op: 'scan', mode: 'start' } });
    expect(mockSetLoading).toHaveBeenCalledWith('scan', true);

    handler({ event: { op: 'scan', mode: 'end' } });
    expect(mockSetLoading).toHaveBeenCalledWith('scan', false);
  });
});
