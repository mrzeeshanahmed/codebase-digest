import * as vscode from 'vscode';
import { logger } from './logger';
import { GitignoreService } from './gitignoreService';
import { FileScanner } from './fileScanner';
import { ContentProcessor } from './contentProcessor';
import { TokenAnalyzer } from './tokenAnalyzer';
// Optionally import CacheService, Metrics if present

export interface ServicesBundle {
    gitignoreService: GitignoreService;
    fileScanner: FileScanner;
    contentProcessor: ContentProcessor;
    tokenAnalyzer: TokenAnalyzer;
    cacheService?: any;
    metrics?: any;
}

export class WorkspaceManager {
    private bundles: Map<string, ServicesBundle> = new Map();

    constructor(folders: readonly vscode.WorkspaceFolder[] | undefined) {
        if (folders) {
            for (const folder of folders) {
                this.bundles.set(folder.uri.fsPath, this.createBundle(folder));
            }
        }
    }

    private createBundle(folder: vscode.WorkspaceFolder): ServicesBundle {
        const gitignoreService = new GitignoreService();
        const fileScanner = new FileScanner(gitignoreService);
        const contentProcessor = new ContentProcessor();
        const tokenAnalyzer = new TokenAnalyzer();
        // Optionally instantiate cacheService, metrics here
        return {
            gitignoreService,
            fileScanner,
            contentProcessor,
            tokenAnalyzer
            // cacheService, metrics
        };
    }

    getBundleForFolder(folder: vscode.WorkspaceFolder | string): ServicesBundle | undefined {
        const key = typeof folder === 'string' ? folder : folder.uri.fsPath;
        return this.bundles.get(key);
    }

    getAllBundles(): ServicesBundle[] {
        return Array.from(this.bundles.values());
    }

    addFolder(folder: vscode.WorkspaceFolder): void {
        if (!this.bundles.has(folder.uri.fsPath)) {
            this.bundles.set(folder.uri.fsPath, this.createBundle(folder));
        }
    }

    removeFolder(folder: vscode.WorkspaceFolder | string): void {
        const key = typeof folder === 'string' ? folder : folder.uri.fsPath;
        this.bundles.delete(key);
    }
}
