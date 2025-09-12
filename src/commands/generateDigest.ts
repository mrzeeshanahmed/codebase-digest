import * as vscode from 'vscode';
import { generateDigest } from '../providers/digestProvider';
import { internalErrors, interactiveMessages } from '../utils';
import { takeTransientOverride } from '../utils/transientOverrides';

export function registerCommands(context: vscode.ExtensionContext, treeProvider: any, services?: any) {
    context.subscriptions.push(
    vscode.commands.registerCommand('codebaseDigest.generateDigest', async (folderPathArg?: string | vscode.Uri | vscode.WorkspaceFolder, overrides?: Record<string, any>) => {
            try {
                // Adapter: resolve workspaceFolder from various caller arg shapes (string path, Uri, or WorkspaceFolder).
                const workspaceFolders = vscode.workspace.workspaceFolders;
                let workspaceFolder: vscode.WorkspaceFolder | undefined;
                try {
                    if (folderPathArg && (folderPathArg as any).uri && (folderPathArg as any).uri.fsPath) {
                        // If a WorkspaceFolder object was passed
                        workspaceFolder = folderPathArg as vscode.WorkspaceFolder;
                    } else if (folderPathArg instanceof vscode.Uri) {
                        workspaceFolder = vscode.workspace.getWorkspaceFolder(folderPathArg as vscode.Uri) || undefined;
                    } else if (typeof folderPathArg === 'string' && folderPathArg) {
                        // Try to find a matching workspace folder by fsPath
                        workspaceFolder = workspaceFolders ? workspaceFolders.find(w => w.uri.fsPath === folderPathArg) : undefined;
                        if (!workspaceFolder) {
                            try { workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(folderPathArg)); } catch (e) { /* ignore */ }
                        }
                    }
                } catch (e) { /* defensive: continue to fallback */ }
                if (!workspaceFolder) {
                    workspaceFolder = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0] : undefined;
                }
                if (!workspaceFolder) {
                    interactiveMessages.showUserError(new Error('No workspace folder found.'));
                    // Ensure the UI is informed about the failure so webview toasts appear
                    try {
                        // Dynamic import so bundlers (webpack) can code-split and avoid
                        // including the optional panel code in the main extension bundle.
                        // @ts-ignore - dynamic import for optional module (code-splitting)
                        const mod = await import(/* webpackChunkName: "codebasePanel" */ '../providers/codebasePanel');
                        if (mod && typeof mod.broadcastGenerationResult === 'function') {
                            mod.broadcastGenerationResult({ error: 'No workspace folder found.' });
                        }
                    } catch (err) { console.warn('broadcastGenerationResult failed (no workspace):', err); }
                    return;
                }
                // Assume WorkspaceManager is available on services
                const workspaceManager = services?.workspaceManager;
                // If no explicit overrides provided by the caller, check for a transient one-shot override
                let finalOverrides = overrides;
                if (!finalOverrides) {
                    const folderPath = workspaceFolder.uri.fsPath;
                    const transient = takeTransientOverride(folderPath);
                    if (transient) {
                        finalOverrides = transient;
                    }
                }
                const result = await generateDigest(workspaceFolder, workspaceManager, treeProvider, finalOverrides);
                if (!result) {
                    interactiveMessages.showUserWarning('No digest was generated.');
                    try {
                        // @ts-ignore - dynamic import for optional module (code-splitting)
                        const mod = await import(/* webpackChunkName: "codebasePanel" */ '../providers/codebasePanel');
                        if (mod && typeof mod.broadcastGenerationResult === 'function') {
                            mod.broadcastGenerationResult({ error: 'No digest was generated.' });
                        }
                    } catch (err) { console.warn('broadcastGenerationResult failed (no digest):', err); }
                    return;
                }
                vscode.window.showInformationMessage('Digest generated successfully.');
                try { vscode.commands.executeCommand('codebaseDigest.flashDigestReady'); } catch (e) { }
                // Broadcast generation result to any open dashboard panels/views so UI can show redaction toast
                try {
                    // @ts-ignore - dynamic import for optional module (code-splitting)
                    const mod = await import(/* webpackChunkName: "codebasePanel" */ '../providers/codebasePanel');
                    if (mod && typeof mod.broadcastGenerationResult === 'function') {
                        mod.broadcastGenerationResult(result);
                    }
                } catch (e) { /* ignore */ }
            } catch (e) {
                // Show user-facing error and also notify any open webview panels so they can
                // surface a toast with the detailed error.
                const errAny: any = e;
                const msg = typeof errAny === 'string' ? errAny : (errAny && errAny.message) ? String(errAny.message) : String(errAny);
                interactiveMessages.showUserError(new Error('Error generating digest.'), String(e));
                try {
                    // @ts-ignore - dynamic import for optional module (code-splitting)
                    const mod = await import(/* webpackChunkName: "codebasePanel" */ '../providers/codebasePanel');
                    if (mod && typeof mod.broadcastGenerationResult === 'function') {
                        mod.broadcastGenerationResult({ error: msg });
                    }
                } catch (err) { console.warn('broadcastGenerationResult failed (exception):', err); }
                return; // make the error path explicit so the command handler doesn't leave a hanging/rejected promise
            }
        })
    );
}
