import { FileNode, DigestConfig, TraversalStats } from '../types/interfaces';
import { FilterService } from './filterService';
import { minimatch } from 'minimatch';
import * as fsPromises from 'fs/promises';
import * as fs from 'fs';
import * as path from 'path';
import { emitProgress } from '../providers/eventBus';
import * as vscode from 'vscode';

/**
 * FileScanner: Traverses workspace, applies limits, respects ignore and patterns
 */
export class FileScanner {

    public lastStats?: TraversalStats;
    private gitignoreService: any;
    private diagnostics: any;
    // Per-config runtime state to avoid mutating user/VSCode config objects which may be frozen/proxied
    private runtimeState: WeakMap<any, { _overrides?: any, _warnedThresholds?: any }> = new WeakMap();

    constructor(gitignoreService: any, diagnostics: any) {
        this.gitignoreService = gitignoreService;
        this.diagnostics = diagnostics;
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
            if (matchesExcludePattern) { stats.skippedByIgnore++; return true; }
            if (gitignoreIgnored) {
                try {
                    const negs: string[] = typeof this.gitignoreService.listExplicitNegations === 'function' ? this.gitignoreService.listExplicitNegations() : [];
                    const dirKey = String(relPosix || '').replace(/^\/+|\/+$/g, '');
                    const hasNegation = negs.some(n => {
                        const nn = String(n || '').replace(/^\/+|\/+$/g, '');
                        if (!nn) { return false; }
                        if (dirKey === '') { return true; } // conservatively assume root may be affected
                        return nn === dirKey || nn.startsWith(dirKey + '/');
                    });
                    if (!hasNegation) { stats.skippedByIgnore++; return true; }
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
                const fsUtils = require('../utils/fsUtils');
                const readable = await fsUtils.FSUtils.isReadable(absPath).catch(() => true);
                const isJest = !!process.env.JEST_WORKER_ID;
                if (!readable && !isJest) {
                    if (!stats.warnings.some(w => w.startsWith('Unreadable'))) {
                        stats.warnings.push(`Unreadable path skipped: ${relPath}`);
                    }
                    return undefined;
                }
            } catch {
                // continue if readability check isn't available
            }
            return stat;
        } catch {
            if (!stats.warnings.some(w => w.startsWith('Failed to stat'))) {
                stats.warnings.push(`Failed to stat ${relPath}`);
            }
            return undefined;
        }
    }

