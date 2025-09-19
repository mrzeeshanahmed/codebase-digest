/**
 * Verify the webview logger forwards messages to window.__cbd_postLog when configured.
 */
describe('webview.logger forwarding', () => {
  beforeEach(() => {
    // Reset any global provided by the logger module
    try { delete (global as any).vscode; } catch (e) {}
    try { delete (global as any).__cbd_postLog; } catch (e) {}
    try { delete (global as any).__cbd_logger; } catch (e) {}
    // Re-require to ensure logger bootstraps into window.__cbd_logger
    jest.resetModules();
  });

  test('forwards to window.__cbd_postLog with correct shape', () => {
    const calls: any[] = [];
    // provide a window-level postLog bridge
    (global as any).__cbd_postLog = (payload: any) => { calls.push(payload); };
    // Load the logger (it writes into window.__cbd_logger when exports undefined)
    require('../../resources/webview/logger');

    // Obtain the exported logger instance from window.__cbd_logger
    const logger = (global as any).__cbd_logger;
    expect(logger).toBeDefined();
    logger.info('hello', { a: 1 });
    logger.warn('warn-me');
    logger.error('boom');

    // The bridge should have been invoked for each call (3 times)
    expect(calls.length).toBeGreaterThanOrEqual(3);
    // Each call must have level and args
    for (const c of calls) {
      expect(c).toHaveProperty('level');
      expect(c).toHaveProperty('args');
      expect(Array.isArray(c.args) || typeof c.args === 'object').toBeTruthy();
    }
  });
});
