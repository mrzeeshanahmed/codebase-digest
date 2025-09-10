/**
 * NOTE: This module exposes interactive user-facing helpers that present
 * prompts and return the caller's chosen action. These functions are
 * intended for interactive flows where the calling code needs to branch
 * based on the user's selection (e.g., Retry, Ignore, Sign in).
 *
 * For non-interactive logging or simple notifications (no returned actions),
 * prefer the helpers in `src/utils/errors.ts` which write to the Output
 * Channel and show a lightweight message.
 */

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
    const message = fallbackMessage || err.message || 'An error occurred';
    // Special-case missing-Git guidance: offer Install and PATH diagnostics
    if (String(message).toLowerCase().includes('git not found') || String(message).toLowerCase().includes('git not found:')) {
        const install = 'Install Git';
        const showPath = 'Show PATH';
        const pick = await vscode.window.showErrorMessage(message, install, showPath, 'OK');
        if (pick === install) {
            try { await vscode.env.openExternal(vscode.Uri.parse('https://git-scm.com/downloads')); } catch (_) {}
            return { action: 'install' };
        }
        if (pick === showPath) {
            const ch = vscode.window.createOutputChannel('Codebase Digest Diagnostics');
            try { ch.appendLine(`PATH=${process.env.PATH || ''}`); } catch (_) {}
            ch.show(true);
            return { action: 'showPath' };
        }
        return { action: 'ok' };
    }
    const pick = await vscode.window.showErrorMessage(message, 'OK');
    return { action: 'ok' };
}

export async function showUserWarning(message: string, options?: string[]) {
    const pick = await vscode.window.showWarningMessage(message, ...(options || ['OK']));
    return pick;
}

export default {};
