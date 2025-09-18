// Centralized, TypeScript-safe webview command names.
// Use this as the single source of truth for command strings in TypeScript code.
export const COMMANDS = {
  state: 'state',
  previewDelta: 'previewDelta',
  ingestPreview: 'ingestPreview',
  ingestError: 'ingestError',
  progress: 'progress',
  remoteRepoLoaded: 'remoteRepoLoaded',
  generationResult: 'generationResult',
  restoredState: 'restoredState',
  config: 'config',
  diagnostic: 'diagnostic',
  test: 'test',
  updateTree: 'updateTree',
  refreshTree: 'refreshTree'
} as const;

export type WebviewCommand = typeof COMMANDS[keyof typeof COMMANDS];

// A convenience object with exact typing usable at runtime in the extension host.
export const WebviewCommands = COMMANDS;

export type WebviewCommandKey = keyof typeof COMMANDS;
