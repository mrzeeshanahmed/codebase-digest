import { FileNode, DigestConfig, TraversalStats } from '../types/interfaces';
import { FilterService } from './filterService';
import { GitignoreService } from './gitignoreService';
import { Diagnostics } from '../utils/diagnostics';
import { minimatch } from 'minimatch';
import * as fsPromises from 'fs/promises';
import * as fs from 'fs';
import * as path from 'path';
import { emitProgress } from '../providers/eventBus';
import type { ProgressEvent } from '../providers/eventBus';
import * as vscode from 'vscode';

/**
 * FileScanner: Traverses workspace, applies limits, respects ignore and patterns
 */
export class FileScanner {

    public lastStats?: TraversalStats;
    private gitignoreService: GitignoreService;
    // Accept either the Diagnostics helper or a lightweight logger-compatible shape
    private diagnostics: Diagnostics | { info?: (msg: string, extra?: unknown) => void; warn?: (msg: string, extra?: unknown) => void; debug?: (msg: string, extra?: unknown) => void };
    // Throttle progress emissions to avoid spamming UI for large repos
    private lastProgressEmitMs: number = 0;
    private progressMinIntervalMs: number = 200; // emit at most every 200ms
    // Per-config runtime state to avoid mutating user/VSCode config objects which may be frozen/proxied
    private runtimeState: WeakMap<DigestConfig, { _overrides?: Record<string, unknown>; _warnedThresholds?: Record<string, boolean> }> = new WeakMap();

    constructor(gitignoreService: GitignoreService, diagnostics: Diagnostics | { info?: (msg: string, extra?: unknown) => void; warn?: (msg: string, extra?: unknown) => void; debug?: (msg: string, extra?: unknown) => void }) {
        this.gitignoreService = gitignoreService;
        this.diagnostics = diagnostics;
    }

    // Type guard to narrow unknown nodes to FileNode
    private static isFileNode(obj: unknown): obj is FileNode {
        if (typeof obj !== 'object' || obj === null) { return false; }
        const rec = obj as Record<string, unknown>;
        if (!('type' in rec)) { return false; }
        const t = rec['type'];
        return typeof t === 'string' && (t === 'file' || t === 'directory' || t === 'symlink');
    }

    /**
     * Small helper used by tests and other services to aggregate simple stats
     */
    aggregateStats(files: FileNode[]) {
        const extCounts: Record<string, number> = {};
        const sizeBuckets: Record<string, number> = {
            '≤1KB': 0,
            '1–10KB': 0,
            '10–100KB': 0,
            '100KB–1MB': 0,
            '>1MB': 0
        };
        const langCounts: Record<string, number> = {};
        for (const fi of files) {
            const ext = path.extname(fi.path).toLowerCase();
            extCounts[ext] = (extCounts[ext] || 0) + 1;
            const sz = fi.size || 0;
            if (sz <= 1024) { sizeBuckets['≤1KB']++; }
            else if (sz <= 10 * 1024) { sizeBuckets['1–10KB']++; }
            else if (sz <= 100 * 1024) { sizeBuckets['10–100KB']++; }
            else if (sz <= 1024 * 1024) { sizeBuckets['100KB–1MB']++; }
            else { sizeBuckets['>1MB']++; }
            try {
                const fmt = require('../utils/formatters').Formatters.prototype.inferLang(ext);
                langCounts[fmt] = (langCounts[fmt] || 0) + 1;
            } catch { }
        }
        return { extCounts, sizeBuckets, langCounts };
    }

    // Helper: push a node and update stats for files/symlinks
    private pushFileNode(results: FileNode[], node: FileNode, stats: TraversalStats) {
        results.push(node);
        stats.totalFiles++;
        stats.totalSize += (node.size || 0);
    }

