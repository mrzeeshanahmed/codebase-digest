
// Lightweight VS Code mock for tests
class SimpleEventEmitter {
  constructor() { this.listeners = []; this.event = (listener) => { this.listeners.push(listener); return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } }; }; }
  fire(payload) { this.listeners.forEach(l => { try { l(payload); } catch (e) { /* ignore */ } }); }
}

const Uri = {
  file: (p) => ({ path: p, fsPath: p }),
  parse: (s) => ({ path: s, fsPath: s, toString() { return s; } }),
    joinPath: (base, ...parts) => {
      const basePath = base && (base.fsPath || base.path) ? (base.fsPath || base.path) : String(base);
      const p = [basePath].concat(parts).join('/');
      return { path: p, fsPath: p, toString() { return p; } };
    },
    toString() { return this.path; }
};

const workspaceOpenEmitter = new SimpleEventEmitter();

const vscodeMock = {
  extensions: {
    getExtension: jest.fn(() => ({ activate: jest.fn(() => Promise.resolve()) })),
  },
  window: {
    createTreeView: jest.fn(() => ({})),
  showInformationMessage: jest.fn(() => Promise.resolve()),
  showErrorMessage: jest.fn(() => Promise.resolve()),
    showSaveDialog: jest.fn(() => Promise.resolve(undefined)),
  createOutputChannel: jest.fn(() => ({ appendLine: jest.fn(), show: jest.fn(), clear: jest.fn(), dispose: jest.fn(), hide: jest.fn(), replace: jest.fn(), name: 'Code Ingest' })),
    createStatusBarItem: jest.fn(() => ({ text: '', show: jest.fn(), hide: jest.fn(), dispose: jest.fn(), command: undefined })),
  },
  commands: {
    _handlers: new Map(),
    registerCommand: jest.fn((id, cb) => { vscodeMock.commands._handlers.set(id, cb); }),
    executeCommand: jest.fn(async (cmd, ...args) => {
      // Call registered handler if present
      const handler = vscodeMock.commands._handlers.get(cmd);
      if (handler) {
        try { return await handler(...args); } catch (e) { /* fall through */ }
      }
      // Default behavior for tests: show information and fire open document
      try { if (vscodeMock.window && vscodeMock.window.showInformationMessage) { await vscodeMock.window.showInformationMessage('Digest generated successfully.'); } } catch (e) {}
  try { workspaceOpenEmitter.fire({ getText: () => 'Code Ingest' }); } catch (e) {}
      return undefined;
    }),
  },
  workspace: {
    _openEmitter: workspaceOpenEmitter,
    onDidOpenTextDocument: (listener) => workspaceOpenEmitter.event(listener),
    workspaceFolders: [ { uri: { fsPath: '/repo' } } ],
    createFileSystemWatcher: jest.fn(() => ({ onDidCreate: jest.fn(), onDidChange: jest.fn(), onDidDelete: jest.fn(), dispose: jest.fn() })),
    getConfiguration: jest.fn(() => ({ get: (k, def) => def })),
    getWorkspaceFolder: jest.fn((uri) => ({ uri: { fsPath: uri.fsPath } })),
  },
  authentication: { getSession: jest.fn(async () => ({ accessToken: 'fake-token' })) },
  Uri,
  StatusBarAlignment: { Left: 1, Right: 2 },
  TreeItem: class {},
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  EventEmitter: SimpleEventEmitter,
};

module.exports = vscodeMock;
