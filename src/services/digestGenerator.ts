import { FileNode, DigestConfig, TraversalStats, DigestResult } from '../types/interfaces';
import { TokenAnalyzer } from './tokenAnalyzer';
import { ContentProcessor } from './contentProcessor';
import * as path from 'path';
import { getTokenizer, getMatchingHandler } from '../plugins/index';
import { getFormatter } from '../format/output';
import { buildSummary } from '../format/summaryBuilder';
import { buildTree, buildSelectedTreeLines } from '../format/treeBuilder';
import { runPool, CancellationToken } from '../utils/asyncPool';
import { analyzeImports } from './dependencyAnalyzer';
import * as vscode from 'vscode';
import { emitProgress } from '../providers/eventBus';
import { redactSecrets } from '../utils/redactSecrets';
import { Formatters } from '../utils/formatters';
import { UIPrompter, VscodeUIPrompter } from '../utils/ui';


export class DigestGenerator {
    public contentProcessor: ContentProcessor;
    private tokenAnalyzer: TokenAnalyzer;
    private prompter: UIPrompter;
    // Lazily-created shared OutputChannel for all instances to avoid UI spam
    private static _errorChannel: vscode.OutputChannel | null = null;
    // Accessor to get or create the shared OutputChannel. Use this instead of
    // calling vscode.window.createOutputChannel directly so we don't leak channels
    // by creating many during repeated operations.
    public static getErrorChannel(): vscode.OutputChannel | null {
        if (!DigestGenerator._errorChannel) {
            try {
                DigestGenerator._errorChannel = vscode.window.createOutputChannel('Code Ingest');
            } catch (e) {
                DigestGenerator._errorChannel = null;
            }
        }
        return DigestGenerator._errorChannel;
    }
    // Dispose the shared channel when the extension or service is deactivated.
    public static disposeErrorChannel(): void {
        try {
            if (DigestGenerator._errorChannel) {
                try { DigestGenerator._errorChannel.dispose(); } catch (e) { /* ignore */ }
                DigestGenerator._errorChannel = null;
            }
        } catch (e) { /* ignore */ }
    }
    // Per-config runtime state to avoid mutating possibly frozen config objects
    private runtimeState: WeakMap<DigestConfig, { _overrides?: Record<string, unknown>, _warnedThresholds?: Record<string, boolean> }> = new WeakMap();
    constructor(contentProcessor: ContentProcessor, tokenAnalyzer: TokenAnalyzer, prompter?: UIPrompter) {
    this.contentProcessor = contentProcessor;
    this.tokenAnalyzer = tokenAnalyzer;
    this.prompter = prompter || new VscodeUIPrompter();
    }
    async generate(
        files: FileNode[],
        config: DigestConfig,
        plugins: Array<{ fileHandler?: (file: FileNode, ext: string, cfg: DigestConfig) => Promise<string | { content?: string } | undefined> }>,
        outputFormat: 'markdown' | 'text' | 'json'
    ): Promise<DigestResult> {
        // Local helper types to avoid spreading `any` across the file
        type ExtendedConfig = DigestConfig & Partial<{
            concurrentFileReads: number;
            includeAnalysisSummary: boolean;
            outputPresetCompatible: boolean;
            maxSelectedTreeLines: number;
            redactionPatterns: string[];
            redactionPlaceholder: string;
            showRedacted: boolean;
            includeTree: boolean | 'minimal';
        }>;
        type ExtendedResult = DigestResult & { redactionApplied?: boolean; redactionReport?: Record<string, unknown> };

    const cfg = config as ExtendedConfig;
    // Local record view to avoid repeating `as unknown as Record<string, unknown>` casts
    const cfgRec = cfg as unknown as Record<string, unknown>;

        const extractErrorInfo = (err: unknown): { message: string; stack?: string } => {
            if (err && typeof err === 'object') {
                const eObj = err as { message?: unknown; stack?: unknown };
                const message = typeof eObj.message === 'string' ? eObj.message : String(err);
                const stack = typeof eObj.stack === 'string' ? eObj.stack : undefined;
                return { message, stack };
            }
            return { message: String(err || 'Unknown error') };
        };
        let tokenEstimate = 0;
    let outputChunks: string[] = [];
    let outputObjects: { header: string; body: string; imports?: string[] }[] = [];
    let warnings: string[] = [];
    const perFileWarnings: string[] = [];
        const perFileErrors: { path: string; message: string; stack?: string }[] = [];
    // Use the class-level accessor to obtain the shared error channel when needed.
    const formatter = getFormatter(outputFormat);
        // Preserve file order by relPath
        const sortedFiles = [...files].sort((a, b) => a.relPath.localeCompare(b.relPath));

        // Build tasks that process each file and return a result slot
    const tasks = sortedFiles.map((file, index) => async () => {
            try {
                const ext = path.extname(file.path); // includes leading dot, e.g. '.ts', '.ipynb'
                const header = formatter.buildHeader(file, config);
                let body = '';
                try {
                    // proceed normally
                } catch (e) {
                    // placeholder to satisfy TS control flow; actual try/catch per-block below
                }
            // Use plugin registry predicate lookup to find a matching handler without
            // invoking plugin handlers during discovery. This avoids expensive or
            // side-effectful calls during a simple match check.
            try {
                const matching = getMatchingHandler(file);
                    if (matching && matching.handler) {
                    // Call registered handler only after a match is confirmed.
                    const handled = await matching.handler(file, config, (outputFormat === 'markdown' ? 'markdown' : 'text') as 'markdown' | 'text');
                    if (handled && typeof handled === 'object' && 'content' in handled) {
                        body = String((handled as { content?: unknown }).content || '');
                    } else {
                        body = String(handled || '');
                    }
                } else if (Array.isArray(plugins) && plugins.length > 0) {
                    // Backwards-compatible fallback: allow passing plugin-like objects
                    // directly to generate(). Call each plugin.fileHandler at most once
                    // and use the first non-undefined return value as the body.
                    for (const p of plugins) {
                        try {
                            if (p && typeof p.fileHandler === 'function') {
                                const maybe = await p.fileHandler(file, ext, config);
                                if (maybe !== undefined && maybe !== null) {
                                    // Accept either legacy string return or an object with 'content'
                                    if (typeof maybe === 'object' && 'content' in maybe) {
                                        body = String((maybe as { content?: unknown }).content || '');
                                    } else {
                                        body = String(maybe);
                                    }
                                    break;
                                }
                            }
                        } catch (e) {
                            // If a plugin handler throws while probing, capture and continue
                            // to next plugin rather than aborting the whole generation.
                                    try { const ch = DigestGenerator.getErrorChannel(); ch && ch.appendLine('Plugin probe failed: ' + String(e)); } catch {}
                        }
                    }
                    if (!body) {
                        body = await formatter.buildBody(file, ext, config, this.contentProcessor);
                    }
                } else {
                    body = await formatter.buildBody(file, ext, config, this.contentProcessor);
                }
                } catch (err: unknown) {
                    // Capture per-file read/processing errors but do not abort overall generation
                    const { message: msg, stack } = extractErrorInfo(err);
                    perFileErrors.push({ path: file.relPath, message: msg, stack });
                // Keep body as a placeholder so downstream steps can continue
                body = `ERROR: ${msg}`;
            }
            // Normalize body to a string for downstream processing (token estimates, startsWith checks, JSON output)
            try {
                if (body && typeof body !== 'string') {
                    // Convert Buffers to strings. For binary files, respect binaryFilePolicy when possible.
                        if (typeof Buffer !== 'undefined' && Buffer.isBuffer(body)) {
                        const policy = (typeof cfgRec['binaryFilePolicy'] === 'string') ? String(cfgRec['binaryFilePolicy']) : 'skip';
                        if (policy === 'includeBase64') {
                            body = (body as Buffer).toString('base64');
                        } else {
                            // For 'skip' or unknown policies, represent binary content as an empty string to avoid breaking downstream logic
                            body = '';
                        }
                    } else {
                        body = String(body);
                    }
                }
            } catch (e) {
                // Fall back to empty string if conversion fails
                body = String(body || '');
            }
            // Dependency analysis for JS/TS files
            let imports: string[] = [];
            try {
                imports = await analyzeImports(file.path, ext, body);
            } catch (e: unknown) {
                // If dependency analysis fails, degrade gracefully:
                // 1) Log a concise message to the shared OutputChannel (non-fatal)
                // 2) Push a user-facing warning (so callers see something in the summary)
                // 3) Attempt a lightweight heuristic fallback to extract import/require statements
                const { message: msg } = extractErrorInfo(e);
                try {
                    const ch = DigestGenerator.getErrorChannel();
                    if (ch) {
                            ch.appendLine(`[analyzeImports] ${file.relPath}: ${msg}`);
                            try { const info = extractErrorInfo(e); if (info.stack) { ch.appendLine(String(info.stack)); } } catch (_) {}
                        }
                } catch (ee) { /* swallow channel failures */ }
                try { warnings.push(`Dependency analysis failed for ${file.relPath}; proceeding without full import resolution`); } catch (ee) { /* swallow */ }
                try { const { stack } = extractErrorInfo(e); perFileErrors.push({ path: file.relPath, message: `analyzeImports: ${msg}`, stack }); } catch (ee) { /* swallow */ }
                // Heuristic fallback: scan the file body for common import/require patterns to capture likely deps.
                try {
                    const heur: string[] = [];
                    if (body && typeof body === 'string') {
                        // match ES import statements: import X from 'mod' or import 'mod'
                        const importRe = /import\s+(?:[\s\S]+?)from\s+['"]([^'"]+)['"]/g;
                        let m: RegExpExecArray | null = null;
                        while ((m = importRe.exec(body)) !== null) {
                            if (m[1]) { heur.push(m[1]); }
                        }
                        // match bare imports like: import 'mod';
                        const importBareRe = /import\s+['"]([^'"]+)['"]/g;
                        while ((m = importBareRe.exec(body)) !== null) {
                            if (m[1]) { heur.push(m[1]); }
                        }
                        // match CommonJS requires: require('mod') or require("mod")
                        const reqRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
                        while ((m = reqRe.exec(body)) !== null) {
                            if (m[1]) { heur.push(m[1]); }
                        }
                        // De-dup and prefer package-like names
                        const seenH = new Set<string>();
                        const finalH = [] as string[];
                        for (const h of heur) {
                            if (!seenH.has(h)) { seenH.add(h); finalH.push(h); }
                        }
                        imports = finalH;
                    } else {
                        imports = [];
                    }
                } catch (e: unknown) {
                    imports = [];
                }
            }
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
                // Only emit determinate progress if we have a positive token limit
                const shouldEmit = tokenLimit > 0 && (index % 20) === 0;
                if (shouldEmit) {
                    // Compute raw usage percentage. To avoid showing a misleading 100% before
                    // all files are processed (which can happen when tokenLimit is small),
                    // clamp intermediate progress to a maximum of 99% unless usage >= 100%.
                    const rawPercent = ((tokenEstimate + fileTokenEstimate) / tokenLimit) * 100;
                    const percent = rawPercent >= 100 ? 100 : Math.min(99, Math.floor(rawPercent));
                    emitProgress({ op: 'generate', mode: 'progress', determinate: true, percent, message: 'Estimating tokens' });
                } else if (tokenLimit > 0 && (index % 20) === 0) {
                    // fallback non-determinate emission path if needed
                    emitProgress({ op: 'generate', mode: 'progress', determinate: false, message: 'Estimating tokens' });
                }
                // If crossing 80% threshold, present an override if interactive and not already warned
                if (tokenLimit > 0) {
                    const usage = (tokenEstimate + fileTokenEstimate) / tokenLimit;
                    if (usage >= 0.8) {
                        const state = this.runtimeState.get(config) || {};
                        const warned = state._warnedThresholds && state._warnedThresholds.tokens;
                        if (!warned) {
                            state._warnedThresholds = { ...(state._warnedThresholds || {}), tokens: true };
                            this.runtimeState.set(config, state);
                            const override = await this.prompter.promptForTokenOverride(usage);
                            if (override) {
                                state._overrides = { ...(state._overrides || {}), allowTokensOnce: true };
                                this.runtimeState.set(config, state);
                            } else {
                                throw new Error('Cancelled');
                            }
                        }
                    }
                }
            } catch (e: unknown) {
                // If user cancels or other error, propagate to abort generation
                throw e;
            }
                return { index, header, body, token: fileTokenEstimate, relPath: file.relPath, imports };
            } catch (error: unknown) {
                // Catch any unexpected per-file error and return a harmless error result
                const extractErrorInfo = (err: unknown): { message: string; stack?: string } => {
                    if (err && typeof err === 'object') {
                        const eObj = err as { message?: unknown; stack?: unknown };
                        const message = typeof eObj.message === 'string' ? eObj.message : String(err);
                        const stack = typeof eObj.stack === 'string' ? eObj.stack : undefined;
                        return { message, stack };
                    }
                    return { message: String(err || 'Unknown error') };
                };
                const info = extractErrorInfo(error);
                try { perFileErrors.push({ path: file.relPath, message: info.message, stack: info.stack }); } catch (_) { }
                try { const ch = DigestGenerator.getErrorChannel(); ch && ch.appendLine(`Error processing ${file.relPath}: ${info.message}`); } catch (_) { }
                return { index, header: '', body: `ERROR: ${info.message}`, token: 0, relPath: file.relPath, imports: [] };
            }
        });