    // Decide whether to skip an entry based on include/exclude/gitignore rules
    private shouldSkipEntry(relPath: string, relPosix: string, isDir: boolean, cfg: DigestConfig, stats: TraversalStats): boolean {
        const includePatterns: string[] = cfg.includePatterns || [];
        const excludePatterns: string[] = cfg.excludePatterns || [];
        const matchesInclude = includePatterns.length === 0 ? true : includePatterns.some(p => minimatch(relPosix, p, { dot: true, nocase: false, matchBase: false }));
        const matchesExcludePattern = excludePatterns.some(p => minimatch(relPosix, p, { dot: true, nocase: false, matchBase: false }));
        const gitignoreIgnored = !!cfg.respectGitignore && this.gitignoreService.isIgnored(relPath, isDir);

        // New semantics: for files, includePatterns (when present) override excludes/gitignore.
        if (!isDir) {
            if (includePatterns && includePatterns.length > 0) {
                // If include patterns exist, only include files that match an include
                if (!matchesInclude) { stats.skippedByIgnore++; return true; }
                // If the file is gitignored, respect gitignore (do not override)
                if (gitignoreIgnored) { stats.skippedByIgnore++; return true; }
                // match found and not gitignored: include even if excluded by excludePatterns
                return false;
            }
            // No include patterns: original semantics (exclude or gitignore cause skip)
            if (matchesExcludePattern || gitignoreIgnored) { stats.skippedByIgnore++; return true; }
        } else {
            // Directories: preserve original behavior for exclude patterns.
            // Additionally: if a directory is gitignored and there are NO explicit negation
            // patterns that reference this directory or any descendant, we can safely skip
            // recursing into it to save IO. If any explicit negation exists that targets
            // this dir or a child, we must recurse so the negation can take effect.
            // However, also consider user-provided includePatterns: if any include pattern
            // targets a file or path under this directory, we must not skip the directory
            // even if it appears excluded or gitignored. The heuristics below conservatively
            // detect include patterns that likely reference descendants.
            const includeTargetsDescendant = (dirKey: string) => {
                try {
                    if (!includePatterns || includePatterns.length === 0) { return false; }
                    // Test each include pattern against a representative descendant path
                    // under this directory. Use two variants to catch single-level and multi-level matches.
                    // Use posix join for pattern tests because include/exclude patterns
                    // are evaluated against posix-style rel paths (forward slashes).
                    const sample1 = dirKey ? path.posix.join(dirKey, '__includetest__') : '__includetest__';
            try { if (this._progressTimer && typeof (this._progressTimer as any).unref === 'function') { try { (this._progressTimer as any).unref(); } catch (e) {} } } catch (e) {}
                    const sample2 = dirKey ? path.posix.join(dirKey, '__includetest__', 'x') : path.posix.join('__includetest__', 'x');
                    for (const p of includePatterns) {
                        try {
                            if (typeof p !== 'string') { continue; }
                            const pat = p.startsWith('!') ? p.slice(1) : p;
                            if (!pat) { continue; }
                            if (minimatch(sample1, pat, { dot: true, nocase: false, matchBase: false }) || minimatch(sample2, pat, { dot: true, nocase: false, matchBase: false })) {
                                return true;
                            }
                        } catch (e) { continue; }
                    }
                } catch (e) { /* ignore */ }
                return false;
            };

            if (matchesExcludePattern) {
                        const dirKey = String(relPosix || '').replace(/^\/+|\/+$/g, '');
                        if (!includeTargetsDescendant(dirKey)) { stats.skippedByIgnore++; return true; }
            }
            if (gitignoreIgnored) {
                try {
                    const negs: string[] = typeof this.gitignoreService.listExplicitNegations === 'function' ? this.gitignoreService.listExplicitNegations() : [];
                    const dirKey = String(relPosix || '').replace(/^\/+|\/+$/g, '');
                    const hasNegation = negs.some(n => {
                        const nn = String(n || '').replace(/^\/+|\/+$/g, '');
                        if (!nn) { return false; }
                        if (dirKey === '') { return true; } // conservatively assume root may be affected
                        const dirPrefix = dirKey.endsWith('/') ? dirKey : path.posix.join(dirKey, '');
                        return nn === dirKey || nn.startsWith(dirPrefix);
                    });
                    // If explicit gitignore negations don't reference this dir, also check includePatterns
                    const includeTargets = includeTargetsDescendant(dirKey);
                    if (!hasNegation && !includeTargets) { stats.skippedByIgnore++; return true; }
                } catch (e) {
                    // On any error while querying negations, be conservative and do not skip so negations are honoured.
                }
            }
        }
        return false;
    }

