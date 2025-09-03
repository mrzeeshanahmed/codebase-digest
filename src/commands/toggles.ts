import * as vscode from 'vscode';
import { CodebaseDigestTreeProvider } from '../providers/treeDataProvider';

export function registerToggles(context: vscode.ExtensionContext, treeProvider: CodebaseDigestTreeProvider) {
    context.subscriptions.push(
        vscode.commands.registerCommand('codebaseDigest.togglePresetCompatible', async () => {
            const cfg = vscode.workspace.getConfiguration('codebaseDigest');
            const current = cfg.get('outputPresetCompatible', false);
            await cfg.update('outputPresetCompatible', !current, vscode.ConfigurationTarget.Workspace);
            treeProvider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codebaseDigest.toggleNotebookOutputs', async () => {
            const cfg = vscode.workspace.getConfiguration('codebaseDigest');
            const current = cfg.get('notebookIncludeNonTextOutputs', false);
            await cfg.update('notebookIncludeNonTextOutputs', !current, vscode.ConfigurationTarget.Workspace);
            treeProvider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codebaseDigest.toggleGitignoreRespect', async () => {
            const cfg = vscode.workspace.getConfiguration('codebaseDigest');
            const current = cfg.get('respectGitignore', true);
            await cfg.update('respectGitignore', !current, vscode.ConfigurationTarget.Workspace);
            treeProvider.refresh();
        })
    );
}
