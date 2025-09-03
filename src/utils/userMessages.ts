import * as vscode from 'vscode';
import { FileReadError, GitAuthError, RateLimitError, SizeLimitExceeded, DepthLimitExceeded } from './errors';

export async function showUserError(err: Error, fallbackMessage?: string) {
    if (err instanceof FileReadError) {
        const pick = await vscode.window.showErrorMessage(`${err.message}`, 'Retry', 'Ignore');
        if (pick === 'Retry') { return { action: 'retry' }; }
        return { action: 'ignore' };
    }
    if (err instanceof GitAuthError) {
        const pick = await vscode.window.showErrorMessage(`${err.message}`, 'Sign in', 'Ignore');
        if (pick === 'Sign in') { return { action: 'signIn' }; }
        return { action: 'ignore' };
    }
    if (err instanceof RateLimitError) {
        const pick = await vscode.window.showErrorMessage(`${err.message}`, 'Retry later', 'Open docs');
        if (pick === 'Open docs') { return { action: 'docs' }; }
        return { action: 'retry' };
    }
    if (err instanceof SizeLimitExceeded) {
        const pick = await vscode.window.showErrorMessage(`${err.message}`, 'Increase limit', 'Skip file');
        if (pick === 'Increase limit') { return { action: 'increase' }; }
        return { action: 'skip' };
    }
    if (err instanceof DepthLimitExceeded) {
        const pick = await vscode.window.showErrorMessage(`${err.message}`, 'Increase depth', 'Skip');
        if (pick === 'Increase depth') { return { action: 'increase' }; }
        return { action: 'skip' };
    }
    // Generic fallback
    const pick = await vscode.window.showErrorMessage(fallbackMessage || err.message || 'An error occurred', 'OK');
    return { action: 'ok' };
}

export async function showUserWarning(message: string, options?: string[]) {
    const pick = await vscode.window.showWarningMessage(message, ...(options || ['OK']));
    return pick;
}

export default {};
