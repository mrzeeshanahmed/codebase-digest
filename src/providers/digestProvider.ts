/**
 * Code Ingest Orchestration Flow
 *
 * 1. scan: Traverse and filter files in the workspace using FileScanner and FilterService.
 * 2. select: Track user selection of files for preview and digest generation.
 * 3. generate: Build digest summary, tree, and content using Formatters and ContentProcessor.
 * 4. write: Output digest to editor, file, or clipboard via OutputWriter, supporting progressive writes.
 * 5. cache: Optionally cache digest results for quick reopening and reuse using CacheService.
 *
 * This flow ensures deterministic, efficient, and user-driven digest generation and output.
 */
// DigestProvider orchestrates digest generation
// CODEMOD-SAFE: Do not change exported type names, field names, or command IDs unless a prompt explicitly says so
import { Services } from '../services';
import { DigestConfig, FileNode, DigestResult } from '../types/interfaces';
import * as vscode from 'vscode';
import { CodebaseDigestTreeProvider } from './treeDataProvider';
import { CacheService } from '../services/cacheService';
import { ingestRemoteRepo, cleanup as cleanupRemoteTmp, RemoteRepoMeta } from '../services/githubService';
import { DigestGenerator } from '../services/digestGenerator';
import { OutputWriter } from '../services/outputWriter';
import { redactSecrets } from '../utils/redactSecrets';
import { showUserError } from '../utils/userMessages';
import * as errorsUtil from '../utils/errors';
import { emitProgress } from './eventBus';
import { broadcastGenerationResult } from './codebasePanel';
import { getMutex } from '../utils/asyncLock';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

/**
 * Generate a digest from selected files and config.
 * @param selectedFiles Array of FileNode (files only)
 * @param config DigestConfig object
 * @param stats TraversalStats (optional)
 * @returns DigestResult
 */


