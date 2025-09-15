import * as vscode from 'vscode';
import { CodebaseDigestTreeProvider } from '../providers/treeDataProvider';
import { ConfigurationService } from '../services/configurationService';

export function registerToggles(context: vscode.ExtensionContext, treeProvider: CodebaseDigestTreeProvider) {
    context.subscriptions.push(
        vscode.commands.registerCommand('codebaseDigest.togglePresetCompatible', async () => {
            // Read validated snapshot for current value, preserve WorkspaceConfiguration.update for persistence
            const snapshot = ConfigurationService.getWorkspaceConfig(undefined as any);
            const current = !!(snapshot as any).outputPresetCompatible;
            const cfg = vscode.workspace.getConfiguration('codebaseDigest');
            await cfg.update('outputPresetCompatible', !current, vscode.ConfigurationTarget.Workspace);
            treeProvider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codebaseDigest.toggleNotebookOutputs', async () => {
            const snapshot = ConfigurationService.getWorkspaceConfig(undefined as any);
            const current = !!(snapshot as any).notebookIncludeNonTextOutputs;
            const cfg = vscode.workspace.getConfiguration('codebaseDigest');
            await cfg.update('notebookIncludeNonTextOutputs', !current, vscode.ConfigurationTarget.Workspace);
            treeProvider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codebaseDigest.toggleGitignoreRespect', async () => {
            const snapshot = ConfigurationService.getWorkspaceConfig(undefined as any);
            const current = ((snapshot as any).respectGitignore === undefined) ? true : !!(snapshot as any).respectGitignore;
            const cfg = vscode.workspace.getConfiguration('codebaseDigest');
            await cfg.update('respectGitignore', !current, vscode.ConfigurationTarget.Workspace);
            treeProvider.refresh();
        })
    );
}
