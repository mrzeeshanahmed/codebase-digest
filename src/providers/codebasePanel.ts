import * as vscode from 'vscode';
import * as path from 'path';
import { CodebaseDigestTreeProvider } from './treeDataProvider';
import { onProgress } from './eventBus';

const panels: Map<string, CodebaseDigestPanel> = new Map();
let sidebarRegistered = false;
let registeredDisposable: vscode.Disposable | undefined;
const activeViews: Set<vscode.WebviewView> = new Set();

export class CodebaseDigestPanel {
    private panel?: vscode.WebviewPanel;
    private extensionUri: vscode.Uri;
    private treeProvider: CodebaseDigestTreeProvider;
    private folderPath: string;

    constructor(extensionUri: vscode.Uri, treeProvider: CodebaseDigestTreeProvider, folderPath: string) {
        this.extensionUri = extensionUri;
        this.treeProvider = treeProvider;
        this.folderPath = folderPath;
    }

    public reveal() {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.One);
            return;
        }
        this.panel = vscode.window.createWebviewPanel('codebaseDigestPanel', 'Codebase Digest', vscode.ViewColumn.One, {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'resources', 'webview'), this.extensionUri]
        });
        this.setHtml(this.panel.webview);
        this.panel.webview.onDidReceiveMessage(msg => {
            if (msg.type === 'getState') {
                this.postPreviewState();
            } else if (msg.type === 'configRequest') {
                this.postConfig();
            } else if (msg.type === 'config' && msg.action === 'set' && msg.changes) {
                this.applyConfigChanges(msg.changes).then(() => this.postConfig());
            } else if (msg.type === 'action') {
                const commandMap: Record<string, string> = {
                    refresh: 'codebaseDigest.refreshTree',
                    selectAll: 'codebaseDigest.selectAll',
                    clearSelection: 'codebaseDigest.clearSelection',
                    expandAll: 'codebaseDigest.expandAll',
                    collapseAll: 'codebaseDigest.collapseAll',
                    generateDigest: 'codebaseDigest.generateDigest',
                    tokenCount: 'codebaseDigest.estimateTokens'
                };
                // allow pause/resume to be invoked from the webview
                // Resolve folder target: prefer an explicit folderPath from the message, else use the panel's folder
                const targetFolder = (msg && (msg.folderPath || msg.folder)) || this.folderPath || '';
                if (msg.actionType === 'pauseScan') {
                    vscode.commands.executeCommand('codebaseDigest.pauseScan', targetFolder);
                } else if (msg.actionType === 'resumeScan') {
                    vscode.commands.executeCommand('codebaseDigest.resumeScan', targetFolder);
                }
                // ingestRemote action comes from the webview and includes repo/ref/subpath/includeSubmodules
                if (msg.actionType === 'ingestRemote' && msg.repo) {
                    const params = { repo: msg.repo, ref: msg.ref, subpath: msg.subpath, includeSubmodules: !!msg.includeSubmodules };
                    // Use the programmatic command to perform ingest and return a small preview to the webview
                    vscode.commands.executeCommand('codebaseDigest.ingestRemoteRepoProgrammatic', params).then((result: any) => {
                        if (this.panel) { this.panel.webview.postMessage({ type: 'ingestPreview', payload: result }); }
                    }, (err: any) => {
                        if (this.panel) { this.panel.webview.postMessage({ type: 'ingestError', error: String(err) }); }
                    });
                }
                if (msg.actionType === 'setSelection' && Array.isArray(msg.relPaths)) {
                    this.treeProvider.setSelectionByRelPaths(msg.relPaths);
                    this.postPreviewState();
                } else if (msg.actionType === 'toggleExpand' && typeof msg.relPath === 'string') {
                    // Route to an extension-level command so the correct provider instance handles it
                    vscode.commands.executeCommand('codebaseDigest.toggleExpand', targetFolder, msg.relPath);
                } else if (commandMap[msg.actionType]) {
                    // Support passing transient overrides for generateDigest (one-shot overrides from webview)
                    if (msg.actionType === 'generateDigest' && msg.overrides) {
                        vscode.commands.executeCommand(commandMap[msg.actionType], targetFolder, msg.overrides);
                    } else {
                        vscode.commands.executeCommand(commandMap[msg.actionType], targetFolder);
                    }
                }
            }
        });
        this.panel.onDidDispose(() => {
            this.panel = undefined;
            panels.delete(this.folderPath);
        });

    // Wire preview updates: post compact deltas to keep stats live without full re-render
    const debouncedPostDelta = debounce(() => this.postPreviewDelta(), 200);
    this.treeProvider.setPreviewUpdater(() => debouncedPostDelta());
    // Forward progress events to the webview
    const disposeProgress = onProgress(e => {
        if (this.panel) {
            this.panel.webview.postMessage({ type: 'progress', event: e });
        }
    });
    // Also send initial full state
    this.postPreviewState();
    // Periodic heartbeat to refresh stats every 5s
    const interval = setInterval(() => this.postPreviewDelta(), 5000);
    this.panel.onDidDispose(() => { clearInterval(interval); });
    this.panel.onDidDispose(() => { disposeProgress(); });
    }

        private async postConfig() {
            if (!this.panel) { return; }
            const cfg = vscode.workspace.getConfiguration('codebaseDigest', vscode.Uri.file(this.folderPath));
                const thresholdsDefault = { maxFiles: 25000, maxTotalSizeBytes: 536870912, tokenLimit: 32000 };
                const payload = {
                    type: 'config',
                    folderPath: this.folderPath,
                    settings: {
                        gitignore: cfg.get('gitignore', true),
                        presets: cfg.get('presets', []),
                        outputFormat: cfg.get('outputFormat', 'text'),
                        tokenModel: cfg.get('tokenModel', 'gpt-4o'),
                        binaryPolicy: cfg.get('binaryPolicy', 'skip'),
                        thresholds: cfg.get('thresholds', thresholdsDefault),
                        // redaction settings
                        showRedacted: cfg.get('showRedacted', false),
                        redactionPatterns: cfg.get('redactionPatterns', []),
                        redactionPlaceholder: cfg.get('redactionPlaceholder', '[REDACTED]')
                    }
                };

            this.panel.webview.postMessage(payload);
        }

        private async applyConfigChanges(changes: Record<string, any>) {
            const cfg = vscode.workspace.getConfiguration('codebaseDigest', vscode.Uri.file(this.folderPath));
            for (const [key, value] of Object.entries(changes)) {
                try {
                    await cfg.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
                } catch (e) {
                    // fallback to workspace if workspaceFolder fails
                    await cfg.update(key, value, vscode.ConfigurationTarget.Workspace);
                }
            }
        }

    private postPreviewState() {
        if (!this.panel) { return; }
        const preview = this.treeProvider.getPreviewData();
        this.panel.webview.postMessage({ type: 'state', state: preview });
    }

    private postPreviewDelta() {
        if (!this.panel) { return; }
        const preview = this.treeProvider.getPreviewData();
        const delta = {
            selectedCount: preview.selectedCount,
            totalFiles: preview.totalFiles,
            selectedSize: preview.selectedSize,
            tokenEstimate: preview.tokenEstimate,
            contextLimit: preview.contextLimit
        };
        this.panel.webview.postMessage({ type: 'previewDelta', delta });
    }
    private setHtml(webview: vscode.Webview) {
    // Delegate to shared helper so panel and view rendering stay consistent
    setWebviewHtml(webview, this.extensionUri);
    }

}

