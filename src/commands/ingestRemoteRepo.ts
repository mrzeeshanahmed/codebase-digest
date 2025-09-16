import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { ContentProcessor } from '../services/contentProcessor';
import { internalErrors, interactiveMessages } from '../utils';
import { Formatters } from '../utils/formatters';
import { TokenAnalyzer } from '../services/tokenAnalyzer';
import { DigestConfig, TraversalStats } from '../types/interfaces';
import { ingestRemoteRepo, cleanup as cleanupRemoteTmp, buildRemoteSummary } from '../services/githubService';
import { ConfigurationService } from '../services/configurationService';
import { emitProgress } from '../providers/eventBus';

export function registerIngestRemoteRepo(context: vscode.ExtensionContext) {
    // Keep backward-compatible interactive command
    context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.ingestRemoteRepo', async () => {
        // Delegate to interactive prompt flow implemented below
        await interactiveIngestFlow();
    }));

    // Register programmatic command that accepts a params object
    context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.ingestRemoteRepoProgrammatic', async (params: { repo: string, ref?: any, subpath?: string, includeSubmodules?: boolean }) => {
        return await ingestRemoteRepoProgrammatic(params);
    }));

    // New programmatic commands to support two-stage remote ingest from the webview
    context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.loadRemoteRepo', async (params: { repo: string, ref?: any, subpath?: string, includeSubmodules?: boolean }) => {
        return await loadRemoteRepo(params);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.ingestLoadedRepo', async (params: { tmpPath: string }) => {
        if (!params || !params.tmpPath) { throw new Error('tmpPath parameter required'); }
        return await ingestLoadedRepo(params.tmpPath);
    }));
}

