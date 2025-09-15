import * as vscode from 'vscode';
import { scrubTokens } from '../utils/redaction';
import { Diagnostics } from '../utils/diagnostics';

const OUTPUT_CHANNEL_NAME = 'Codebase Digest - Errors';
let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    }
    return outputChannel;
}

export type ErrorHandlerOptions = {
    diagnostics?: Diagnostics;
    showUser?: boolean; // whether to show an error message to the user
    userMessage?: string; // fallback user message
};

export async function handleError(err: unknown, context?: string, opts: ErrorHandlerOptions = {}): Promise<void> {
    try {
        const details = (() => {
            if (err instanceof Error) {
                return `${err.name}: ${err.message}`;
            }
            try {
                return String(err);
            } catch (_) {
                return 'Unknown error';
            }
        })();

        const scrubbed = scrubTokens(details);

        if (opts.diagnostics && scrubbed) {
            try {
                opts.diagnostics.error(scrubbed);
            } catch (_) {
                /* ignore */
            }
        }

        const channel = getOutputChannel();
        if (context) {
            channel.appendLine(`[CONTEXT] ${context}`);
        }
        if (scrubbed) {
            channel.appendLine(`[ERROR] ${scrubbed}`);
        }
        channel.show(true);

        if (opts.showUser) {
            const msg = opts.userMessage || 'An error occurred';
            const pick = await vscode.window.showErrorMessage(msg, 'Show Details');
            if (pick === 'Show Details') {
                channel.show(true);
            }
        }
    } catch (e) {
        try {
            console.error('handleError failed', e);
        } catch (_) {
            /* ignore */
        }
    }
}

export function logErrorToChannel(err: unknown, context?: string): void {
    try {
        const details = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        const scrubbed = scrubTokens(details);
        const channel = getOutputChannel();
        if (context) {
            channel.appendLine(`[CONTEXT] ${context}`);
        }
        channel.appendLine(`[ERROR] ${scrubbed}`);
    } catch (e) {
        try {
            console.error('logErrorToChannel failed', e);
        } catch (_) {
            /* ignore */
        }
    }
}

export default { handleError, logErrorToChannel };
