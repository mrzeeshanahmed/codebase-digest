import * as vscode from 'vscode';
import { UIPrompter } from '../types/interfaces';

export class VscodeUIPrompter implements UIPrompter {
    async promptForTokenOverride(usage: number): Promise<boolean> {
        const pick = await vscode.window.showQuickPick([
            { label: 'Override once and continue', id: 'override' },
            { label: 'Cancel generation', id: 'cancel' }
        ], { placeHolder: `Estimated tokens ${(usage * 100).toFixed(0)}% of limit. Choose an action.`, ignoreFocusOut: true });
        return pick?.id === 'override';
    }

    async promptForSizeOverride(usage: number): Promise<boolean> {
        const pick = await vscode.window.showQuickPick([
            { label: 'Override once and continue', id: 'override' },
            { label: 'Cancel scan', id: 'cancel' }
        ], { placeHolder: `Scanning would use ${(usage * 100).toFixed(0)}% of maxTotalSizeBytes. Choose an action.`, ignoreFocusOut: true });
        return pick?.id === 'override';
    }

    async promptForFileCountOverride(usage: number): Promise<boolean> {
        const pick = await vscode.window.showQuickPick([
            { label: 'Override once and continue', id: 'override' },
            { label: 'Cancel scan', id: 'cancel' }
        ], { placeHolder: `Scanning has reached ${(usage * 100).toFixed(0)}% of maxFiles. Choose an action.`, ignoreFocusOut: true });
        return pick?.id === 'override';
    }
}
