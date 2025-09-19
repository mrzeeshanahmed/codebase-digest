// Lightweight error reporter for webview handlers
// Provides a single entrypoint to report errors from handlers so
// we don't silently swallow exceptions. Intentionally small and
// best-effort: logs to console.error and forwards to a window-level
// OutputChannel bridge if available (for host-side reporting).
function _safeStringifyContext(ctx) {
  try { return JSON.stringify(ctx); } catch (e) { return String(ctx); }
}
// Use the shared logger module when available
var logger = null;
try { if (typeof require === 'function') { logger = require('../logger'); } } catch (e) { /* best-effort */ }

function _webviewLog(level /*, ...args */) {
  try {
    const args = Array.prototype.slice.call(arguments, 1);
    if (logger && typeof logger[level] === 'function') {
      try { logger[level].apply(null, args); return; } catch (e) { /* fallthrough */ }
    }
    try { const c = console || {}; if (c[level]) { c[level].apply(c, args); } else if (c.error) { c.error.apply(c, args); } } catch (e) {}
  } catch (e) {}
}

function reportError(err, context) {
  try {
    const ctx = context || {};
    try {
      const args = ['[webview][errorReporter] Error reported', _safeStringifyContext(ctx), err && (err.stack || err.message || err)];
      // Ensure console.error receives the readable message first (tests rely on this)
      try { console && console.error && console.error.apply(console, args); } catch (e) { /* swallow */ }
      try { _webviewLog('error', ...args); } catch (e) { /* swallow */ }
    } catch (e) { /* swallow logging failures */ }

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
