// Webview-side logger: prefixes messages and channels to console. Optionally
// forwards messages back to the extension via vscode.postMessage when
// window.__cbd_postLog is provided.
(function(exports){
  const DEFAULT = { debugEnabled: false };
  let opts = Object.assign({}, DEFAULT);

  function configure(o) { opts = Object.assign({}, DEFAULT, o || {}); }

  function format(prefix, args) {
    try {
      const ts = new Date().toISOString();
      const out = Array.prototype.slice.call(args).map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      return `${ts} [${prefix}] ${out}`;
    } catch (e) { return `[${prefix}]`; }
  }

  function forward(level, args) {
    try {
      if (typeof vscode !== 'undefined' && typeof vscode.postMessage === 'function') {
        try { vscode.postMessage({ type: 'log', level, args }); } catch (e) { /* ignore */ }
      }
      if (typeof window !== 'undefined' && typeof window.__cbd_postLog === 'function') {
        try { window.__cbd_postLog({ level, args }); } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
  }

  function info() { try { console.info('[codebase-digest]', ...arguments); forward('info', arguments); } catch (e) {} }
  function warn() { try { console.warn('[codebase-digest]', ...arguments); forward('warn', arguments); } catch (e) {} }
  function error() { try { console.error('[codebase-digest]', ...arguments); forward('error', arguments); } catch (e) {} }
  function debug() { try { if (!opts.debugEnabled) { return; } console.debug('[codebase-digest]', ...arguments); forward('debug', arguments); } catch (e) {} }

  exports.configure = configure;
  exports.info = info;
  exports.warn = warn;
  exports.error = error;
  exports.debug = debug;

})(typeof exports === 'undefined' ? (window.__cbd_logger = {}) : exports);