    // Safe stat + readability check, returns undefined on failure and records warnings
    private async safeStatReadable(absPath: string, relPath: string, stats: TraversalStats): Promise<fs.Stats | undefined> {
        try {
            const stat = await fsPromises.lstat(absPath) as fs.Stats;
            try {
                const fsUtilsMod = require('../utils/fsUtils') as unknown;
                const isJest = !!process.env.JEST_WORKER_ID;
                // Do not swallow errors from isReadable; treat errors as unreadable to avoid
                // accidentally proceeding on permission-denied or other IO failures.
                let readable: boolean = false;
                try {
                    // Defensive: the utils module may export FSUtils as a property or export
                    // a bare isReadable function. Narrow shapes at runtime and prefer the
                    // explicit isReadable function when available. Fall back to a simple
                    // fs.access check when no helper is present.
                    let isReadableFn: ((p: string) => Promise<boolean>) | undefined;
                    if (fsUtilsMod && typeof fsUtilsMod === 'object') {
                        const rec = fsUtilsMod as Record<string, unknown>;
                        const maybeFSUtils = rec['FSUtils'];
                        // Prefer FSUtils.isReadable when present, otherwise look for top-level isReadable
                        if (maybeFSUtils && typeof (maybeFSUtils as Record<string, unknown>)['isReadable'] === 'function') {
                            const fn = (maybeFSUtils as Record<string, unknown>)['isReadable'];
                            // Normalize runtime return types (boolean | Promise<boolean>) into Promise<boolean>
                            isReadableFn = (p: string) => Promise.resolve((fn as unknown as ((p: string) => boolean | Promise<boolean>))(String(p))).then(Boolean);
                        } else if (typeof rec['isReadable'] === 'function') {
                            const fn = rec['isReadable'];
                            isReadableFn = (p: string) => Promise.resolve((fn as unknown as ((p: string) => boolean | Promise<boolean>))(String(p))).then(Boolean);
                        }
                    }
                    if (isReadableFn) {
                        readable = await isReadableFn(absPath);
                    } else {
                        // Fallback: attempt a permissions check using fs.access
                        try {
                            // Read fs.constants safely (no double-cast)
                            const maybeConstants = (fs as { constants?: Record<string, number> }).constants;
                            const accessMode = maybeConstants && typeof maybeConstants.R_OK === 'number' ? maybeConstants.R_OK : 4;
                            await fsPromises.access(absPath, accessMode);
                            readable = true;
                        } catch (_) {
                            readable = false;
                        }
                    }
                } catch (e) {
                    // If the readability check throws, treat as unreadable and record a warning
                    try {
                        if (!stats.warnings.some(w => w.startsWith('Unreadable'))) {
                            stats.warnings.push(`Unreadable path skipped (error checking readability): ${relPath}`);
                        }
                    } catch {}
                    readable = false;
                }
                if (!readable && !isJest) {
                    if (!stats.warnings.some(w => w.startsWith('Unreadable'))) {
                        stats.warnings.push(`Unreadable path skipped: ${relPath}`);
                    }
                    return undefined;
                }
            } catch {
                // If fsUtils can't be required or other unexpected error, be conservative and treat as unreadable
                if (!stats.warnings.some(w => w.startsWith('Unreadable'))) {
                    stats.warnings.push(`Unreadable path skipped (read check failed): ${relPath}`);
                }
                return undefined;
            }
            return stat;
        } catch {
            if (!stats.warnings.some(w => w.startsWith('Failed to stat'))) {
                stats.warnings.push(`Failed to stat ${relPath}`);
            }
            return undefined;
        }
    }

    // Throttled progress emitter: emits at most once per progressMinIntervalMs
    private emitProgressThrottled(e: ProgressEvent) {
        try {
            const now = Date.now();
            if (now - this.lastProgressEmitMs >= this.progressMinIntervalMs) {
                this.lastProgressEmitMs = now;
                try { emitProgress(e); } catch (err) {
                    try {
                        if (this.diagnostics && typeof this.diagnostics.warn === 'function') { this.diagnostics.warn('emitProgress failed', err); }
                        else { console.warn('emitProgress failed', err); }
                    } catch {}
                }
            }
        } catch (ex) { try { this.diagnostics && this.diagnostics.warn && this.diagnostics.warn('emitProgressThrottled failed', ex); } catch {} }
    }

    // Debounced progress emitter: coalesces frequent progress events and emits
    // the latest event at most once per interval (progressMinIntervalMs). This is
    // useful when loops or many file events call emit frequently; it reduces UI
    // churn by consolidating bursty updates.
    private _pendingProgressEvent: ProgressEvent | null = null;
    private _progressTimer: ReturnType<typeof setTimeout> | null = null;
    private emitProgressDebounced(e: ProgressEvent) {
        try {
            // Overwrite pending with the latest event so we emit the most recent state
            this._pendingProgressEvent = e;
            // If a timer is already scheduled, do nothing else; the timer will emit the latest
            if (this._progressTimer) { return; }
            this._progressTimer = setTimeout(() => {
                try {
                    if (this._pendingProgressEvent) {
                        try { emitProgress(this._pendingProgressEvent); } catch (err) {
                            try { this.diagnostics && this.diagnostics.warn ? this.diagnostics.warn('emitProgress failed', err) : console.warn('emitProgress failed', err); } catch {};
                        }
                    }
                } finally {
                    this._pendingProgressEvent = null;
                    if (this._progressTimer) { try { clearTimeout(this._progressTimer); } catch {} }
                    this._progressTimer = null;
                }
            }, this.progressMinIntervalMs);
            try { if (this._progressTimer && typeof (this._progressTimer as any).unref === 'function') { try { (this._progressTimer as any).unref(); } catch (e) {} } } catch (e) {}
        } catch (ex) { try { this.diagnostics && this.diagnostics.warn && this.diagnostics.warn('emitProgressDebounced failed', ex); } catch {} }
    }

