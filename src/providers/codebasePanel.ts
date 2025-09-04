import * as vscode from 'vscode';
import * as path from 'path';
import { CodebaseDigestTreeProvider } from './treeDataProvider';
import { onProgress } from './eventBus';
import { setWebviewHtml, wireWebviewMessages } from './webviewHelpers';

const panels: Map<string, CodebaseDigestPanel> = new Map();
let registeredDisposable: vscode.Disposable | undefined;
const activeViews: Set<vscode.WebviewView> = new Set();

export class CodebaseDigestPanel {
    private panel?: vscode.WebviewPanel;
    private extensionUri: vscode.Uri;
    private treeProvider: CodebaseDigestTreeProvider;
    private folderPath: string;
    private context?: vscode.ExtensionContext;

    // Support two constructor shapes for backwards compatibility with tests:
    // - new CodebaseDigestPanel(context, extensionUri, treeProvider, folderPath)
    // - legacy: new CodebaseDigestPanel(extensionUri, treeProvider, folderPath)
    constructor(contextOrExtensionUri: any, extensionUriOrTreeProvider?: any, treeProviderOrFolderPath?: any, folderPathArg?: any) {
        // Detect whether the first argument is an ExtensionContext (has workspaceState/subscriptions)
        if (contextOrExtensionUri && typeof contextOrExtensionUri === 'object' && ('workspaceState' in contextOrExtensionUri || 'subscriptions' in contextOrExtensionUri)) {
            this.context = contextOrExtensionUri as vscode.ExtensionContext;
            this.extensionUri = extensionUriOrTreeProvider as vscode.Uri;
            this.treeProvider = treeProviderOrFolderPath as CodebaseDigestTreeProvider;
            this.folderPath = folderPathArg as string;
        } else {
            // Legacy calling shape: (extensionUri, treeProvider, folderPath)
            this.context = undefined;
            this.extensionUri = contextOrExtensionUri as vscode.Uri;
            this.treeProvider = extensionUriOrTreeProvider as CodebaseDigestTreeProvider;
            this.folderPath = treeProviderOrFolderPath as string;
        }
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
        // Wire message routing via shared helper so panel and view remain consistent
    wireWebviewMessages(this.panel.webview, this.treeProvider, this.folderPath, async (changes: Record<string, any>) => {
            await this.applyConfigChanges(changes);
    }, () => this.postPreviewState(), this.context);
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
                const thresholds = cfg.get('thresholds', thresholdsDefault) as any || {};
                const maxFiles = cfg.get('maxFiles', thresholds.maxFiles || thresholdsDefault.maxFiles) as number;
                const maxTotalSizeBytes = cfg.get('maxTotalSizeBytes', thresholds.maxTotalSizeBytes || thresholdsDefault.maxTotalSizeBytes) as number;
                const tokenLimit = cfg.get('tokenLimit', thresholds.tokenLimit || thresholdsDefault.tokenLimit) as number;

                const payload = {
                    type: 'config',
                    folderPath: this.folderPath,
                    settings: {
                        respectGitignore: cfg.get('respectGitignore', cfg.get('gitignore', true)),
                        presets: cfg.get('presets', []),
                        outputFormat: cfg.get('outputFormat', 'text'),
                        tokenModel: cfg.get('tokenModel', 'chars-approx'),
                        binaryFilePolicy: cfg.get('binaryFilePolicy', cfg.get('binaryPolicy', 'skip')),
                        // flattened thresholds
                        maxFiles,
                        maxTotalSizeBytes,
                        tokenLimit,
                        thresholds: Object.assign({}, thresholdsDefault, thresholds),
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
    const panel = new CodebaseDigestPanel(context, extensionUri, treeProvider, folderPath);
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

            // Use shared wiring helper for sidebar messages as well
            wireWebviewMessages(webviewView.webview, treeProvider, treeProvider['workspaceRoot'] || '', async (changes: Record<string, any>) => {
                // mirror panel behavior: persist config changes then push updated config
                const folder = treeProvider['workspaceRoot'] || '';
                const cfg = vscode.workspace.getConfiguration('codebaseDigest', vscode.Uri.file(folder));
                for (const [key, value] of Object.entries(changes)) {
                    try { await cfg.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder); } catch (e) { await cfg.update(key, value, vscode.ConfigurationTarget.Workspace); }
                }
                const thresholdsDefault = { maxFiles: 25000, maxTotalSizeBytes: 536870912, tokenLimit: 32000 };
                const thresholds = cfg.get('thresholds', thresholdsDefault) as any || {};
                const maxFiles = cfg.get('maxFiles', thresholds.maxFiles || thresholdsDefault.maxFiles) as number;
                const maxTotalSizeBytes = cfg.get('maxTotalSizeBytes', thresholds.maxTotalSizeBytes || thresholdsDefault.maxTotalSizeBytes) as number;
                const tokenLimit = cfg.get('tokenLimit', thresholds.tokenLimit || thresholdsDefault.tokenLimit) as number;
                const updated = {
                    respectGitignore: cfg.get('respectGitignore', cfg.get('gitignore', true)),
                    presets: cfg.get('presets', []),
                    outputFormat: cfg.get('outputFormat', 'text'),
                    tokenModel: cfg.get('tokenModel', 'chars-approx'),
                    binaryFilePolicy: cfg.get('binaryFilePolicy', cfg.get('binaryPolicy', 'skip')),
                    maxFiles,
                    maxTotalSizeBytes,
                    tokenLimit,
                    thresholds: Object.assign({}, thresholdsDefault, thresholds),
                    showRedacted: cfg.get('showRedacted', false),
                    redactionPatterns: cfg.get('redactionPatterns', []),
                    redactionPlaceholder: cfg.get('redactionPlaceholder', '[REDACTED]')
                };
                webviewView.webview.postMessage({ type: 'config', folderPath: folder, settings: updated });
            }, () => {
                // on getState, send current preview
                const preview = treeProvider.getPreviewData();
                webviewView.webview.postMessage({ type: 'state', state: preview });
            }, context);

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
    // registration tracked via registeredDisposable
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

// Re-export helpers for backwards compatibility with imports from codebasePanel
export { setWebviewHtml, wireWebviewMessages };
