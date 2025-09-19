import * as vscode from 'vscode';
import * as path from 'path';
import { CodebaseDigestTreeProvider } from './treeDataProvider';
import { onProgress } from './eventBus';
import { onState } from './eventBus';
import { setWebviewHtml, wireWebviewMessages } from './webviewHelpers';
import { ConfigurationService } from '../services/configurationService';
import { debounce } from '../utils/debounce';
import { Diagnostics } from '../utils/diagnostics';
import logger from '../utils/logger';
import { WebviewCommands, WebviewCommand } from '../types/webview';
import { isRecord, isStringArray, hasProp, isNumber } from '../utils/typeGuards';
const diagnostics = new Diagnostics('debug', 'Code Ingest');

// Small typed payload shapes sent to the webview. Keep these minimal and
// only include primitives and small arrays to avoid sending large or sensitive
// objects accidentally.
interface ProgressEventPayload {
    type: WebviewCommand;
    event: { op?: string; mode?: string; [k: string]: unknown };
}

interface PreviewDeltaPayload {
    type: WebviewCommand;
    delta: {
        selectedCount?: number;
        totalFiles?: number;
        selectedSize?: number;
        tokenEstimate?: number;
        contextLimit?: number;
        fileTree?: unknown; // tree may be large; webview is responsible for rendering
        selectedPaths: string[];
    };
}

interface StatePayload {
    type: WebviewCommand;
    state: unknown;
}

