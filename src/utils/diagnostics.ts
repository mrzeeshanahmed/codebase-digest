/**
 * Diagnostics: Logging, timers, and warnings aggregation for Code Ingest.
 */
import * as vscode from 'vscode';
import { FileNode } from '../types/interfaces';
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class Diagnostics {
    private channel: vscode.OutputChannel;
    private logLevel: LogLevel;

    constructor(logLevel: LogLevel = 'info', channelName: string = 'Code Ingest') {
        this.channel = vscode.window.createOutputChannel(channelName);
        this.logLevel = logLevel;
    }

    getChannel(): vscode.OutputChannel {
        return this.channel;
    }

    debug(message: string, extra?: any) {
        if (this.shouldLog('debug')) {
            this.channel.appendLine(`[DEBUG] ${message}` + (extra ? ` ${JSON.stringify(extra)}` : ''));
        }
    }
    info(message: string, extra?: any) {
        if (this.shouldLog('info')) {
            this.channel.appendLine(`[INFO] ${message}` + (extra ? ` ${JSON.stringify(extra)}` : ''));
        }
    }
    warn(message: string, extra?: any) {
        if (this.shouldLog('warn')) {
            this.channel.appendLine(`[WARN] ${message}` + (extra ? ` ${JSON.stringify(extra)}` : ''));
        }
    }
    error(message: string, extra?: any) {
        if (this.shouldLog('error')) {
            this.channel.appendLine(`[ERROR] ${message}` + (extra ? ` ${JSON.stringify(extra)}` : ''));
        }
    }

    private shouldLog(level: LogLevel): boolean {
        const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
        return levels.indexOf(level) >= levels.indexOf(this.logLevel);
    }
}

export class Timer {
    private label: string;
    private startTime: number;
    private logger: Diagnostics;

    constructor(label: string, logger: Diagnostics) {
        this.label = label;
        this.logger = logger;
        this.startTime = Date.now();
    }
    stop(): number {
        const ms = Date.now() - this.startTime;
        this.logger.debug(`${this.label} took ${ms} ms`);
        return ms;
    }
}

export class Warnings {
    list: string[] = [];
    add(msg: string): void {
        this.list.push(msg);
    }
}
