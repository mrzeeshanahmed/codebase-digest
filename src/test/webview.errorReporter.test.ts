describe('webview utils errorReporter', () => {
  beforeEach(() => {
    // ensure a fresh module
    try { delete require.cache[require.resolve('../../resources/webview/utils/errorReporter.js')]; } catch (e) {}
    (global as any).window = (global as any).window || {};
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete (global as any).window.__vscodeOutputChannel;
  });

  test('reportError logs to console.error', () => {
    const reporter = require('../../resources/webview/utils/errorReporter.js');
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const err = new Error('boom');
    reporter.reportError(err, { file: 'testfile.js', command: 'doIt' });

    expect(spy).toHaveBeenCalled();
    const callArgs = spy.mock.calls[0];
    expect(callArgs[0]).toMatch(/\[webview\]\[errorReporter\] Error reported/);
    spy.mockRestore();
  });

  test('reportError forwards to window.__vscodeOutputChannel.append when available', () => {
    const reporter = require('../../resources/webview/utils/errorReporter.js');
    const appendSpy = jest.fn();
    (global as any).window.__vscodeOutputChannel = { append: appendSpy };

    const err = new Error('forward');
    reporter.reportError(err, { file: 'forward.js', command: 'fwd' });

    expect(appendSpy).toHaveBeenCalled();
    const arg = appendSpy.mock.calls[0][0];
    expect(arg).toMatch(/\[webview\]\[error\] forward.js/);
  });

  test('reportError never throws even if logging bridges throw', () => {
    const reporter = require('../../resources/webview/utils/errorReporter.js');
    // Make console.error throw
    const origConsoleError = console.error;
    console.error = () => { throw new Error('logging failed'); };
    // Make output channel throw
    (global as any).window.__vscodeOutputChannel = { append: () => { throw new Error('append failed'); } };

    expect(() => {
      reporter.reportError(new Error('boom'), { file: 'swallow.js' });
    }).not.toThrow();

    // restore
    console.error = origConsoleError;
  });
});
