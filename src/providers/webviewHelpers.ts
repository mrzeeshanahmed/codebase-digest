import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Set HTML for a webview by rewriting resource URIs and injecting a strict CSP.
 */
export function setWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri) {
    const fs = require('fs');
    const indexPath = path.join(extensionUri.fsPath, 'resources', 'webview', 'index.html');
    let html = fs.readFileSync(indexPath, 'utf8');
    html = html.replace(/<link\s+[^>]*href="([^"]+)"[^>]*>/g, (m: string, href: string) => {
        const uri = webview.asWebviewUri(vscode.Uri.file(path.join(extensionUri.fsPath, 'resources', 'webview', href)));
        return m.replace(href, uri.toString());
    });
    html = html.replace(/<script\s+[^>]*src="([^"]+)"[^>]*>/g, (m: string, src: string) => {
        const uri = webview.asWebviewUri(vscode.Uri.file(path.join(extensionUri.fsPath, 'resources', 'webview', src)));
        return m.replace(src, uri.toString());
    });
    // Rewrite image src attributes to use the webview asWebviewUri so resources are loaded from the local webview root
    html = html.replace(/<img\s+[^>]*src="([^"]+)"[^>]*>/g, (m: string, src: string) => {
        const uri = webview.asWebviewUri(vscode.Uri.file(path.join(extensionUri.fsPath, 'resources', 'webview', src)));
        return m.replace(src, uri.toString());
    });
    html = html.replace(/<meta[^>]+http-equiv=['"]?Content-Security-Policy['"]?[^>]*>/gi, '');
    const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource}; style-src ${webview.cspSource}; img-src ${webview.cspSource};">`;
    html = html.replace(/<head[^>]*>/i, (match: string) => `${match}${cspMeta}`);
    webview.html = html;
}

// Shared wiring for webview message routing to avoid duplication between panel and sidebar view
export function wireWebviewMessages(webview: vscode.Webview, treeProvider: any, folderPath: string, onConfigSet: (changes: Record<string, any>) => Promise<void>, onGetState?: () => void, context?: vscode.ExtensionContext) {
    // Restore any persisted state for this workspace folder into the webview
    try {
        if (context) {
            const key = `codebaseDigest:webviewState:${folderPath || 'global'}`;
            const stored = context.workspaceState.get(key);
            if (stored) {
                try { webview.postMessage({ type: 'restoredState', state: stored }); } catch (e) { /* swallow */ }
            }
        }
    } catch (e) { /* ignore workspaceState errors */ }

    webview.onDidReceiveMessage((msg: any) => processWebviewMessage(msg, webview, treeProvider, folderPath, onConfigSet, onGetState, context));
}

