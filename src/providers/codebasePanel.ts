import * as vscode from 'vscode';
import * as path from 'path';
import { CodebaseDigestTreeProvider } from './treeDataProvider';
import { onProgress } from './eventBus';
import { setWebviewHtml, wireWebviewMessages } from './webviewHelpers';
import { Diagnostics } from '../utils/diagnostics';
const diagnostics = new Diagnostics('debug');

const panels: Map<string, CodebaseDigestPanel> = new Map();
let registeredDisposable: vscode.Disposable | undefined;
// Track active sidebar views and their associated folderPath so broadcasts can be scoped.
const activeViews: Map<vscode.WebviewView, string> = new Map();

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
        // Detect whether the first argument is an ExtensionContext by duck-typing useful members.
        // Some test harnesses may provide partial contexts; prefer checking for 'subscriptions' (array)
        // and workspaceState having 'get' as a function to be robust across environments.
        if (contextOrExtensionUri && typeof contextOrExtensionUri === 'object'
            && Array.isArray((contextOrExtensionUri as any).subscriptions)
            && (contextOrExtensionUri as any).workspaceState && typeof (contextOrExtensionUri as any).workspaceState.get === 'function') {
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
    // Send current configuration to webview immediately so settings UI is populated
    try { this.postConfig(); } catch (e) { try { diagnostics.error('postConfig failed', String((e && ((e as any).stack || (e as any).message)) || e)); } catch {} }
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
            try { this.panel.webview.postMessage({ type: 'progress', event: e }); } catch (e) { try { diagnostics.warn('postMessage progress failed', e); } catch {} }
        }
    });
    // Post an immediate preview delta when scans start or end so chips update promptly
    const scanProgressDisp = onProgress((ev: any) => {
                try {
            // Only update preview chips when a scan completes (end) to avoid noisy updates on start
                if (ev && ev.op === 'scan' && ev.mode === 'end') {
                try { this.postPreviewDelta(); } catch (inner) { try { diagnostics.warn('postPreviewDelta failed', inner); } catch {} }
            }
        } catch (ex) { try { diagnostics.error('scanProgress dispatch failed', ex); } catch {} }
    });
    // Send initial full state only if a scan has already populated data; otherwise wait for scan completion to avoid empty first-paint
    try {
        const previewNow = this.treeProvider.getPreviewData();
        if (previewNow && typeof previewNow.totalFiles === 'number' && previewNow.totalFiles > 0) {
            try { this.postPreviewState(); } catch (e) { try { diagnostics.warn('postPreviewState failed', e); } catch {} }
        }
    } catch (e) { try { diagnostics.warn('getting previewNow failed', e); } catch {} }
    // Periodic heartbeat to refresh stats every 5s
    const interval = setInterval(() => this.postPreviewDelta(), 5000);
    this.panel.onDidDispose(() => { clearInterval(interval); });
    this.panel.onDidDispose(() => { try { disposeProgress(); } catch (e) { try { diagnostics.warn('disposeProgress failed', e); } catch {} } });
    this.panel.onDidDispose(() => { try { scanProgressDisp(); } catch (e) { try { diagnostics.warn('scanProgressDisp failed', e); } catch {} } });
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
                // Prefer WorkspaceFolder-level settings when the folder is part of the workspace;
                // otherwise update at the Workspace level.
                try {
                    const folderUri = vscode.Uri.file(this.folderPath);
                    const wf = vscode.workspace.getWorkspaceFolder(folderUri);
                    if (wf) {
                        await cfg.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
                    } else {
                        await cfg.update(key, value, vscode.ConfigurationTarget.Workspace);
                    }
                } catch (e) {
                    // Best-effort: if WorkspaceFolder update failed for unexpected reasons, try Workspace as a fallback.
                    try { await cfg.update(key, value, vscode.ConfigurationTarget.Workspace); } catch (err) { /* ignore */ }
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
            contextLimit: preview.contextLimit,
                // Send hierarchical tree and selected paths (webview will decide how to render compactly)
                fileTree: preview.fileTree,
                selectedPaths: Array.isArray(preview.selectedPaths) ? preview.selectedPaths : []
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

            // Post configuration eagerly so settings UI is populated on first open
            try {
                const folder = treeProvider['workspaceRoot'] || '';
                const cfg = vscode.workspace.getConfiguration('codebaseDigest', vscode.Uri.file(folder));
                const thresholdsDefault = { maxFiles: 25000, maxTotalSizeBytes: 536870912, tokenLimit: 32000 };
                const thresholds = cfg.get('thresholds', thresholdsDefault) as any || {};
                const maxFiles = cfg.get('maxFiles', thresholds.maxFiles || thresholdsDefault.maxFiles) as number;
                const maxTotalSizeBytes = cfg.get('maxTotalSizeBytes', thresholds.maxTotalSizeBytes || thresholdsDefault.maxTotalSizeBytes) as number;
                const tokenLimit = cfg.get('tokenLimit', thresholds.tokenLimit || thresholdsDefault.tokenLimit) as number;
                const payload = {
                    type: 'config',
                    folderPath: folder,
                    settings: {
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
                    }
                };
                webviewView.webview.postMessage(payload);
            } catch (e) { /* ignore */ }

            // track active view so we can broadcast messages to it later (store advertised folderPath)
            try { activeViews.set(webviewView, treeProvider['workspaceRoot'] || ''); } catch (e) {}

            // Use shared wiring helper for sidebar messages as well
            wireWebviewMessages(webviewView.webview, treeProvider, treeProvider['workspaceRoot'] || '', async (changes: Record<string, any>) => {
                // mirror panel behavior: persist config changes then push updated config
                const folder = treeProvider['workspaceRoot'] || '';
                const cfg = vscode.workspace.getConfiguration('codebaseDigest', vscode.Uri.file(folder));
                for (const [key, value] of Object.entries(changes)) {
                    try {
                        const folderUri = vscode.Uri.file(folder);
                        const wf = vscode.workspace.getWorkspaceFolder(folderUri);
                        if (wf) {
                            await cfg.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
                        } else {
                            await cfg.update(key, value, vscode.ConfigurationTarget.Workspace);
                        }
                    } catch (e) {
                        try { await cfg.update(key, value, vscode.ConfigurationTarget.Workspace); } catch (err) { /* ignore */ }
                    }
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
                    try { webviewView.webview.postMessage({ type: 'progress', event: ev }); } catch (e) { try { console.warn('codebasePanel: post progress failed', e); } catch {} }
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
                    try { disposeProgress(); } catch (e) { try { console.warn('codebasePanel: disposeProgress failed', e); } catch {} }
                    if (pending) { clearTimeout(pending); pending = null; }
                });
            })();

            // send an immediate preview delta so chips populate quickly on reveal
            try {
                const preview = treeProvider.getPreviewData();
                const delta = { selectedCount: preview.selectedCount, totalFiles: preview.totalFiles, selectedSize: preview.selectedSize, tokenEstimate: preview.tokenEstimate, contextLimit: preview.contextLimit, fileTree: preview.fileTree, selectedPaths: Array.isArray(preview.selectedPaths) ? preview.selectedPaths : [] };
                webviewView.webview.postMessage({ type: 'previewDelta', delta });
            } catch (e) { try { console.warn('codebasePanel: post previewDelta failed', e); } catch {} }

            // Hook into treeProvider progress to post preview deltas when scans start/end
            const scanProgressDisp = onProgress((ev: any) => {
                try {
                    // Post a preview delta when a scan finishes so chips update to reflect final counts
                    if (ev && ev.op === 'scan' && ev.mode === 'end') {
                        try {
                            const preview = treeProvider.getPreviewData();
                            const delta = { selectedCount: preview.selectedCount, totalFiles: preview.totalFiles, selectedSize: preview.selectedSize, tokenEstimate: preview.tokenEstimate, contextLimit: preview.contextLimit, fileTree: preview.fileTree, selectedPaths: Array.isArray(preview.selectedPaths) ? preview.selectedPaths : [] };
                            webviewView.webview.postMessage({ type: 'previewDelta', delta });
                        } catch (inner) { /* ignore */ }
                    }
                } catch (ex) { /* ignore */ }
            });

            // Provide periodic preview deltas
            const interval = setInterval(() => {
                const preview = treeProvider.getPreviewData();
                const delta = { selectedCount: preview.selectedCount, totalFiles: preview.totalFiles, selectedSize: preview.selectedSize, tokenEstimate: preview.tokenEstimate, contextLimit: preview.contextLimit, fileTree: preview.fileTree, selectedPaths: Array.isArray(preview.selectedPaths) ? preview.selectedPaths : [] };
                webviewView.webview.postMessage({ type: 'previewDelta', delta });
            }, 5000);
            webviewView.onDidDispose(() => clearInterval(interval));
            webviewView.onDidDispose(() => { try { scanProgressDisp(); } catch (e) {} });
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
    // Post to active sidebar views (filter by folderPath when provided)
    for (const [vw, vwFolder] of activeViews.entries()) {
        try {
            if (!folderPath || vwFolder === folderPath) {
                vw.webview.postMessage({ type: 'generationResult', result });
            }
        } catch (e) { /* ignore */ }
    }
}

