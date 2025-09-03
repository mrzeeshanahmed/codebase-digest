import * as vscode from 'vscode';
import { CodebaseDigestTreeProvider } from '../providers/treeDataProvider';

// Refresh tree command
export function registerRefreshTree(context: vscode.ExtensionContext, treeProvider: CodebaseDigestTreeProvider) {
    context.subscriptions.push(
        vscode.commands.registerCommand('codebaseDigest.refreshTree', async () => {
            await treeProvider.refresh();
        })
    );
}