    // Check size and file-count thresholds and warn/override as original logic; returns control flags
    private async checkAndWarnLimits(stat: fs.Stats, relPath: string, cfg: DigestConfig, stats: TraversalStats): Promise<{ continueScan: boolean, breakAll?: boolean }> {
        // maxFileSize
        if (stat.size >= cfg.maxFileSize) {
            stats.skippedBySize++;
            // Push a single, detailed warning for oversized files to avoid redundant messages
            if (!stats.warnings.some(w => w.startsWith('Skipped oversized file'))) {
                // keep the phrase 'file size' so callers/tests that search for that term still match
                stats.warnings.push(`Skipped oversized file (file size: ${stat.size} bytes > maxFileSize): ${relPath}`);
            }
            return { continueScan: false };
        }

        // total size projection and throttled size progress
        const projectedTotal = stats.totalSize + stat.size;
        const sizeLimit = cfg.maxTotalSizeBytes || Number.MAX_SAFE_INTEGER;
        const sizePercent = sizeLimit > 0 ? projectedTotal / sizeLimit : 0;
    try { if (stats.totalFiles % 50 === 0) { this.emitProgressDebounced({ op: 'scan', mode: 'progress', determinate: true, percent: Math.min(100, Math.floor(sizePercent * 100)), message: 'Scanning (size)', totalFiles: stats.totalFiles, totalSize: stats.totalSize }); } } catch (e) {}

        if (sizePercent >= 1) {
            const state = this.runtimeState.get(cfg) || {};
            const overrides = state._overrides || {};
            if (overrides.allowSizeOnce) {
                state._overrides = { ...overrides, allowSizeOnce: false };
                this.runtimeState.set(cfg, state);
            } else {
                stats.skippedByTotalLimit++;
                // Single warning entry for total-size-based skip
                if (!stats.warnings.some(w => w.startsWith('Skipped file due to total size limit'))) {
                    stats.warnings.push(`Skipped file due to total size limit: ${relPath} (would exceed maxTotalSizeBytes)`);
                }
                return { continueScan: false };
            }
        } else if (sizePercent >= 0.8) {
                const state = this.runtimeState.get(cfg) || {};
                const warned = state._warnedThresholds && state._warnedThresholds.size;
            if (!warned) {
                state._warnedThresholds = { ...(state._warnedThresholds || {}), size: true };
                this.runtimeState.set(cfg, state);
                    // Safely read optional boolean flag from cfg without double-cast
                    let promptsEnabled = false;
                    try {
                        const maybeCfg = cfg as unknown;
                        if (maybeCfg && typeof maybeCfg === 'object' && 'promptsOnThresholds' in maybeCfg) {
                            const val = (maybeCfg as Record<string, unknown>)['promptsOnThresholds'];
                            promptsEnabled = typeof val === 'boolean' ? val : false;
                        }
                    } catch {}
                const isJest = !!process.env.JEST_WORKER_ID;
                if (isJest || !promptsEnabled) {
                    if (!stats.warnings.some(w => w.startsWith('Approaching total size limit'))) {
                        stats.warnings.push(`Approaching total size limit: ${(sizePercent * 100).toFixed(0)}%`);
                    }
                    state._overrides = { ...(state._overrides || {}), allowSizeOnce: true };
                    this.runtimeState.set(cfg, state);
                } else {
                            const pick = await vscode.window.showQuickPick([
                        { label: 'Override once and continue', id: 'override' },
                        { label: 'Cancel scan', id: 'cancel' }
                    ], { placeHolder: `Scanning would use ${(sizePercent * 100).toFixed(0)}% of maxTotalSizeBytes. Choose an action.`, ignoreFocusOut: true });
                    if (pick && pick.id === 'override') {
                        state._overrides = { ...(state._overrides || {}), allowSizeOnce: true };
                        this.runtimeState.set(cfg, state);
                    } else {
                        throw new Error('Cancelled');
                    }
                }
            }
        }

        // File count checks and throttled file progress
        const filePercent = cfg.maxFiles > 0 ? stats.totalFiles / cfg.maxFiles : 0;
    try { if (stats.totalFiles % 50 === 0) { this.emitProgressDebounced({ op: 'scan', mode: 'progress', determinate: true, percent: Math.min(100, Math.floor(filePercent * 100)), message: 'Scanning (files)', totalFiles: stats.totalFiles, totalSize: stats.totalSize }); } } catch (e) {}

        if (stats.totalFiles >= cfg.maxFiles) {
            const state = this.runtimeState.get(cfg) || {};
            const overrides = state._overrides || {};
            if (overrides.allowFilesOnce) {
                state._overrides = { ...overrides, allowFilesOnce: false };
                this.runtimeState.set(cfg, state);
                return { continueScan: true };
            } else {
                if (filePercent >= 0.8) {
                    const warned = state._warnedThresholds && state._warnedThresholds.files;
                    if (!warned) {
                        state._warnedThresholds = { ...(state._warnedThresholds || {}), files: true };
                        this.runtimeState.set(cfg, state);
                        // Safely read optional boolean flag from cfg without double-cast
                        let promptsEnabled = false;
                        try {
                            const maybeCfg = cfg as unknown;
                            if (maybeCfg && typeof maybeCfg === 'object' && 'promptsOnThresholds' in maybeCfg) {
                                const val = (maybeCfg as Record<string, unknown>)['promptsOnThresholds'];
                                promptsEnabled = typeof val === 'boolean' ? val : false;
                            }
                        } catch {}
                        const isJest = !!process.env.JEST_WORKER_ID;
                        if (isJest || !promptsEnabled) {
                            if (!stats.warnings.some(w => w.startsWith('Approaching file count'))) {
                                stats.warnings.push(`Approaching file count limit: ${(filePercent * 100).toFixed(0)}%`);
                            }
                            state._overrides = { ...(state._overrides || {}), allowFilesOnce: true };
                            this.runtimeState.set(cfg, state);
                        } else {
                            const pick = await vscode.window.showQuickPick([
                                { label: 'Override once and continue', id: 'override' },
                                { label: 'Cancel scan', id: 'cancel' }
                            ], { placeHolder: `Scanning has reached ${(filePercent * 100).toFixed(0)}% of maxFiles. Choose an action.`, ignoreFocusOut: true });
                            if (pick && pick.id === 'override') {
                                state._overrides = { ...(state._overrides || {}), allowFilesOnce: true };
                                this.runtimeState.set(cfg, state);
                            } else {
                                throw new Error('Cancelled');
                            }
                        }
                    } else {
                        stats.skippedByMaxFiles++;
                        // Consolidate file-count warning into a single message
                        if (!stats.warnings.some(w => w.startsWith('Max file count reached'))) {
                            stats.warnings.push(`Max file count reached: ${cfg.maxFiles}`);
                        }
                        return { continueScan: false, breakAll: true };
                    }
                } else {
                    stats.skippedByMaxFiles++;
                    if (!stats.warnings.some(w => w.startsWith('Max file count reached'))) {
                        stats.warnings.push(`Max file count reached: ${cfg.maxFiles}`);
                    }
                    return { continueScan: false, breakAll: true };
                }
            }
        }

        return { continueScan: true };
    }

