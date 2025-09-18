// Lightweight error reporter for webview handlers
// Provides a single entrypoint to report errors from handlers so
// we don't silently swallow exceptions. Intentionally small and
// best-effort: logs to console.error and forwards to a window-level
// OutputChannel bridge if available (for host-side reporting).
function _safeStringifyContext(ctx) {
  try {
    return JSON.stringify(ctx);
  } catch (e) {
    return String(ctx);
  }
}

function reportError(err, context) {
  try {
    const ctx = context || {};
    try {
      // Console output always available in webviews/tests
      console.error('[webview][errorReporter] Error reported', _safeStringifyContext(ctx), err && (err.stack || err.message || err));
    } catch (e) {
      // swallow logging failures - we can't do more
    }

    // Best-effort: if an OutputChannel bridge exists on window, call it.
    try {
      if (typeof window !== 'undefined' && window.__vscodeOutputChannel && typeof window.__vscodeOutputChannel.append === 'function') {
        const header = `[webview][error] ${ctx && ctx.file ? ctx.file : 'unknown'} ${ctx && ctx.command ? '(' + ctx.command + ')' : ''}`;
        const body = err && err.stack ? err.stack : (err && err.message ? err.message : String(err));
        window.__vscodeOutputChannel.append(`${header} ${body}\n`);
      }
    } catch (e) { /* best-effort bridge failed */ }
  } catch (e) {
    // Last-resort: swallow to avoid throwing from error reporting
  }
}

module.exports = { reportError };
