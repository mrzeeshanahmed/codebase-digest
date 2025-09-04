import * as vscode from 'vscode';
import { ContentProcessor } from '../services/contentProcessor';
import { internalErrors, interactiveMessages } from '../utils';
import { Formatters } from '../utils/formatters';
import { TokenAnalyzer } from '../services/tokenAnalyzer';
import { DigestConfig, TraversalStats } from '../types/interfaces';
import { ingestRemoteRepo, cleanup as cleanupRemoteTmp, buildRemoteSummary } from '../services/githubService';
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
}

async function interactiveIngestFlow() {
    // Original interactive flow preserved for backward compatibility
    let repoInput = await vscode.window.showInputBox({ prompt: 'Enter GitHub repo URL or user/repo slug', ignoreFocusOut: true });
    if (!repoInput) { return; }
    let repo = repoInput.trim();
    const urlMatch = repo.match(/github\.com\/([^\/]+)\/([^\/\?#]+)(?:[\/\?#]|$)/);
    if (urlMatch) { repo = `${urlMatch[1]}/${urlMatch[2]}`; }
    else if (!/^[^\/]+\/[^\/]+$/.test(repo)) { interactiveMessages.showUserError(new Error('Invalid repo format. Please enter a valid GitHub URL or owner/repo slug.')); return; }

    const refType = await vscode.window.showQuickPick([{ label: 'Branch', value: 'branch' },{ label: 'Tag', value: 'tag' },{ label: 'Commit', value: 'commit' },{ label: 'None', value: 'none' }], { placeHolder: 'Specify a branch, tag, or commit (optional)' });
    let ref: any = {};
    if (refType && refType.value !== 'none') { const refValue = await vscode.window.showInputBox({ prompt: `Enter ${refType.label} name`, ignoreFocusOut: true }); if (refValue) { ref[refType.value] = refValue; } }
    const subpath = await vscode.window.showInputBox({ prompt: 'Enter subpath to ingest (optional)', ignoreFocusOut: true });
    const config: DigestConfig = vscode.workspace.getConfiguration('codebaseDigest') as any;
    let includeSubmodules = config.includeSubmodules;
    const submodulePick = await vscode.window.showQuickPick([{ label: 'Yes', value: true },{ label: 'No', value: false }], { placeHolder: 'Include submodules?', ignoreFocusOut: true });
    if (submodulePick) { includeSubmodules = submodulePick.value; await vscode.workspace.getConfiguration('codebaseDigest').update('includeSubmodules', includeSubmodules, vscode.ConfigurationTarget.Workspace); }
    try {
        await ingestRemoteRepoProgrammatic({ repo, ref, subpath, includeSubmodules });
    } catch (e) {
        // interactive command shows errors via underlying implementation
    }
}

export async function ingestRemoteRepoProgrammatic(params: { repo: string, ref?: any, subpath?: string, includeSubmodules?: boolean }) : Promise<{ output?: string, preview?: any } | void> {
    // This function performs the ingest and returns a preview string that can be shown in the dashboard webview.
    const { repo, ref, subpath, includeSubmodules } = params;
    const formatters = new Formatters();
    const config: DigestConfig = vscode.workspace.getConfiguration('codebaseDigest') as any;
    let tmpDir: string | undefined;
    try {
        emitProgress({ op: 'generate', mode: 'start', determinate: false, message: 'Ingesting remote repo...' });
        const result = await ingestRemoteRepo(repo, { ref, subpath, includeSubmodules });
        tmpDir = result.localPath;
        const meta = result.meta;
        // Use ContentProcessor.scanDirectory to get files
        const files = await ContentProcessor.scanDirectory(tmpDir, config);
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
                emitProgress({ op: 'generate', mode: 'progress', determinate: false, message: `Processing ${file.relPath}` });
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
        emitProgress({ op: 'generate', mode: 'end', determinate: false, message: 'Ingest complete' });
        // Return small preview payload to caller (dashboard)
        return { output, preview: { summary: remoteSummary + summary, tree, tokenEstimate, totalFiles: stats.totalFiles, totalSize: stats.totalSize } };
    } catch (err: any) {
        emitProgress({ op: 'generate', mode: 'end', determinate: false, message: 'Ingest failed' });
        if (String(err).includes('rate limit') || String(err).includes('auth')) {
            interactiveMessages.showUserError(new Error('GitHub authentication failed or rate-limited. Please sign in using VS Code’s GitHub auth provider (View > Accounts > Sign in with GitHub).'), String(err));
        } else {
            interactiveMessages.showUserError(new Error('Remote repo ingest failed.'), String(err));
        }
        throw err;
    } finally {
        if (tmpDir) { await cleanupRemoteTmp(tmpDir); }
    }
}
