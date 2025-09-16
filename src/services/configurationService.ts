import * as vscode from 'vscode';
import { DigestConfig } from '../types/interfaces';
import { Diagnostics } from '../utils/diagnostics';
import { validateConfig, isDigestConfig } from '../utils/validateConfig';

/**
 * Centralized configuration loader and validator for workspace-scoped settings.
 * Exposes a static helper `getWorkspaceConfig` for convenience across the codebase.
 */
export class ConfigurationService {
    /**
     * Read, coerce and validate codebaseDigest settings for the given workspace folder.
     * If diagnostics is provided, validation warnings/errors will be reported there.
     */
    public static getWorkspaceConfig(folder?: vscode.WorkspaceFolder | vscode.Uri, diagnostics?: Diagnostics): DigestConfig {
        const scope = folder && (folder as any).uri ? (folder as vscode.WorkspaceFolder).uri : (folder as vscode.Uri | undefined);
        const cfg = vscode.workspace.getConfiguration('codebaseDigest', scope as any);

        const getter = <T>(key: string, def: T): T => {
            try {
                if (cfg && typeof (cfg as any).get === 'function') {
                    return (cfg as any).get(key, def) as T;
                }
                // Fallback for tests or plain object configs
                const raw = (cfg as any)[key];
                return raw === undefined ? def : raw as T;
            } catch (e) {
                return def;
            }
        };

        const snapshot: Partial<DigestConfig & Record<string, unknown>> = {
            maxFileSize: getter('maxFileSize', 10485760),
            maxFiles: getter('maxFiles', 25000),
            maxTotalSizeBytes: getter('maxTotalSizeBytes', 536870912),
            maxDirectoryDepth: getter('maxDirectoryDepth', 20),
            tokenLimit: getter('tokenLimit', 32000),
            outputFormat: getter('outputFormat', 'markdown'),
            binaryFilePolicy: getter('binaryFilePolicy', undefined as any),
            contextLimit: getter('contextLimit', 0),
            cacheEnabled: getter('cacheEnabled', false),
            cacheDir: getter('cacheDir', ''),
            notebookIncludeNonTextOutputs: getter('notebookIncludeNonTextOutputs', false),
            notebookNonTextOutputMaxBytes: getter('notebookNonTextOutputMaxBytes', 200000),
            showRedacted: getter('showRedacted', false),
            redactionPatterns: getter('redactionPatterns', []),
            redactionPlaceholder: getter('redactionPlaceholder', '[REDACTED]'),
            excludePatterns: getter('excludePatterns', ['node_modules/**', '.git/**', '*.log', '*.tmp', '.DS_Store', 'Thumbs.db']),
            includePatterns: getter('includePatterns', []),
            respectGitignore: getter('respectGitignore', true),
            gitignoreFiles: getter('gitignoreFiles', ['.gitignore']),
            includeMetadata: getter('includeMetadata', true),
            includeTree: getter('includeTree', true),
            includeSummary: getter('includeSummary', true),
            includeFileContents: getter('includeFileContents', true),
            useStreamingRead: getter('useStreamingRead', true),
            notebookProcess: getter('notebookProcess', true),
            tokenEstimate: getter('tokenEstimate', true),
            tokenModel: getter('tokenModel', 'chars-approx'),
            tokenDivisorOverrides: getter('tokenDivisorOverrides', {}),
            performanceLogLevel: getter('performanceLogLevel', 'info'),
            performanceCollectMetrics: getter('performanceCollectMetrics', false),
            outputSeparatorsHeader: getter('outputSeparatorsHeader', ''),
            outputWriteLocation: getter('outputWriteLocation', 'editor'),
            filterPresets: getter('filterPresets', []),
            watcherDebounceMs: getter('watcherDebounceMs', 300),
            pendingHydrationBatchSize: getter('pendingHydrationBatchSize', 25),
            pendingHydrationBatchDelayMs: getter('pendingHydrationBatchDelayMs', 25),
            maxPendingHydrations: getter('maxPendingHydrations', 200),
            directoryPageSize: getter('directoryPageSize', 200),
            includeTreeMode: getter('includeTreeMode', 'full'),
            openSidebarOnActivate: getter('openSidebarOnActivate', true),
            binaryPolicy: getter('binaryPolicy', undefined as any),
            gitignore: getter('gitignore', undefined as any),
            thresholds: getter('thresholds', undefined as any),
            presets: getter('presets', undefined as any),
        } as Partial<DigestConfig>;

        try {
            if (isDigestConfig(snapshot)) {
                const diag = diagnostics || new Diagnostics('info');
                validateConfig(snapshot as DigestConfig, diag);
                return snapshot as DigestConfig;
            }
        } catch (e) {
            // fall through
        }

        const coerced: DigestConfig = {
            maxFileSize: Number(snapshot.maxFileSize) || 10485760,
            maxFiles: Number(snapshot.maxFiles) || 25000,
            maxTotalSizeBytes: Number(snapshot.maxTotalSizeBytes) || 536870912,
            maxDirectoryDepth: Number(snapshot.maxDirectoryDepth) || 20,
            tokenLimit: Number(snapshot.tokenLimit) || 32000,
            outputFormat: typeof snapshot.outputFormat === 'string' ? snapshot.outputFormat as any : 'markdown',
            binaryFilePolicy: typeof snapshot.binaryFilePolicy === 'string' ? snapshot.binaryFilePolicy as any : (typeof (snapshot as any).binaryPolicy === 'string' ? (snapshot as any).binaryPolicy as any : 'skip'),
            includeMetadata: Boolean(snapshot.includeMetadata),
            includeTree: Boolean(snapshot.includeTree),
            includeSummary: Boolean(snapshot.includeSummary),
            includeFileContents: Boolean(snapshot.includeFileContents),
            useStreamingRead: Boolean(snapshot.useStreamingRead),
            notebookProcess: Boolean(snapshot.notebookProcess),
            tokenEstimate: Boolean(snapshot.tokenEstimate),
            tokenModel: typeof snapshot.tokenModel === 'string' ? snapshot.tokenModel : 'chars-approx',
            tokenDivisorOverrides: typeof snapshot.tokenDivisorOverrides === 'object' && snapshot.tokenDivisorOverrides !== null ? snapshot.tokenDivisorOverrides as Record<string, number> : {},
            performanceLogLevel: typeof snapshot.performanceLogLevel === 'string' ? snapshot.performanceLogLevel as any : 'info',
            performanceCollectMetrics: Boolean(snapshot.performanceCollectMetrics),
            outputSeparatorsHeader: typeof snapshot.outputSeparatorsHeader === 'string' ? snapshot.outputSeparatorsHeader : '',
            outputWriteLocation: typeof snapshot.outputWriteLocation === 'string' ? snapshot.outputWriteLocation as any : 'editor',
            contextLimit: Number(snapshot.contextLimit) || 0,
            cacheEnabled: Boolean(snapshot.cacheEnabled),
            cacheDir: typeof snapshot.cacheDir === 'string' ? snapshot.cacheDir : '',
            showRedacted: Boolean(snapshot.showRedacted),
            redactionPatterns: Array.isArray(snapshot.redactionPatterns) ? snapshot.redactionPatterns as string[] : [],
            redactionPlaceholder: typeof snapshot.redactionPlaceholder === 'string' ? snapshot.redactionPlaceholder : '[REDACTED]',
            excludePatterns: Array.isArray(snapshot.excludePatterns) ? snapshot.excludePatterns as string[] : ['node_modules/**', '.git/**', '*.log', '*.tmp', '.DS_Store', 'Thumbs.db'],
            includePatterns: Array.isArray(snapshot.includePatterns) ? snapshot.includePatterns as string[] : [],
            respectGitignore: typeof snapshot.respectGitignore === 'boolean' ? Boolean(snapshot.respectGitignore) : (typeof snapshot.gitignore === 'boolean' ? Boolean(snapshot.gitignore) : true),
            gitignoreFiles: Array.isArray(snapshot.gitignoreFiles) ? snapshot.gitignoreFiles as string[] : ['.gitignore'],
            filterPresets: Array.isArray(snapshot.filterPresets) ? snapshot.filterPresets as string[] : (Array.isArray((snapshot as any).presets) ? (snapshot as any).presets as string[] : []),
            presets: Array.isArray((snapshot as any).presets) ? (snapshot as any).presets as string[] : [],
            watcherDebounceMs: Number(getter('watcherDebounceMs', 300)),
            pendingHydrationBatchSize: Number(getter('pendingHydrationBatchSize', 25)),
            pendingHydrationBatchDelayMs: Number(getter('pendingHydrationBatchDelayMs', 25)),
            maxPendingHydrations: Number(getter('maxPendingHydrations', 200)),
            directoryPageSize: Number(getter('directoryPageSize', 200)),
            includeTreeMode: typeof snapshot.includeTreeMode === 'string' ? snapshot.includeTreeMode : 'full',
            openSidebarOnActivate: Boolean(getter('openSidebarOnActivate', true)),
        } as DigestConfig;

        const ret = coerced as any;
        if ((snapshot as any).thresholds !== undefined) { ret.thresholds = (snapshot as any).thresholds; }
        if ((snapshot as any).binaryPolicy !== undefined) { ret.binaryPolicy = (snapshot as any).binaryPolicy; }
        ret.presets = Array.isArray((snapshot as any).presets) ? (snapshot as any).presets : ret.presets || [];

        try { validateConfig(coerced, diagnostics || new Diagnostics('info')); } catch (e) { /* ignore validation errors during coercion */ }
        return ret as DigestConfig;
    }
}

export default ConfigurationService;