interface DiagnosticPayload {
    type: WebviewCommand;
    level: 'error' | 'warning' | 'info';
    message: string;
}

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
    // track periodic preview interval so it can be cleared when webview reloads
    private previewInterval?: ReturnType<typeof setInterval>;

    // Support two constructor shapes for backwards compatibility with tests:
    // - new CodebaseDigestPanel(context, extensionUri, treeProvider, folderPath)
    // - legacy: new CodebaseDigestPanel(extensionUri, treeProvider, folderPath)
    constructor(contextOrExtensionUri: unknown, extensionUriOrTreeProvider?: unknown, treeProviderOrFolderPath?: unknown, folderPathArg?: unknown) {
        // Detect whether the first argument is an ExtensionContext by duck-typing useful members.
        // Some test harnesses may provide partial contexts; prefer checking for 'subscriptions' (array)
        // and workspaceState having 'get' as a function to be robust across environments.
        type PartialCtx = { subscriptions?: unknown; workspaceState?: { get?: unknown } };
        if (contextOrExtensionUri && typeof contextOrExtensionUri === 'object') {
            const maybeCtx = contextOrExtensionUri as PartialCtx;
            if (Array.isArray(maybeCtx.subscriptions) && maybeCtx.workspaceState && typeof (maybeCtx.workspaceState as { get?: unknown }).get === 'function') {
                this.context = contextOrExtensionUri as vscode.ExtensionContext;
                this.extensionUri = extensionUriOrTreeProvider as vscode.Uri;
                this.treeProvider = treeProviderOrFolderPath as CodebaseDigestTreeProvider;
                this.folderPath = folderPathArg as string;
            } else {
                // Legacy calling shape fallback handled below
                this.context = undefined;
                this.extensionUri = contextOrExtensionUri as vscode.Uri;
                this.treeProvider = extensionUriOrTreeProvider as CodebaseDigestTreeProvider;
                this.folderPath = treeProviderOrFolderPath as string;
            }
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
    // Ensure any previously scheduled interval is cleared before (re)creating
        if (this.previewInterval) { try { clearInterval(this.previewInterval); } catch {} this.previewInterval = undefined; }
    this.panel = vscode.window.createWebviewPanel('codebaseDigestPanel', 'Code Ingest', vscode.ViewColumn.One, {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'resources', 'webview'), this.extensionUri]
        });
    this.setHtml(this.panel.webview);
    // Send current configuration to webview immediately so settings UI is populated
    try { this.postConfig(); } catch (e) { try { const em = e && typeof e === 'object' ? String(((e as Record<string, unknown>)['stack'] || (e as Record<string, unknown>)['message']) ?? e) : String(e); diagnostics.error('postConfig failed', em); } catch {} }
        // Wire message routing via shared helper so panel and view remain consistent
    wireWebviewMessages(this.panel.webview, this.treeProvider, this.folderPath, async (changes: Record<string, unknown>) => {
            await this.applyConfigChanges(changes);
    }, () => this.postPreviewState(), this.context);
        // Listen for arbitrary commands coming from the webview (sidebar/panel)
        // e.g., a message with type 'refreshTree' should trigger the corresponding VS Code command
        const panelMsgDisp = this.panel.webview.onDidReceiveMessage((msg: any) => {
            try {
                if (!msg) { return; }
                const t = (msg && (msg.type || msg.actionType || msg.command)) ? (msg.type || msg.actionType || msg.command) : undefined;
                if (!t) { return; }
                // Map webview-level command names to VS Code commands
                try {
                    const refreshCmd = (WebviewCommands && (WebviewCommands as unknown) && (WebviewCommands as any).refreshTree) ? (WebviewCommands as any).refreshTree : 'refreshTree';
                    if (t === refreshCmd || t === 'refreshTree') { try { vscode.commands.executeCommand('codebaseDigest.refreshTree'); } catch (err) { try { diagnostics.warn('executeCommand refreshTree failed', err); } catch {} } }
                } catch (e) { /* swallow */ }
            } catch (e) { /* swallow */ }
        });
        this.panel.onDidDispose(() => { try { panelMsgDisp.dispose(); } catch (e) { /* ignore */ } });
        this.panel.onDidDispose(() => {
            this.panel = undefined;
            panels.delete(this.folderPath);
        });

    // Wire preview updates: post compact deltas to keep stats live without full re-render
    const debouncedPostDelta = debounce(() => this.postPreviewDelta(), 200);
    this.treeProvider.setPreviewUpdater(() => debouncedPostDelta());
    // Ensure we cancel the debounced updater when the panel is disposed to
    // avoid leaving a pending timeout that retains closures.
    this.panel.onDidDispose(() => {
        try {
            const dp = debouncedPostDelta as unknown as { cancel?: unknown };
            if (dp && typeof dp === 'object' && typeof dp.cancel === 'function') {
                try { (dp.cancel as Function)(); } catch (e) { /* ignore */ }
            }
        } catch (e) { }
        try { this.treeProvider.setPreviewUpdater(() => {}); } catch (e) { }
    });
    // Forward progress events to the webview
    const disposeProgress = onProgress(e => {
                if (this.panel) {
            try {
                const rawOp = (e && typeof e === 'object') ? (e as Record<string, unknown>)['op'] : undefined;
                const rawMode = (e && typeof e === 'object') ? (e as Record<string, unknown>)['mode'] : undefined;
                const evt = { op: typeof rawOp === 'string' ? rawOp : undefined, mode: typeof rawMode === 'string' ? rawMode : undefined };
                const payload: ProgressEventPayload = { type: WebviewCommands.progress, event: evt };
                this.panel.webview.postMessage(payload);
            } catch (err) { try { diagnostics.warn('postMessage progress failed', err); } catch {} }
        }
    });
    // Forward state events (full preview/state payloads) to panels and sidebar views
    const disposeState = onState(payload => {
        try {
            // Post to panel if present and folder matches (or not provided)
            if (this.panel && this.panel.webview && typeof this.panel.webview.postMessage === 'function') {
                try { this.panel.webview.postMessage({ type: WebviewCommands.state, state: payload.state }); } catch (e) { try { diagnostics.warn('post state to panel failed', e); } catch {} }
            }
            // Post to any active sidebar views matching folderPath
            for (const [vw, vwFolder] of activeViews.entries()) {
                try {
                    if (!payload.folderPath || payload.folderPath === vwFolder) {
                        vw.webview.postMessage({ type: WebviewCommands.state, state: payload.state });
                    }
                } catch (e) { /* ignore per-view errors */ }
            }
        } catch (e) { /* swallow */ }
    });
    // Post an immediate preview delta when scans start or end so chips update promptly
    const scanProgressDisp = onProgress((ev: unknown) => {
                try {
            // Only update preview chips when a scan completes (end) to avoid noisy updates on start
                if (ev && typeof ev === 'object') {
                const op = (ev as Record<string, unknown>)['op'];
                const mode = (ev as Record<string, unknown>)['mode'];
                if (op === 'scan' && mode === 'end') {
                    try { this.postPreviewDelta(); } catch (inner) { try { diagnostics.warn('postPreviewDelta failed', inner); } catch {} }
                }
            }
        } catch (ex) { try { diagnostics.error('scanProgress dispatch failed', ex); } catch {} }
    });
    // Send initial full state only if a scan has already populated data; otherwise wait for scan completion to avoid empty first-paint
    try {
        const previewNow = this.treeProvider.getPreviewData && typeof this.treeProvider.getPreviewData === 'function' ? this.treeProvider.getPreviewData() : null;
        if (previewNow && typeof previewNow.totalFiles === 'number' && previewNow.totalFiles > 0) {
            try { this.postPreviewState(); } catch (e) { try { diagnostics.warn('postPreviewState failed', e); } catch {} }
        }
    } catch (e) { try { diagnostics.warn('getting previewNow failed', e); } catch {} }
    // Periodic heartbeat to refresh stats every 5s
    const __cbd_preview_interval = setInterval(() => this.postPreviewDelta(), 5000);
    try { if (__cbd_preview_interval && typeof ( (__cbd_preview_interval as unknown as { unref?: unknown }).unref) === 'function') { try { ((__cbd_preview_interval as unknown as { unref?: Function }).unref!()); } catch (e) {} } } catch (e) {}
    this.previewInterval = __cbd_preview_interval as unknown as ReturnType<typeof setInterval>;
    this.panel.onDidDispose(() => { try { if (this.previewInterval) { try { clearInterval(this.previewInterval as unknown as ReturnType<typeof setInterval>); } catch {} this.previewInterval = undefined; } } catch (e) { try { diagnostics.warn('clearing previewInterval failed', e); } catch {} } });
    this.panel.onDidDispose(() => { try { disposeProgress(); } catch (e) { try { diagnostics.warn('disposeProgress failed', e); } catch {} } });
    this.panel.onDidDispose(() => { try { scanProgressDisp(); } catch (e) { try { diagnostics.warn('scanProgressDisp failed', e); } catch {} } });
    this.panel.onDidDispose(() => { try { disposeState(); } catch (e) { try { diagnostics.warn('disposeState failed', e); } catch {} } });
    }

        private async postConfig() {
            if (!this.panel) { return; }
            // Use ConfigurationService to get validated snapshot for reads
            try {
                const cfgSnapshot = ConfigurationService.getWorkspaceConfig(vscode.Uri.file(this.folderPath), diagnostics);
                const thresholdsDefault = { maxFiles: 25000, maxTotalSizeBytes: 536870912, tokenLimit: 32000 };
                const thresholds = isRecord(cfgSnapshot) && hasProp(cfgSnapshot, 'thresholds') ? (cfgSnapshot as Record<string, unknown>)['thresholds'] as Record<string, unknown> : {};
                const cfgRec = isRecord(cfgSnapshot) ? cfgSnapshot as Record<string, unknown> : {};
                const presets = isStringArray(cfgRec['presets']) ? cfgRec['presets'] as string[] : [];
                const filterPresets = isStringArray(cfgRec['filterPresets']) ? cfgRec['filterPresets'] as string[] : [];
                const settings: Record<string, unknown> = {
                    presets,
                    filterPresets,
                    thresholds: Object.assign({}, thresholdsDefault, thresholds),
                };
                if (typeof cfgRec['respectGitignore'] === 'boolean') { settings['respectGitignore'] = cfgRec['respectGitignore']; }
                if (typeof cfgRec['outputFormat'] === 'string') { settings['outputFormat'] = cfgRec['outputFormat']; }
                if (typeof cfgRec['tokenModel'] === 'string') { settings['tokenModel'] = cfgRec['tokenModel']; }
                if (typeof cfgRec['binaryFilePolicy'] === 'string') { settings['binaryFilePolicy'] = cfgRec['binaryFilePolicy']; }
                if (isNumber(cfgRec['maxFiles'])) { settings['maxFiles'] = cfgRec['maxFiles'] as number; }
                if (isNumber(cfgRec['maxTotalSizeBytes'])) { settings['maxTotalSizeBytes'] = cfgRec['maxTotalSizeBytes'] as number; }
                if (isNumber(cfgRec['tokenLimit'])) { settings['tokenLimit'] = cfgRec['tokenLimit'] as number; }
                if (typeof cfgRec['showRedacted'] === 'boolean') { settings['showRedacted'] = cfgRec['showRedacted']; }
                if (Array.isArray(cfgRec['redactionPatterns'])) { settings['redactionPatterns'] = cfgRec['redactionPatterns']; }
                settings['redactionPlaceholder'] = typeof cfgRec['redactionPlaceholder'] === 'string' ? cfgRec['redactionPlaceholder'] : undefined;
                const payload: { type: WebviewCommand; folderPath: string; settings: Record<string, unknown> } = { type: WebviewCommands.config, folderPath: this.folderPath, settings };
                try {
                    const perf = ConfigurationService.getWorkspaceConfig(vscode.Uri.file(this.folderPath));
                    const perfRec = isRecord(perf) ? perf as Record<string, unknown> : {};
                    settings['debugEnabled'] = perfRec['performanceLogLevel'] === 'debug';
                } catch (e) { /* ignore */ }
                this.panel.webview.postMessage(payload);
            } catch (e) { try { diagnostics.warn('postConfig failed (snapshot)', e); } catch {} }
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
            // After applying changes, push updated config back to the webview so UI stays in sync.
            try { await this.postConfig(); } catch (e) { try { diagnostics.warn('postConfig after applyConfigChanges failed', e); } catch {} }
        }

    private postPreviewState() {
        if (!this.panel) { return; }
        const preview = this.treeProvider.getPreviewData();
        const statePayload: StatePayload = { type: WebviewCommands.state, state: preview } as StatePayload;
    this.panel.webview.postMessage(statePayload);
    }

    private postPreviewDelta() {
        if (!this.panel) { return; }
        const preview = this.treeProvider.getPreviewData();
        const delta: PreviewDeltaPayload['delta'] = {
            selectedCount: typeof preview.selectedCount === 'number' ? preview.selectedCount : undefined,
            totalFiles: typeof preview.totalFiles === 'number' ? preview.totalFiles : undefined,
            selectedSize: typeof preview.selectedSize === 'number' ? preview.selectedSize : undefined,
            tokenEstimate: typeof preview.tokenEstimate === 'number' ? preview.tokenEstimate : undefined,
            contextLimit: typeof preview.contextLimit === 'number' ? preview.contextLimit : undefined,
            fileTree: preview.fileTree,
            selectedPaths: Array.isArray(preview.selectedPaths) ? (preview.selectedPaths as unknown[]).map((p: unknown) => String(p)) : []
        };
    const payload: PreviewDeltaPayload = { type: WebviewCommands.previewDelta, delta } as PreviewDeltaPayload;
    this.panel.webview.postMessage(payload);
    }
    private setHtml(webview: vscode.Webview) {
    // Delegate to shared helper so panel and view rendering stay consistent
    setWebviewHtml(webview, this.extensionUri);
    }

}

