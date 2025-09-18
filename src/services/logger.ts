import * as vscode from 'vscode';

class Logger {
    private static instance: Logger;
    private readonly outputChannel: vscode.OutputChannel;

    private constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Code Ingest');
    }

    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    private log(level: string, message: string, ...args: any[]) {
        const timestamp = new Date().toISOString();
        const formattedMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
        this.outputChannel.appendLine(formattedMessage);
        if (args.length > 0) {
            args.forEach(arg => {
                this.outputChannel.appendLine(JSON.stringify(arg, null, 2));
            });
        }
    }

    public info(message: string, ...args: any[]): void {
        this.log('info', message, ...args);
    }

    public warn(message: string, ...args: any[]): void {
        this.log('warn', message, ...args);
    }

    public error(message: string, error?: Error | any, ...args: any[]): void {
        const errorMessage = error ? `${message} - ${error.message}` : message;
        this.log('error', errorMessage, ...args);
        if (error?.stack) {
            this.outputChannel.appendLine(error.stack);
        }
    }

    public debug(message: string, ...args: any[]): void {
        // For now, debug logs can be the same as info.
        // Could be configured to only show in development mode.
        this.log('debug', message, ...args);
    }

    public show(): void {
        this.outputChannel.show();
    }

    public async showUserError(message: string, error?: Error | any): Promise<void> {
        this.error(message, error); // Log the error first
        const choice = await vscode.window.showErrorMessage(message, 'Show Logs');
        if (choice === 'Show Logs') {
            this.show();
        }
    }
}

export const logger = Logger.getInstance();
