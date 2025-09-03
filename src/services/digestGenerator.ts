import { FileNode, DigestConfig, TraversalStats, DigestResult } from '../types/interfaces';
import { TokenAnalyzer } from './tokenAnalyzer';
import { ContentProcessor } from './contentProcessor';
import * as path from 'path';
import { getTokenizer } from '../plugins/index';
import { getFormatter } from '../format/output';
import { buildSummary } from '../format/summaryBuilder';
import { buildTree, buildSelectedTreeLines } from '../format/treeBuilder';
import { runPool, CancellationToken } from '../utils/asyncPool';
import { analyzeImports } from './dependencyAnalyzer';
import * as vscode from 'vscode';
import { emitProgress } from '../providers/eventBus';


export class DigestGenerator {
    public contentProcessor: ContentProcessor;
    private tokenAnalyzer: TokenAnalyzer;
    constructor(contentProcessor: ContentProcessor, tokenAnalyzer: TokenAnalyzer) {
    this.contentProcessor = contentProcessor;
    this.tokenAnalyzer = tokenAnalyzer;
    }
    async generate(
        files: FileNode[],
        config: DigestConfig,
        plugins: any[],
        outputFormat: 'markdown' | 'text' | 'json'
    ): Promise<DigestResult> {
        let tokenEstimate = 0;
    let outputChunks: string[] = [];
    let outputObjects: { header: string; body: string; imports?: string[] }[] = [];
    let warnings: string[] = [];
    const perFileWarnings: string[] = [];
    const perFileErrors: { path: string; message: string; stack?: string }[] = [];
    const errorChannel = vscode.window.createOutputChannel('Codebase Digest Errors');
    const formatter = getFormatter(outputFormat);
        // Preserve file order by relPath
        const sortedFiles = [...files].sort((a, b) => a.relPath.localeCompare(b.relPath));

        // Build tasks that process each file and return a result slot
    const tasks = sortedFiles.map((file, index) => async () => {
            const ext = path.extname(file.path); // includes leading dot, e.g. '.ts', '.ipynb'
            const header = formatter.buildHeader(file, config);
            let body = '';
            try {
                // proceed normally
            } catch (e) {
                // placeholder to satisfy TS control flow; actual try/catch per-block below
            }
            let pluginHandler = plugins.find(p => p.fileHandler && p.fileHandler(file, ext, config));
            try {
                if (pluginHandler && pluginHandler.fileHandler) {
                    body = await pluginHandler.fileHandler(file, ext, config);
                } else {
                    body = await formatter.buildBody(file, ext, config, this.contentProcessor);
                }
            } catch (err: any) {
                // Capture per-file read/processing errors but do not abort overall generation
                const msg = err && err.message ? String(err.message) : String(err || 'Unknown error');
                perFileErrors.push({ path: file.relPath, message: msg, stack: err && err.stack ? String(err.stack) : undefined });
                // Keep body as a placeholder so downstream steps can continue
                body = `ERROR: ${msg}`;
            }
            // Dependency analysis for JS/TS files
            let imports: string[] = [];
            try {
                imports = await analyzeImports(file.path, ext, body);
            } catch (e) { imports = []; }
            // Token estimation (unchanged semantics)
            let tokenizer = config.tokenModel ? getTokenizer(config.tokenModel) : undefined;
            let fileTokenEstimate = 0;
            if (tokenizer) {
                fileTokenEstimate = tokenizer(body, config);
            } else {
                fileTokenEstimate = this.tokenAnalyzer.estimate(body, config.tokenModel, config.tokenDivisorOverrides);
            }
            // Emit token progress roughly as files are processed
            try {
                const tokenLimit = config.tokenLimit || config.contextLimit || 0;
                if (tokenLimit > 0) {
                    // Throttle token progress emissions to every 20 files to reduce overhead
                    const shouldEmit = (index % 20) === 0;
                    const percent = Math.min(100, Math.floor(((tokenEstimate + fileTokenEstimate) / tokenLimit) * 100));
                    if (shouldEmit) { emitProgress({ op: 'generate', mode: 'progress', determinate: true, percent, message: 'Estimating tokens' }); }
                    // If crossing 80% threshold, present an override if interactive and not already warned
                    const usage = (tokenEstimate + fileTokenEstimate) / tokenLimit;
                    if (usage >= 0.8) {
                        const warned = (config as any)._warnedThresholds && (config as any)._warnedThresholds.tokens;
                        if (!warned) {
                            (config as any)._warnedThresholds = { ...(config as any)._warnedThresholds, tokens: true };
                            if (!process.env.JEST_WORKER_ID) {
                                const pick = await vscode.window.showQuickPick([
                                    { label: 'Override once and continue', id: 'override' },
                                    { label: 'Cancel generation', id: 'cancel' }
                                ], { placeHolder: `Estimated tokens ${(usage * 100).toFixed(0)}% of limit. Choose an action.`, ignoreFocusOut: true });
                                if (pick && pick.id === 'override') {
                                    (config as any)._overrides = { ...(config as any)._overrides, allowTokensOnce: true };
                                } else {
                                    throw new Error('Cancelled');
                                }
                            } else {
                                // In tests, just append a warning
                                // Do nothing else; generation will continue but warning is recorded
                            }
                        }
                    }
                }
            } catch (e) {
                // If user cancels or other error, propagate to abort generation
                throw e;
            }
            return { index, header, body, token: fileTokenEstimate, relPath: file.relPath, imports };
        });

        // Optional cancellation token (config may provide one in future)
        const token: CancellationToken | undefined = undefined;
    const concurrency = (config as any).concurrentFileReads || 8;
            const results = await runPool(tasks, concurrency, token);

    // Aggregate results in order
        const analysisMap: Record<string, any> = {};
        for (const r of results) {
            tokenEstimate += r.token;
            if (r.body && r.body.startsWith('ERROR:')) {
                perFileWarnings.push(r.body);
            }
            // Aggregate imports into analysis map keyed by relPath
            if (r.relPath) {
                analysisMap[r.relPath] = { imports: Array.isArray((r as any).imports) ? (r as any).imports : [] };
            }
            if (outputFormat === 'json') {
                outputObjects.push({ header: r.header, body: r.body, imports: Array.isArray((r as any).imports) ? (r as any).imports : [] });
            } else if (outputFormat === 'markdown' || outputFormat === 'text') {
                outputChunks.push(r.header + r.body + '\n');
            }
        }

        // Stable dedupe of per-file warnings
        if (perFileWarnings.length > 0) {
            const seen = new Set<string>();
            for (const w of perFileWarnings) {
                if (!seen.has(w)) {
                    warnings.push(w);
                    seen.add(w);
                }
            }
        }
        // Stable dedupe of per-file errors and log to OutputChannel
        const dedupedErrors: { path: string; message: string; stack?: string }[] = [];
        if (perFileErrors.length > 0) {
            const seenErr = new Set<string>();
            for (const e of perFileErrors) {
                const key = `${e.path}::${e.message}`;
                if (!seenErr.has(key)) {
                    seenErr.add(key);
                    dedupedErrors.push(e);
                }
            }
            // Log to output channel in a compact form
            errorChannel.appendLine(`Codebase Digest encountered ${dedupedErrors.length} unique file errors:`);
            for (const e of dedupedErrors) {
                errorChannel.appendLine(`- ${e.path}: ${e.message}`);
                if (e.stack) {
                    errorChannel.appendLine(e.stack);
                }
            }
            // Show channel to user non-modally
            errorChannel.show(true);
        }
        // Build summary and tree using Formatters
        // For stats, build a TraversalStats object with minimal required fields
        // Build TraversalStats snapshot
        const stats: TraversalStats = {
            totalFiles: files.length,
            totalSize: files.reduce((acc, f) => acc + (f.size || 0), 0),
            skippedBySize: 0,
            skippedByTotalLimit: 0,
            skippedByMaxFiles: 0,
            skippedByDepth: 0,
            skippedByIgnore: 0,
            directories: files.filter(f => f.type === 'directory').length,
            symlinks: files.filter(f => f.type === 'symlink').length,
            warnings,
            durationMs: 0,
            tokenEstimate
        };
        // Forward stats to summary and tree
    let summary: any = await buildSummary(config, stats, files, tokenEstimate, warnings);
        // If there are per-file errors, append a collapsed Errors section to the summary
        if (dedupedErrors.length > 0) {
            const errLines = dedupedErrors.map(e => `- ${e.path}: ${e.message}`);
            const collapsed = `\n\n<details><summary>Errors (${dedupedErrors.length}) - click to expand</summary>\n\n${errLines.join('\n')}\n\n</details>\n`;
            // For markdown output, append to summary; for text/json we'll append as plain text
            if (typeof summary === 'string') {
                // Append the collapsed section to the existing summary
                // Note: final outputFormat may be json/text/markdown; summaries are typically markdown
                summary = summary + collapsed;
            }
        }
        let tree = '';
        if (files.length > 0) {
            if (typeof config.includeTree === 'string' && config.includeTree === 'minimal') {
                const maxLines = config.maxSelectedTreeLines || 100;
                tree = buildSelectedTreeLines(files, maxLines).join('\n');
            } else if (config.includeTree === true) {
                tree = buildTree(files, true);
            }
        }

        // Add token limit warning if configured
        const contextLimit = config.contextLimit || config.tokenLimit;
        const tokenLimitWarning = typeof (this.tokenAnalyzer as any).warnIfExceedsLimit === 'function'
            ? (this.tokenAnalyzer as any).warnIfExceedsLimit(tokenEstimate, contextLimit)
            : null;
        if (tokenLimitWarning) {
            // Ensure deduplication with existing warnings
            if (!warnings.includes(tokenLimitWarning)) {
                warnings.push(tokenLimitWarning);
            }
        }
        // Assemble content string for DigestResult.
        // For JSON output use the canonical shape the provider expects so cache/editor output and returned content match:
        // { summary, tree, files: outputObjects, warnings }
        let content: string;
        if (outputFormat === 'json') {
            const canonical = { summary, tree, files: outputObjects, warnings };
            content = JSON.stringify(canonical, null, 2);
        } else {
            content = formatter.finalize(outputChunks, config);
        }
        // Build metadata
        const metadata = {
            totalFiles: files.length,
            totalSize: stats.totalSize,
            generatedAt: new Date().toISOString(),
            workspacePath: '',
            selectedFiles: files.map(f => f.relPath),
            limits: {
                maxFiles: config.maxFiles,
                maxTotalSizeBytes: config.maxTotalSizeBytes,
                maxFileSize: config.maxFileSize,
                maxDirectoryDepth: config.maxDirectoryDepth
            },
            stats,
            analysis: analysisMap,
            format: outputFormat
        };
        const result: DigestResult = {
            summary,
            tree,
            content,
            chunks: outputChunks,
            outputObjects,
            warnings,
            tokenEstimate,
            metadata,
            errors: dedupedErrors
        };
        return result;
    }
}