// Use shared debounce helper from ../utils/debounce.ts

export function registerCodebasePanel(context: vscode.ExtensionContext, extensionUri: vscode.Uri, treeProvider: CodebaseDigestTreeProvider) {
    const folderPath = (treeProvider && typeof (treeProvider as unknown as Record<string, unknown>)['workspaceRoot'] === 'string') ? String((treeProvider as unknown as Record<string, unknown>)['workspaceRoot']) : '';
    const key = folderPath || String(context.storageUri || context.extensionUri);
    if (panels.has(key)) { return panels.get(key)!; }
    const panel = new CodebaseDigestPanel(context, extensionUri, treeProvider, folderPath);
    panels.set(key, panel);
    return panel;
}

export function registerCodebaseView(context: vscode.ExtensionContext, extensionUri: vscode.Uri, treeProvider: CodebaseDigestTreeProvider) {
    // Diagnostic: log when registerCodebaseView is invoked
    try {
        const tpRec = treeProvider as unknown as { workspaceRoot?: unknown };
        const wp = tpRec && typeof tpRec.workspaceRoot === 'string' ? tpRec.workspaceRoot : undefined;
        try { logger.info('registerCodebaseView called for', wp); } catch (e) {}
    } catch (e) {}
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
            // Narrow once for the whole resolver and post configuration eagerly so settings UI is populated on first open
            const tpRec = treeProvider as unknown as { workspaceRoot?: unknown };
            try {
                const folder = typeof tpRec.workspaceRoot === 'string' ? String(tpRec.workspaceRoot) : '';
                const snapshot = ConfigurationService.getWorkspaceConfig(vscode.Uri.file(folder));
                const thresholdsDefault = { maxFiles: 25000, maxTotalSizeBytes: 536870912, tokenLimit: 32000 };
                const snapRec = isRecord(snapshot) ? snapshot as Record<string, unknown> : {};
                const thresholds = isRecord(snapRec['thresholds']) ? (snapRec['thresholds'] as Record<string, unknown>) : {};
                const presets = isStringArray(snapRec['presets']) ? snapRec['presets'] as string[] : [];
                const filterPresets = isStringArray(snapRec['filterPresets']) ? snapRec['filterPresets'] as string[] : [];
                const settings: Record<string, unknown> = {
                    presets,
                    filterPresets,
                    thresholds: Object.assign({}, thresholdsDefault, thresholds || {}),
                };
                if (typeof snapRec['respectGitignore'] === 'boolean') { settings['respectGitignore'] = snapRec['respectGitignore']; }
                if (typeof snapRec['outputFormat'] === 'string') { settings['outputFormat'] = snapRec['outputFormat']; }
                if (typeof snapRec['tokenModel'] === 'string') { settings['tokenModel'] = snapRec['tokenModel']; }
                if (typeof snapRec['binaryFilePolicy'] === 'string') { settings['binaryFilePolicy'] = snapRec['binaryFilePolicy']; }
                if (isNumber(snapRec['maxFiles'])) { settings['maxFiles'] = snapRec['maxFiles'] as number; }
                if (isNumber(snapRec['maxTotalSizeBytes'])) { settings['maxTotalSizeBytes'] = snapRec['maxTotalSizeBytes'] as number; }
                if (isNumber(snapRec['tokenLimit'])) { settings['tokenLimit'] = snapRec['tokenLimit'] as number; }
                if (typeof snapRec['showRedacted'] === 'boolean') { settings['showRedacted'] = snapRec['showRedacted']; }
                if (Array.isArray(snapRec['redactionPatterns'])) { settings['redactionPatterns'] = snapRec['redactionPatterns']; }
                settings['redactionPlaceholder'] = typeof snapRec['redactionPlaceholder'] === 'string' ? snapRec['redactionPlaceholder'] : '[REDACTED]';
                webviewView.webview.postMessage({ type: WebviewCommands.config, folderPath: folder, settings });
            } catch (e) { /* ignore */ }

            // track active view so we can broadcast messages to it later (store advertised folderPath)
                try {
                    const advertised = typeof tpRec.workspaceRoot === 'string' ? String(tpRec.workspaceRoot) : '';
                    activeViews.set(webviewView, advertised);
                    try { logger.debug('resolveWebviewView active view tracked for', advertised); } catch (e) {}
                } catch (e) {}

            // Use shared wiring helper for sidebar messages as well
                wireWebviewMessages(webviewView.webview, treeProvider, typeof tpRec.workspaceRoot === 'string' ? String(tpRec.workspaceRoot) : '', async (changes: Record<string, any>) => {
                // mirror panel behavior: persist config changes then push updated config
                const folder = typeof tpRec.workspaceRoot === 'string' ? String(tpRec.workspaceRoot) : '';
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
                // After applying changes, read back a validated snapshot and post that to the webview
                try {
                    const snapshot = ConfigurationService.getWorkspaceConfig(vscode.Uri.file(folder));
                    const snapRec = isRecord(snapshot) ? snapshot as Record<string, unknown> : {};
                    const presets = isStringArray(snapRec['presets']) ? snapRec['presets'] as string[] : [];
                    const filterPresets = isStringArray(snapRec['filterPresets']) ? snapRec['filterPresets'] as string[] : [];
                    const settings: Record<string, unknown> = {
                        presets,
                        filterPresets,
                        thresholds: Object.assign({}, { maxFiles: 25000, maxTotalSizeBytes: 536870912, tokenLimit: 32000 }, (isRecord(snapRec['thresholds']) ? snapRec['thresholds'] as Record<string, unknown> : {})),
                    };
                    if (typeof snapRec['respectGitignore'] === 'boolean') { settings['respectGitignore'] = snapRec['respectGitignore']; }
                    if (typeof snapRec['outputFormat'] === 'string') { settings['outputFormat'] = snapRec['outputFormat']; }
                    if (typeof snapRec['tokenModel'] === 'string') { settings['tokenModel'] = snapRec['tokenModel']; }
                    if (typeof snapRec['binaryFilePolicy'] === 'string') { settings['binaryFilePolicy'] = snapRec['binaryFilePolicy']; }
                    if (isNumber(snapRec['maxFiles'])) { settings['maxFiles'] = snapRec['maxFiles'] as number; }
                    if (isNumber(snapRec['maxTotalSizeBytes'])) { settings['maxTotalSizeBytes'] = snapRec['maxTotalSizeBytes'] as number; }
                    if (isNumber(snapRec['tokenLimit'])) { settings['tokenLimit'] = snapRec['tokenLimit'] as number; }
                    if (typeof snapRec['showRedacted'] === 'boolean') { settings['showRedacted'] = snapRec['showRedacted']; }
                    if (Array.isArray(snapRec['redactionPatterns'])) { settings['redactionPatterns'] = snapRec['redactionPatterns']; }
                    settings['redactionPlaceholder'] = typeof snapRec['redactionPlaceholder'] === 'string' ? snapRec['redactionPlaceholder'] : '[REDACTED]';
                    webviewView.webview.postMessage({ type: WebviewCommands.config, folderPath: folder, settings });
                } catch (e) { /* ignore */ }
            }, () => {
                // on getState, send current preview
                try {
                    const preview = treeProvider.getPreviewData();
                    try { logger.debug('resolveWebviewView posting state (onGetState):', preview && typeof preview.totalFiles === 'number' ? { totalFiles: preview.totalFiles, selectedCount: preview.selectedCount } : preview); } catch (e) {}
                    const statePayload: StatePayload = { type: WebviewCommands.state, state: preview };
                    webviewView.webview.postMessage(statePayload);
                } catch (e) { /* ignore */ }
            }, context);
                // Listen for commands coming from the sidebar webview instance
                const sidebarMsgDisp = webviewView.webview.onDidReceiveMessage((msg: any) => {
                    try {
                        if (!msg) { return; }
                        const t = (msg && (msg.type || msg.actionType || msg.command)) ? (msg.type || msg.actionType || msg.command) : undefined;
                        if (!t) { return; }
                        try {
                            const refreshCmd = (WebviewCommands && (WebviewCommands as unknown) && (WebviewCommands as any).refreshTree) ? (WebviewCommands as any).refreshTree : 'refreshTree';
                            if (t === refreshCmd || t === 'refreshTree') { try { vscode.commands.executeCommand('codebaseDigest.refreshTree'); } catch (err) { try { diagnostics.warn('executeCommand refreshTree failed', err); } catch {} } }
                        } catch (e) { /* swallow */ }
                    } catch (e) { /* ignore */ }
                });
                webviewView.onDidDispose(() => { try { sidebarMsgDisp.dispose(); } catch (e) { /* ignore */ } });

            // Forward progress events to the sidebar webview with light throttling to avoid UI jank
            ((): void => {
                let lastSent = 0;
                let pending: ReturnType<typeof setTimeout> | null = null;
                let lastEvent: unknown = null;
                const ms = 200; // minimum interval between posts
                const send = (ev: unknown) => {
                    try {
                        const rawOp = (ev && typeof ev === 'object') ? (ev as Record<string, unknown>)['op'] : undefined;
                        const rawMode = (ev && typeof ev === 'object') ? (ev as Record<string, unknown>)['mode'] : undefined;
                        const evt = { op: typeof rawOp === 'string' ? rawOp : undefined, mode: typeof rawMode === 'string' ? rawMode : undefined };
                        const payload: ProgressEventPayload = { type: WebviewCommands.progress, event: evt };
                        webviewView.webview.postMessage(payload);
                    } catch (e) { try { logger.warn('codebasePanel: post progress failed', e); } catch {} }
                };
                const disposeProgress = onProgress((ev: unknown) => {
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
                        try { if (pending && typeof ((pending as unknown as { unref?: unknown }).unref) === 'function') { try { ((pending as unknown as { unref?: Function }).unref!()); } catch (e) {} } } catch (e) {}
                    }
                });
                // Ensure disposal when the view is closed
                webviewView.onDidDispose(() => {
                    try { disposeProgress(); } catch (e) { try { logger.warn('codebasePanel: disposeProgress failed', e); } catch {} }
                    if (pending) { clearTimeout(pending); pending = null; }
                });
            })();

            // send an immediate preview delta so chips populate quickly on reveal
                try {
                    const preview = treeProvider.getPreviewData();
                    try { logger.debug('resolveWebviewView posting immediate previewDelta:', preview && typeof preview.totalFiles === 'number' ? { totalFiles: preview.totalFiles, selectedCount: preview.selectedCount } : preview); } catch (e) {}
                    const delta: PreviewDeltaPayload['delta'] = {
                        selectedCount: typeof preview.selectedCount === 'number' ? preview.selectedCount : undefined,
                        totalFiles: typeof preview.totalFiles === 'number' ? preview.totalFiles : undefined,
                        selectedSize: typeof preview.selectedSize === 'number' ? preview.selectedSize : undefined,
                        tokenEstimate: typeof preview.tokenEstimate === 'number' ? preview.tokenEstimate : undefined,
                        contextLimit: typeof preview.contextLimit === 'number' ? preview.contextLimit : undefined,
                        fileTree: preview.fileTree,
                        selectedPaths: Array.isArray(preview.selectedPaths) ? (preview.selectedPaths as unknown[]).map((p: unknown) => String(p)) : []
                    };
                    const payload: PreviewDeltaPayload = { type: WebviewCommands.previewDelta, delta } as PreviewDeltaPayload;
                    webviewView.webview.postMessage(payload);
                } catch (e) { try { logger.warn('codebasePanel: post previewDelta failed', e); } catch {} }

            // Hook into treeProvider progress to post preview deltas when scans start/end
            const scanProgressDisp = onProgress((ev: unknown) => {
                try {
                    if (ev && typeof ev === 'object') {
                        const op = (ev as Record<string, unknown>)['op'];
                        const mode = (ev as Record<string, unknown>)['mode'];
                        if (op === 'scan' && mode === 'end') {
                            try {
                                const preview = treeProvider.getPreviewData();
                                const delta: PreviewDeltaPayload['delta'] = {
                                    selectedCount: typeof preview.selectedCount === 'number' ? preview.selectedCount : undefined,
                                    totalFiles: typeof preview.totalFiles === 'number' ? preview.totalFiles : undefined,
                                    selectedSize: typeof preview.selectedSize === 'number' ? preview.selectedSize : undefined,
                                    tokenEstimate: typeof preview.tokenEstimate === 'number' ? preview.tokenEstimate : undefined,
                                    contextLimit: typeof preview.contextLimit === 'number' ? preview.contextLimit : undefined,
                                    fileTree: preview.fileTree,
                                    selectedPaths: Array.isArray(preview.selectedPaths) ? (preview.selectedPaths as unknown[]).map((p: unknown) => String(p)) : []
                                };
                                const payload: PreviewDeltaPayload = { type: WebviewCommands.previewDelta, delta } as PreviewDeltaPayload;
                                webviewView.webview.postMessage(payload);
                            } catch (inner) { /* ignore */ }
                        }
                    }
                } catch (ex) { /* ignore */ }
            });

            // Provide periodic preview deltas. Keep a handle so we can clear it when the webview
            // is re-resolved/revealed to avoid duplicate intervals.
            let sidebarInterval: ReturnType<typeof setInterval> | undefined;
            const startSidebarInterval = () => {
                if (sidebarInterval) { try { clearInterval(sidebarInterval as unknown as ReturnType<typeof setInterval>); } catch {} sidebarInterval = undefined; }
                const __cbd_sidebar_interval = setInterval(() => {
                    try {
                        const preview = treeProvider.getPreviewData();
                        const delta: PreviewDeltaPayload['delta'] = {
                            selectedCount: typeof preview.selectedCount === 'number' ? preview.selectedCount : undefined,
                            totalFiles: typeof preview.totalFiles === 'number' ? preview.totalFiles : undefined,
                            selectedSize: typeof preview.selectedSize === 'number' ? preview.selectedSize : undefined,
                            tokenEstimate: typeof preview.tokenEstimate === 'number' ? preview.tokenEstimate : undefined,
                            contextLimit: typeof preview.contextLimit === 'number' ? preview.contextLimit : undefined,
                            fileTree: preview.fileTree,
                            selectedPaths: Array.isArray(preview.selectedPaths) ? (preview.selectedPaths as unknown[]).map((p: unknown) => String(p)) : []
                        };
                        const payload: PreviewDeltaPayload = { type: WebviewCommands.previewDelta, delta } as PreviewDeltaPayload;
                        webviewView.webview.postMessage(payload);
                    } catch (e) { /* ignore */ }
                }, 5000);
                try { if (__cbd_sidebar_interval && typeof ((__cbd_sidebar_interval as unknown as { unref?: unknown }).unref) === 'function') { try { ((__cbd_sidebar_interval as unknown as { unref?: Function }).unref!()); } catch (e) {} } } catch (e) {}
                sidebarInterval = __cbd_sidebar_interval as unknown as ReturnType<typeof setInterval>;
            };
            // Register disposal handler first so it is guaranteed to run if the view
            // is disposed very quickly after being resolved. This prevents the
            // interval from continuing when the dispose handler might not yet be
            // registered due to ordering.
            webviewView.onDidDispose(() => { try { if (sidebarInterval) { try { clearInterval(sidebarInterval as unknown as ReturnType<typeof setInterval>); } catch {} sidebarInterval = undefined; } } catch (e) {} });
            startSidebarInterval();
            webviewView.onDidDispose(() => { try { scanProgressDisp(); } catch (e) {} });
            webviewView.onDidDispose(() => { try { activeViews.delete(webviewView); } catch (e) {} });
        }
    };
    try {
        registeredDisposable = vscode.window.registerWebviewViewProvider('codebaseDigestDashboard', provider, { webviewOptions: { retainContextWhenHidden: true } });
        context.subscriptions.push(registeredDisposable);
    try { logger.info('webview view provider registered for codebaseDigestDashboard'); } catch (e) {}
    } catch (err) {
    try { logger.error('failed to register webview view provider', err); } catch (e) {}
        throw err;
    }
    // registration tracked via registeredDisposable
}

