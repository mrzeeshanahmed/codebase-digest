// Shared types and interfaces for Code Ingest
// CODEMOD-SAFE: Do not change exported type names, field names, or command IDs unless a prompt explicitly says so
export interface FileNode {
    path: string;
    relPath: string;
    name: string;
    type: 'file' | 'directory' | 'symlink';
    size?: number;
    mtime?: Date;
    children?: FileNode[];
    isSelected: boolean;
    depth: number;
    isBinary?: boolean;
}

export interface TraversalStats {
    totalFiles: number;
    totalSize: number;
    skippedBySize: number;
    skippedByTotalLimit: number;
    skippedByMaxFiles: number;
    skippedByDepth: number;
    skippedByIgnore: number;
    directories: number;
    symlinks: number;
    warnings: string[];
    durationMs: number;
    tokenEstimate?: number;
}

export interface DigestConfig {
    base64FenceLanguage?: string;
    notebookIncludeNonTextOutputs?: boolean;
    notebookNonTextOutputMaxBytes?: number;
    notebookIncludeCodeCells?: boolean;
    notebookIncludeMarkdownCells?: boolean;
    notebookIncludeOutputs?: boolean;
    notebookOutputMaxChars?: number;
    notebookCodeFenceLanguage?: string;
    includeSubmodules?: boolean;
    maxFileSize: number;
    maxFiles: number;
    maxTotalSizeBytes: number;
    maxDirectoryDepth: number;
    excludePatterns: string[];
    includePatterns: string[];
    includedFileTypes?: string[];
    respectGitignore: boolean;
    gitignoreFiles: string[];
    outputFormat: 'markdown' | 'text' | 'json';
    outputPresetCompatible?: boolean;
    includeMetadata: boolean;
    includeTree: boolean;
    includeSummary: boolean;
    includeFileContents: boolean;
    useStreamingRead: boolean;
    binaryFilePolicy: 'skip' | 'includeBase64' | 'includePlaceholder';
    notebookProcess: boolean;
        tokenEstimate: boolean;
        tokenModel: string;
        tokenLimit?: number;
        tokenDivisorOverrides?: Record<string, number>;
    performanceLogLevel: 'info' | 'debug' | 'warn' | 'error';
    performanceCollectMetrics: boolean;
    outputSeparatorsHeader: string;
    /**
     * Template for per-file headers shown before each file's contents in the digest output.
     * Tokens available: <relPath>, <size>, <modified>
     * Example: "==== <relPath> (<size>, <modified>) ===="
     */
    outputHeaderTemplate?: string;
    outputWriteLocation: 'editor' | 'file' | 'clipboard' | 'prompt';
        selectedTreeMinimal?: boolean;
        maxSelectedTreeLines?: number;
    streamingThresholdBytes?: number;
    remoteRepo?: string;
    remoteRepoOptions?: {
        ref?: { tag?: string; branch?: string; commit?: string };
        subpath?: string;
    };
    contextLimit?: number;
    cacheEnabled?: boolean;
    cacheDir?: string;
    /**
     * If true, when scan approaches configured size/file thresholds the scanner will
     * show interactive prompts (QuickPick) to allow overriding once. When false
     * (or omitted in test/CI contexts) the scanner will emit a warning and
     * continue once without blocking for user input.
     */
    promptsOnThresholds?: boolean;
    filterPresets?: string[];
    // Redaction settings
    redactionPatterns?: string[];
    redactionPlaceholder?: string;
    showRedacted?: boolean;
}

export interface DigestResult {
    summary: string;
    tree: string;
    content: string;
    chunks?: string[]; // For markdown/text output
    outputObjects?: { header: string; body: string; imports?: string[] }[]; // For json output
    warnings: string[];
    tokenEstimate: number;
    // Optional per-file errors collected during generation
    errors?: { path: string; message: string; stack?: string }[];
    metadata: {
        totalFiles: number;
        totalSize: number;
        generatedAt: string;
        workspacePath: string;
        selectedFiles: string[];
        limits: {
            maxFiles: number;
            maxTotalSizeBytes: number;
            maxFileSize: number;
            maxDirectoryDepth: number;
        };
    stats: TraversalStats;
    format: string;
    };
    // Optional per-file analysis metadata keyed by relative path
    analysis?: Record<string, { imports?: string[] }>;
    // Whether redaction was applied to the generated content
    redactionApplied?: boolean;
    
}
