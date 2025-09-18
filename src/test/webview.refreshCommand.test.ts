import * as vscode from 'vscode';
import * as path from 'path';
import { registerCodebaseView } from '../providers/codebasePanel';
import { ConfigurationService } from '../services/configurationService';

describe('codebasePanel webview command forwarding', () => {
  it('executes refreshTree when webview posts refreshTree', async () => {
    const fakeExtUri = vscode.Uri.file(path.join(__dirname, '..', '..'));
    const treeProvider: any = { getPreviewData: () => ({ selectedCount: 0, totalFiles: 0 }), setPreviewUpdater: () => {}, workspaceRoot: '' };
    const context: any = { subscriptions: [] };

    // Capture the provider passed to registerWebviewViewProvider
    let capturedProvider: any = null;
    const originalRegister: any = (vscode.window as any).registerWebviewViewProvider;
    try {
      (vscode.window as any).registerWebviewViewProvider = (id: string, provider: any, opts?: any) => {
        capturedProvider = provider;
        return { dispose: () => {} } as any;
      };

      // Stub configuration snapshot used in resolve flow
      const origCfg = ConfigurationService.getWorkspaceConfig;
      (ConfigurationService as any).getWorkspaceConfig = jest.fn(() => ({
        respectGitignore: false,
        presets: [],
        filterPresets: [],
        outputFormat: 'markdown',
        tokenModel: 'gpt',
        binaryFilePolicy: 'skip',
        maxFiles: 0,
        maxTotalSizeBytes: 0,
        tokenLimit: 0,
        showRedacted: false,
        redactionPatterns: [],
        redactionPlaceholder: ''
      }));

      // Spy on executeCommand
      const origExec = (vscode.commands as any).executeCommand;
      (vscode.commands as any).executeCommand = jest.fn();

      // Register the view provider (captures provider)
      registerCodebaseView(context as any, fakeExtUri, treeProvider as any);
      expect(capturedProvider).toBeDefined();

      // Create a fake WebviewView and capture the onDidReceiveMessage callback
      let handler: ((m: any) => void) | null = null;
      const fakeWebviewView: any = {
        webview: {
          postMessage: jest.fn(),
          onDidReceiveMessage: (cb: (m: any) => void) => { handler = cb; return { dispose: () => {} }; },
          asWebviewUri: (u: vscode.Uri) => vscode.Uri.parse('https://mock' + u.path),
          cspSource: 'https://mock'
        },
        // resolveWebviewView expects the view to expose onDidDispose
        onDidDispose: (cb: () => void) => { return { dispose: () => {} }; }
      };

      // Call resolveWebviewView to set up listeners
      await capturedProvider.resolveWebviewView(fakeWebviewView);
      expect(typeof handler).toBe('function');

      // Simulate posting the refreshTree message from the webview
      handler!({ type: 'refreshTree' });

      // Expect executeCommand called with the refreshTree command
      expect((vscode.commands as any).executeCommand).toHaveBeenCalledWith('codebaseDigest.refreshTree');

      // Restore stubs
      (ConfigurationService as any).getWorkspaceConfig = origCfg;
      (vscode.commands as any).executeCommand = origExec;
    } finally {
      (vscode.window as any).registerWebviewViewProvider = originalRegister;
    }
  });
});