// Allow external callers to refresh active views with new settings (e.g., debugEnabled)
export function refreshActiveViews(folderPath?: string, payload?: { settings?: Record<string, unknown> }) {
    try {
        // Broadcast to panels
        for (const [key, panel] of panels.entries()) {
            try {
                const pub = panel as unknown as { folderPath?: string; panel?: { webview?: { postMessage?: (p: unknown) => void } } };
                const panelFolder = typeof pub.folderPath === 'string' ? pub.folderPath : key;
                if (!folderPath || panelFolder === folderPath || key === folderPath) {
                    const p = pub.panel;
                    if (p && p.webview && typeof p.webview.postMessage === 'function') {
                        try { p.webview.postMessage({ type: WebviewCommands.config, folderPath: panelFolder, settings: Object.assign({}, (payload && payload.settings) || {}) }); } catch (e) { /* ignore per-view errors */ }
                    }
                }
            } catch (e) { /* ignore */ }
        }
        // Broadcast to active sidebar views
        for (const [vw, vwFolder] of activeViews.entries()) {
            try {
                if (!folderPath || vwFolder === folderPath) {
                    vw.webview.postMessage({ type: WebviewCommands.config, folderPath: vwFolder, settings: Object.assign({}, (payload && payload.settings) || {}) });
                }
            } catch (e) { /* ignore */ }
        }
    } catch (e) { /* swallow */ }
}