export async function generateDigest(
    workspaceFolder: vscode.WorkspaceFolder,
    workspaceManager: import('../services/workspaceManager').WorkspaceManager,
    treeProvider?: CodebaseDigestTreeProvider,
    overrides?: Record<string, any>
): Promise<DigestResult | undefined> {
    // Acquire per-workspace mutex so multiple generateDigest invocations don't run
    // concurrently (user may click generate repeatedly or webview may trigger twice).
    const workspacePath = workspaceFolder.uri.fsPath;
    const _mutex = getMutex(workspacePath);
    const _release = await _mutex.lock();
    try {
    const services = workspaceManager.getBundleForFolder(workspaceFolder);
    if (!services) {
        // Log and show error consistently, then broadcast to any webviews
        errorsUtil.showUserError('No services found for workspace folder.', workspaceFolder.uri.fsPath);
        try { broadcastGenerationResult({ error: 'No services found for workspace folder.' }, workspacePath); } catch (e) { try { console.warn('digestProvider: broadcastGenerationResult failed', e); } catch {} }
        return;
    }
    const config: DigestConfig = vscode.workspace.getConfiguration('codebaseDigest', workspaceFolder.uri) as any;
    // runtimeConfig merges saved workspace settings with transient overrides for this run only
    // Note: overrides is intentionally transient (one-shot) and should not be persisted back
    // to the user's WorkspaceConfiguration. This ensures the "Disable redaction for this run"
    // toggle from the webview only affects the current generation and is cleared immediately
    // by the webview after being used.
    const runtimeConfig = Object.assign({}, config, overrides || {});
    const diagnostics = services.diagnostics;
    const cacheService = services.cacheService || new CacheService();
    const digestGenerator = new DigestGenerator(services.contentProcessor, services.tokenAnalyzer);
    // Prepare token model and divisor overrides from config
    const tokenModel = runtimeConfig.tokenModel || config.tokenModel || 'chars-approx';
    const tokenDivisorOverrides = runtimeConfig.tokenDivisorOverrides || config.tokenDivisorOverrides || {};
    const outputWriter = new OutputWriter();
    let files: FileNode[] = [];
    let remoteMeta: any = undefined;
    let remoteTmpDir: string | undefined;
    // Step 1: resolve remote repo if needed
    if (config.remoteRepo) {
        try {
            vscode.window.showInformationMessage(`Ingesting remote repo: ${config.remoteRepo}`);
            const result = await ingestRemoteRepo(config.remoteRepo, config.remoteRepoOptions || {});
            remoteTmpDir = result.localPath;
            remoteMeta = result.meta;
            files = await require('../services/contentProcessor').ContentProcessor.scanDirectory(remoteTmpDir, config);
        } catch (err) {
            if (remoteTmpDir) {
                await cleanupRemoteTmp(remoteTmpDir);
            }
            const details = String(err);
            diagnostics?.error && diagnostics.error('Remote repo ingest failed: ' + details);
            // Log to output channel and show an error; broadcast to webview
            errorsUtil.showUserError('Remote repo ingest failed.', details, diagnostics);
                try { broadcastGenerationResult({ error: 'Remote repo ingest failed.' }, workspacePath); } catch (e) { try { console.warn('digestProvider: broadcastGenerationResult failed', e); } catch {} }
            return;
        }
    } else {
    const selectedFiles: FileNode[] = treeProvider ? treeProvider.getSelectedFiles() : [];
        if (!selectedFiles || selectedFiles.length === 0) {
            const pick = await vscode.window.showQuickPick([
                { label: 'Select All Files', value: 'all' },
                { label: 'Cancel', value: 'cancel' }
            ], { placeHolder: 'No files selected. What would you like to do?' });
            if (!pick || pick.value === 'cancel') {
        errorsUtil.showUserWarning('Digest generation cancelled: no files selected.');
        try { broadcastGenerationResult({ error: 'Digest generation cancelled: no files selected.' }, workspacePath); } catch (e) { /* swallow */ }
        return;
            }
            if (pick.value === 'all' && treeProvider) {
                treeProvider.selectAll();
                // Do not refresh here; immediately re-read selected files
            }
        }
        files = treeProvider ? treeProvider.getSelectedFiles() : [];
        if (!files || files.length === 0) {
            errorsUtil.showUserWarning('Digest generation cancelled: no files selected.');
            try { broadcastGenerationResult({ error: 'Digest generation cancelled: no files selected.' }, workspacePath); } catch (e) { /* swallow */ }
            return;
        }
    }
    // Emit generation start (indeterminate until generator provides progress)
    emitProgress({ op: 'generate', mode: 'start', determinate: false, message: 'Generating digest...' });
    files.sort((a: FileNode, b: FileNode) => a.relPath.localeCompare(b.relPath));
    // Step 2: compute cache key (after remoteMeta is available)
    // Use runtimeConfig so transient overrides are included in the cache key
    const cacheKey = cacheService.computeKey({
        sourceType: runtimeConfig.remoteRepo ? 'remote' : 'local',
        remoteRepo: runtimeConfig.remoteRepo || '',
        commitSha: remoteMeta?.resolved?.sha || '',
        includePatterns: runtimeConfig.includePatterns || config.includePatterns,
        excludePatterns: runtimeConfig.excludePatterns || config.excludePatterns,
        subpath: runtimeConfig.remoteRepoOptions?.subpath || config.remoteRepoOptions?.subpath || '',
        outputFormat: runtimeConfig.outputFormat || config.outputFormat,
        outputPresetCompatible: runtimeConfig.outputPresetCompatible || config.outputPresetCompatible,
        filterPresets: runtimeConfig.filterPresets || config.filterPresets || [],
        outputSeparatorsHeader: runtimeConfig.outputSeparatorsHeader || config.outputSeparatorsHeader || '',
    });
    // Step 3: check cache
    let cacheDir = config.cacheDir;
    if (!cacheDir || typeof cacheDir !== 'string') {
    // Use workspaceFolder storage path or fallback
    cacheDir = path.join(workspaceFolder.uri.fsPath, '.codebase-digest-cache');
    }
    const cachePath = path.join(cacheDir, cacheKey + '.json');
    const cacheOutPath = path.join(cacheDir, cacheKey + '.out');
    if (config.cacheEnabled) {
        try {
            await fsp.mkdir(cacheDir, { recursive: true });
            if (fs.existsSync(cachePath)) {
                const pick = await vscode.window.showQuickPick([
                    { label: 'Open Cached Output', value: 'cached' },
                    { label: 'Regenerate', value: 'regen' },
                    { label: 'Cancel', value: 'cancel' }
                ], { placeHolder: 'Cached digest found. What would you like to do?' });
                if (!pick || pick.value === 'cancel') {
                    errorsUtil.showUserWarning('Digest generation cancelled.');
                    try { broadcastGenerationResult({ error: 'Digest generation cancelled.' }, workspacePath); } catch (e) { /* swallow */ }
                    return;
                }
                if (pick.value === 'cached') {
                    const cached = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
                    let outContent = '';
                    if (fs.existsSync(cacheOutPath)) {
                        outContent = await fsp.readFile(cacheOutPath, 'utf8');
                    }
                    // Use runtimeConfig so any transient overrides are honored when writing cached output
                    await outputWriter.write(outContent, runtimeConfig);
                    // Broadcast the cached generation result so open webviews can show toasts and update chips
                    try {
                        const cachedResult: any = Object.assign({}, cached, { content: outContent });
                        // Ensure top-level redactionApplied mirrors cached metadata so UI code
                        // that inspects `res.redactionApplied` finds the flag.
                        try { cachedResult.redactionApplied = !!(cachedResult?.metadata?.redactionApplied); } catch (e) { cachedResult.redactionApplied = false; }
                        try { broadcastGenerationResult(cachedResult, workspacePath); } catch (e) { try { console.warn('digestProvider: broadcastGenerationResult failed (cached)', e); } catch {} }
                    } catch (e) { /* ignore */ }
                    return cached;
                }
            }
        } catch (e) {
            diagnostics.warn('Cache error: ' + String(e));
        }
    }
    // Step 4: generate digest
    // Generate digest and sum token estimates
    let digest;
    try {
        digest = await digestGenerator.generate(files, {
        ...config,
        ...overrides,
        tokenModel,
        tokenDivisorOverrides
    }, [], runtimeConfig.outputFormat || config.outputFormat);
    } catch (err: any) {
        // If generation was canceled via the event bus, ensure partial artifacts are removed and inform the user
        const details = String(err || 'Generation failed');
        try { diagnostics && diagnostics.error && diagnostics.error('Generation failed or canceled: ' + details); } catch (e) {}
        try { errorsUtil.showUserError('Digest generation failed or canceled.', details, diagnostics as any); } catch (e) {}
        // If cache files were partially written, attempt to remove them to avoid leaving stale artifacts
        try {
            if (fs.existsSync(cacheOutPath)) { await fsp.unlink(cacheOutPath).catch(() => {}); }
        } catch (e) {}
        try {
            if (fs.existsSync(cachePath)) { await fsp.unlink(cachePath).catch(() => {}); }
        } catch (e) {}
        // Broadcast cancellation to webviews
        try { broadcastGenerationResult({ error: 'Generation failed or canceled.' }, workspacePath); } catch (e) {}
        return;
    }
    // Generator may have completed - emit end
    emitProgress({ op: 'generate', mode: 'end', determinate: false, message: 'Digest generation complete' });
    // Compute total token estimate (sum of file estimates). Ensure digest.tokenEstimate is always set.
    let totalTokenEstimate: number = 0;
    if (typeof digest.tokenEstimate === 'number') {
        totalTokenEstimate = digest.tokenEstimate;
    } else if (Array.isArray((digest as any).outputObjects) && (digest as any).outputObjects.length > 0) {
        try {
            totalTokenEstimate = (digest as any).outputObjects.reduce((acc: number, o: any) => acc + (typeof o?.tokenEstimate === 'number' ? o.tokenEstimate : 0), 0);
        } catch (e) {
            totalTokenEstimate = 0;
        }
    } else {
        totalTokenEstimate = 0;
    }
    // Persist the computed token estimate back onto the digest so callers can rely on it
    try { (digest as any).tokenEstimate = totalTokenEstimate; } catch (e) { /* ignore */ }
    // Optionally warn if over tokenLimit
    let tokenLimitWarning = null;
    const numericTokenLimit = Number((runtimeConfig && runtimeConfig.tokenLimit) ?? (config && config.tokenLimit) ?? 0);
    if (numericTokenLimit > 0 && totalTokenEstimate > numericTokenLimit) {
        tokenLimitWarning = services.tokenAnalyzer.warnIfExceedsLimit(totalTokenEstimate, numericTokenLimit);
        if (tokenLimitWarning) {
            digest.warnings = digest.warnings || [];
            digest.warnings.push(tokenLimitWarning);
        }
    }
    // If metrics collection is enabled, append perf summary to summary and expose a view action
    try {
        const metrics = (services as any).metrics as import('../services/metrics').Metrics | undefined;
        if (config.performanceCollectMetrics && metrics) {
            const perfBlock = metrics.getPerfSummary();
            if (perfBlock && perfBlock.length > 0) {
                digest.summary = (digest.summary || '') + '\n' + perfBlock;
                // Expose a metadata flag so callers/UI can offer a 'View metrics' action
                (digest as any).viewMetricsAvailable = true;
            }
            // Also attempt to log metrics to output based on configured log level
            try { metrics.log(); } catch (e) { /* swallow logging errors */ }
        }
    } catch (e) {
        diagnostics.warn('Failed to append performance metrics: ' + String(e));
    }
    // Step 5: write output - the DigestGenerator already applied redaction and set redactionApplied
    const outContent = digest.content;
    // Use runtimeConfig when writing output so transient overrides (e.g., format)
    // affect how the output is written.
    await outputWriter.write(outContent, runtimeConfig);
    // Step 6: emit event
    // If you need to notify digest generation, use an event emitter or callback passed in
    // Step 7: write cache
    if (config.cacheEnabled) {
        try {
            await fsp.mkdir(cacheDir, { recursive: true });
            const cacheObj = {
                summary: digest.summary,
                tree: digest.tree,
                files: digest.outputObjects,
                warnings: digest.warnings,
                metadata: {
                    redactionApplied: !!(digest as any).redactionApplied,
                totalFiles: files.length,
                totalSize: files.reduce((acc, f) => acc + (f.size || 0), 0),
                generatedAt: new Date().toISOString(),
                workspacePath: workspacePath,
                selectedFiles: files.map(f => f.relPath),
                limits: {
                    maxFiles: runtimeConfig.maxFiles || config.maxFiles,
                    maxTotalSizeBytes: runtimeConfig.maxTotalSizeBytes || config.maxTotalSizeBytes,
                    maxFileSize: runtimeConfig.maxFileSize || config.maxFileSize,
                    maxDirectoryDepth: runtimeConfig.maxDirectoryDepth || config.maxDirectoryDepth,
                },
                format: runtimeConfig.outputFormat || config.outputFormat,
            }
        } as any;
            // Write cache atomically: write to temp files then rename into place
            const tmpJson = cachePath + '.tmp';
            const tmpOut = cacheOutPath + '.tmp';
            try {
                await fsp.writeFile(tmpJson, JSON.stringify(cacheObj, null, 2), 'utf8');
                const cacheOut = outContent;
                await fsp.writeFile(tmpOut, cacheOut, 'utf8');
                await fsp.rename(tmpJson, cachePath);
                await fsp.rename(tmpOut, cacheOutPath);
            } catch (e) {
                // Clean up any tmp files on failure
                try { if (fs.existsSync(tmpJson)) { await fsp.unlink(tmpJson).catch(() => {}); } } catch (ee) {}
                try { if (fs.existsSync(tmpOut)) { await fsp.unlink(tmpOut).catch(() => {}); } } catch (ee) {}
                throw e;
            }
        } catch (e) {
            diagnostics.warn('Cache write error: ' + String(e));
        }
    }
    // Step 8: cleanup remote tmp dir
    if (remoteTmpDir) {
        await cleanupRemoteTmp(remoteTmpDir);
    }
    const finalResult = {
    ...digest,
    // Mirror redactionApplied at top-level for compatibility with UI that expects it
    redactionApplied: !!(digest as any).redactionApplied,
        // Return the actual output that was written (redacted or original)
        content: outContent,
        metadata: {
            redactionApplied: !!(digest as any).redactionApplied,
            totalFiles: files.length,
            totalSize: files.reduce((acc, f) => acc + (f.size || 0), 0),
            generatedAt: new Date().toISOString(),
            workspacePath: workspacePath,
            selectedFiles: files.map(f => f.relPath),
            limits: {
                maxFiles: runtimeConfig.maxFiles || config.maxFiles,
                maxTotalSizeBytes: runtimeConfig.maxTotalSizeBytes || config.maxTotalSizeBytes,
                maxFileSize: runtimeConfig.maxFileSize || config.maxFileSize,
                maxDirectoryDepth: runtimeConfig.maxDirectoryDepth || config.maxDirectoryDepth,
            },
            stats: {
                totalFiles: files.length,
                totalSize: files.reduce((acc, f) => acc + (f.size || 0), 0),
                skippedBySize: 0,
                skippedByTotalLimit: 0,
                skippedByMaxFiles: 0,
                skippedByDepth: 0,
                skippedByIgnore: 0,
                directories: 0,
                symlinks: 0,
                warnings: digest.warnings,
                durationMs: 0,
                tokenEstimate: totalTokenEstimate
            },
            format: runtimeConfig.outputFormat || config.outputFormat,
        } as any
    };

    // Broadcast generation result to any open panels or sidebar views so webviews can react (e.g., show redaction toast)
    try {
        broadcastGenerationResult(finalResult, workspaceFolder.uri.fsPath);
    } catch (e) {
        try { diagnostics.warn && diagnostics.warn('Failed to broadcast generation result'); } catch {}
    }

    return finalResult;
    } finally {
        try { _release(); } catch (e) { }
    }
}