function debounce(fn: () => void, ms: number) {
    let t: NodeJS.Timeout | null = null;
    return () => {
        if (t) { clearTimeout(t); }
        t = setTimeout(() => { t = null; fn(); }, ms);
    };
}

export function registerCodebasePanel(context: vscode.ExtensionContext, extensionUri: vscode.Uri, treeProvider: CodebaseDigestTreeProvider) {
    const folderPath = treeProvider['workspaceRoot'] || '';
    const key = folderPath || String(context.storageUri || context.extensionUri);
    if (panels.has(key)) { return panels.get(key)!; }
    const panel = new CodebaseDigestPanel(extensionUri, treeProvider, folderPath);
    panels.set(key, panel);
    return panel;
}

export function registerCodebaseView(context: vscode.ExtensionContext, extensionUri: vscode.Uri, treeProvider: CodebaseDigestTreeProvider) {
    // Diagnostic: log when registerCodebaseView is invoked
    try { console.log('[codebase-digest] registerCodebaseView called for', treeProvider && (treeProvider as any).workspaceRoot); } catch (e) {}
    // If a provider was already registered previously, dispose it so we can re-register with a new treeProvider.
    if (registeredDisposable) {
        try { registeredDisposable.dispose(); } catch (e) { /* ignore */ }
        registeredDisposable = undefined;
        sidebarRegistered = false;
    }
    const provider: vscode.WebviewViewProvider = {
        resolveWebviewView(webviewView: vscode.WebviewView) {
            webviewView.webview.options = {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources', 'webview'), extensionUri]
            };
            // Render the same HTML used by the panel via shared helper
            setWebviewHtml(webviewView.webview, extensionUri);

            // track active view so we can broadcast messages to it later
            try { activeViews.add(webviewView); } catch (e) {}

            webviewView.webview.onDidReceiveMessage(msg => {
                if (msg.type === 'getState') {
                    const preview = treeProvider.getPreviewData();
                    webviewView.webview.postMessage({ type: 'state', state: preview });
                } else if (msg.type === 'configRequest') {
                    const folder = treeProvider['workspaceRoot'] || '';
                    const cfg = vscode.workspace.getConfiguration('codebaseDigest', vscode.Uri.file(folder));
                    const thresholdsDefault = { maxFiles: 25000, maxTotalSizeBytes: 536870912, tokenLimit: 32000 };
                    webviewView.webview.postMessage({ type: 'config', folderPath: folder, settings: {
                        gitignore: cfg.get('gitignore', true),
                        presets: cfg.get('presets', []),
                        outputFormat: cfg.get('outputFormat', 'text'),
                        tokenModel: cfg.get('tokenModel', 'gpt-4o'),
                        binaryPolicy: cfg.get('binaryPolicy', 'skip'),
                        thresholds: cfg.get('thresholds', thresholdsDefault),
                        showRedacted: cfg.get('showRedacted', false),
                        redactionPatterns: cfg.get('redactionPatterns', []),
                        redactionPlaceholder: cfg.get('redactionPlaceholder', '[REDACTED]')
                    }});
                } else if (msg.type === 'config' && msg.action === 'set' && msg.changes) {
                    // Allow the webview (sidebar) to persist settings; mirror applyConfigChanges used by the panel
                    (async () => {
                        const folder = treeProvider['workspaceRoot'] || '';
                        const cfg = vscode.workspace.getConfiguration('codebaseDigest', vscode.Uri.file(folder));
                        for (const [key, value] of Object.entries(msg.changes)) {
                            try {
                                await cfg.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
                            } catch (e) {
                                await cfg.update(key, value, vscode.ConfigurationTarget.Workspace);
                            }
                        }
                        // return updated config to the view so the form refreshes with persisted values
                        const thresholdsDefault = { maxFiles: 25000, maxTotalSizeBytes: 536870912, tokenLimit: 32000 };
                        const updated = {
                            gitignore: cfg.get('gitignore', true),
                            presets: cfg.get('presets', []),
                            outputFormat: cfg.get('outputFormat', 'text'),
                            tokenModel: cfg.get('tokenModel', 'gpt-4o'),
                            binaryPolicy: cfg.get('binaryPolicy', 'skip'),
                            thresholds: cfg.get('thresholds', thresholdsDefault),
                            showRedacted: cfg.get('showRedacted', false),
                            redactionPatterns: cfg.get('redactionPatterns', []),
                            redactionPlaceholder: cfg.get('redactionPlaceholder', '[REDACTED]')
                        };
                        webviewView.webview.postMessage({ type: 'config', folderPath: folder, settings: updated });
                    })();
                } else if (msg.type === 'action') {
                    // Route actions to commands as panel does
                    const commandMap: Record<string, string> = {
                        refresh: 'codebaseDigest.refreshTree',
                        selectAll: 'codebaseDigest.selectAll',
                        clearSelection: 'codebaseDigest.clearSelection',
                        expandAll: 'codebaseDigest.expandAll',
                        collapseAll: 'codebaseDigest.collapseAll',
                        generateDigest: 'codebaseDigest.generateDigest',
                        tokenCount: 'codebaseDigest.estimateTokens'
                    };
                    // Resolve folder target: prefer an explicit folderPath from the message, else use the provider's workspace root
                    const targetFolder = (msg && (msg.folderPath || msg.folder)) || treeProvider['workspaceRoot'] || '';
                    if (msg.actionType === 'ingestRemote' && msg.repo) {
                        const params = { repo: msg.repo, ref: msg.ref, subpath: msg.subpath, includeSubmodules: !!msg.includeSubmodules };
                        vscode.commands.executeCommand('codebaseDigest.ingestRemoteRepoProgrammatic', params).then((result: any) => {
                            webviewView.webview.postMessage({ type: 'ingestPreview', payload: result });
                        }, (err: any) => {
                            webviewView.webview.postMessage({ type: 'ingestError', error: String(err) });
                        });
                    }
                    if (msg.actionType === 'setSelection' && Array.isArray(msg.relPaths)) {
                        treeProvider.setSelectionByRelPaths(msg.relPaths);
                        const preview = treeProvider.getPreviewData();
                        webviewView.webview.postMessage({ type: 'state', state: preview });
                    } else if (msg.actionType === 'toggleExpand' && typeof msg.relPath === 'string') {
                        vscode.commands.executeCommand('codebaseDigest.toggleExpand', targetFolder, msg.relPath);
                    } else if (commandMap[msg.actionType]) {
                        vscode.commands.executeCommand(commandMap[msg.actionType], targetFolder);
                    }
                }
            });

            // Forward progress events to the sidebar webview with light throttling to avoid UI jank
            ((): void => {
                let lastSent = 0;
                let pending: any = null as any;
                let lastEvent: any = null;
                const ms = 200; // minimum interval between posts
                const send = (ev: any) => {
                    try { webviewView.webview.postMessage({ type: 'progress', event: ev }); } catch (e) { /* swallow */ }
                };
                const disposeProgress = onProgress((ev) => {
                    const now = Date.now();
                    if (now - lastSent >= ms) {
                        lastSent = now;
                        send(ev);
                        return;
                    }
                    // schedule the latest event to be sent after remaining interval
                    lastEvent = ev;
                    if (!pending) {
                        const delay = Math.max(0, ms - (now - lastSent));
                        pending = setTimeout(() => {
                            pending = null;
                            if (lastEvent) { lastSent = Date.now(); send(lastEvent); lastEvent = null; }
                        }, delay);
                    }
                });
                // Ensure disposal when the view is closed
                webviewView.onDidDispose(() => {
                    try { disposeProgress(); } catch (e) { /* ignore */ }
                    if (pending) { clearTimeout(pending); pending = null; }
                });
            })();

            // Provide periodic preview deltas
            const interval = setInterval(() => {
                const preview = treeProvider.getPreviewData();
                const delta = { selectedCount: preview.selectedCount, totalFiles: preview.totalFiles, selectedSize: preview.selectedSize, tokenEstimate: preview.tokenEstimate, contextLimit: preview.contextLimit };
                webviewView.webview.postMessage({ type: 'previewDelta', delta });
            }, 5000);
            webviewView.onDidDispose(() => clearInterval(interval));
            webviewView.onDidDispose(() => { try { activeViews.delete(webviewView); } catch (e) {} });
        }
    };
    try {
        registeredDisposable = vscode.window.registerWebviewViewProvider('codebaseDigestDashboard', provider, { webviewOptions: { retainContextWhenHidden: true } });
        context.subscriptions.push(registeredDisposable);
        console.log('[codebase-digest] webview view provider registered for codebaseDigestDashboard');
    } catch (err) {
        console.error('[codebase-digest] failed to register webview view provider', err);
        throw err;
    }
    sidebarRegistered = true;
}

