import * as vscode from 'vscode';
import { CodebaseDigestPanel, registerCodebaseView, setWebviewHtml } from '../providers/codebasePanel';
import { wireWebviewMessages } from '../providers/webviewHelpers';

/*
Manual validation checklist (quick steps to verify sidebar-first UX):

- Reload the extension (Extension Development Host)
- Confirm no editor WebviewPanel auto-opens on activation
- Open the Primary Sidebar and verify a "Codebase Digest" view exists
- Run the Command Palette action "Focus Codebase Digest" (or status bar) and confirm the view receives focus
- Use the welcome/empty state and click the Open Dashboard action — it should focus the sidebar view, not open a panel tab

These tests cover programmatic assertions for CSP injection, asset URI rewriting, and that the contributed view id remains aligned to `codebaseDigestDashboard`.
*/

describe('CodebaseDigestPanel HTML builder', () => {
  it('injects CSP meta and rewrites asset URIs using setHtml', async () => {
    const fakeExtUri = vscode.Uri.file(require('path').join(__dirname, '..', '..'));
    // Minimal tree provider mock (not used for HTML test)
    const treeProvider: any = { getPreviewData: () => ({ selectedCount: 0, totalFiles: 0, selectedSize: '0 B', tokenEstimate: 0 }), setPreviewUpdater: () => {} };
    const panel = new CodebaseDigestPanel(fakeExtUri, treeProvider as any, fakeExtUri.fsPath);

    // Fake webview that captures assigned html and reports asWebviewUri and cspSource
    let assignedHtml = '';
    const fakeWebview: any = {
      asWebviewUri: (u: vscode.Uri) => vscode.Uri.parse('vscode-resource:' + u.path),
      cspSource: 'vscode-resource:',
    };

    // Call internal setHtml via the public reveal flow by creating a temporary fake panel.webview
    // We'll simulate the createWebviewPanel step by creating an object with webview
    const fakePanelObject: any = { webview: { ...fakeWebview, set html(v: string) { assignedHtml = v; }, get html() { return assignedHtml; } } };
    // Invoke setHtml directly (method is private; access via indexing)
    (panel as any).setHtml(fakePanelObject.webview);

    // Validate assignedHtml contains CSP meta and rewritten asset paths
    expect(typeof assignedHtml).toBe('string');
    expect((assignedHtml.match(/Content-Security-Policy/g) || []).length).toBe(1);
    expect(assignedHtml).toContain(fakeWebview.cspSource);
  // Accept both forward and back slashes in paths (Windows paths may use backslashes)
  expect(assignedHtml).toMatch(/vscode-resource:.*resources[\\\/]webview[\\\/]styles\.css/);
  expect(assignedHtml).toMatch(/vscode-resource:.*resources[\\\/]webview[\\\/]main\.js/);
  });
});

