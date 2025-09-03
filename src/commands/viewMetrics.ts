import * as vscode from 'vscode';
import { Services } from '../services';

export async function viewMetricsCommand(workspaceFolder: vscode.WorkspaceFolder | undefined, workspaceManager: import('../services/workspaceManager').WorkspaceManager) {
    if (!workspaceFolder) {
        vscode.window.showInformationMessage('No workspace folder selected to view metrics for.');
        return;
    }
    const services = workspaceManager.getBundleForFolder(workspaceFolder);
    if (!services) {
        vscode.window.showInformationMessage('No services available for this workspace.');
        return;
    }
    const metrics = (services as any).metrics as import('../services/metrics').Metrics | undefined;
    if (!metrics) {
        vscode.window.showInformationMessage('No performance metrics collected for this workspace.');
        return;
    }
    const channel = vscode.window.createOutputChannel('Codebase Digest - Metrics');
    channel.clear();
    channel.appendLine('Performance Metrics:\n');
    channel.appendLine(JSON.stringify({ counters: metrics.counters, timers: metrics.timers }, null, 2));
    channel.show(true);
}
