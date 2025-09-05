/**
 * Codebase Digest Orchestration Flow
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
        try { broadcastGenerationResult({ error: 'No services found for workspace folder.' }, workspacePath); } catch (e) { /* swallow */ }
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
            try { broadcastGenerationResult({ error: 'Remote repo ingest failed.' }, workspacePath); } catch (e) { /* swallow */ }
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
    const cacheKey = cacheService.computeKey({
        sourceType: config.remoteRepo ? 'remote' : 'local',
        remoteRepo: config.remoteRepo || '',
        commitSha: remoteMeta?.resolved?.sha || '',
        includePatterns: config.includePatterns,
        excludePatterns: config.excludePatterns,
        subpath: config.remoteRepoOptions?.subpath || '',
        outputFormat: config.outputFormat,
        outputPresetCompatible: config.outputPresetCompatible,
        filterPresets: config.filterPresets || [],
        outputSeparatorsHeader: config.outputSeparatorsHeader || '',
    });
    // Step 3: check cache
    const fs = require('fs');
    const fsp = require('fs/promises');
    let cacheDir = config.cacheDir;
    if (!cacheDir || typeof cacheDir !== 'string') {
    // Use workspaceFolder storage path or fallback
    cacheDir = require('path').join(workspaceFolder.uri.fsPath, '.codebase-digest-cache');
    }
    const cachePath = require('path').join(cacheDir, cacheKey + '.json');
    const cacheOutPath = require('path').join(cacheDir, cacheKey + '.out');
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
                    await outputWriter.write(outContent, config);
                    return cached;
                }
            }
        } catch (e) {
            diagnostics.warn('Cache error: ' + String(e));
        }
    }
    // Step 4: generate digest
    // Generate digest and sum token estimates
    const digest = await digestGenerator.generate(files, {
        ...config,
        ...overrides,
        tokenModel,
        tokenDivisorOverrides
    }, [], runtimeConfig.outputFormat || config.outputFormat);
    // Generator may have completed - emit end
    emitProgress({ op: 'generate', mode: 'end', determinate: false, message: 'Digest generation complete' });
    // Compute total token estimate (sum of file estimates)
    let totalTokenEstimate = digest.tokenEstimate || 0;
    // Optionally warn if over tokenLimit
    let tokenLimitWarning = null;
    if (config.tokenLimit && totalTokenEstimate > config.tokenLimit) {
        tokenLimitWarning = services.tokenAnalyzer.warnIfExceedsLimit(totalTokenEstimate, config.tokenLimit);
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
    await outputWriter.write(outContent, config);
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
                workspacePath: '',
                selectedFiles: files.map(f => f.relPath),
                limits: {
                    maxFiles: config.maxFiles,
                    maxTotalSizeBytes: config.maxTotalSizeBytes,
                    maxFileSize: config.maxFileSize,
                    maxDirectoryDepth: config.maxDirectoryDepth,
                },
                format: runtimeConfig.outputFormat || config.outputFormat,
            }
        } as any;
            await fsp.writeFile(cachePath, JSON.stringify(cacheObj, null, 2), 'utf8');
            // Cache the already-redacted output if redaction was applied, otherwise cache the original
            const cacheOut = outContent;
            await fsp.writeFile(cacheOutPath, cacheOut, 'utf8');
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
        // Return the actual output that was written (redacted or original)
        content: outContent,
        metadata: {
            redactionApplied: !!(digest as any).redactionApplied,
            totalFiles: files.length,
            totalSize: files.reduce((acc, f) => acc + (f.size || 0), 0),
            generatedAt: new Date().toISOString(),
            workspacePath: '',
            selectedFiles: files.map(f => f.relPath),
            limits: {
                maxFiles: config.maxFiles,
                maxTotalSizeBytes: config.maxTotalSizeBytes,
                maxFileSize: config.maxFileSize,
                maxDirectoryDepth: config.maxDirectoryDepth,
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
        diagnostics.warn && diagnostics.warn('Failed to broadcast generation result: ' + String(e));
    }

    return finalResult;
    } finally {
        try { _release(); } catch (e) { }
    }
}

