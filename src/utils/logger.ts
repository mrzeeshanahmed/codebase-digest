import * as vscode from 'vscode';

const CHANNEL_NAME = 'Codebase Digest';
let outputChannel: vscode.OutputChannel | undefined;

function getChannel() {
    if (!outputChannel) {
        try { outputChannel = vscode.window.createOutputChannel(CHANNEL_NAME); } catch (e) { /* ignore in test env */ }
    }
    return outputChannel;
}

export interface LoggerOptions { debugEnabled?: boolean }

const defaultOpts: LoggerOptions = { debugEnabled: false };

let opts: LoggerOptions = { ...defaultOpts };

export function configureLogger(o: LoggerOptions) {
    opts = Object.assign({}, defaultOpts, o || {});
}

function format(prefix: string, args: any[]) {
    try {
        const ts = new Date().toISOString();
        const out = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        return `${ts} [${prefix}] ${out}`;
    } catch (e) {
        return `[${prefix}]`;
    }
}

export function info(...args: any[]) {
    try {
        const ch = getChannel();
        const msg = format('info', args);
        if (ch) { try { ch.appendLine(msg); } catch (e) {} }
        try { console.info('[codebase-digest]', ...args); } catch (_) {}
    } catch (e) {}
}

export function warn(...args: any[]) {
    try {
        const ch = getChannel();
        const msg = format('warn', args);
        if (ch) { try { ch.appendLine(msg); } catch (e) {} }
        try { console.warn('[codebase-digest]', ...args); } catch (_) {}
    } catch (e) {}
}

export function error(...args: any[]) {
    try {
        const ch = getChannel();
        const msg = format('error', args);
        if (ch) { try { ch.appendLine(msg); } catch (e) {} }
        try { console.error('[codebase-digest]', ...args); } catch (_) {}
    } catch (e) {}
}

export function debug(...args: any[]) {
    try {
        if (!opts.debugEnabled) { return; }
        const ch = getChannel();
        const msg = format('debug', args);
        if (ch) { try { ch.appendLine(msg); } catch (e) {} }
        try { console.debug('[codebase-digest]', ...args); } catch (_) {}
    } catch (e) {}
}

export default { configureLogger, info, warn, error, debug };