// Broadcast generation result to open panels and sidebar views so webview can show toasts (e.g., redactionApplied)
export function broadcastGenerationResult(result: any, folderPath?: string) {
    // Post to panels matching folderPath (or all if not specified)
    for (const [key, panel] of panels.entries()) {
        try {
            if (!folderPath || key === folderPath || (panel as any).folderPath === folderPath) {
                if ((panel as any).panel) { (panel as any).panel.webview.postMessage({ type: 'generationResult', result }); }
            }
        } catch (e) { /* ignore */ }
    }
    // Post to active sidebar views
    for (const vw of activeViews) {
        try {
            // If folderPath is provided, only send to views that advertised that folderPath in their initial config message
            vw.webview.postMessage({ type: 'generationResult', result });
        } catch (e) { /* ignore */ }
    }
}

// Shared helper: load the same index.html, rewrite resource URIs for the webview, and inject a CSP meta
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
    // Inject a single, strict CSP meta that restricts all sources except resources served via webview.cspSource.
    // Note: if inline scripts/styles are ever required in the future, generate a nonce and include it here
    // (e.g. script-src ${webview.cspSource} 'nonce-<nonceVal>') and set the same nonce on the inline elements.
    const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource}; style-src ${webview.cspSource}; img-src ${webview.cspSource};">`;
    html = html.replace(/<head[^>]*>/i, (match: string) => `${match}${cspMeta}`);
    webview.html = html;
}
