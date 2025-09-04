import * as vscode from 'vscode';
import { generateDigest } from '../providers/digestProvider';
import { internalErrors, interactiveMessages } from '../utils';
import { takeTransientOverride } from '../utils/transientOverrides';

export function registerCommands(context: vscode.ExtensionContext, treeProvider: any, services?: any) {
    context.subscriptions.push(
    vscode.commands.registerCommand('codebaseDigest.generateDigest', async (folderPathArg?: string, overrides?: Record<string, any>) => {
            try {
                // Adapter: resolve active workspaceFolder and WorkspaceManager
                const workspaceFolders = vscode.workspace.workspaceFolders;
                const workspaceFolder = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0] : undefined;
                if (!workspaceFolder) {
                    interactiveMessages.showUserError(new Error('No workspace folder found.'));
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
                    return;
                }
                vscode.window.showInformationMessage('Digest generated successfully.');
                try { vscode.commands.executeCommand('codebaseDigest.flashDigestReady'); } catch (e) { }
                // Broadcast generation result to any open dashboard panels/views so UI can show redaction toast
                try {
                    const panelApi = require('../providers/codebasePanel');
                    if (panelApi && typeof panelApi.broadcastGenerationResult === 'function') {
                        panelApi.broadcastGenerationResult(result);
                    }
                } catch (e) { /* ignore */ }
            } catch (e) {
                interactiveMessages.showUserError(new Error('Error generating digest.'), String(e));
            }
        })
    );
}