// Broadcast a previewDelta to open panels and sidebar views so the UI updates chips
export function broadcastPreviewDelta(delta: any, folderPath?: string) {
    try {
        // Post to panels matching folderPath (or all if not specified)
        for (const [key, panel] of panels.entries()) {
            try {
                if (!folderPath || key === folderPath || (panel as any).folderPath === folderPath) {
                    if ((panel as any).panel) { (panel as any).panel.webview.postMessage({ type: 'previewDelta', delta }); }
                }
            } catch (e) { /* ignore */ }
        }
    } catch (e) { /* ignore */ }
    try {
        // Post to active sidebar views, filtered by folderPath when provided
        for (const [vw, vwFolder] of activeViews.entries()) {
            try {
                if (!folderPath || vwFolder === folderPath) {
                    vw.webview.postMessage({ type: 'previewDelta', delta });
                }
            } catch (e) { /* ignore */ }
        }
    } catch (e) { /* ignore */ }
}

// Small convenience helper to allow external callers (commands) to push a previewDelta
// that updates chips in open panels and sidebar views. This is intentionally thin and
// delegates to broadcastPreviewDelta so behavior is consistent.
export function postPreviewDeltaToActiveViews(delta: any, folderPath?: string) {
    try { broadcastPreviewDelta(delta, folderPath); } catch (e) { /* ignore */ }
}

// Re-export helpers for backwards compatibility with imports from codebasePanel
export { setWebviewHtml, wireWebviewMessages };