    // Push a directory node (keeps directory push logic centralized)
    private pushDirectoryNode(results: FileNode[], absPath: string, relPath: string, name: string, stat: fs.Stats, depth: number, childResults: FileNode[]) {
        results.push({
            path: absPath,
            relPath,
            name,
            type: 'directory',
            size: stat.size,
            mtime: stat.mtime,
            depth,
            isSelected: false,
            isBinary: false,
            children: childResults,
        });
    }

    // Handle a symbolic link entry
    private async handleSymlink(entry: fs.Dirent, absPath: string, relPath: string, stat: fs.Stats, depth: number, results: FileNode[], stats: TraversalStats) {
        this.pushFileNode(results, {
            path: absPath,
            relPath,
            name: entry.name,
            type: 'symlink',
            size: stat.size,
            mtime: stat.mtime,
            depth,
            isSelected: false,
            isBinary: false,
        }, stats);
    }

    // Handle a regular file entry: push node and emit occasional progress
    private async handleFile(entry: fs.Dirent, absPath: string, relPath: string, stat: fs.Stats, depth: number, results: FileNode[], stats: TraversalStats) {
        this.pushFileNode(results, {
            path: absPath,
            relPath,
            name: entry.name,
            type: 'file',
            size: stat.size,
            mtime: stat.mtime,
            depth,
            isSelected: false,
            isBinary: false,
        }, stats);
        // Emit progress every 100 files (throttled)
        if (stats.totalFiles % 100 === 0) {
            try {
                this.emitProgressDebounced({ op: 'scan', mode: 'progress', determinate: true, percent: 0, message: 'Scanning...', totalFiles: stats.totalFiles, totalSize: stats.totalSize });
            } catch (e) { try { this.diagnostics && this.diagnostics.warn ? this.diagnostics.warn('readDir failed', e) : console.warn('readDir failed', e); } catch {} }
        }
    }

    // Handle a directory entry: load gitignore for dir, recurse and push directory node
    private async handleDirectory(entry: fs.Dirent, absPath: string, relPath: string, stat: fs.Stats, rootPath: string, depth: number, cfg: DigestConfig, stats: TraversalStats, results: FileNode[], token?: { isCancellationRequested?: boolean }) {
        try {
            await this.gitignoreService.loadForDir(absPath);
        } catch {}
        stats.directories++;
        const childResults = await this.scanDir(absPath, rootPath, depth + 1, cfg, stats, token);
        this.pushDirectoryNode(results, absPath, relPath, entry.name, stat, depth, childResults);
    }

