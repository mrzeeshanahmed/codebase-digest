import * as vscode from 'vscode';

/**
 * Execute a VS Code command safely. Errors are logged and a user-facing message
 * is shown where possible. This helper swallows errors and returns undefined on
 * failure.
 */
function stringifyErr(err: unknown): string {
    try {
        if (!err) { return String(err); }
        if (typeof err === 'string') { return err; }
        if (typeof err === 'object') {
            const rec = err as Record<string, unknown> | null;
            if (rec && typeof rec['message'] === 'string') { return String(rec['message']); }
            try { return JSON.stringify(err); } catch { return String(err); }
        }
        return String(err);
    } catch { return String(err); }
}

export async function safeExecuteCommand(commandId: string, ...args: unknown[]): Promise<unknown> {
    try {
    // vscode.commands.executeCommand accepts any args; pass through as unknown[] to avoid `as any`.
    return await vscode.commands.executeCommand(commandId, ...(args as unknown[]));
    } catch (err) {
        try { vscode.window.showErrorMessage(`Command failed: ${commandId}: ${stringifyErr(err)}`); } catch (e) { /* ignore */ }
        try { console.error('[safeExecuteCommand] command failed', commandId, err); } catch (e) { /* ignore */ }
        return undefined;
    }
}

/**
 * Execute a VS Code command but rethrow errors after logging. Useful when a
 * caller needs to handle fallback behavior on failure.
 */
export async function safeExecuteCommandOrThrow(commandId: string, ...args: unknown[]): Promise<unknown> {
    try {
    return await vscode.commands.executeCommand(commandId, ...(args as unknown[]));
    } catch (err) {
        try { vscode.window.showErrorMessage(`Command failed: ${commandId}: ${stringifyErr(err)}`); } catch (e) { /* ignore */ }
        try { console.error('[safeExecuteCommandOrThrow] command failed', commandId, err); } catch (e) { /* ignore */ }
        throw err;
    }
}
