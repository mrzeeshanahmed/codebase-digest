// Utilities barrel for clearer imports.
// Recommended usage:
//   import { internalErrors, interactiveMessages } from '../utils';
// This encourages explicit namespaced imports (internalErrors vs interactiveMessages)
// and reduces accidental mixing of interactive vs non-interactive helpers.
export * as internalErrors from './errors';
export * as interactiveMessages from './userMessages';
export * from './diagnostics';
export * from './asyncPool';
// Re-export the streaming helper for reading large files.
export { streamLargeFile } from './streaming';