// Exported function: perform only the clone and return the temporary local path (kept)
export async function loadRemoteRepo(params: { repo: string, ref?: any, subpath?: string, includeSubmodules?: boolean }) : Promise<{ localPath?: string, error?: string }>{
    const { repo, ref, subpath, includeSubmodules } = params as any;
    // Normalize and create tmp dir similarly to programmatic flow so callers can inspect it
    let repoSlug = repo;
    if (typeof repoSlug === 'string' && repoSlug.startsWith('https://')) {
        const m = repoSlug.match(/github.com\/([^\/]+\/[^\/]+)(?:[\/\?#]|$)/);
        if (m) { repoSlug = m[1]; }
    }
    repoSlug = String(repoSlug).replace(/\.git$/, '');
    const tmpDirPrefix = path.join(os.tmpdir(), `${repoSlug.replace(/[\/ :]/g, '-')}-`);
    const tmpDir = fs.mkdtempSync(tmpDirPrefix);
    try {
    emitProgress({ op: 'ingest', mode: 'start', determinate: false, message: 'Loading remote repo...' });
        const result = await ingestRemoteRepo(repo, { ref, subpath, includeSubmodules }, tmpDir as any);
        const returnedLocal = (result && (result as any).localPath) ? (result as any).localPath : tmpDir;
    emitProgress({ op: 'ingest', mode: 'end', determinate: false, message: 'Repository loaded' });
        return { localPath: returnedLocal } as any;
    } catch (err: any) {
    emitProgress({ op: 'ingest', mode: 'end', determinate: false, message: 'Load failed' });
        // Attempt to cleanup the temporary dir we created. Wrap in its own
        // try/catch so any cleanup failure does not mask the original error.
        try {
            if (tmpDir) {
                await cleanupRemoteTmp(tmpDir);
            }
        } catch (cleanupErr) {
            try { console.warn('loadRemoteRepo: cleanup failed', String(cleanupErr)); } catch (_) { /* ignore */ }
        }
        return { error: String(err || '') } as any;
    }
}

// Exported function: process a tmpPath previously created by loadRemoteRepo, then cleanup
export async function ingestLoadedRepo(tmpPath: string): Promise<{ output?: string, preview?: any } | void> {
    const tmpDir = tmpPath;
    const formatters = new Formatters();
    // Use validated snapshot for scan-time decisions (do not persist using this object)
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const cfgRaw = (workspaceFolders && workspaceFolders.length > 0)
        ? ConfigurationService.getWorkspaceConfig(workspaceFolders[0])
        : ConfigurationService.getWorkspaceConfig();
    if (!cfgRaw) { throw new Error('Failed to load Code Ingest configuration'); }
    const config: DigestConfig = cfgRaw;
    try {
    emitProgress({ op: 'ingest', mode: 'start', determinate: false, message: 'Ingesting loaded repo...' });
        // Use ContentProcessor.scanDirectory to get files
        const files = await ContentProcessor.scanDirectory(tmpDir, config);
        // Scanning for a preview should not mark every file as selected. Clear
        // any transient selection flags so subsequent generate/gather flows
        // respect the user's explicit selections instead of treating everything
        // as selected which can spike token estimates unexpectedly.
        try {
            for (const f of files) { (f as any).isSelected = false; }
        } catch (e) {
            // non-fatal: continue with files as-is
        }
        files.sort((a, b) => a.relPath.localeCompare(b.relPath));
        const cp = new ContentProcessor();
        let tokenEstimate = 0;
        const contentChunks: string[] = [];
        for (const file of files) {
            try {
                const ext = file.path.split('.').pop()?.toLowerCase() || '';
                const r = await cp.getFileContent(file.path, '.' + ext, config);
                const header = formatters.buildFileHeader(file, config);
                const body = r.content || '';
                let chunk = '';
                if (config.outputPresetCompatible || config.outputFormat === 'markdown' || config.outputFormat === 'text') {
                    chunk = header + body + '\n';
                } else if (config.outputFormat === 'json') {
                    chunk = JSON.stringify({ header, body }, null, 2);
                }
                if (config.tokenEstimate) { tokenEstimate += (new TokenAnalyzer()).estimate(body, config.tokenModel, config.tokenDivisorOverrides); }
                contentChunks.push(chunk);
                emitProgress({ op: 'ingest', mode: 'progress', determinate: false, message: `Processing ${file.relPath}` });
            } catch (e) { /* per-file errors ignored for preview */ }
        }
        const stats: TraversalStats = {
            totalFiles: files.length,
            totalSize: files.reduce((acc, f) => acc + (f.size || 0), 0),
            skippedBySize: 0, skippedByTotalLimit: 0, skippedByMaxFiles: 0, skippedByDepth: 0, skippedByIgnore: 0,
            directories: 0, symlinks: 0, warnings: [], durationMs: 0
        };
        const summary = config.includeSummary ? formatters.buildSummary(config, stats, files, tokenEstimate, '', config.outputWriteLocation, []) : '';
        const tree = config.includeTree ? (typeof config.includeTree === 'string' && config.includeTree === 'minimal' ? formatters.buildSelectedTree(files) : formatters.buildTree(files, true)) : '';
        const output = config.outputFormat === 'json' ? JSON.stringify({ summary: summary, tree, files: contentChunks }, null, 2) : [summary, tree, ...contentChunks].join(config.outputSeparatorsHeader || '\n---\n');
    emitProgress({ op: 'ingest', mode: 'end', determinate: false, message: 'Ingest complete' });
        const previewPayload = { summary, tree, tokenEstimate, totalFiles: stats.totalFiles, totalSize: stats.totalSize };
        return { output, preview: previewPayload };
    } catch (err: any) {
    emitProgress({ op: 'ingest', mode: 'end', determinate: false, message: 'Ingest failed' });
        const errStr = String(err || '');
        if (errStr.toLowerCase().includes('rate limit')) {
            interactiveMessages.showUserError(new Error('GitHub API rate limit reached. Try again later or use an authenticated session.'), String(err));
        } else if (errStr.toLowerCase().includes('auth') || errStr.toLowerCase().includes('authentication')) {
            interactiveMessages.showUserError(new Error('Authentication required. Sign in via VS Code (Accounts > Sign in with GitHub) and retry.'), String(err));
        } else {
            interactiveMessages.showUserError(new Error('Remote repository ingest failed.'), String(err));
        }
        // Re-throw so programmatic callers receive the error and can forward it to the webview
        throw err;
    } finally {
        // Always attempt to cleanup the temporary directory after ingest
        try {
            if (tmpDir) { await cleanupRemoteTmp(tmpDir); }
        } catch (e) { /* best-effort cleanup */ }
    }
}

async function interactiveIngestFlow() {
    // Original interactive flow preserved for backward compatibility
    let repoInput = await vscode.window.showInputBox({ prompt: 'Enter GitHub repo URL or user/repo slug', ignoreFocusOut: true });
    if (!repoInput) { return; }
    let repo = repoInput.trim();
    const urlMatch = repo.match(/github\.com\/([^\/]+)\/([^\/\?#]+)(?:[\/\?#]|$)/);
    if (urlMatch) { repo = `${urlMatch[1]}/${urlMatch[2]}`; }
    else if (!/^[^\/]+\/[^\/]+$/.test(repo)) { interactiveMessages.showUserError(new Error('Invalid repository format. Enter a GitHub URL or owner/repo slug (e.g. owner/repo).')); return; }

    const refType = await vscode.window.showQuickPick([{ label: 'Branch', value: 'branch' },{ label: 'Tag', value: 'tag' },{ label: 'Commit', value: 'commit' },{ label: 'None', value: 'none' }], { placeHolder: 'Specify a branch, tag, or commit (optional)' });
    let ref: any = {};
    if (refType && refType.value !== 'none') { const refValue = await vscode.window.showInputBox({ prompt: `Enter ${refType.label} name`, ignoreFocusOut: true }); if (refValue) { ref[refType.value] = refValue; } }
    const subpath = await vscode.window.showInputBox({ prompt: 'Enter subpath to ingest (optional)', ignoreFocusOut: true });
    // Use validated snapshot for interactive defaults; preserve cfg.update below for persistence
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const cfgRawInteractive = (workspaceFolders && workspaceFolders.length > 0)
        ? ConfigurationService.getWorkspaceConfig(workspaceFolders[0])
        : ConfigurationService.getWorkspaceConfig();
    if (!cfgRawInteractive) { throw new Error('Failed to load Code Ingest configuration'); }
    const config: DigestConfig = cfgRawInteractive;
    let includeSubmodules = config.includeSubmodules;
    const submodulePick = await vscode.window.showQuickPick([{ label: 'Yes', value: true },{ label: 'No', value: false }], { placeHolder: 'Include submodules?', ignoreFocusOut: true });
    if (submodulePick) { includeSubmodules = submodulePick.value; await vscode.workspace.getConfiguration('codebaseDigest').update('includeSubmodules', includeSubmodules, vscode.ConfigurationTarget.Workspace); }
    try {
        await ingestRemoteRepoProgrammatic({ repo, ref, subpath, includeSubmodules });
    } catch (e) {
        // interactive command shows errors via underlying implementation
    }
}

/**
 * Programmatic ingest of a remote GitHub repo.
 *
 * Lifecycle / tmp dir contract:
 * - This function clones/pulls the remote repository into a temporary directory and scans files
 *   from that temp location. By default the temporary directory is cleaned up before this
 *   function returns. The returned `output`/`preview` payload contains concatenated content
 *   produced in-memory so callers should NOT rely on the temp directory remaining on disk.
 * - If callers need to keep the temp dir around for manual inspection or further processing,
 *   pass `keepTmpDir: true` in `params`. When `keepTmpDir` is true the caller becomes
 *   responsible for calling the service cleanup utility (`githubService.cleanup`) when done.
 */
export async function ingestRemoteRepoProgrammatic(params: { repo: string, ref?: any, subpath?: string, includeSubmodules?: boolean, keepTmpDir?: boolean }) : Promise<{ output?: string, preview?: any } | void> {
    // This function performs the ingest and returns a preview string that can be shown in the dashboard webview.
    const { repo, ref, subpath, includeSubmodules, keepTmpDir } = params as any;
    const formatters = new Formatters();
    // Use validated snapshot for scan-time decisions
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const cfgRawProgrammatic = (workspaceFolders && workspaceFolders.length > 0)
        ? ConfigurationService.getWorkspaceConfig(workspaceFolders[0])
        : ConfigurationService.getWorkspaceConfig();
    if (!cfgRawProgrammatic) { throw new Error('Failed to load Code Ingest configuration'); }
    const config: DigestConfig = cfgRawProgrammatic;
    // Normalize repo input before deriving a tmp dir name. Accept owner/repo or
    // a full GitHub URL; strip a trailing .git if present so the mkdtemp prefix
    // doesn't include ".git" which can cause confusing temp dir names.
    let repoSlug = repo;
    if (typeof repoSlug === 'string' && repoSlug.startsWith('https://')) {
        const m = repoSlug.match(/github.com\/([^\/]+\/[^\/]+)(?:[\/\?#]|$)/);
        if (m) { repoSlug = m[1]; }
    }
    repoSlug = String(repoSlug).replace(/\.git$/, '');
    const tmpDirPrefix = path.join(os.tmpdir(), `${repoSlug.replace(/[\/ :]/g, '-')}-`);
    let tmpDir: string | undefined = undefined;

    try {
        // Create temporary directory; if mkdtempSync throws we'll handle in catch/finally
        tmpDir = fs.mkdtempSync(tmpDirPrefix);
    emitProgress({ op: 'ingest', mode: 'start', determinate: false, message: 'Ingesting remote repo...' });
    // Pass the created tmpDir to the service function.
    const result = await ingestRemoteRepo(repo, { ref, subpath, includeSubmodules }, tmpDir as any);
        // When the service completes it returns localPath; prefer using that if present
        // but we created the top-level tmpDir and will scan from it.
        // tmpDir variable already points to the created dir.
        const meta = result.meta;
    // Use ContentProcessor.scanDirectory to get files
    const files = await ContentProcessor.scanDirectory(tmpDir, config);
    // Do not treat a scan-for-preview as a user selection pass. Clear any
    // isSelected flags so token / selection chips reflect real user choices.
    try {
        for (const f of files) { (f as any).isSelected = false; }
    } catch (e) { /* continue with scanned files if mutation fails */ }
        files.sort((a, b) => a.relPath.localeCompare(b.relPath));
        const cp = new ContentProcessor();
        let tokenEstimate = 0;
        const contentChunks: string[] = [];
        for (const file of files) {
            try {
                const ext = file.path.split('.').pop()?.toLowerCase() || '';
                const r = await cp.getFileContent(file.path, '.' + ext, config);
                const header = formatters.buildFileHeader(file, config);
                const body = r.content || '';
                let chunk = '';
                if (config.outputPresetCompatible || config.outputFormat === 'markdown' || config.outputFormat === 'text') {
                    // Formatters.buildFileHeader now includes a trailing newline; avoid inserting an extra blank line here.
                    chunk = header + body + '\n';
                } else if (config.outputFormat === 'json') {
                    chunk = JSON.stringify({ header, body }, null, 2);
                }
                if (config.tokenEstimate) { tokenEstimate += (new TokenAnalyzer()).estimate(body, config.tokenModel, config.tokenDivisorOverrides); }
                contentChunks.push(chunk);
                emitProgress({ op: 'ingest', mode: 'progress', determinate: false, message: `Processing ${file.relPath}` });
            } catch (e) { /* per-file errors ignored for preview */ }
        }
        const stats: TraversalStats = {
            totalFiles: files.length,
            totalSize: files.reduce((acc, f) => acc + (f.size || 0), 0),
            skippedBySize: 0, skippedByTotalLimit: 0, skippedByMaxFiles: 0, skippedByDepth: 0, skippedByIgnore: 0,
            directories: 0, symlinks: 0, warnings: [], durationMs: 0
        };
        const summary = config.includeSummary ? formatters.buildSummary(config, stats, files, tokenEstimate, repo, config.outputWriteLocation, []) : '';
        const remoteSummary = (config.includeSummary && meta) ? buildRemoteSummary(meta) : '';
        const tree = config.includeTree ? (typeof config.includeTree === 'string' && config.includeTree === 'minimal' ? formatters.buildSelectedTree(files) : formatters.buildTree(files, true)) : '';
        const output = config.outputFormat === 'json' ? JSON.stringify({ summary: remoteSummary + summary, tree, files: contentChunks }, null, 2) : [remoteSummary + summary, tree, ...contentChunks].join(config.outputSeparatorsHeader || '\n---\n');
    emitProgress({ op: 'ingest', mode: 'end', determinate: false, message: 'Ingest complete' });
        // Return small preview payload to caller (dashboard). If caller requested the
        // temporary clone to be retained, return the localPath so caller can inspect it.
        const previewPayload = { summary: remoteSummary + summary, tree, tokenEstimate, totalFiles: stats.totalFiles, totalSize: stats.totalSize };
        if (keepTmpDir) {
            // Caller requested to keep the temp dir: prefer the service-returned
            // localPath when available (it may point to a more precise subdir),
            // otherwise fall back to the tmpDir we created.
            const returnedLocal = (result && (result as any).localPath) ? (result as any).localPath : tmpDir;
            return { output, preview: previewPayload, localPath: returnedLocal } as any;
        }
        return { output, preview: previewPayload };
    } catch (err: any) {
    emitProgress({ op: 'ingest', mode: 'end', determinate: false, message: 'Ingest failed' });
        const errStr = String(err || '');
        if (errStr.toLowerCase().includes('rate limit')) {
            interactiveMessages.showUserError(new Error('GitHub API rate limit reached. Try again later or use an authenticated session.'), String(err));
        } else if (errStr.toLowerCase().includes('auth') || errStr.toLowerCase().includes('authentication')) {
            interactiveMessages.showUserError(new Error('Authentication required. Sign in via VS Code (Accounts > Sign in with GitHub) and retry.'), String(err));
        } else {
            interactiveMessages.showUserError(new Error('Remote repository ingest failed.'), String(err));
        }
        // Re-throw so programmatic callers receive the error and the webview can
        // display a specific reason via the 'ingestError' message.
        throw err;
    } finally {
        // Only cleanup the temporary dir if the caller did not request it to be kept.
        try {
            if (tmpDir && !keepTmpDir) { await cleanupRemoteTmp(tmpDir); }
        } catch (e) {
            // best-effort cleanup; do not mask original errors
        }
    }
}