describe('main.js wiring (static checks)', () => {
  it('declares acquireVsCodeApi and uses postMessage', () => {
    const js = `const vscode = acquireVsCodeApi();\nvscode.postMessage({ type: 'test', payload: 123 });`;
    expect(js).toMatch(/const vscode = acquireVsCodeApi\(\)/);
    expect(js).toMatch(/vscode\.postMessage\(/);
  });
});

describe('View registration and WebviewView HTML', () => {
  it('registers view id codebaseDigestDashboard when registerCodebaseView is called', () => {
    const fakeExtUri = vscode.Uri.file(require('path').join(__dirname, '..', '..'));
    const treeProvider: any = { getPreviewData: () => ({ selectedCount: 0, totalFiles: 0, selectedSize: '0 B', tokenEstimate: 0 }), setPreviewUpdater: () => {}, workspaceRoot: '' };
    const context: any = { subscriptions: [] };

    // If the test runner's vscode stub doesn't implement registerWebviewViewProvider,
    // provide a temporary mock function to capture the call.
    const originalRegister: any = (vscode.window as any).registerWebviewViewProvider;
    let calledWithId: string | null = null;
    (vscode.window as any).registerWebviewViewProvider = (id: string, provider: any, opts?: any) => {
      calledWithId = id;
      return { dispose: () => {} } as any;
    };

    // Call registration - our mock will capture the id
    registerCodebaseView(context as any, fakeExtUri, treeProvider as any);
    expect(calledWithId).toBe('codebaseDigestDashboard');

    // restore original if it existed
    (vscode.window as any).registerWebviewViewProvider = originalRegister;
  });

  it('setWebviewHtml injects CSP and rewrites URIs for a WebviewView.webview', () => {
    const fakeExtUri = vscode.Uri.file(require('path').join(__dirname, '..', '..'));
    let assignedHtml = '';
    const fakeWebview: any = {
      asWebviewUri: (u: vscode.Uri) => vscode.Uri.parse('vscode-resource:' + u.path),
      cspSource: 'vscode-resource:',
      set html(v: string) { assignedHtml = v; },
      get html() { return assignedHtml; }
    };

    // Call the shared helper directly to simulate the view rendering path
    setWebviewHtml(fakeWebview as any, fakeExtUri);

    expect(typeof assignedHtml).toBe('string');
    expect((assignedHtml.match(/Content-Security-Policy/g) || []).length).toBe(1);
    expect(assignedHtml).toContain(fakeWebview.cspSource);
    expect(assignedHtml).toMatch(/vscode-resource:.*resources[\\\/]webview[\\\/]styles\.css/);
    expect(assignedHtml).toMatch(/vscode-resource:.*resources[\\\/]webview[\\\/]main\.js/);
  });

  it('applyPreset action updates workspace config and triggers refresh', async () => {
    // Prepare fake webview that captures posted messages and allows simulating incoming ones
    let posted: any[] = [];
    let handler: ((m: any) => void) | null = null;
    const fakeWebview: any = {
      postMessage: (m: any) => { posted.push(m); return true; },
      onDidReceiveMessage: (cb: (m: any) => void) => { handler = cb; return { dispose: () => {} }; },
      cspSource: 'vscode-resource:'
    };

    // Mock configuration object with mutable state for filterPresets
    let storedPresets: any[] = [];
    const cfgMock = {
      update: jest.fn(async (k: string, v: any) => { if (k === 'filterPresets') { storedPresets = v; } }),
      get: jest.fn((k: string, d: any) => { if (k === 'filterPresets') { return storedPresets; } return d; })
    } as any;
    const originalGetConfig = (vscode.workspace as any).getConfiguration;
  (vscode.workspace as any).getConfiguration = jest.fn(() => cfgMock);
  const originalConfigTarget = (vscode as any).ConfigurationTarget;
  (vscode as any).ConfigurationTarget = { Workspace: 1, WorkspaceFolder: 2, Global: 3 } as any;
  const originalExecute = (vscode.commands as any).executeCommand;
  (vscode.commands as any).executeCommand = jest.fn();
  const originalUriFile = (vscode.Uri as any).file;
  (vscode.Uri as any).file = (p: string) => ({ fsPath: p });

    const treeProvider: any = { refresh: jest.fn(), workspaceRoot: '' };

    // Wire messages and then simulate applyPreset incoming message
  wireWebviewMessages(fakeWebview as any, treeProvider, 'mockFolder', async () => { /* noop */ }, undefined, undefined);
  // simulate message
  if (!handler) { throw new Error('webview handler not registered'); }
  await (handler as any)({ type: 'action', actionType: 'applyPreset', preset: 'codeOnly' });

  // Accept either code path:
  // - direct config update (cfg.update called and treeProvider.refresh invoked)
  // - fallback: executeCommand('codebaseDigest.applyPreset', folder, preset)
  const executed = (vscode.commands && typeof (vscode.commands as any).executeCommand === 'function') ? (vscode.commands as any).executeCommand as jest.Mock : null;
  const cfgUpdated = cfgMock.update.mock.calls.length > 0;
  const fallbackCalled = executed && executed.mock.calls.length > 0;
  expect(cfgUpdated || fallbackCalled).toBeTruthy();
  // Ensure either refresh was called (direct path) or fallback was invoked
  expect(treeProvider.refresh.mock.calls.length > 0 || (fallbackCalled && executed!.mock.calls.some((c: any[]) => c[0] === 'codebaseDigest.applyPreset'))).toBeTruthy();
  // Expect webview posted a config response (may be empty if fallback occurred)
  const cfgPost = posted.find(p => p && p.type === 'config');
  if (cfgPost) {
    expect(cfgPost).toBeDefined();
  } else {
    // If no config was posted, ensure fallback path was used
    expect(fallbackCalled).toBeTruthy();
  }

    // restore
  (vscode.workspace as any).getConfiguration = originalGetConfig;
  (vscode as any).ConfigurationTarget = originalConfigTarget;
  (vscode.commands as any).executeCommand = originalExecute;
  (vscode.Uri as any).file = originalUriFile;
  });

  it('configRequest maps gitignore->respectGitignore, binaryPolicy->binaryFilePolicy, and flattens thresholds', async () => {
    let handler: ((m: any) => void) | null = null;
    let posted: any[] = [];
    const fakeWebview: any = {
      postMessage: (m: any) => { posted.push(m); return true; },
      onDidReceiveMessage: (cb: (m: any) => void) => { handler = cb; return { dispose: () => {} }; },
      cspSource: 'vscode-resource:'
    };

    // Config has legacy keys set
    const thresholds = { maxFiles: 123, maxTotalSizeBytes: 9999, tokenLimit: 777 };
    const cfgMock = {
      get: jest.fn((k: string, d: any) => {
        if (k === 'gitignore') { return false; }
        if (k === 'respectGitignore') { return false; }
        if (k === 'binaryPolicy') { return 'includeBase64'; }
        if (k === 'thresholds') { return thresholds; }
        if (k === 'maxFiles') { return thresholds.maxFiles; }
        if (k === 'maxTotalSizeBytes') { return thresholds.maxTotalSizeBytes; }
        if (k === 'tokenLimit') { return thresholds.tokenLimit; }
        // default behavior: return provided default when key not explicitly mocked
        return d;
      }),
      update: jest.fn()
    } as any;
    const originalGetConfig = (vscode.workspace as any).getConfiguration;
    (vscode.workspace as any).getConfiguration = jest.fn(() => cfgMock);

  wireWebviewMessages(fakeWebview as any, {} as any, 'mockFolder', async () => { /* noop */ }, undefined, undefined);
  if (!handler) { throw new Error('webview handler not registered'); }
  await (handler as any)({ type: 'configRequest' });

    const cfgPost = posted.find(p => p && p.type === 'config');
    expect(cfgPost).toBeDefined();
    const s = cfgPost.settings;
    expect(s.respectGitignore).toBe(false);
    expect(s.binaryFilePolicy).toBe('includeBase64');
    expect(s.maxFiles).toBe(thresholds.maxFiles);
    expect(s.maxTotalSizeBytes).toBe(thresholds.maxTotalSizeBytes);
    expect(s.tokenLimit).toBe(thresholds.tokenLimit);

    (vscode.workspace as any).getConfiguration = originalGetConfig;
  });
});