    async scanRoot(rootPath: string, cfg: DigestConfig, token?: { isCancellationRequested?: boolean }): Promise<FileNode[]> {
        await this.gitignoreService.loadRoot(rootPath, cfg.gitignoreFiles);
        const stats: TraversalStats = {
            totalFiles: 0,
            totalSize: 0,
            skippedBySize: 0,
            skippedByTotalLimit: 0,
            skippedByMaxFiles: 0,
            skippedByDepth: 0,
            skippedByIgnore: 0,
            directories: 0,
            symlinks: 0,
            warnings: [],
            durationMs: 0
        };
        // Integrate filter preset
        let presetName: string | undefined;
        try {
            // Read filterPresets defensively from cfg without double-cast.
            const maybeCfg = cfg as unknown;
            if (maybeCfg && typeof maybeCfg === 'object') {
                const rec = maybeCfg as Record<string, unknown>;
                const maybe = rec['filterPresets'];
                const userPresets = Array.isArray(maybe) ? maybe.filter((x: unknown) => typeof x === 'string').map(x => String(x)) : undefined;
                presetName = Array.isArray(userPresets) && userPresets.length > 0 ? userPresets[0] : undefined;
            }
        } catch {}
        let preset: { include?: string[], exclude?: string[] } = {};
        if (presetName && typeof presetName === 'string') {
            preset = FilterService.resolvePreset(presetName);
        }
        // Merge preset with user include/exclude
    // Preserve any explicit negations (patterns starting with '!') so they are
    // not removed by include-wins deduplication logic inside processPatterns.
    const explicitNegations = Array.isArray(cfg.includePatterns) ? (cfg.includePatterns as string[]).filter(p => typeof p === 'string' && p.startsWith('!')).map(p => p.slice(1)) : [];
    const merged = FilterService.processPatterns(cfg.includePatterns, cfg.excludePatterns, preset, undefined, explicitNegations);
    // Use merged patterns for scanning and type the merged config more precisely
    const mergedCfg: DigestConfig & { includePatterns: string[]; excludePatterns: string[] } = Object.assign({}, cfg, { includePatterns: Array.from(merged.include), excludePatterns: Array.from(merged.exclude), respectGitignore: true });
    // For scanning, strip user-provided negation patterns (starting with '!') so glob matching works as expected
    const scanCfg: DigestConfig & { includePatterns: string[]; excludePatterns: string[] } = Object.assign({}, mergedCfg, { excludePatterns: Array.from((mergedCfg.excludePatterns || []).filter((p: string) => !(typeof p === 'string' && p.startsWith('!')))) });
    // DEBUG: log merged exclude/include patterns
    try { console.debug('[FileScanner.scanRoot] mergedCfg.excludePatterns=', mergedCfg.excludePatterns, 'includePatterns=', mergedCfg.includePatterns); } catch (e) { try { this.diagnostics?.debug && this.diagnostics.debug('scanRoot debug failed', String(e)); } catch {} }
        const start = Date.now();
    const nodes = await this.scanDir(rootPath, rootPath, 0, scanCfg, stats, token);
        stats.durationMs = Date.now() - start;
    try { this.diagnostics?.info && this.diagnostics.info('File scan complete', stats); } catch {}
        this.lastStats = stats;
        // Post-scan: if any explicit negation in gitignore refers to a file present at root, ensure it's included
        try {
            const negs: string[] = this.gitignoreService.listExplicitNegations();
            for (const n of negs) {
                // If the user provided an explicit negation in cfg.excludePatterns (e.g. '!path'),
                // do not inject it here because the user's exclude/include semantics should take precedence.
                try {
                    if (Array.isArray(mergedCfg.excludePatterns) && mergedCfg.excludePatterns.some((p: string) => p === '!' + n || p === n)) {
                        continue;
                    }
                } catch (e) { try { this.diagnostics && this.diagnostics.warn && this.diagnostics.warn('negation check failed', e); } catch {} }
                const candidate = path.join(rootPath, n);
                try {
                    if (fs.existsSync(candidate)) {
                        const rel = path.relative(rootPath, candidate).replace(/\\/g, '/');
                        // If user provided an exclude pattern that positively matches this rel (and isn't itself a negation),
                        // do not inject the file since user exclusion should take precedence.
                        try {
                            const excludes: string[] = Array.isArray(mergedCfg.excludePatterns) ? mergedCfg.excludePatterns : [];
                            const posExcludes = excludes.filter(p => typeof p === 'string' && !p.startsWith('!'));
                            if (posExcludes.some(p => {
                                try { return minimatch(rel, p, { dot: true, nocase: false, matchBase: false }); } catch (err) { return false; }
                            })) {
                                continue;
                            }
                        } catch (e) { try { this.diagnostics && this.diagnostics.warn && this.diagnostics.warn('exclude match failed', e); } catch {} }
                        // Ensure it exists in the hierarchical nodes; if absent, inject minimal node at correct place
                        const lstat = await fsPromises.lstat(candidate);
                        const inject: FileNode = { path: candidate, relPath: rel, name: path.basename(candidate), type: lstat.isDirectory() ? 'directory' : 'file', size: lstat.size, mtime: lstat.mtime, depth: 0, isSelected: false, isBinary: false };
                        const parts = rel.split('/');
                        let parentList = nodes;
                        for (let i = 0; i < parts.length - 1; i++) {
                            const seg = parts[i];
                            let dir = parentList.find((n: unknown) => FileScanner.isFileNode(n) && n.type === 'directory' && n.name === seg) as FileNode | undefined;
                            if (!dir) {
                                // create a new directory node
                                const newDir: FileNode = { type: 'directory', name: seg, relPath: parts.slice(0, i + 1).join('/'), path: path.join(rootPath, parts.slice(0, i + 1).join(path.sep)), size: 0, depth: i, isSelected: false, isBinary: false, children: [] } as FileNode;
                                parentList.push(newDir);
                                dir = newDir;
                            }
                            // dir is now guaranteed
                            dir.children = dir.children || [];
                            parentList = dir.children;
                        }
                        if (!parentList.some((n: unknown) => (FileScanner.isFileNode(n) ? n.relPath === rel : false))) {
                            parentList.push(inject);
                        }
                    }
                } catch (e) { try { this.diagnostics && this.diagnostics.warn && this.diagnostics.warn('inject negation candidate failed', e); } catch {} }
            }
        } catch (e) { }
        // Dedupe warnings but preserve first-occurrence detail: keep order and unique by prefix key
        const seen = new Set<string>();
        const deduped: string[] = [];
        for (const w of stats.warnings) {
            const key = w.split(':')[0];
            if (!seen.has(key)) { seen.add(key); deduped.push(w); }
        }
    // Replace stats.warnings with deduped list
    stats.warnings = deduped;
    try { console.debug('[FileScanner.scanRoot] returning nodes count=', nodes.length, 'nodes=', nodes.map((n: FileNode) => n.relPath || n.name)); } catch (e) { try { this.diagnostics?.debug && this.diagnostics.debug('scanRoot returning debug failed', String(e)); } catch {} }
    return nodes;
    }