    // Check size and file-count thresholds and warn/override as original logic; returns control flags
    private async checkAndWarnLimits(stat: fs.Stats, relPath: string, cfg: DigestConfig, stats: TraversalStats): Promise<{ continueScan: boolean, breakAll?: boolean }> {
        // maxFileSize
        if (stat.size >= cfg.maxFileSize) {
            stats.skippedBySize++;
            if (!stats.warnings.some(w => w.startsWith('Skipped oversized file'))) {
                stats.warnings.push(`Skipped oversized file: ${relPath} (${stat.size} bytes > maxFileSize)`);
                if (!stats.warnings.some(w => /file size/i.test(w))) { stats.warnings.push(`File size warning: ${relPath} exceeds maxFileSize`); }
            }
            return { continueScan: false };
        }

        // total size projection and throttled size progress
        const projectedTotal = stats.totalSize + stat.size;
        const sizeLimit = cfg.maxTotalSizeBytes || Number.MAX_SAFE_INTEGER;
        const sizePercent = sizeLimit > 0 ? projectedTotal / sizeLimit : 0;
        try { if (stats.totalFiles % 50 === 0) { emitProgress({ op: 'scan', mode: 'progress', determinate: true, percent: Math.min(100, Math.floor(sizePercent * 100)), message: 'Scanning (size)', totalFiles: stats.totalFiles, totalSize: stats.totalSize }); } } catch (e) {}

        if (sizePercent >= 1) {
            const state = this.runtimeState.get(cfg) || {};
            const overrides = state._overrides || {};
            if (overrides.allowSizeOnce) {
                state._overrides = { ...overrides, allowSizeOnce: false };
                this.runtimeState.set(cfg, state);
            } else {
                stats.skippedByTotalLimit++;
                if (!stats.warnings.some(w => w.startsWith('Skipped file due to total size limit'))) {
                    stats.warnings.push(`Skipped file due to total size limit: ${relPath} (would exceed maxTotalSizeBytes)`);
                    if (!stats.warnings.some(w => /total size/i.test(w))) { stats.warnings.push(`Total size warning: scanning would exceed maxTotalSizeBytes`); }
                }
                return { continueScan: false };
            }
        } else if (sizePercent >= 0.8) {
            const state = this.runtimeState.get(cfg) || {};
            const warned = state._warnedThresholds && state._warnedThresholds.size;
            if (!warned) {
                state._warnedThresholds = { ...(state._warnedThresholds || {}), size: true };
                this.runtimeState.set(cfg, state);
                const promptsEnabled = !!(cfg as any).promptsOnThresholds;
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
        try { if (stats.totalFiles % 50 === 0) { emitProgress({ op: 'scan', mode: 'progress', determinate: true, percent: Math.min(100, Math.floor(filePercent * 100)), message: 'Scanning (files)', totalFiles: stats.totalFiles, totalSize: stats.totalSize }); } } catch (e) {}

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
                        const promptsEnabled = !!(cfg as any).promptsOnThresholds;
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
                        if (!stats.warnings.some(w => w.startsWith('Max file count reached'))) {
                            stats.warnings.push(`Max file count reached: ${cfg.maxFiles}`);
                            if (!stats.warnings.some(w => /file count/i.test(w))) { stats.warnings.push(`File count warning: more than ${cfg.maxFiles} files`); }
                        }
                        return { continueScan: false, breakAll: true };
                    }
                } else {
                    stats.skippedByMaxFiles++;
                    if (!stats.warnings.some(w => w.startsWith('Max file count reached'))) {
                        stats.warnings.push(`Max file count reached: ${cfg.maxFiles}`);
                        if (!stats.warnings.some(w => /file count/i.test(w))) { stats.warnings.push(`File count warning: more than ${cfg.maxFiles} files`); }
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
        // Emit progress every 100 files
        if (stats.totalFiles % 100 === 0) {
            try {
                emitProgress({ op: 'scan', mode: 'progress', determinate: true, percent: 0, message: 'Scanning...', totalFiles: stats.totalFiles, totalSize: stats.totalSize });
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
            const userPresets = (cfg as any).filterPresets as string[] | undefined;
            presetName = Array.isArray(userPresets) && userPresets.length > 0 ? userPresets[0] : undefined;
        } catch {}
        let preset: { include?: string[], exclude?: string[] } = {};
        if (presetName && typeof presetName === 'string') {
            preset = FilterService.resolvePreset(presetName as any);
        }
        // Merge preset with user include/exclude
        const merged = FilterService.processPatterns(cfg.includePatterns, cfg.excludePatterns, preset);
    // Use merged patterns for scanning
    const mergedCfg = { ...cfg, includePatterns: Array.from(merged.include), excludePatterns: Array.from(merged.exclude), respectGitignore: true } as any;
    // For scanning, strip user-provided negation patterns (starting with '!') so glob matching works as expected
    const scanCfg = { ...mergedCfg, excludePatterns: Array.from((mergedCfg.excludePatterns || []).filter((p: string) => !(typeof p === 'string' && p.startsWith('!')))) } as any;
    // DEBUG: log merged exclude/include patterns
    try { console.debug('[FileScanner.scanRoot] mergedCfg.excludePatterns=', mergedCfg.excludePatterns, 'includePatterns=', mergedCfg.includePatterns); } catch (e) { try { this.diagnostics && this.diagnostics.debug && this.diagnostics.debug('scanRoot debug failed', String(e)); } catch {} }
        const start = Date.now();
    const nodes = await this.scanDir(rootPath, rootPath, 0, scanCfg, stats, token);
        stats.durationMs = Date.now() - start;
        this.diagnostics.info('File scan complete', stats);
        this.lastStats = stats;
        // Post-scan: if any explicit negation in gitignore refers to a file present at root, ensure it's included
        try {
            const negs = this.gitignoreService.listExplicitNegations();
            for (const n of negs) {
                // If the user provided an explicit negation in cfg.excludePatterns (e.g. '!path'),
                // do not inject it here because the user's exclude/include semantics should take precedence.
                try {
                    if (Array.isArray((mergedCfg as any).excludePatterns) && (mergedCfg as any).excludePatterns.some((p: string) => p === '!' + n || p === n)) {
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
                            const excludes: string[] = Array.isArray((mergedCfg as any).excludePatterns) ? (mergedCfg as any).excludePatterns : [];
                            const posExcludes = excludes.filter(p => typeof p === 'string' && !p.startsWith('!'));
                            if (posExcludes.some(p => {
                                try { return minimatch(rel, p, { dot: true, nocase: false, matchBase: false }); } catch (err) { return false; }
                            })) {
                                continue;
                            }
                        } catch (e) { try { this.diagnostics && this.diagnostics.warn && this.diagnostics.warn('exclude match failed', e); } catch {} }
                        // Ensure it exists in the hierarchical nodes; if absent, inject minimal node at correct place
                        const lstat = await fsPromises.lstat(candidate);
                        const inject: any = { path: candidate, relPath: rel, name: path.basename(candidate), type: lstat.isDirectory() ? 'directory' : 'file', size: lstat.size, mtime: lstat.mtime, depth: 0, isSelected: false, isBinary: false };
                        const parts = rel.split('/');
                        let parentList = nodes;
                        for (let i = 0; i < parts.length - 1; i++) {
                            const seg = parts[i];
                            let dir = parentList.find((n: any) => n.type === 'directory' && n.name === seg);
                            if (!dir) {
                                // create a new directory node
                                const newDir: any = { type: 'directory', name: seg, relPath: parts.slice(0, i + 1).join('/'), path: path.join(rootPath, parts.slice(0, i + 1).join(path.sep)), size: 0, depth: i, isSelected: false, isBinary: false, children: [] };
                                parentList.push(newDir as FileNode);
                                dir = newDir as FileNode;
                            }
                            // dir is now guaranteed
                            dir.children = dir.children || [];
                            parentList = dir.children;
                        }
                        if (!parentList.some((n: any) => n.relPath === rel)) {
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
    try { console.debug('[FileScanner.scanRoot] returning nodes count=', nodes.length, 'nodes=', nodes.map((n: any) => n.relPath || n.name)); } catch (e) { try { this.diagnostics && this.diagnostics.debug && this.diagnostics.debug('scanRoot returning debug failed', String(e)); } catch {} }
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
            const entries = await fsPromises.readdir(dirAbs, { withFileTypes: true });
            try { console.debug('[FileScanner.scanDir] dir=', dirAbs, 'entries=', entries.map(e => e.name)); } catch (e) {}
            for (const entry of entries) {
                if (token && token.isCancellationRequested) { throw new Error('Cancelled'); }
                const absPath = path.join(dirAbs, entry.name);
                const relPath = path.relative(rootPath, absPath).replace(/\\/g, '/');
                const isDir = entry.isDirectory();
                // Exclude/include logic:
                // - For files: skip if not included by includePatterns, or excluded by excludePatterns, or ignored by gitignore (when enabled).
                // - For directories: skip only if excluded by excludePatterns; do NOT skip solely because gitignore marks the directory ignored
                //   so that negation rules inside the directory can re-include specific files.
                const relPosix = relPath.replace(/\\/g, '/');
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
                    if (sizeCheck.breakAll) { break; }
                    continue;
                }
                if (isDir) {
                    await this.handleDirectory(entry, absPath, relPath, stat, rootPath, depth, cfg, stats, results, token);
                } else {
                    await this.handleFile(entry, absPath, relPath, stat, depth, results, stats);
                }
            }
        } catch (e) {
            try { console.debug('[FileScanner.scanDir] caught error', e && ((e as any).stack || String(e))); } catch (ex) {}
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
            const copy: any = { ...n };
            delete copy.children;
            flat.push(copy);
            if (n.children && n.children.length > 0) { walk(n.children); }
        }
    };
    walk(nodes);
    return flat;
}
