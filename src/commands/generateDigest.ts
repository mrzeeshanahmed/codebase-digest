import * as vscode from 'vscode';
import { generateDigest } from '../providers/digestProvider';
import { internalErrors, interactiveMessages } from '../utils';
import { safeExecuteCommand } from '../utils/safeExecuteCommand';
import { takeTransientOverride } from '../utils/transientOverrides';
import { isRecord, hasProp } from '../utils/typeGuards';
import type { WorkspaceManager } from '../services/workspaceManager';
import type { CodebaseDigestTreeProvider } from '../providers/treeDataProvider';

export function registerCommands(context: vscode.ExtensionContext, treeProvider: unknown, services?: unknown) {
    context.subscriptions.push(
    vscode.commands.registerCommand('codebaseDigest.generateDigest', async (folderPathArg?: string | vscode.Uri | vscode.WorkspaceFolder, overrides?: Record<string, unknown>) => {
            try {
                // Adapter: resolve workspaceFolder from various caller arg shapes (string path, Uri, or WorkspaceFolder).
                const workspaceFolders = vscode.workspace.workspaceFolders;
                let workspaceFolder: vscode.WorkspaceFolder | undefined;
                try {
                    // Guard: check common WorkspaceFolder shape { uri: { fsPath } }
                    if (folderPathArg && isRecord(folderPathArg) && hasProp(folderPathArg, 'uri')) {
                        const maybeUri = (folderPathArg as Record<string, unknown>)['uri'];
                        if (isRecord(maybeUri) && hasProp(maybeUri, 'fsPath')) {
                            workspaceFolder = folderPathArg as vscode.WorkspaceFolder;
                        }
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
                        // dynamic import for optional module (code-splitting)
                        const mod: unknown = await import(/* webpackChunkName: "codebasePanel" */ '../providers/codebasePanel.js');
                        if (isRecord(mod)) {
                            const mrec = mod as Record<string, unknown>;
                            const bgr = typeof mrec['broadcastGenerationResult'] === 'function' ? (mrec['broadcastGenerationResult'] as (p: unknown) => void) : undefined;
                            try { bgr && bgr({ error: 'No workspace folder found.' }); } catch (_) { /* swallow */ }
                        }
                    } catch (err) { console.warn('broadcastGenerationResult failed (no workspace):', err); }
                    return;
                }
                // Assume WorkspaceManager is available on services; narrow carefully
                const workspaceManager: WorkspaceManager | undefined = isRecord(services) && hasProp(services, 'workspaceManager') ? (services as Record<string, unknown>)['workspaceManager'] as WorkspaceManager : undefined;
                // If no explicit overrides provided by the caller, check for a transient one-shot override
                let finalOverrides = isRecord(overrides) ? overrides as Record<string, unknown> : undefined;
                if (!finalOverrides) {
                    const folderPath = workspaceFolder.uri.fsPath;
                    const transient = takeTransientOverride(folderPath);
                    if (transient) {
                        finalOverrides = transient;
                    }
                }
                if (!workspaceManager) {
                    // If workspaceManager is required but absent, surface a user-facing message and try to broadcast
                    internalErrors.logUserError('WorkspaceManager service is not available for this workspace.');
                    try {
                        const mod: unknown = await import(/* webpackChunkName: "codebasePanel" */ '../providers/codebasePanel.js');
                        if (isRecord(mod)) {
                            const mrec = mod as Record<string, unknown>;
                            const bgr = typeof mrec['broadcastGenerationResult'] === 'function' ? (mrec['broadcastGenerationResult'] as (p: unknown) => void) : undefined;
                            try { bgr && bgr({ error: 'WorkspaceManager service is not available.' }); } catch (_) { /* swallow */ }
                        }
                    } catch (err) { /* ignore */ }
                    return;
                }
                // Narrow treeProvider if possible
                const treeProviderNarrowed: CodebaseDigestTreeProvider | undefined = isRecord(treeProvider) && hasProp(treeProvider, 'getSelectedFiles') ? (treeProvider as unknown as CodebaseDigestTreeProvider) : undefined;
                const result = await generateDigest(workspaceFolder, workspaceManager, treeProviderNarrowed, finalOverrides);
                if (!result) {
                    interactiveMessages.showUserWarning('No digest was generated.');
                    try {
                        // dynamic import for optional module (code-splitting)
                        const mod: unknown = await import(/* webpackChunkName: "codebasePanel" */ '../providers/codebasePanel.js');
                        if (isRecord(mod)) {
                            const mrec = mod as Record<string, unknown>;
                            const bgr = typeof mrec['broadcastGenerationResult'] === 'function' ? (mrec['broadcastGenerationResult'] as (p: unknown) => void) : undefined;
                            try { bgr && bgr({ error: 'No digest was generated.' }); } catch (_) { /* swallow */ }
                        }
                    } catch (err) { console.warn('broadcastGenerationResult failed (no digest):', err); }
                    return;
                }
                vscode.window.showInformationMessage('Digest generated successfully.');
                try { safeExecuteCommand('codebaseDigest.flashDigestReady').then(() => {/*noop*/}); } catch (e) { }
                // Broadcast generation result to any open dashboard panels/views so UI can show redaction toast
                try {
                    // dynamic import for optional module (code-splitting)
                    const mod: unknown = await import(/* webpackChunkName: "codebasePanel" */ '../providers/codebasePanel.js');
                    if (isRecord(mod)) {
                        const mrec = mod as Record<string, unknown>;
                        const bgr = typeof mrec['broadcastGenerationResult'] === 'function' ? (mrec['broadcastGenerationResult'] as (p: unknown) => void) : undefined;
                        try { bgr && bgr(result); } catch (_) { /* swallow */ }
                    }
                } catch (e) { /* ignore */ }
            } catch (e) {
                // Show user-facing error and also notify any open webview panels so they can
                // surface a toast with the detailed error.
                const errAny = e as unknown;
                const msg = typeof errAny === 'string' ? errAny : (isRecord(errAny) && hasProp(errAny, 'message')) ? String((errAny as Record<string, unknown>)['message']) : String(errAny);
                interactiveMessages.showUserError(new Error('Error generating digest.'), String(e));
                try {
                    // dynamic import for optional module (code-splitting)
                    const mod: unknown = await import(/* webpackChunkName: "codebasePanel" */ '../providers/codebasePanel.js');
                    if (isRecord(mod)) {
                        const mrec = mod as Record<string, unknown>;
                        const bgr = typeof mrec['broadcastGenerationResult'] === 'function' ? (mrec['broadcastGenerationResult'] as (p: unknown) => void) : undefined;
                        try { bgr && bgr({ error: msg }); } catch (_) { /* swallow */ }
                    }
                 } catch (err) { console.warn('broadcastGenerationResult failed (exception):', err); }
                 return; // make the error path explicit so the command handler doesn't leave a hanging/rejected promise
            }
        })
    );
}
