// Shared webview command names used across the extension host and the webview.
// Keep this in sync with resources/webview/constants.js (COMMANDS).
export type WebviewCommand =
  | 'state'
  | 'previewDelta'
  | 'ingestPreview'
  | 'ingestError'
  | 'progress'
  | 'remoteRepoLoaded'
  | 'generationResult'
  | 'restoredState'
  | 'config'
  | 'diagnostic'
  | 'test';

// Optionally export a const enum-like map for convenience when constructing
// messages in TypeScript code. Using a plain object allows runtime access
// and keeps the set minimal.
export const WebviewCommands = {
  state: 'state' as WebviewCommand,
  previewDelta: 'previewDelta' as WebviewCommand,
  ingestPreview: 'ingestPreview' as WebviewCommand,
  ingestError: 'ingestError' as WebviewCommand,
  progress: 'progress' as WebviewCommand,
  remoteRepoLoaded: 'remoteRepoLoaded' as WebviewCommand,
  generationResult: 'generationResult' as WebviewCommand,
  restoredState: 'restoredState' as WebviewCommand,
  config: 'config' as WebviewCommand,
  diagnostic: 'diagnostic' as WebviewCommand,
  test: 'test' as WebviewCommand
} as const;