export async function processWebviewMessage(msg: any, webview: vscode.Webview, treeProvider: any, folderPath: string, onConfigSet: (changes: Record<string, any>) => Promise<void>, onGetState?: () => void, context?: vscode.ExtensionContext) {
    if (msg.type === 'getState') {
        if (onGetState) { onGetState(); }
        return;
    }
    // Allow webview to persist lightweight UI state (e.g., last-selected files)
    if (msg.type === 'persistState' && msg.state && context) {
        try {
            const key = `codebaseDigest:webviewState:${folderPath || 'global'}`;
            context.workspaceState.update(key, msg.state);
        } catch (e) { /* swallow */ }
        return;
    }
    if (msg.type === 'configRequest') {
        const folder = folderPath || '';
        const cfg = vscode.workspace.getConfiguration('codebaseDigest', vscode.Uri.file(folder));
        const thresholdsDefault = { maxFiles: 25000, maxTotalSizeBytes: 536870912, tokenLimit: 32000 };
        // Provide both legacy and normalized keys to the webview for backwards compatibility.
        const thresholds = cfg.get('thresholds', thresholdsDefault) as any || {};
        const maxFiles = cfg.get('maxFiles', thresholds.maxFiles || thresholdsDefault.maxFiles) as number;
        const maxTotalSizeBytes = cfg.get('maxTotalSizeBytes', thresholds.maxTotalSizeBytes || thresholdsDefault.maxTotalSizeBytes) as number;
        const tokenLimit = cfg.get('tokenLimit', thresholds.tokenLimit || thresholdsDefault.tokenLimit) as number;

        webview.postMessage({ type: 'config', folderPath: folder, settings: {
            // normalized key names (preferred)
            respectGitignore: cfg.get('respectGitignore', cfg.get('gitignore', true)),
            presets: cfg.get('presets', []),
            outputFormat: cfg.get('outputFormat', 'text'),
            tokenModel: cfg.get('tokenModel', 'chars-approx'),
            binaryFilePolicy: cfg.get('binaryFilePolicy', cfg.get('binaryPolicy', 'skip')),
            // flattened thresholds for easier UI binding
            maxFiles,
            maxTotalSizeBytes,
            tokenLimit,
            // legacy shape for older webview consumers
            thresholds: Object.assign({}, thresholdsDefault, thresholds),
            // redaction settings
            showRedacted: cfg.get('showRedacted', false),
            redactionPatterns: cfg.get('redactionPatterns', []),
            redactionPlaceholder: cfg.get('redactionPlaceholder', '[REDACTED]')
        }});
        return;
    }
    if (msg.type === 'config' && msg.action === 'set' && msg.changes) {
        // delegate persistence to caller
        (async () => { try { await onConfigSet(msg.changes); } catch (e) { /* swallow */ } })();
        return;
    }
    if (msg.type === 'action') {
        const commandMap: Record<string, string> = {
            refresh: 'codebaseDigest.refreshTree',
            selectAll: 'codebaseDigest.selectAll',
            clearSelection: 'codebaseDigest.clearSelection',
            expandAll: 'codebaseDigest.expandAll',
            collapseAll: 'codebaseDigest.collapseAll',
            generateDigest: 'codebaseDigest.generateDigest',
            tokenCount: 'codebaseDigest.estimateTokens'
        };
        const targetFolder = (msg && (msg.folderPath || msg.folder)) || folderPath || treeProvider['workspaceRoot'] || '';

        if (msg.actionType === 'pauseScan') {
            vscode.commands.executeCommand('codebaseDigest.pauseScan', targetFolder);
            return;
        }
        // Apply a named preset (e.g., Code/Docs/Tests) persisted per-workspace
        if (msg.actionType === 'applyPreset' && typeof msg.preset === 'string') {
            const allowed = ['default', 'codeOnly', 'docsOnly', 'testsOnly'];
            const preset = msg.preset;
            if (!allowed.includes(preset)) { return; }
            try {
                const cfg = vscode.workspace.getConfiguration('codebaseDigest', vscode.Uri.file(targetFolder || ''));
                await cfg.update('filterPresets', [preset], vscode.ConfigurationTarget.Workspace);
                try { if (treeProvider && typeof treeProvider.refresh === 'function') { treeProvider.refresh(); } } catch (e) { /* swallow */ }
                try { webview.postMessage({ type: 'config', folderPath: targetFolder, settings: { filterPresets: cfg.get('filterPresets', []) } }); } catch (e) { /* swallow */ }
                return;
            } catch (err) {
                // fallback to command if direct persistence fails
                try { await vscode.commands.executeCommand('codebaseDigest.applyPreset', targetFolder, preset); } catch (e) { /* swallow */ }
                return;
            }
        }
        if (msg.actionType === 'resumeScan') {
            vscode.commands.executeCommand('codebaseDigest.resumeScan', targetFolder);
            return;
        }
        // Allow webview to request cancellation of long writes
        if (msg.actionType === 'cancelWrite') {
            try {
                // defer require to avoid circular deps at module init
                const eb = require('../providers/eventBus');
                if (eb && typeof eb.emitProgress === 'function') {
                    eb.emitProgress({ op: 'write', mode: 'cancel' });
                }
            } catch (e) { /* swallow */ }
            return;
        }
        if (msg.actionType === 'ingestRemote' && msg.repo) {
            const params = { repo: msg.repo, ref: msg.ref, subpath: msg.subpath, includeSubmodules: !!msg.includeSubmodules };
            vscode.commands.executeCommand('codebaseDigest.ingestRemoteRepoProgrammatic', params).then((result: any) => {
                try { webview.postMessage({ type: 'ingestPreview', payload: result }); } catch (e) { /* swallow */ }
            }, (err: any) => { try { webview.postMessage({ type: 'ingestError', error: String(err) }); } catch (e) { /* swallow */ } });
            return;
        }

        if (msg.actionType === 'setSelection' && Array.isArray(msg.relPaths)) {
            treeProvider.setSelectionByRelPaths(msg.relPaths);
            try { const preview = treeProvider.getPreviewData(); webview.postMessage({ type: 'state', state: preview }); } catch (e) { /* swallow */ }
            return;
        }
        if (msg.actionType === 'toggleExpand' && typeof msg.relPath === 'string') {
            vscode.commands.executeCommand('codebaseDigest.toggleExpand', targetFolder, msg.relPath);
            return;
        }
        if (commandMap[msg.actionType]) {
            if (msg.actionType === 'generateDigest' && msg.overrides) {
                vscode.commands.executeCommand(commandMap[msg.actionType], targetFolder, msg.overrides);
            } else {
                vscode.commands.executeCommand(commandMap[msg.actionType], targetFolder);
            }
            return;
        }
    }
}
