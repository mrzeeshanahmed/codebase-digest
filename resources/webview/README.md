Webview logging

This folder contains the webview-side JavaScript used by the Codebase Digest VS Code extension. To centralize logging and forwarding from the webview to the extension host, use the shared `logger.js` module.

Usage

- Import/require the logger from any webview module:
  const logger = require('./logger');

- Call logger.info/warn/error/debug(...) in place of console.* when you want messages forwarded to the host. `logger.js` will always emit to the console as a fallback.

Forwarding contract

- `logger.js` will call `vscode.postMessage({ type: 'log', level, args })` when `vscode.postMessage` is available.
- It will also call `window.__cbd_postLog({ level, args })` when that bridge is provided (useful for tests or custom host shims).

Fallbacks

- If the shared logger is not available, modules should fall back to calling `console.warn`/`console.error` directly to preserve behavior in tests and non-hosted environments.

Best practices

- Prefer the shared logger for any diagnostic messages to keep formatting and forwarding consistent.
- Keep console.error calls for user-facing or test-asserted messages where the explicit console call is required (some tests assert `console.error` ordering).