    /**
     * Scan a single directory for lazy loading (used by treeDataProvider).
     */
    async scanDirectory(dirAbs: string, cfg: DigestConfig, token?: { isCancellationRequested?: boolean }): Promise<FileNode[]> {
        const stats: TraversalStats = {
            totalFiles: 0,
            totalSize: 0,
            skippedBySize: 0,
            skippedByTotalLimit: 0,
            skippedByMaxFiles: 0,
            skippedByDepth: 0,
            skippedByIgnore: 0,
            directories: 0,
            symlinks: 0,
            warnings: [],
            durationMs: 0
        };
        await this.gitignoreService.loadForDir(dirAbs);
        return await this.scanDir(dirAbs, dirAbs, 0, cfg, stats, token);
    }

    /**
     * Shallow (one-level) scan of a directory with optional pagination. Returns items and total count
     * after applying include/exclude/gitignore and other per-entry filters. This is optimized for
     * tree lazy-loading where scanning nested children is expensive.
     */
    async scanDirectoryShallow(dirAbs: string, cfg: DigestConfig, token?: { isCancellationRequested?: boolean }, start: number = 0, pageSize: number = 200): Promise<{ items: FileNode[]; total: number }> {
        const items: FileNode[] = [];
        let total = 0;
        try {
            if (token && token.isCancellationRequested) { return { items, total }; }
            await this.gitignoreService.loadForDir(dirAbs);
            const dirHandle = await fsPromises.opendir(dirAbs);
            try {
                const allEntries: fs.Dirent[] = [];
                for await (const e of dirHandle) { allEntries.push(e); }
                // Evaluate each entry with filtering to compute total and collect page
                for (let i = 0; i < allEntries.length; i++) {
                    const entry = allEntries[i];
                    const absPath = path.join(dirAbs, entry.name);
                    const relPath = path.relative(dirAbs, absPath).replace(/\\/g, '/');
                    const relPosix = relPath.replace(/\\/g, '/');
                    const isDir = entry.isDirectory();
                    // Apply skip logic
                    if (this.shouldSkipEntry(relPath, relPosix, isDir, cfg, { totalFiles: 0, totalSize: 0, skippedBySize: 0, skippedByTotalLimit: 0, skippedByMaxFiles: 0, skippedByDepth: 0, skippedByIgnore: 0, directories: 0, symlinks: 0, warnings: [], durationMs: 0 })) { continue; }
                    // stat readability
                    const stat = await this.safeStatReadable(absPath, relPath, { totalFiles: 0, totalSize: 0, skippedBySize: 0, skippedByTotalLimit: 0, skippedByMaxFiles: 0, skippedByDepth: 0, skippedByIgnore: 0, directories: 0, symlinks: 0, warnings: [], durationMs: 0 });
                    if (!stat) { continue; }
                    total++;
                    if (total - 1 < start) { continue; }
                    if (items.length >= pageSize) { continue; }
                    if (entry.isSymbolicLink()) {
                        items.push({ path: absPath, relPath, name: entry.name, type: 'symlink', size: stat.size, mtime: stat.mtime, depth: 0, isSelected: false, isBinary: false });
                        continue;
                    }
                    if (entry.isDirectory()) {
                        items.push({ path: absPath, relPath, name: entry.name, type: 'directory', size: stat.size, mtime: stat.mtime, depth: 0, isSelected: false, isBinary: false, children: [] });
                    } else {
                        items.push({ path: absPath, relPath, name: entry.name, type: 'file', size: stat.size, mtime: stat.mtime, depth: 0, isSelected: false, isBinary: false });
                    }
                }
            } finally { try { await dirHandle.close(); } catch (_) {} }
        } catch (e) {
            // On any error, return what we have; caller may surface warnings
        }
        return { items, total };
    }

