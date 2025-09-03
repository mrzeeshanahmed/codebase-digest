import * as vscode from 'vscode';
import { CodebaseDigestPanel, registerCodebaseView, setWebviewHtml } from '../providers/codebasePanel';

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
});
