import * as vscode from 'vscode';
import { FileNode } from '../types/interfaces';
import { CodebaseDigestTreeProvider } from '../providers/treeDataProvider';

export function registerSelectionCommands(context: vscode.ExtensionContext, treeProvider: CodebaseDigestTreeProvider) {
    context.subscriptions.push(
        vscode.commands.registerCommand('codebaseDigest.selectAll', () => {
            treeProvider.selectAll();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('codebaseDigest.clearSelection', () => {
            treeProvider.clearSelection();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('codebaseDigest.toggleSelection', (node: FileNode) => {
            treeProvider.toggleSelection(node);
        })
    );
}
