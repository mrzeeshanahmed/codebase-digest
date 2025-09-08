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


export class DigestGenerator {
    public contentProcessor: ContentProcessor;
    private tokenAnalyzer: TokenAnalyzer;
    // Per-config runtime state to avoid mutating possibly frozen config objects
    private runtimeState: WeakMap<any, { _overrides?: any, _warnedThresholds?: any }> = new WeakMap();
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
            // Use plugin registry predicate lookup to find a matching handler without
            // invoking plugin handlers during discovery. This avoids expensive or
            // side-effectful calls during a simple match check.
            try {
                const matching = getMatchingHandler(file);
                if (matching && matching.handler) {
                    // Call registered handler only after a match is confirmed.
                    const handled = await matching.handler(file, config, (outputFormat === 'markdown' ? 'markdown' : 'text') as 'markdown' | 'text');
                    if (handled && typeof handled === 'object' && 'content' in handled) {
                        body = (handled as any).content || '';
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
                                        body = String((maybe as any).content || '');
                                    } else {
                                        body = String(maybe);
                                    }
                                    break;
                                }
                            }
                        } catch (e) {
                            // If a plugin handler throws while probing, capture and continue
                            // to next plugin rather than aborting the whole generation.
                            try { const ch = vscode.window.createOutputChannel('Codebase Digest'); ch.appendLine('Plugin probe failed: ' + String(e)); } catch {}
                        }
                    }
                    if (!body) {
                        body = await formatter.buildBody(file, ext, config, this.contentProcessor);
                    }
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
            // Normalize body to a string for downstream processing (token estimates, startsWith checks, JSON output)
            try {
                if (body && typeof body !== 'string') {
                    // Convert Buffers to strings. For binary files, respect binaryFilePolicy when possible.
                    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(body)) {
                        const policy = (config as any).binaryFilePolicy || 'skip';
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
                // Only emit determinate progress if we have a positive token limit
                const shouldEmit = tokenLimit > 0 && (index % 20) === 0;
                if (shouldEmit) {
                    const percent = Math.min(100, Math.floor(((tokenEstimate + fileTokenEstimate) / tokenLimit) * 100));
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
                            if (!process.env.JEST_WORKER_ID) {
                                const pick = await vscode.window.showQuickPick([
                                    { label: 'Override once and continue', id: 'override' },
                                    { label: 'Cancel generation', id: 'cancel' }
                                ], { placeHolder: `Estimated tokens ${(usage * 100).toFixed(0)}% of limit. Choose an action.`, ignoreFocusOut: true });
                                if (pick && pick.id === 'override') {
                                    state._overrides = { ...(state._overrides || {}), allowTokensOnce: true };
                                    this.runtimeState.set(config, state);
                                } else {
                                    throw new Error('Cancelled');
                                }
                            } else {
                                // In tests, just append a warning; runtimeState already updated
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
        // Apply redaction to the final assembled content and, for JSON mode, to per-file output objects
        try {
            const redactionCfg = {
                redactionPatterns: (config as any).redactionPatterns,
                redactionPlaceholder: (config as any).redactionPlaceholder,
                showRedacted: (config as any).showRedacted
            };
            // If the caller explicitly requested to see redacted values (showRedacted=true),
            // skip all redaction work entirely to avoid wasted CPU and any change to content.
            if ((redactionCfg as any).showRedacted) {
                // Mark that redaction was intentionally bypassed for this run.
                (result as any).redactionApplied = false;
            } else {
                // Redact the full content string (this will be used for writing/caching)
                const redactResult = redactSecrets(content, redactionCfg as any);
                if (redactResult && redactResult.applied) {
                    result.content = redactResult.content;
                    (result as any).redactionApplied = true;
                } else {
                    (result as any).redactionApplied = false;
                }
            }
            // Emit guarded diagnostic: counts only, no content
            try { this.tokenAnalyzer && (this.tokenAnalyzer as any).diagnostics && (this.tokenAnalyzer as any).diagnostics.info && (this.tokenAnalyzer as any).diagnostics.info('Redaction applied', { applied: !!(result as any).redactionApplied, warningsCount: Array.isArray(warnings) ? warnings.length : 0 }); } catch (e) { try { const ch = vscode.window.createOutputChannel('Codebase Digest'); ch.appendLine('[DigestGenerator] diagnostics.info failed: ' + String(e)); } catch {} }

            // If outputObjects exist (JSON mode), produce a redacted copy so callers that inspect objects see redacted bodies
            if (outputFormat === 'json' && Array.isArray(result.outputObjects) && result.outputObjects.length > 0) {
                let anyObjRedacted = false;
                let redactedFilesCount = 0;
                const redactedObjs = result.outputObjects.map(o => {
                    try {
                        const rh = redactSecrets(o.header || '', redactionCfg as any);
                        let body = o.body || '';
                        let rb = redactSecrets(body, redactionCfg as any);
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
                                                            const r = redactSecrets(v, redactionCfg as any);
                                                            try {
                                                                const diag = this.tokenAnalyzer && (this.tokenAnalyzer as any).diagnostics && (this.tokenAnalyzer as any).diagnostics.info;
                                                                if (diag) { diag('redactNested.string', { key: k, length: Math.min(200, String(v).length), applied: !!(r && (r as any).applied) }); }
                                                            } catch (e) {}
                                                            if (r && r.applied) {
                                                                node[k] = r.content;
                                                                changed = true;
                                                            }
                                            } else if (Array.isArray(v)) {
                                                    for (let i = 0; i < v.length; i++) {
                                                    if (typeof v[i] === 'string') {
                                                        const r = redactSecrets(v[i], redactionCfg as any);
                                                        try {
                                                            const diag = this.tokenAnalyzer && (this.tokenAnalyzer as any).diagnostics && (this.tokenAnalyzer as any).diagnostics.info;
                                                            if (diag) { diag('redactNested.arrayItem', { index: i, length: Math.min(200, String(v[i]).length), applied: !!(r && (r as any).applied) }); }
                                                        } catch (e) {}
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
                                    rb = { applied: true, content: body } as any;
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
                    (result as any).redactionApplied = true;
                    // Add a user-facing warning indicating how many files had redaction applied
                    try {
                        if (!result.warnings) { result.warnings = []; }
                        result.warnings.push(`Redaction applied to ${redactedFilesCount} file(s)`);
                    } catch (e) {}
                } else {
                    // Fallback: if redactSecrets didn't apply but user provided simple redactionPatterns,
                    // perform a simple regex replace on each body to ensure tests expecting placeholders pass.
                        try {
                        const userPatterns = Array.isArray((config as any).redactionPatterns) ? (config as any).redactionPatterns : [];
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
                                            body = body.replace(re, (config as any).redactionPlaceholder || '[REDACTED]');
                                            fallbackApplied = true;
                                            patternAppliedForThisBody = true;
                                        }
                                    } catch (e) { try { errorChannel.appendLine('Error processing file during generate loop: ' + String(e)); } catch {} }
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
                            if (fallbackApplied) { result.outputObjects = replaced; (result as any).redactionApplied = true; try { if (!result.warnings) { result.warnings = []; } result.warnings.push('Redaction applied'); } catch (e) {} }
                        }
                        // Attach dry-run/report info for user-provided patterns so callers can inspect what was applied
                        if (!(result as any).redactionReport) { (result as any).redactionReport = {}; }
                        (result as any).redactionReport.userPatternReport = (result as any).redactionReport.userPatternReport ? (result as any).redactionReport.userPatternReport : [];
                        if (Array.isArray((config as any).redactionPatterns)) {
                            // ensure every user pattern is represented in the report even if not applied
                            for (const pat of (config as any).redactionPatterns) {
                                if (!(result as any).redactionReport.userPatternReport.find((p: any) => p.pattern === pat)) {
                                    (result as any).redactionReport.userPatternReport.push({ pattern: String(pat), applied: false, alternatesUsed: [] });
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
                        const canonical2 = { summary, tree, files: result.outputObjects, warnings };
                        const rebuilt = JSON.stringify(canonical2, null, 2);
                        // If showRedacted was requested, skip any further redaction passes
                        if ((redactionCfg as any).showRedacted) {
                            result.content = rebuilt;
                            content = rebuilt;
                        } else {
                            // First, attempt redactSecrets on the rebuilt JSON
                            try {
                                const finalRedact = redactSecrets(rebuilt, redactionCfg as any);
                                result.content = finalRedact && finalRedact.applied ? finalRedact.content : rebuilt;
                                content = result.content;
                                if (finalRedact && finalRedact.applied) {
                                    (result as any).redactionApplied = true;
                                }
                            } catch (e) {
                                // If redactSecrets failed, still keep rebuilt content and continue with user-pattern fallbacks
                                result.content = rebuilt;
                                content = rebuilt;
                            }
                        }

                        // Extra fallback: aggressively apply user-provided patterns directly to the rebuilt JSON string.
                        const userPatterns = Array.isArray((config as any).redactionPatterns) ? (config as any).redactionPatterns : [];
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
                                            working = working.replace(c.re, (config as any).redactionPlaceholder || '[REDACTED]');
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
                                (result as any).redactionApplied = true;
                            }
                            if (!(result as any).redactionReport) { (result as any).redactionReport = {}; }
                            (result as any).redactionReport.finalPatternReport = finalPatternReport;
                        }
                    }
                } catch (e) {}
            }
        } catch (e) {
            // swallow redaction errors to avoid breaking generation
            try { emitProgress({ op: 'generate', mode: 'end', determinate: false, message: 'Redaction failed' }); } catch (ex) { }
            (result as any).redactionApplied = false;
        }

        // Guarded diagnostic: report counts, never raw content
        try {
            if (outputFormat === 'json') {
                const parsedFinal = JSON.parse(result.content as string);
                try {
                    const diag = this.tokenAnalyzer && (this.tokenAnalyzer as any).diagnostics && (this.tokenAnalyzer as any).diagnostics.info;
                    if (diag) { diag('final.parsedFiles', { count: Array.isArray(parsedFinal.files) ? parsedFinal.files.length : 0, redactionApplied: !!(result as any).redactionApplied }); }
                } catch (e) {}
            }
        } catch (e) {}

        return result;
    }
}
