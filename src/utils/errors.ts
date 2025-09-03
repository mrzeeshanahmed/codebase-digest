export class FileReadError extends Error {
    constructor(public filePath: string, message?: string) {
        super(message || `Failed to read file ${filePath}`);
        this.name = 'FileReadError';
    }
}

export class GitAuthError extends Error {
    constructor(public remote: string, message?: string) {
        super(message || `Authentication error accessing ${remote}`);
        this.name = 'GitAuthError';
    }
}

export class RateLimitError extends Error {
    constructor(public service: string, message?: string) {
        super(message || `${service} rate limit exceeded`);
        this.name = 'RateLimitError';
    }
}

export class SizeLimitExceeded extends Error {
    constructor(public size: number, public limit: number, message?: string) {
        super(message || `Size ${size} exceeds limit ${limit}`);
        this.name = 'SizeLimitExceeded';
    }
}

export class DepthLimitExceeded extends Error {
    constructor(public depth: number, public limit: number, message?: string) {
        super(message || `Depth ${depth} exceeds limit ${limit}`);
        this.name = 'DepthLimitExceeded';
    }
}

export default {};
import * as vscode from 'vscode';
import { Diagnostics } from './diagnostics';

const OUTPUT_CHANNEL_NAME = 'Codebase Digest';
let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    }
    return outputChannel;
}

export function showUserError(message: string, details?: string, diagnostics?: Diagnostics) {
    if (diagnostics && details) {
        diagnostics.error(details);
    }
    const channel = getOutputChannel();
    if (details) {
        channel.appendLine(`[ERROR] ${details}`);
    }
    channel.show(true);
    vscode.window.showErrorMessage(message, 'Show Details').then(action => {
        if (action === 'Show Details') {
            channel.show(true);
        }
    });
}

export function showUserWarning(message: string, details?: string, diagnostics?: Diagnostics) {
    if (diagnostics && details) {
        diagnostics.warn(details);
    }
    const channel = getOutputChannel();
    if (details) {
        channel.appendLine(`[WARNING] ${details}`);
    }
    channel.show(true);
    vscode.window.showWarningMessage(message, 'Show Details').then(action => {
        if (action === 'Show Details') {
            channel.show(true);
        }
    });
}