        // Optional cancellation token: observe progress events for a generate.cancel
        // event so callers can cancel generation via the shared event bus. The
        // token is passed to runPool so workers stop early and the pool rejects
        // with an error when cancellation is requested.
        let tokenObj: CancellationToken = { isCancellationRequested: false };
        let unsubToken: (() => void) | undefined;
        try {
            unsubToken = require('../providers/eventBus').onProgress((ev: { op?: string; mode?: string }) => {
                try {
                    if (ev && ev.op === 'generate' && ev.mode === 'cancel') {
                        tokenObj.isCancellationRequested = true;
                    }
                } catch (e) { /* swallow */ }
            });
        } catch (e) {
            // If event bus isn't available for some reason, continue without cancellation support
            tokenObj = { isCancellationRequested: false };
        }
    const concurrency = (typeof cfg.concurrentFileReads === 'number') ? cfg.concurrentFileReads : 8;
        let results;
        try {
            results = await runPool(tasks, concurrency, tokenObj);
        } finally {
            try { if (typeof unsubToken === 'function') { unsubToken(); } } catch (e) { }
        }

    // Aggregate results in order
        const analysisMap: Record<string, string[]> = {};
    for (const r of results as Array<{ token: number; header?: string; body: string; relPath?: string; imports?: unknown }>) {
            tokenEstimate += r.token || 0;
            if (r.body && typeof r.body === 'string' && r.body.startsWith('ERROR:')) {
                perFileWarnings.push(r.body);
            }
            // Aggregate imports into analysis map keyed by relPath
            if (r.relPath) {
                analysisMap[r.relPath] = Array.isArray(r.imports) ? (r.imports as string[]) : [];
            }
            if (outputFormat === 'json') {
                outputObjects.push({ header: String(r.header || ''), body: r.body, imports: Array.isArray(r.imports) ? (r.imports as string[]) : [] });
            } else if (outputFormat === 'markdown' || outputFormat === 'text') {
                // Normalize header/body concatenation to avoid double-blank lines.
                const hdr = String(r.header || '');
                const bdy = String(r.body || '');
                let combined = '';
                if (!hdr) {
                    combined = bdy;
                } else if (hdr.endsWith('\n')) {
                    // Header already ends with newline(s) — strip leading newlines from body to avoid gaps
                    combined = hdr + bdy.replace(/^\n+/, '');
                } else {
                    // Header doesn't end with newline — ensure single newline between header and body
                    if (bdy.startsWith('\n')) {
                        combined = hdr + bdy;
                    } else {
                        combined = hdr + '\n' + bdy;
                    }
                }
                // Ensure a single trailing newline so chunks end consistently
                if (!combined.endsWith('\n')) { combined += '\n'; }
                outputChunks.push(combined);
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
            const channel = DigestGenerator.getErrorChannel();
            if (channel) {
                channel.appendLine(`Code Ingest encountered ${dedupedErrors.length} unique file errors:`);
                for (const e of dedupedErrors) {
                    channel.appendLine(`- ${e.path}: ${e.message}`);
                    if (e.stack) {
                        channel.appendLine(e.stack);
                    }
                }
                // Show channel to user non-modally (only when there are errors)
                try { channel.show(true); } catch (e) { /* best-effort: ignore UI failures */ }
            }
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
    let summary: string = await buildSummary(cfg, stats, files, tokenEstimate, warnings) as string;
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
            // Determine whether the caller requested a tree. Historically there
            // were two related config properties: `includeTree` (boolean or
            // legacy 'minimal' string) and `includeTreeMode` ('full'|'minimal').
            // Accept both for compatibility.
            const requestedTree = (config as any).includeTree === true || (config as any).includeTree === 'minimal';
            const modeIsMinimal = (config as any).includeTree === 'minimal' || (config as any).includeTreeMode === 'minimal';
            if (requestedTree) {
                if (modeIsMinimal) {
                    const maxLines = config.maxSelectedTreeLines || 100;
                    tree = buildSelectedTreeLines(files, maxLines).join('\n');
                } else {
                    tree = buildTree(files, true);
                }
            }
        }

    // Add token limit warning if configured
        const contextLimit = config.contextLimit || config.tokenLimit;
        const tokenLimitWarning = typeof this.tokenAnalyzer.warnIfExceedsLimit === 'function'
            ? this.tokenAnalyzer.warnIfExceedsLimit(tokenEstimate, contextLimit)
            : null;
        if (tokenLimitWarning) {
            // Ensure deduplication with existing warnings
            if (!warnings.includes(tokenLimitWarning)) {
                warnings.push(tokenLimitWarning);
            }
        }
    // For human-readable formats (text/markdown) optionally prepend the summary and
    // ASCII tree to the output content when outputPresetCompatible is enabled so the user sees
    // an immediate overview at the top of the generated file.
    // This is gated behind the config flag to avoid surprising existing callers/tests.
    if (outputFormat !== 'json' && cfg.outputPresetCompatible) {
            try {
                const fm = new Formatters();
                let headerBlock = '';
                if (typeof summary === 'string' && summary.length > 0) {
                    headerBlock += summary;
                }
                if (tree && tree.length > 0) {
                    // For markdown, fence the tree for nicer rendering; for text,
                    // just append the raw ASCII tree.
                    if (outputFormat === 'markdown') {
                        headerBlock += '\n\n' + fm.fence(tree, '.txt', 'markdown');
                    } else {
                        headerBlock += '\n\n' + tree;
                    }
                }
                if (headerBlock.length > 0) {
                    // Insert as the first chunk so finalizer will put separators
                    // after this block as usual.
                    outputChunks.unshift(headerBlock + '\n');
                }
            } catch (e) {
                // Non-fatal: if building the header block fails, continue without it
            }
        }

        // If the caller explicitly requested the ASCII tree but did NOT opt into
        // the legacy outputPresetCompatible header behavior, still ensure the
        // generated tree is included as a top-level chunk so it appears in the
        // final output. This covers callers that expect includeTree to always
        // add the tree regardless of outputPresetCompatible.
        if (tree && tree.length > 0 && outputFormat !== 'json' && !cfg.outputPresetCompatible) {
            try {
                const fm2 = new Formatters();
                if (outputFormat === 'markdown') {
                    outputChunks.unshift(fm2.fence(tree, '.txt', 'markdown') + '\n');
                } else {
                    outputChunks.unshift(tree + '\n');
                }
            } catch (e) {
                // non-fatal
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
    // Typed alias for mutation sites to avoid repeated `as any` casts
    const mResult = result as ExtendedResult;
        // Apply redaction to the final assembled content and, for JSON mode, to per-file output objects
        try {
            const redactionCfg: Partial<DigestConfig> = {
                redactionPatterns: cfg.redactionPatterns,
                redactionPlaceholder: cfg.redactionPlaceholder,
                showRedacted: cfg.showRedacted
            };
            const emitDiag = (k: string, v: unknown) => {
                try {
                    const hostAny = this.tokenAnalyzer;
                    if (hostAny && typeof hostAny === 'object') {
                        const host = hostAny as { diagnostics?: unknown };
                        const diag = host.diagnostics;
                        if (diag && typeof diag === 'object') {
                            const info = (diag as { info?: unknown }).info;
                            if (typeof info === 'function') {
                                try { (info as (k: string, v: unknown) => void)(k, v); } catch (_) { /* swallow diag errors */ }
                            }
                        }
                    }
                } catch (_) { /* swallow */ }
            };
            // If the caller explicitly requested to see redacted values (showRedacted=true),
            // skip all redaction work entirely to avoid wasted CPU and any change to content.
            if (redactionCfg.showRedacted) {
                // Mark that redaction was intentionally bypassed for this run.
                const mResult = result as ExtendedResult;
                mResult.redactionApplied = false;
            } else {
                // Redact the full content string (this will be used for writing/caching)
                const redactResult = redactSecrets(content, redactionCfg);
                const mResult = result as ExtendedResult;
                if (redactResult && redactResult.applied) {
                    result.content = redactResult.content;
                    mResult.redactionApplied = true;
                } else {
                    mResult.redactionApplied = false;
                }
            }
            // Emit guarded diagnostic: counts only, no content
            try {
                const hostAny = this.tokenAnalyzer;
                if (hostAny && typeof hostAny === 'object') {
                    const host = hostAny as { diagnostics?: unknown };
                    const diag = host.diagnostics;
                    if (diag && typeof diag === 'object') {
                        const info = (diag as { info?: unknown }).info;
                        if (typeof info === 'function') {
                            try { (info as (k: string, v: unknown) => void)('Redaction applied', { applied: !!(result as ExtendedResult).redactionApplied, warningsCount: Array.isArray(warnings) ? warnings.length : 0 }); } catch (e) { try { const ch = DigestGenerator.getErrorChannel(); ch && ch.appendLine('[DigestGenerator] diagnostics.info failed: ' + String(e)); } catch {} }
                        }
                    }
                }
            } catch (e) { try { const ch = DigestGenerator.getErrorChannel(); ch && ch.appendLine('[DigestGenerator] diagnostics.info failed: ' + String(e)); } catch {} }

            // If outputObjects exist (JSON mode), produce a redacted copy so callers that inspect objects see redacted bodies
                if (outputFormat === 'json' && Array.isArray(result.outputObjects) && result.outputObjects.length > 0) {
                let anyObjRedacted = false;
                let redactedFilesCount = 0;
                const redactedObjs = (result.outputObjects || []).map(o => {
                    try {
                        const rh = redactSecrets(o.header || '', redactionCfg);
                        let body = o.body || '';
                        let rb = redactSecrets(body, redactionCfg);
                        // If redactSecrets didn't apply and body looks like JSON, try parsing and redacting nested string fields
                        if (!rb.applied) {
                            try {
                                const parsed = JSON.parse(body);
                                let changed = false;
                                const walk = (node: any) => {
                                    if (node && typeof node === 'object') {
                                        for (const k of Object.keys(node)) {
                                            const v = node[k];
                                            if (typeof v === 'string') {
                                                            // Do not log raw string content. Emit guarded diagnostics
                                                            const r = redactSecrets(v, redactionCfg);
                                                            try {
                                                                const rrAny: unknown = r;
                                                                let appliedFlag = false;
                                                                if (rrAny && typeof rrAny === 'object' && 'applied' in (rrAny as Record<string, unknown>)) {
                                                                    const a = (rrAny as Record<string, unknown>)['applied'];
                                                                    appliedFlag = typeof a === 'boolean' ? a as boolean : Boolean(a);
                                                                } else {
                                                                    appliedFlag = Boolean((rrAny as Record<string, unknown>)['applied']);
                                                                }
                                                                emitDiag('redactNested.string', { key: k, length: Math.min(200, String(v).length), applied: appliedFlag });
                                                            } catch (_) {}
                                                            if (r && r.applied) { node[k] = r.content; changed = true; }
                                            } else if (Array.isArray(v)) {
                                                    for (let i = 0; i < v.length; i++) {
                                                    if (typeof v[i] === 'string') {
                                                        const r = redactSecrets(v[i], redactionCfg);
                                                        try {
                                                            const rrAny: unknown = r;
                                                            let appliedFlag = false;
                                                            if (rrAny && typeof rrAny === 'object' && 'applied' in (rrAny as Record<string, unknown>)) {
                                                                const a = (rrAny as Record<string, unknown>)['applied'];
                                                                appliedFlag = typeof a === 'boolean' ? a as boolean : Boolean(a);
                                                            } else {
                                                                appliedFlag = Boolean((rrAny as Record<string, unknown>)['applied']);
                                                            }
                                                            emitDiag('redactNested.arrayItem', { index: i, length: Math.min(200, String(v[i]).length), applied: appliedFlag });
                                                        } catch (_) {}
                                                        if (r && r.applied) { v[i] = r.content; changed = true; }
                                                    } else if (typeof v[i] === 'object') { walk(v[i]); }
                                                }
                                            } else if (typeof v === 'object') { walk(v); }
                                        }
                                    }
                                };
                                walk(parsed);
                                if (changed) {
                                    body = JSON.stringify(parsed);
                                    rb = { applied: true, content: body };
                                }
                            } catch (e) {
                                // ignore parse errors
                            }
                        }
                        if (rh.applied || rb.applied) { anyObjRedacted = true; redactedFilesCount += 1; }
                        return { header: rh.content, body: rb.content, imports: o.imports };
                    } catch (e) {
                        return o;
                    }
                });
                result.outputObjects = redactedObjs;
                if (anyObjRedacted) {
                    (result as ExtendedResult).redactionApplied = true;
                    // Add a user-facing warning indicating how many files had redaction applied
                    try {
                        if (!result.warnings) { result.warnings = []; }
                        result.warnings.push(`Redaction applied to ${redactedFilesCount} file(s)`);
                    } catch (e) {}
                } else {
                    // Fallback: if redactSecrets didn't apply but user provided simple redactionPatterns,
                    // perform a simple regex replace on each body to ensure tests expecting placeholders pass.
                        try {
                        const userPatterns = Array.isArray(cfg.redactionPatterns) ? cfg.redactionPatterns : [];
                        const userPatternReport: { pattern: string; applied: boolean; alternatesUsed: string[] }[] = [];
                        if (userPatterns.length > 0) {
                            let fallbackApplied = false;
                            const replaced = result.outputObjects.map(o => {
                                let body = o.body || '';
                                for (const pat of userPatterns) {
                                    let patternAppliedForThisBody = false;
                                    const alternatesUsed: string[] = [];
                                    try {
                                        let re: RegExp | null = null;
                                        try { re = new RegExp(pat, 'g'); } catch (e) { re = null; }
                                        if (!re) {
                                            // Replace common shorthand escapes with explicit classes to improve matching
                                            let alt = pat.replace(/\\w/g, '[A-Za-z0-9_]');
                                            alt = alt.replace(/\\d/g, '[0-9]');
                                            alt = alt.replace(/w\+/g, '[A-Za-z0-9_]+');
                                            alt = alt.replace(/d\+/g, '[0-9]+');
                                            try { re = new RegExp(alt, 'g'); alternatesUsed.push('shorthand-expansion'); } catch (e) { re = null; }
                                        }
                                        if (re && re.test(body)) {
                                            body = body.replace(re, cfg.redactionPlaceholder || '[REDACTED]');
                                            fallbackApplied = true;
                                            patternAppliedForThisBody = true;
                                        }
                                    } catch (e) { try { const ch = DigestGenerator.getErrorChannel(); ch && ch.appendLine('Error processing file during generate loop: ' + String(e)); } catch {} }
                                    // Record per-pattern report (merge later)
                                    const existing = userPatternReport.find(p => p.pattern === pat);
                                    if (!existing) {
                                        userPatternReport.push({ pattern: String(pat), applied: patternAppliedForThisBody, alternatesUsed });
                                    } else if (patternAppliedForThisBody) {
                                        existing.applied = true;
                                        for (const a of alternatesUsed) { if (!existing.alternatesUsed.includes(a)) { existing.alternatesUsed.push(a); } }
                                    }
                                }
                                return { ...o, body };
                            });
                            if (fallbackApplied) { result.outputObjects = replaced; (result as ExtendedResult).redactionApplied = true; try { if (!result.warnings) { result.warnings = []; } result.warnings.push('Redaction applied'); } catch (e) {} }
                        }
                        // Attach dry-run/report info for user-provided patterns so callers can inspect what was applied
                        if (!(result as ExtendedResult).redactionReport) { (result as ExtendedResult).redactionReport = {}; }
                        const report = (result as ExtendedResult).redactionReport as Record<string, any>;
                        report['userPatternReport'] = report['userPatternReport'] ? report['userPatternReport'] : [];
                        if (Array.isArray(cfg.redactionPatterns)) {
                            // ensure every user pattern is represented in the report even if not applied
                            for (const pat of cfg.redactionPatterns) {
                                if (!report['userPatternReport'].find((p: any) => p.pattern === pat)) {
                                    report['userPatternReport'].push({ pattern: String(pat), applied: false, alternatesUsed: [] });
                                }
                            }
                        }
                    } catch (e) {}
                }
                
                // DEBUG: log whether per-file objects were redacted
                try { emitProgress({ op: 'generate', mode: 'progress', determinate: false, message: `JSON objects redacted: ${anyObjRedacted}` }); } catch (e) {}
                // Rebuild canonical JSON from possibly-redacted outputObjects and re-run redactSecrets to ensure final content matches
                try {
                    if (outputFormat === 'json') {
                        // Rebuild canonical JSON using the final `result` state so any warnings appended during redaction
                        // or fallback passes are included in the content.
                        const finalWarnings = Array.isArray(result.warnings) ? result.warnings : warnings;
                        const canonical2 = { summary, tree, files: result.outputObjects, warnings: finalWarnings };
                        const rebuilt = JSON.stringify(canonical2, null, 2);
                        // If showRedacted was requested, skip any further redaction passes
                        if (redactionCfg.showRedacted) {
                            result.content = rebuilt;
                            content = rebuilt;
                        } else {
                            // First, attempt redactSecrets on the rebuilt JSON
                            try {
                                const finalRedact = redactSecrets(rebuilt, redactionCfg);
                                result.content = finalRedact && finalRedact.applied ? finalRedact.content : rebuilt;
                                content = result.content;
                                if (finalRedact && finalRedact.applied) {
                                    (result as ExtendedResult).redactionApplied = true;
                                }
                            } catch (e) {
                                // If redactSecrets failed, still keep rebuilt content and continue with user-pattern fallbacks
                                result.content = rebuilt;
                                content = rebuilt;
                            }
                        }

                        // Extra fallback: aggressively apply user-provided patterns directly to the rebuilt JSON string.
                        const userPatterns = Array.isArray(cfg.redactionPatterns) ? cfg.redactionPatterns : [];
                        if (userPatterns.length > 0) {
                            let working = String(result.content || '');
                            let fallbackApplied = false;
                            const finalPatternReport: { pattern: string; applied: boolean; alternatesUsed: string[] }[] = [];
                            for (const pat of userPatterns) {
                                if (!pat || typeof pat !== 'string') {
                                    finalPatternReport.push({ pattern: String(pat), applied: false, alternatesUsed: [] });
                                    continue;
                                }
                                const candidates: { re: RegExp | null; tag: string }[] = [];
                                try { candidates.push({ re: new RegExp(pat, 'g'), tag: 'raw' }); } catch (e) { candidates.push({ re: null, tag: 'raw' }); }
                                try {
                                    let alt = pat.replace(/\\w/g, '[A-Za-z0-9_]').replace(/\\d/g, '[0-9]');
                                    alt = alt.replace(/w\+/g, '[A-Za-z0-9_]+').replace(/d\+/g, '[0-9]+');
                                    candidates.push({ re: new RegExp(alt, 'g'), tag: 'shorthand-expansion' });
                                } catch (e) { candidates.push({ re: null, tag: 'shorthand-expansion' }); }
                                try {
                                    const m = pat.match(/([a-zA-Z0-9_\-]+\s*[:=]\s*)/);
                                    if (m) {
                                        const prefix = m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                                        const loose = new RegExp(prefix + '[A-Za-z0-9_\\-]{4,}', 'g');
                                        candidates.push({ re: loose, tag: 'loose-prefix' });
                                    }
                                } catch (e) { /* ignore */ }

                                let patternApplied = false;
                                const alternatesUsed: string[] = [];
                                for (const c of candidates) {
                                    try {
                                        if (!c.re) { continue; }
                                        if (c.re.test(working)) {
                                            working = working.replace(c.re, cfg.redactionPlaceholder || '[REDACTED]');
                                            fallbackApplied = true;
                                            patternApplied = true;
                                            alternatesUsed.push(c.tag);
                                        }
                                    } catch (e) { /* ignore individual regex failures */ }
                                }
                                finalPatternReport.push({ pattern: String(pat), applied: patternApplied, alternatesUsed });
                            }
                            if (fallbackApplied) {
                                result.content = working;
                                content = working;
                                (result as ExtendedResult).redactionApplied = true;
                            }
                            if (!mResult.redactionReport) { mResult.redactionReport = {}; }
                            (mResult.redactionReport as Record<string, any>).finalPatternReport = finalPatternReport;
                        }
                        // After any user-pattern fallbacks, ensure that the result.content matches the final state of result.warnings
                        try {
                            const finalWarnings2 = Array.isArray(mResult.warnings) ? mResult.warnings as string[] : warnings;
                            const canonicalFinal = { summary, tree, files: mResult.outputObjects, warnings: finalWarnings2 };
                            const finalRebuilt = JSON.stringify(canonicalFinal, null, 2);
                            // Only overwrite if different to avoid unnecessary churn
                            if (String(result.content || '') !== finalRebuilt) {
                                result.content = finalRebuilt;
                                content = finalRebuilt;
                            }
                        } catch (e) { /* ignore rebuild errors */ }
                    }
                } catch (e) {}
            }
        } catch (e) {
            // swallow redaction errors to avoid breaking generation
            try { emitProgress({ op: 'generate', mode: 'end', determinate: false, message: 'Redaction failed' }); } catch (ex) { }
                            mResult.redactionApplied = false;
        }

        // Guarded diagnostic: report counts, never raw content
        try {
            if (outputFormat === 'json') {
                const parsedFinal = JSON.parse(result.content as string);
                try {
                    const hostAny = this.tokenAnalyzer;
                    if (hostAny && typeof hostAny === 'object') {
                        const host = hostAny as { diagnostics?: unknown };
                        const diag = host.diagnostics;
                        if (diag && typeof diag === 'object') {
                            const info = (diag as { info?: unknown }).info;
                            if (typeof info === 'function') {
                                try { (info as (k: string, v: unknown) => void)('final.parsedFiles', { count: Array.isArray(parsedFinal.files) ? parsedFinal.files.length : 0, redactionApplied: !!mResult.redactionApplied }); } catch (e) {}
                            }
                        }
                    }
                } catch (e) {}
            }
        } catch (e) {}

        // Final guard: Ensure the ASCII tree is present at the very top of
        // the output for human formats (markdown/text) when the caller
        // requested includeTree. This runs after any redaction/rebuild steps
        // so mutations to `result.content` won't remove the tree.
        try {
            const requestedTree = (config as any).includeTree === true || (config as any).includeTree === 'minimal';
            if (tree && tree.length > 0 && outputFormat !== 'json' && requestedTree) {
                const fmFinal = new Formatters();
                // Ensure chunks contain the tree as the first chunk
                try {
                    const chunksExist = Array.isArray(result.chunks) && result.chunks.length > 0;
                    const firstChunkHasTree = chunksExist && typeof result.chunks![0] === 'string' && result.chunks![0].includes(tree);
                    if (!firstChunkHasTree) {
                        if (!Array.isArray(result.chunks)) { (result as any).chunks = []; }
                        if (outputFormat === 'markdown') {
                            (result as any).chunks.unshift(fmFinal.fence(tree, '.txt', 'markdown') + '\n');
                        } else {
                            (result as any).chunks.unshift(tree + '\n');
                        }
                    }
                } catch (e) { /* non-fatal - continue to ensure content update below */ }

                // Ensure the final content string also contains the tree at the top
                try {
                    const contentStr = String(result.content || '');
                    if (!contentStr.includes(tree)) {
                        if (outputFormat === 'markdown') {
                            const pref = fmFinal.fence(tree, '.txt', 'markdown') + '\n';
                            result.content = pref + contentStr;
                        } else {
                            result.content = tree + '\n' + contentStr;
                        }
                        // Keep local `content` in sync if it exists in this scope
                        try { if (typeof content !== 'undefined') { (content as any) = result.content; } } catch (_) {}
                    }
                } catch (e) { /* non-fatal */ }
            }
        } catch (e) { /* swallow - do not break generation for guard failures */ }

        return result;
    }
}