// Broadcast generation result to open panels and sidebar views so webview can show toasts (e.g., redactionApplied)
export function broadcastGenerationResult(result: any, folderPath?: string) {
    // Determine the intended target folder for this generation result.
    // Preference order: explicit folderPath param, result.folderPath/result.workspacePath, else undefined.
    const inferred = folderPath || (result && (result.folderPath || result.workspacePath || result.workspaceFolder));
    // If we couldn't infer a folder and the workspace is multi-root, avoid broadcasting to all
    // to prevent toasts from appearing in unrelated workspace views. Callers should pass
    // an explicit folderPath when running in multi-root workspaces.
    const workspaceFolders = vscode.workspace.workspaceFolders || [];
    const ambiguousMultiRoot = !inferred && workspaceFolders.length > 1;
    if (ambiguousMultiRoot) {
        try { diagnostics.warn('broadcastGenerationResult skipped: ambiguous target folder in multi-root workspace; pass folderPath to broadcastGenerationResult'); } catch (e) {}
        return;
    }

    // Post to panels matching inferred folderPath (or all if none/in single-root workspace)
        for (const [key, panel] of panels.entries()) {
            try {
                type PanelPub = { folderPath?: string; panel?: { webview?: { postMessage?: (p: unknown) => void } } };
                const pub = panel as unknown as PanelPub;
                const panelFolder = typeof pub.folderPath === 'string' ? pub.folderPath : key;
                if (!inferred || panelFolder === inferred || key === inferred) {
                    try {
                        const p = pub.panel;
                            if (p && p.webview && typeof p.webview.postMessage === 'function') {
                            p.webview.postMessage({ type: WebviewCommands.generationResult, result });
                        }
                    } catch (e) { /* ignore */ }
                }
            } catch (e) { /* ignore */ }
        }
    // Post to active sidebar views (filter by inferred when provided)
    for (const [vw, vwFolder] of activeViews.entries()) {
        try {
                if (!inferred || vwFolder === inferred) {
                vw.webview.postMessage({ type: WebviewCommands.generationResult, result });
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
                    const pub = panel as unknown as { folderPath?: string; panel?: { webview?: { postMessage?: (p: unknown) => void } } };
                    const panelFolder = typeof pub.folderPath === 'string' ? pub.folderPath : key;
                    if (!folderPath || key === folderPath || panelFolder === folderPath) {
                        const p = pub.panel;
                            if (p && p.webview && typeof p.webview.postMessage === 'function') {
                            p.webview.postMessage({ type: WebviewCommands.previewDelta, delta });
                        }
                    }
                } catch (e) { /* ignore */ }
            }
        } catch (e) { /* ignore */ }
    try {
        // Post to active sidebar views, filtered by folderPath when provided
        for (const [vw, vwFolder] of activeViews.entries()) {
            try {
                    if (!folderPath || vwFolder === folderPath) {
                    vw.webview.postMessage({ type: WebviewCommands.previewDelta, delta });
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
