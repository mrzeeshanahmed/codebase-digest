import * as vscode from 'vscode';
import { validateConfig, isDigestConfig } from '../utils/validateConfig';
import { Diagnostics } from '../utils/diagnostics';
import { DigestConfig } from '../types/interfaces';

/**
 * Centralized configuration loader and validator for workspace-scoped settings.
 * Provides a safe, typed DigestConfig snapshot suitable for passing to services.
 */
export class ConfigurationService {
    /**
     * Read, coerce and validate codebaseDigest settings for the given workspace folder.
     * If diagnostics is provided, validation warnings/errors will be reported there.
     */
    public static getWorkspaceConfig(folder?: vscode.WorkspaceFolder | vscode.Uri, diagnostics?: Diagnostics): DigestConfig {
        const scope = folder && (folder as any).uri ? (folder as vscode.WorkspaceFolder).uri : (folder as vscode.Uri | undefined);
        const cfg = vscode.workspace.getConfiguration('codebaseDigest', scope as any);

        // Helper to read from WorkspaceConfiguration or plain object used in tests
        const getter = <T>(key: string, def: T): T => {
            try {
                if (cfg && typeof (cfg as any).get === 'function') {
                    return (cfg as any).get(key, def) as T;
                }
                // plain object fallback
                const raw = (cfg as any)[key];
                return raw === undefined ? def : raw as T;
            } catch (e) {
                return def;
            }
        };

        // Build a plain object snapshot of settings with sensible defaults.
        const snapshot: Partial<DigestConfig & Record<string, unknown>> = {
            // numeric limits and common fields with sensible defaults
            maxFileSize: getter('maxFileSize', 10485760),
            maxFiles: getter('maxFiles', 25000),
            maxTotalSizeBytes: getter('maxTotalSizeBytes', 536870912),
            maxDirectoryDepth: getter('maxDirectoryDepth', 20),
            tokenLimit: getter('tokenLimit', 32000),
            // enums / policies
            outputFormat: getter('outputFormat', 'markdown'),
                // Leave undefined when not explicitly set so legacy alias can be detected
                binaryFilePolicy: getter('binaryFilePolicy', undefined as any),
            // caching / limits
            contextLimit: getter('contextLimit', 0),
            cacheEnabled: getter('cacheEnabled', false),
            cacheDir: getter('cacheDir', ''),
            // notebook handling
            notebookIncludeNonTextOutputs: getter('notebookIncludeNonTextOutputs', false),
            notebookNonTextOutputMaxBytes: getter('notebookNonTextOutputMaxBytes', 200000),
            // redaction
            showRedacted: getter('showRedacted', false),
            redactionPatterns: getter('redactionPatterns', []),
            redactionPlaceholder: getter('redactionPlaceholder', '[REDACTED]'),
            // pattern lists and ignore behavior
            excludePatterns: getter('excludePatterns', ['node_modules/**', '.git/**', '*.log', '*.tmp', '.DS_Store', 'Thumbs.db']),
            includePatterns: getter('includePatterns', []),
                respectGitignore: getter('respectGitignore', true),
            gitignoreFiles: getter('gitignoreFiles', ['.gitignore']),
            // feature flags / outputs
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
            // Tree/provider specific tuning
            watcherDebounceMs: getter('watcherDebounceMs', 300),
            pendingHydrationBatchSize: getter('pendingHydrationBatchSize', 25),
            pendingHydrationBatchDelayMs: getter('pendingHydrationBatchDelayMs', 25),
            maxPendingHydrations: getter('maxPendingHydrations', 200),
            directoryPageSize: getter('directoryPageSize', 200),
            includeTreeMode: getter('includeTreeMode', 'full'),
            // Activation helper
            openSidebarOnActivate: getter('openSidebarOnActivate', true),
            // Back-compat: read legacy aliases that some tests and older settings use
            // Allow 'binaryPolicy' as an alias for 'binaryFilePolicy'
            binaryPolicy: getter('binaryPolicy', undefined as any),
            // Legacy gitignore alias
            gitignore: getter('gitignore', undefined as any),
            // Legacy thresholds object used by older code/tests
            thresholds: getter('thresholds', undefined as any),
            // Legacy presets key
            presets: getter('presets', undefined as any),
        } as Partial<DigestConfig>;

        // If the object already looks like a DigestConfig, run validateConfig for warnings
        try {
            if (isDigestConfig(snapshot)) {
                // ensure diagnostics is present for validateConfig
                const diag = diagnostics || new Diagnostics('info');
                validateConfig(snapshot as DigestConfig, diag);
                return snapshot as DigestConfig;
            }
        } catch (e) {
            // fall through to coercion
        }

        // Coerce types conservatively
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
            // Support legacy 'gitignore' boolean alias: prefer explicit 'respectGitignore' but fall back to 'gitignore'
            respectGitignore: typeof snapshot.respectGitignore === 'boolean' ? Boolean(snapshot.respectGitignore) : (typeof snapshot.gitignore === 'boolean' ? Boolean(snapshot.gitignore) : true),
            gitignoreFiles: Array.isArray(snapshot.gitignoreFiles) ? snapshot.gitignoreFiles as string[] : ['.gitignore'],
            // Support legacy 'presets' key by merging into filterPresets when filterPresets absent
            filterPresets: Array.isArray(snapshot.filterPresets) ? snapshot.filterPresets as string[] : (Array.isArray((snapshot as any).presets) ? (snapshot as any).presets as string[] : []),
            // Preserve raw presets alias for downstream consumers if present
            presets: Array.isArray((snapshot as any).presets) ? (snapshot as any).presets as string[] : [],
            watcherDebounceMs: Number(getter('watcherDebounceMs', 300)),
            pendingHydrationBatchSize: Number(getter('pendingHydrationBatchSize', 25)),
            pendingHydrationBatchDelayMs: Number(getter('pendingHydrationBatchDelayMs', 25)),
            maxPendingHydrations: Number(getter('maxPendingHydrations', 200)),
            directoryPageSize: Number(getter('directoryPageSize', 200)),
            includeTreeMode: typeof snapshot.includeTreeMode === 'string' ? snapshot.includeTreeMode : 'full',
            openSidebarOnActivate: Boolean(getter('openSidebarOnActivate', true)),
        } as DigestConfig;

        // Include legacy auxiliary keys on the returned object for compatibility
        const ret = coerced as any;
        if ((snapshot as any).thresholds !== undefined) { ret.thresholds = (snapshot as any).thresholds; }
        if ((snapshot as any).binaryPolicy !== undefined) { ret.binaryPolicy = (snapshot as any).binaryPolicy; }
        ret.presets = Array.isArray((snapshot as any).presets) ? (snapshot as any).presets : ret.presets || [];

    try { validateConfig(coerced, diagnostics || new Diagnostics('info')); } catch (e) { /* ignore validation errors during coercion */ }
        return ret as DigestConfig;
    }
}

export default ConfigurationService;