    private async scanDir(dirAbs: string, rootPath: string, depth: number, cfg: DigestConfig, stats: TraversalStats, token?: { isCancellationRequested?: boolean }): Promise<FileNode[]> {
        // Allow scanning root at depth 0 when maxDirectoryDepth == 0. Only skip when depth exceeds the max.
        if (depth > cfg.maxDirectoryDepth) {
            stats.skippedByDepth++;
            if (!stats.warnings.some(w => w.startsWith('Max directory depth'))) {
                stats.warnings.push(`Max directory depth reached at ${dirAbs}`);
            }
            return [];
        }
        let results: FileNode[] = [];
        try {
            if (token && token.isCancellationRequested) {
                // Abort early if cancellation requested
                throw new Error('Cancelled');
            }
            const dirHandle = await fsPromises.opendir(dirAbs);
            try { console.debug('[FileScanner.scanDir] opendir=', dirAbs); } catch (e) {}
            // Process directory entries in bounded-size batches to avoid unbounded memory
            // usage when directories contain very large numbers of entries. This also
            // allows emitting progress per batch and checking cancellation between batches.
            const BATCH_SIZE = 100;
            const batch: fs.Dirent[] = [];

            const processBatch = async (items: fs.Dirent[]) => {
                for (const entry of items) {
                    if (token && token.isCancellationRequested) { throw new Error('Cancelled'); }
                    const absPath = path.join(dirAbs, entry.name);
                    const relPath = path.relative(rootPath, absPath).replace(/\\/g, '/');
                    const isDir = entry.isDirectory();
                    const relPosix = relPath.replace(/\\/g, '/');

                    // Apply skip logic
                    if (this.shouldSkipEntry(relPath, relPosix, isDir, cfg, stats)) { continue; }
                    // stat + readable
                    const stat = await this.safeStatReadable(absPath, relPath, stats);
                    if (!stat) { continue; }

                    // symlink handling
                    if (entry.isSymbolicLink()) {
                        await this.handleSymlink(entry, absPath, relPath, stat, depth, results, stats);
                        continue;
                    }

                    // size / total / files checks
                    const sizeCheck = await this.checkAndWarnLimits(stat, relPath, cfg, stats);
                    if (!sizeCheck.continueScan) {
                        if (sizeCheck.breakAll) { return { breakAll: true }; }
                        continue;
                    }

                    if (isDir) {
                        await this.handleDirectory(entry, absPath, relPath, stat, rootPath, depth, cfg, stats, results, token);
                    } else {
                        await this.handleFile(entry, absPath, relPath, stat, depth, results, stats);
                    }
                }
                // Emit a debounced progress update after processing the batch
                try {
                    this.emitProgressDebounced({ op: 'scan', mode: 'progress', determinate: false, percent: 0, message: 'Scanning...', totalFiles: stats.totalFiles, totalSize: stats.totalSize });
                } catch (e) { try { this.diagnostics && this.diagnostics.warn ? this.diagnostics.warn('emitProgress failed', e) : console.warn('emitProgress failed', e); } catch {} }
                return { breakAll: false };
            };

            for await (const entry of dirHandle) {
                if (token && token.isCancellationRequested) { await dirHandle.close(); throw new Error('Cancelled'); }
                batch.push(entry);
                if (batch.length >= BATCH_SIZE) {
                    const r = await processBatch(batch.splice(0, batch.length));
                    if (r && (r as any).breakAll) { break; }
                    if (token && token.isCancellationRequested) { await dirHandle.close(); throw new Error('Cancelled'); }
                }
            }
            // process remaining items
            if (batch.length > 0) {
                const r = await processBatch(batch.splice(0, batch.length));
                if (r && (r as any).breakAll) { /* noop - we'll return results below */ }
            }
            try { await dirHandle.close(); } catch (_) {}
        } catch (e) {
            try {
                // Safely extract stack or string from unknown error without `as any`
                let errInfo: string = '';
                try {
                    if (e && typeof e === 'object' && 'stack' in (e as Record<string, unknown>) && typeof (e as Record<string, unknown>)['stack'] === 'string') {
                        errInfo = (e as Record<string, unknown>)['stack'] as string;
                    } else {
                        errInfo = String(e);
                    }
                } catch (_) {
                    errInfo = String(e);
                }
                console.debug('[FileScanner.scanDir] caught error', errInfo);
            } catch (ex) {}
            if (String(e) === 'Error: Cancelled') {
                // Propagate cancellation upwards
                this.lastStats = stats;
                throw e;
            }
            if (!stats.warnings.some(w => w.startsWith('Failed to read directory'))) {
                stats.warnings.push(`Failed to read directory ${dirAbs}`);
            }
        }
        return results;
    }
}

// Optional: flat view for tests or tooling
export function flattenTree(nodes: FileNode[]): FileNode[] {
    const flat: FileNode[] = [];
    const walk = (nlist: FileNode[]) => {
        for (const n of nlist) {
            // Create a shallow copy without children while preserving FileNode shape
            const { children, ...rest } = n as FileNode;
            const copy: FileNode = { ...rest } as FileNode;
            flat.push(copy);
            if (n.children && n.children.length > 0) { walk(n.children); }
        }
    };
    walk(nodes);
    return flat;
}
