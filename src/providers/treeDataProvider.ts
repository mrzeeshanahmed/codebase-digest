import * as vscode from 'vscode';
import { FileNode } from '../types/interfaces';
import { FileScanner } from '../services/fileScanner';
import { FilterService } from '../services/filterService';
import { GitignoreService } from '../services/gitignoreService';
import { Diagnostics } from '../utils/diagnostics';
import { SelectionManager } from './selectionManager';
import { DirectoryCache } from './directoryCache';
import { computePreviewState } from './previewState';
import { ExpandState, MAX_EXPAND_DEPTH } from './expandState';
import { formatSize, formatTooltip, createTreeIcon, ContextValues } from './treeHelpers';
import { emitProgress } from './eventBus';
import { debounce } from '../utils/debounce';
import { getMutex } from '../utils/asyncLock';
import { minimatch } from 'minimatch';
import { ConfigurationService } from '../services/configurationService';

export class CodebaseDigestTreeProvider implements vscode.TreeDataProvider<FileNode>, vscode.Disposable {
    private expandState: ExpandState;
    // When filesystem events produce a very large number of pending hydrations,
    // avoid processing them all in a tight loop which can block the event loop
    // and lead to poor UI responsiveness. We make these tunable via workspace
    // settings so users and telemetry can refine them over time.
    private static readonly DEFAULT_MAX_PENDING_HYDRATIONS = 200;
    private static readonly DEFAULT_PENDING_BATCH_SIZE = 25;
    private static readonly DEFAULT_PENDING_BATCH_DELAY_MS = 25;

    /**
     * Expand all folders up to MAX_EXPAND_DEPTH
     */
    async expandAll(): Promise<void> {
        this.expandState.expandAll(this.rootNodes);
    }

    /**
     * Collapse all folders
     */
    async collapseAll(): Promise<void> {
        this.expandState.collapseAll();
    }
    private workspaceFolder: vscode.WorkspaceFolder;
    public statusBarItem?: vscode.StatusBarItem;
    private rootNodes: FileNode[] = [];
    private _onDidChangeTreeData: vscode.EventEmitter<FileNode | undefined> = new vscode.EventEmitter<FileNode | undefined>();
    readonly onDidChangeTreeData: vscode.Event<FileNode | undefined> = this._onDidChangeTreeData.event;
    private gitignoreService: GitignoreService;
    private fileScanner: FileScanner;
    private workspaceRoot: string = '';
    // Optional test-injected config (tests may set this directly)
    public config?: Partial<import('../types/interfaces').DigestConfig>;
    private selectedRelPaths: string[] = [];
    private previewUpdater?: () => void;
    private totalFiles: number = 0;
    private totalSize: number = 0;
    private lastScanStats?: import('../types/interfaces').TraversalStats;
    private directoryCache: DirectoryCache;
    private diagnostics: Diagnostics;
    private _watcher?: vscode.FileSystemWatcher | null;
    // Debounced refresh function to coalesce full workspace scans
    private debouncedRefresh?: () => void;
    private scanning: boolean = false;
    // Simple cancellation token for scan operations
    private scanToken: { isCancellationRequested?: boolean } | null = null;
    // Per-directory debounce timers to coalesce rapid FS events
    private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    // While a full workspace scan is in progress, coalesce directory hydration
    // requests here so many watcher events don't queue up many expensive scans.
    private pendingHydrations: Set<string> = new Set();
    private selectionManager: SelectionManager;
    // Optional metrics service injected via services bundle (opaque to provider)
    private metrics?: unknown;

    constructor(folder: vscode.WorkspaceFolder, services: { gitignoreService: GitignoreService; fileScanner: FileScanner; diagnostics?: Diagnostics; metrics?: unknown }) {
    this.workspaceFolder = folder;
    this.gitignoreService = services.gitignoreService;
    this.fileScanner = services.fileScanner;
    // Prefer an explicitly provided metrics service if present
    this.metrics = services && services.metrics ? services.metrics : undefined;
    this.workspaceRoot = folder.uri.fsPath;
    this.directoryCache = new DirectoryCache(this.fileScanner);
    this.selectionManager = new SelectionManager(() => this.rootNodes, this.selectedRelPaths, (n) => this._onDidChangeTreeData.fire(n), () => this.previewUpdater && this.previewUpdater());
    this.expandState = new ExpandState({ maxDepth: MAX_EXPAND_DEPTH, onDidChange: () => this._onDidChangeTreeData.fire(undefined), onPreviewUpdate: () => this.previewUpdater && this.previewUpdater() });

        // Register FileSystemWatcher for incremental updates (guard in tests where workspace may be mocked)
        const watcher = (vscode.workspace && typeof vscode.workspace.createFileSystemWatcher === 'function')
            ? vscode.workspace.createFileSystemWatcher('**/*')
            : null;
    // Store watcher on instance so it can be disposed later
    this._watcher = watcher;
    const path = require('path');
    this.diagnostics = services && services.diagnostics ? services.diagnostics : new Diagnostics('info');
        const handleChange = (uri: vscode.Uri) => {
            const dir = path.dirname(uri.fsPath);

            // Ignore events under heavy noise folders to reduce watcher churn
            // (node_modules and .git). If a gitignore service is available,
            // prefer its decision for more accurate filtering.
            try {
                const low = (dir || '').toLowerCase();
                if (low.includes(`${path.sep}node_modules${path.sep}`) || low.endsWith(`${path.sep}node_modules`) || low.includes(`${path.sep}.git${path.sep}`) || low.endsWith(`${path.sep}.git`)) {
                    return;
                }
                if (this.gitignoreService && typeof this.gitignoreService.isIgnored === 'function') {
                    try { if (this.gitignoreService.isIgnored(uri.fsPath)) { return; } } catch (e) { /* ignore gitignore failures */ }
                }
            } catch (e) { /* ignore filtering errors */ }

            // Debounce key is the directory path; coalesce rapid events for same dir
            const key = String(dir || this.workspaceRoot || 'root');
            const runNow = async () => {
                // If the dir equals workspace root, perform a full refresh
                        if (dir === this.workspaceRoot) {
                            // Respect any existing cancellation token: refresh will create a fresh token
                            try { await this.refresh(); } catch (e) { try { this.diagnostics && this.diagnostics.warn ? this.diagnostics.warn('refresh failed in watcher', e) : console.warn('refresh failed in watcher', e); } catch {} }
                            return;
                        }

                // If a full workspace scan is in progress, coalesce this hydration
                // request and process it after the scan completes to avoid queuing
                // many individual directory scans behind the workspace mutex.
                if (this.scanning) {
                    try { this.pendingHydrations.add(dir); } catch (e) { /* swallow */ }
                    return;
                }

                // Find parent node in tree
                let parentNode: FileNode | undefined;
                const findNode = (nodes: FileNode[]): FileNode | undefined => {
                    for (const node of nodes) {
                        if (node.path === dir && node.type === 'directory') {
                            return node;
                        }
                        if (node.children) {
                            const found = findNode(node.children);
                            if (found) {
                                return found;
                            }
                        }
                    }
                    return undefined;
                };
                parentNode = findNode(this.rootNodes);
                if (parentNode) {
                    const config = this.loadConfig();
                    // Acquire workspace mutex so directory-level scans do not overlap with
                    // full workspace scans (scanWorkspace) which also use the same mutex.
                    const m = getMutex(this.workspaceRoot || this.workspaceFolder.uri.fsPath);
                    const relRelease = await m.lock();
                    try {
                        // Do not reuse possibly-cancelled scan token for individual
                        // directory hydrations. Passing undefined ensures a fresh
                        // uncancelled run so the Loading... node won't get stuck.
                        parentNode.children = await this.fileScanner.scanDirectory(parentNode.path, config, undefined);
                        this.directoryCache.set(parentNode.path, parentNode.children);
                        this._onDidChangeTreeData.fire(parentNode);
                    } finally {
                        try { relRelease(); } catch (e) { /* swallow */ }
                    }
                }
            };

            // Clear existing timer and schedule a new one
            try {
                const prev = this.debounceTimers.get(key);
                if (prev) { try { clearTimeout(prev); } catch (e) { /* ignore timing clear errors */ } }
            } catch (e) { /* ignore timing clear errors */ }
            const t = setTimeout(async () => {
                try {
                    try { await runNow(); } catch (e) { try { this.diagnostics && this.diagnostics.warn ? this.diagnostics.warn('debounced runNow failed', e) : console.warn('debounced runNow failed', e); } catch {} }
                } catch (outerErr) {
                    // Catch any unexpected synchronous errors thrown while handling the debounce
                    try { this.diagnostics && this.diagnostics.warn ? this.diagnostics.warn('debounce handler failed', outerErr) : console.warn('debounce handler failed', outerErr); } catch {}
                } finally {
                    try { this.debounceTimers.delete(key); } catch (e) { /* swallow */ }
                }
            }, 250);
            this.debounceTimers.set(key, t as ReturnType<typeof setTimeout>);
        };
        // Create a small debounced refresh so rapid watcher storms don't trigger
        // many immediate full workspace scans. Use a short delay to remain
        // responsive but avoid thrashing the worker. Read delay from centralized service.
        try {
            const cfg = ConfigurationService.getWorkspaceConfig(this.workspaceFolder, this.diagnostics);
            const debounceMs = typeof (cfg as any).watcherDebounceMs === 'number' && (cfg as any).watcherDebounceMs >= 0 ? (cfg as any).watcherDebounceMs : 300;
            this.debouncedRefresh = debounce(() => {
                try { this.refresh(); } catch (e) { /* swallow */ }
            }, debounceMs);
        } catch (e) {
            this.debouncedRefresh = debounce(() => { try { this.refresh(); } catch (e) { /* swallow */ } }, 300);
        }

        if (watcher) {
            watcher.onDidCreate(handleChange);
            watcher.onDidDelete(handleChange);
            watcher.onDidChange(handleChange);
        }
        // Ensure the provider can be cleanly disposed by callers. Tests and extension activation
        // code may call dispose() when a workspace is removed. We implement a typed
        // dispose() method below on the class so the vscode.Disposable contract is satisfied.
    }

    // Local helper: extended FileNode that may include virtual metadata for UI-only nodes
    private static isVirtualFileNode(node: FileNode | unknown): node is FileNode & { virtualType?: string; childCount?: number; totalSize?: number } {
        if (typeof node !== 'object' || node === null) { return false; }
        const n = node as Record<string, unknown>;
        return typeof n.name === 'string' && (typeof n.virtualType === 'string' || typeof n.childCount === 'number' || typeof n.totalSize === 'number');
    }

    public dispose(): void {
        // Comprehensive cleanup to avoid leaks when provider is disposed
        try {
            // Iterate and clear any scheduled debounce timers
            try {
                for (const [key, timer] of this.debounceTimers.entries()) {
                    try {
                        if (timer) {
                            // clearTimeout accepts the timer id returned by setTimeout
                            try { clearTimeout(timer as unknown as ReturnType<typeof setTimeout>); } catch (_) { /* ignore timer clear errors */ }
                        }
                    } catch (_) { /* ignore per-timer errors */ }
                }
            } catch (_) { /* ignore iteration errors */ }
            try { this.debounceTimers.clear(); } catch (_) { /* ignore */ }
        } catch (e) { /* ignore */ }

        try { this.pendingHydrations.clear(); } catch (e) { /* ignore */ }

        // Dispose watcher (will also remove its event listeners)
        try {
            if (this._watcher && typeof (this._watcher.dispose) === 'function') {
                try { this._watcher.dispose(); } catch (e) { /* ignore */ }
            }
            this._watcher = undefined;
        } catch (e) { /* ignore */ }

        // Dispose the TreeData change emitter
        try {
            if (this._onDidChangeTreeData && typeof (this._onDidChangeTreeData.dispose) === 'function') {
                try { this._onDidChangeTreeData.dispose(); } catch (e) { /* ignore */ }
            }
        } catch (e) { /* ignore */ }

        // Dispose other disposables if present (status bar, expand/selection/directory/dx)
        try { if (this.statusBarItem && typeof (this.statusBarItem.dispose) === 'function') { this.statusBarItem.dispose(); } } catch (e) { /* ignore */ }
        const tryDispose = (o: unknown) => {
            try {
                if (o && typeof o === 'object') {
                    const rec = o as Record<string, unknown>;
                    const dd = rec['dispose'];
                    if (typeof dd === 'function') {
                        try { (dd as Function).call(o); } catch (_) { /* swallow dispose errors */ }
                    }
                }
            } catch (_) { /* swallow */ }
        };

        tryDispose(this.expandState);
        tryDispose(this.selectionManager);
        tryDispose(this.directoryCache);
        tryDispose(this.diagnostics);

        // Clear preview updater reference and any scan token to avoid holding closures
        try { this.previewUpdater = undefined; } catch (e) { /* ignore */ }
        try { this.scanToken = null; } catch (e) { /* ignore */ }
        try { this.debouncedRefresh = undefined; } catch (e) { /* ignore */ }

        try { emitProgress({ op: 'scan', mode: 'end', determinate: false, message: 'provider disposed' }); } catch (e) { /* ignore */ }
    }

    toggleSelection(node: FileNode): void { this.selectionManager.toggleSelection(node); }

    // Toggle expanded state for a specific relPath (used by webview keyboard interactions)
    public toggleExpand(relPath: string): void {
        if (!relPath) { return; }
        this.expandState.toggle(relPath);
        this._onDidChangeTreeData.fire(undefined);
    }

    getSelectedFiles(): FileNode[] { return this.selectionManager.getSelectedFiles(); }

    getPreviewData(): any {
        const selectedFiles = this.getSelectedFiles();
    const config = this.config || this.loadConfig();
        const preview = computePreviewState(this.rootNodes, selectedFiles, this.fileScanner, config);
        // Set totalFiles from lastScanStats.totalFiles, or recursively count file nodes if missing
        let totalFiles = this.lastScanStats?.totalFiles;
        if (typeof totalFiles !== 'number') {
            const countFiles = (nodes: FileNode[]): number => {
                let count = 0;
                for (const node of nodes) {
                    if (node.type === 'file') {
                        count++;
                    }
                    if (node.children) {
                        count += countFiles(node.children);
                    }
                }
                return count;
            };
            totalFiles = countFiles(this.rootNodes);
        }
    // Ensure preview reflects computed fallback when lastScanStats is missing
    if (typeof preview.totalFiles !== 'number') {
        preview.totalFiles = totalFiles;
    }
    return preview;
    }

    private formatSize(size: number): string {
        if (size < 1024) {
            return `${size} B`;
        }
        if (size < 1024 * 1024) {
            return `${(size / 1024).toFixed(1)} KB`;
        }
        if (size < 1024 * 1024 * 1024) {
            return `${(size / (1024 * 1024)).toFixed(1)} MB`;
        }
        return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    }

    clearSelection(): void {
        this.selectedRelPaths = [];
        const clearNode = (node: FileNode) => {
            node.isSelected = false;
            this.selectedRelPaths = this.selectedRelPaths.filter(rp => rp !== node.relPath);
            if (node.children) {
                for (const child of node.children) {
                    clearNode(child);
                }
            }
        };
        for (const node of this.rootNodes) {
            clearNode(node);
        }
        this._onDidChangeTreeData.fire(undefined);
        if (this.previewUpdater) {
            this.previewUpdater();
        }
    }

    setSelectionByRelPaths(relPaths: string[]): void {
        // Delegate selection setting to the centralized SelectionManager so there's
        // a single implementation for marking nodes and keeping selectedRelPaths
        // deterministic. SelectionManager will trigger onChange/preview updates.
        if (this.selectionManager && typeof this.selectionManager.setSelectionByRelPaths === 'function') {
            this.selectionManager.setSelectionByRelPaths(relPaths || []);
            return;
        }
        // Fallback: if SelectionManager isn't available (defensive), fall back to
        // the previous behavior to ensure callers still work.
        this.selectedRelPaths = [];
        const markSelection = (node: FileNode) => {
            node.isSelected = relPaths.includes(node.relPath);
            if (node.isSelected) {
                if (!this.selectedRelPaths.includes(node.relPath)) {
                    this.selectedRelPaths.push(node.relPath);
                }
            } else {
                this.selectedRelPaths = this.selectedRelPaths.filter(rp => rp !== node.relPath);
            }
            if (node.children) {
                for (const child of node.children) {
                    markSelection(child);
                }
            }
        };
        for (const node of this.rootNodes) {
            markSelection(node);
        }
        this._onDidChangeTreeData.fire(undefined);
        if (this.previewUpdater) {
            this.previewUpdater();
        }
    }

    /**
     * Select all files that belong to a top-level virtual group by name.
     */
    public selectGroupByName(groupName: string): void {
        if (!groupName) { return; }
        // Find the virtual group node at top-level
    const group = this.rootNodes.find(r => CodebaseDigestTreeProvider.isVirtualFileNode(r) && r.virtualType === 'virtualGroup' && r.name === groupName);
        if (!group || !group.children) { return; }
        const rels: string[] = [];
        const collect = (n: FileNode) => {
            if (n.type === 'file') { rels.push(n.relPath); }
            if (n.children) { for (const c of n.children) { collect(c); } }
        };
        for (const c of group.children) { collect(c); }
        // Apply selection
        this.setSelectionByRelPaths(rels);
    }

    setPreviewUpdater(fn: () => void): void {
        this.previewUpdater = fn;
    }

    updateCounts(): void {
        const preview = this.getPreviewData();
        let title = `Selected: ${preview.selectedCount} / ${preview.totalFiles} | Size: ${this.formatSize(preview.selectedSize)} | ~Tokens: ${preview.tokenEstimate}`;
        let warning = '';
        if (preview.contextLimit > 0 && preview.tokenEstimate > preview.contextLimit) {
            warning = `⚠️ Over context limit (${preview.contextLimit})`;
            title += ` | ${warning}`;
        }
        if (this.statusBarItem) {
            this.statusBarItem.text = title;
            this.statusBarItem.show();
        }
    }

    refresh(): void {
        // Set scanning true, wrap scanWorkspace in withProgress
        this.scanning = true;
        // Emit indeterminate start
        emitProgress({ op: 'scan', mode: 'start', determinate: false, message: 'Scanning workspace...' });
        vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Scanning workspace...' }, async () => {
            // Create a fresh token for this scan
            this.scanToken = { isCancellationRequested: false };
            try {
                await this.scanWorkspace(this.scanToken);
            } finally {
                // Clear the token regardless of scan success so subsequent hydrations
                // do not accidentally reuse a stale token. We'll process any
                // coalesced hydration requests after the scan below.
                this.scanToken = null;
            }

            // Process any directory hydration requests that were coalesced while the
            // full workspace scan was running. We handle these sequentially using
            // the workspace mutex to avoid races with other scans.
            if (this.pendingHydrations.size > 0) {
                // Snapshot and clear early so incoming watcher events are captured separately
                const allPending = Array.from(this.pendingHydrations);
                this.pendingHydrations.clear();
                const backlog = allPending.length;
                const config = this.loadConfig();

                // Allow tuning via workspace settings. If settings are not present,
                // fall back to reasonable defaults defined above.
                const wsCfg = ConfigurationService.getWorkspaceConfig(this.workspaceFolder, this.diagnostics);
                const maxPending = typeof (wsCfg as any).maxPendingHydrations === 'number' ? (wsCfg as any).maxPendingHydrations : CodebaseDigestTreeProvider.DEFAULT_MAX_PENDING_HYDRATIONS;
                const batchSize = typeof (wsCfg as any).pendingHydrationBatchSize === 'number' ? (wsCfg as any).pendingHydrationBatchSize : CodebaseDigestTreeProvider.DEFAULT_PENDING_BATCH_SIZE;
                const batchDelay = typeof (wsCfg as any).pendingHydrationBatchDelayMs === 'number' ? (wsCfg as any).pendingHydrationBatchDelayMs : CodebaseDigestTreeProvider.DEFAULT_PENDING_BATCH_DELAY_MS;

                // Lightweight telemetry hook: prefer an explicitly injected metrics service, otherwise fall back to Diagnostics logging.
                let metricsSvc: unknown = this.metrics;
                try {
                    if (!metricsSvc) {
                        // Narrow `this` only to the small shape we need: an optional
                        // `services` container. Keep checks defensive so behavior is unchanged.
                        const selfRec = this as unknown as { services?: unknown };
                        if (selfRec.services && typeof selfRec.services === 'object') {
                            const svcRec = selfRec.services as Record<string, unknown>;
                            metricsSvc = svcRec['metrics'];
                        }
                    }
                } catch (e) { /* swallow */ }
                const logTelemetry = (payload: Record<string, unknown>) => {
                    try {
                        // Enrich payload with workspace-level snapshot if available
                        try {
                            const ws = (payload.workspace && typeof payload.workspace === 'object') ? payload.workspace as Record<string, unknown> : {};
                            ws.path = this.workspaceRoot;
                            ws.totalFiles = this.totalFiles || (this.lastScanStats && this.lastScanStats.totalFiles) || 0;
                            ws.totalSize = this.totalSize || (this.lastScanStats && this.lastScanStats.totalSize) || 0;
                            payload.workspace = ws;
                            payload.provider = payload.provider || { pendingHydrationsCount: backlog, rootNodes: (this.rootNodes && this.rootNodes.length) || 0 };
                        } catch (e) { /* swallow enrichment errors */ }

                        if (metricsSvc) {
                            // Prefer a small explicit shape for the metrics API we call.
                            const mrec = metricsSvc as { inc?: (k: string, v?: number) => void; log?: (...args: unknown[]) => void } | undefined;
                            if (mrec && typeof mrec.inc === 'function') {
                                try { mrec.inc('pendingHydrationsEvents', 1); } catch (e) { /* ignore */ }
                            }
                            if (mrec && typeof mrec.log === 'function') {
                                try { mrec.log(); } catch (_) { /* ignore */ }
                            }
                        }

                        // Also write structured debug to Diagnostics for easier local inspection
                        try { this.diagnostics && this.diagnostics.debug ? this.diagnostics.debug('pendingHydrations.telemetry', payload) : console.debug('pendingHydrations.telemetry', payload); } catch (e) { /* swallow */ }
                    } catch (e) { /* swallow */ }
                };

                // If backlog is huge, prefer scheduling a full refresh rather than
                // iterating an enormous list of per-directory hydrations which can
                // be far slower than a single optimized workspace scan.
                if (backlog > maxPending) {
                    try {
                        // Emit telemetry with backlog size and chosen threshold
                        logTelemetry({ event: 'backlog_too_large', backlog, maxPending, batchSize, batchDelay, ts: Date.now() });
                        // Schedule a deferred full refresh to allow the UI to breathe
                        // and to let further watcher events be coalesced into the next scan.
                        setTimeout(() => {
                            try { if (this.debouncedRefresh) { this.debouncedRefresh(); } } catch (e) { /* swallow */ }
                        }, 50);
                        try { this.diagnostics && this.diagnostics.warn ? this.diagnostics.warn(`pendingHydrations backlog too large (${backlog}), scheduling full refresh (maxPending=${maxPending})`) : console.warn(`pendingHydrations backlog too large (${backlog}), scheduling full refresh (maxPending=${maxPending})`); } catch {}
                    } catch (e) { /* swallow scheduling errors */ }
                } else {
                    // Process in small batches to avoid blocking the event loop for too long
                    let idx = 0;
                    const startMs = Date.now();
                    while (idx < allPending.length) {
                        const batch = allPending.slice(idx, idx + batchSize);
                        // Process the batch in parallel-ish but still serialized with the workspace mutex
                        for (const dirPath of batch) {
                            try {
                                // Find parent node in the freshly-scanned tree
                                const findNode = (nodes: FileNode[]): FileNode | undefined => {
                                    for (const node of nodes) {
                                        if (node.path === dirPath && node.type === 'directory') { return node; }
                                        if (node.children) { const f = findNode(node.children); if (f) { return f; } }
                                    }
                                    return undefined;
                                };
                                const parentNode = findNode(this.rootNodes);
                                if (!parentNode) { continue; }
                                const m = getMutex(this.workspaceRoot || this.workspaceFolder.uri.fsPath);
                                const relRelease = await m.lock();
                                try {
                                    const children = await this.fileScanner.scanDirectory(parentNode.path, config, undefined);
                                    parentNode.children = children;
                                    this.directoryCache.set(parentNode.path, children);
                                    this._onDidChangeTreeData.fire(parentNode);
                                } finally {
                                    try { relRelease(); } catch (e) { /* swallow */ }
                                }
                            } catch (e) {
                                try { this.diagnostics && this.diagnostics.warn ? this.diagnostics.warn('pending hydration failed', e) : console.warn('pending hydration failed', e); } catch {}
                            }
                        }
                        idx += batchSize;
                        // yield to the event loop briefly between batches
                        if (idx < allPending.length) {
                            await new Promise(res => setTimeout(res, batchDelay));
                        }
                    }
                    const elapsed = Date.now() - startMs;
                    try { logTelemetry({ event: 'backlog_processed', backlog, batchSize, batchDelay, elapsed, ts: Date.now() }); } catch (e) { /* swallow */ }
                }
            }
            this.scanning = false;
            this._onDidChangeTreeData.fire(undefined);
            if (this.previewUpdater) {
                this.previewUpdater();
            }
            // End progress
            emitProgress({ op: 'scan', mode: 'end', determinate: false, message: 'Scan complete' });
        });
    }

    /**
     * Scan the workspace folder and update rootNodes
     */
    async scanWorkspace(token?: { isCancellationRequested?: boolean }): Promise<void> {
        const rootPath = this.workspaceFolder.uri.fsPath;
        this.workspaceRoot = rootPath;
        const config = this.loadConfig();
        // Serialize workspace scans to avoid overlapping scan operations which
        // previously led to race conditions when refresh() or watcher events
        // triggered multiple scans concurrently.
        const mutex = getMutex(rootPath);
        const release = await mutex.lock();
        try {
            this.rootNodes = await this.fileScanner.scanRoot(rootPath, config, token);
            // Apply any configured virtual folder mappings so UI presents synthetic top-level groups
            this.applyVirtualFoldersIfConfigured();
            // Optionally update stats
            this.lastScanStats = this.fileScanner.lastStats;
            // Update counts for status bar
            this.totalFiles = this.lastScanStats?.totalFiles || 0;
            this.totalSize = this.lastScanStats?.totalSize || 0;
            // Reapply isSelected flags by marking nodes whose relPath is in selectedRelPaths
            if (this.selectedRelPaths && this.selectedRelPaths.length > 0) {
                const markSelection = (node: FileNode) => {
                    node.isSelected = this.selectedRelPaths.includes(node.relPath);
                    if (node.children) {
                        for (const child of node.children) {
                            markSelection(child);
                        }
                    }
                };
                for (const node of this.rootNodes) {
                    markSelection(node);
                }
            }
            // Update counts/status and invoke previewUpdater
            this.updateCounts();
            if (this.previewUpdater) {
                this.previewUpdater();
            }
        } catch (err) {
            this.rootNodes = [];
        } finally {
            // Always release the mutex so other queued operations can proceed
            try { release(); } catch (e) { }
        }
    }

    /**
     * Apply virtual folder grouping based on workspace setting `codebaseDigest.virtualFolders`.
     * This will remove matched file nodes from their original places and create synthetic
     * top-level folder nodes containing those file nodes so they render as first-level groups.
     */
    private applyVirtualFoldersIfConfigured() {
        const cfg = this.loadConfig();
        const vfs: Record<string, string[]> = cfg.virtualFolders || {};
        if (!vfs || Object.keys(vfs).length === 0) { return; }

    // use named minimatch import

        const extractNodeByRelPath = (nodes: FileNode[], relPath: string): FileNode | null => {
            for (let i = 0; i < nodes.length; i++) {
                const node = nodes[i];
                if (node.relPath === relPath) {
                    nodes.splice(i, 1);
                    return node;
                }
                if (node.children && node.children.length > 0) {
                    const found = extractNodeByRelPath(node.children, relPath);
                    if (found) {
                        // If a directory becomes empty, leave it (UI will show empty dir) — safer than aggressive pruning
                        return found;
                    }
                }
            }
            return null;
        };

        const traverseCollectFiles = (nodes: FileNode[], out: FileNode[]) => {
            for (const n of nodes) {
                if (n.type === 'file') { out.push(n); }
                if (n.children) { traverseCollectFiles(n.children, out); }
            }
        };

        // For each virtual group, find matching files and extract them from tree
        const groups: FileNode[] = [];
        const allFiles: FileNode[] = [];
        traverseCollectFiles(this.rootNodes, allFiles);

        const alreadyTaken = new Set<string>();
        for (const [groupName, patterns] of Object.entries(vfs)) {
            const children: FileNode[] = [];
            for (const pattern of patterns || []) {
                for (const f of allFiles) {
                    if (alreadyTaken.has(f.relPath)) { continue; }
                    let matched = false;
                    // If pattern ends with a slash, treat as prefix
                    if (pattern.endsWith('/')) {
                        matched = f.relPath.startsWith(pattern);
                    } else {
                        try {
                            matched = minimatch(f.relPath, pattern, { dot: true });
                        } catch (e) {
                            // on bad pattern, fallback to prefix
                            matched = f.relPath.startsWith(pattern);
                        }
                    }
                    if (matched) {
                        const extracted = extractNodeByRelPath(this.rootNodes, f.relPath);
                        if (extracted) {
                                // Normalize depth for top-level group children and their descendants
                                const normalizeDepth = (node: FileNode, baseDepth: number) => {
                                    node.depth = baseDepth;
                                    if (node.children && node.children.length > 0) {
                                        for (const c of node.children) {
                                            normalizeDepth(c, baseDepth + 1);
                                        }
                                    }
                                };
                                normalizeDepth(extracted, 1);
                                children.push(extracted);
                                alreadyTaken.add(f.relPath);
                            }
                    }
                }
            }
            if (children.length > 0) {
                // compute metadata
                const childCount = children.length;
                const totalSize = children.reduce((s, c) => s + (c.size || 0), 0);
                const groupNode: FileNode & { virtualType: 'virtualGroup'; childCount: number; totalSize: number } = {
                    type: 'directory',
                    name: groupName,
                    relPath: `virtual:${groupName}`,
                    path: '',
                    isSelected: false,
                    depth: 0,
                    children,
                    // mark as virtual for easier detection
                    virtualType: 'virtualGroup',
                    // attach metadata
                    childCount,
                    totalSize
                };
                groups.push(groupNode);
            }
        }

        if (groups.length > 0) {
            // Prepend virtual groups so they appear first-level
            this.rootNodes = [...groups, ...this.rootNodes];
            // Remove any selected relPaths that were extracted into virtual groups
            // to avoid duplicate/stale selections after grouping. Use the alreadyTaken set
            // which contains relPaths moved into virtual groups.
            try {
                if (this.selectedRelPaths && this.selectedRelPaths.length > 0) {
                    const taken = alreadyTaken;
                    this.selectedRelPaths = this.selectedRelPaths.filter(rp => !taken.has(rp));
                }
            } catch (e) { /* defensive: ignore selection pruning errors */ }
        }
    }

    selectAll(): void {
        this.selectedRelPaths = [];
        const selectNode = (node: FileNode) => {
            node.isSelected = true;
            if (node.type === 'file') {
                if (!this.selectedRelPaths.includes(node.relPath)) {
                    this.selectedRelPaths.push(node.relPath);
                }
            }
            if (node.children) {
                for (const child of node.children) {
                    selectNode(child);
                }
            }
        };
        for (const node of this.rootNodes) {
            selectNode(node);
        }
        this._onDidChangeTreeData.fire(undefined);
        if (this.previewUpdater) {
            this.previewUpdater();
        }
    }

    updateViewTitle(): void {
        if (this.previewUpdater) {
            this.previewUpdater();
        }
    }

    public loadConfig(): any {
        try {
            const cfg = ConfigurationService.getWorkspaceConfig(this.workspaceFolder, this.diagnostics);
            return cfg;
        } catch (e) {
            // Fall back to a small defensive default object to avoid throwing during scans
            return {
                maxFileSize: 1024 * 1024,
                maxFiles: 1000,
                maxTotalSizeBytes: 100 * 1024 * 1024,
                maxDirectoryDepth: 20,
                excludePatterns: [],
                includePatterns: [],
                respectGitignore: true,
                gitignoreFiles: [],
                outputFormat: 'text',
                includeMetadata: true,
                includeTree: true,
                includeSummary: true,
                includeFileContents: false,
                useStreamingRead: false,
                binaryFilePolicy: 'skip',
                notebookProcess: false,
                notebookIncludeNonTextOutputs: false,
                tokenEstimate: false,
                tokenModel: 'chars-approx',
                performanceLogLevel: 'info',
                performanceCollectMetrics: false,
                outputSeparatorsHeader: '',
                outputWriteLocation: 'editor',
                includeTreeMode: 'full'
            };
        }
    }

    async getChildren(element?: FileNode): Promise<FileNode[]> {
        if (!element) {
            if (this.scanning) {
                return [
                    {
                        type: 'file',
                        name: 'Scanning...',
                        relPath: '__scanning__',
                        path: '',
                        isSelected: false,
                        depth: 0,
                        children: [],
                        virtualType: 'scanning'
                    } as FileNode & { virtualType: 'scanning' }
                ];
            }
            if (!this.rootNodes || this.rootNodes.length === 0) {
                // Provide a helpful welcome state with actionable entries so users can
                // open the dashboard, generate a digest, ingest a remote repo, clear cache or open settings.
                return [
                    {
                        type: 'file',
                        name: 'Welcome to Code Ingest',
                        relPath: '__welcome__',
                        path: '',
                        isSelected: false,
                        depth: 0,
                        children: [],
                        virtualType: 'welcome'
                    } as FileNode & { virtualType: 'welcome' },
                    {
                        type: 'file',
                        name: 'Open Dashboard',
                        relPath: '__welcome__:openDashboard',
                        path: '',
                        isSelected: false,
                        depth: 0,
                        children: [],
                        virtualType: 'welcomeAction',
                        action: 'openDashboard'
                    } as FileNode & { virtualType: 'welcomeAction'; action?: string },
                    {
                        type: 'file',
                        name: 'Generate Digest',
                        relPath: '__welcome__:generate',
                        path: '',
                        isSelected: false,
                        depth: 0,
                        children: [],
                        virtualType: 'welcomeAction',
                        action: 'generate'
                    } as FileNode & { virtualType: 'welcomeAction'; action?: string },
                    {
                        type: 'file',
                        name: 'Ingest Remote Repo',
                        relPath: '__welcome__:ingest',
                        path: '',
                        isSelected: false,
                        depth: 0,
                        children: [],
                        virtualType: 'welcomeAction',
                        action: 'ingest'
                    } as FileNode & { virtualType: 'welcomeAction'; action?: string },
                    {
                        type: 'file',
                        name: 'Clear Digest Cache',
                        relPath: '__welcome__:clearCache',
                        path: '',
                        isSelected: false,
                        depth: 0,
                        children: [],
                        virtualType: 'welcomeAction',
                        action: 'clearCache'
                    } as FileNode & { virtualType: 'welcomeAction'; action?: string },
                    {
                        type: 'file',
                        name: 'Settings',
                        relPath: '__welcome__:settings',
                        path: '',
                        isSelected: false,
                        depth: 0,
                        children: [],
                        virtualType: 'welcomeAction',
                        action: 'settings'
                    } as FileNode & { virtualType: 'welcomeAction'; action?: string }
                ];
            }
            return this.rootNodes;
        }
        if (element.type === 'directory') {
            // If caller requested children for a special 'Load more...' virtual node,
            // perform the next-page fetch and return an empty list (the parent will be refreshed).
            if (CodebaseDigestTreeProvider.isVirtualFileNode(element) && element.virtualType === 'loadMore') {
                // element carries metadata: parentPath, nextIndex, pageSize
                const meta = element as unknown as { parentPath?: unknown; nextIndex?: unknown; pageSize?: unknown };
                const parentPath = typeof meta.parentPath === 'string' ? String(meta.parentPath) : undefined;
                const nextIndex = typeof meta.nextIndex === 'number' ? meta.nextIndex as number : 0;
                const pageSize = typeof meta.pageSize === 'number' ? meta.pageSize as number : 200;
                if (parentPath) {
                    (async () => {
                        const m = getMutex(this.workspaceRoot || this.workspaceFolder.uri.fsPath);
                        const rel = await m.lock();
                        try {
                            const cfg = this.loadConfig();
                            const res = await this.fileScanner.scanDirectoryShallow(parentPath, cfg, undefined, nextIndex, pageSize);
                            // Find parent node and insert items before the loadMore node
                            const findNode = (nodes: FileNode[]): FileNode | undefined => {
                                for (const node of nodes) {
                                    if (node.path === parentPath && node.type === 'directory') { return node; }
                                    if (node.children) { const f = findNode(node.children); if (f) { return f; } }
                                }
                                return undefined;
                            };
                            const parentNode = findNode(this.rootNodes);
                            if (parentNode && parentNode.children) {
                                // locate the loadMore index
                                const lmIndex = parentNode.children.findIndex(c => CodebaseDigestTreeProvider.isVirtualFileNode(c) && (c as any).virtualType === 'loadMore');
                                const insertAt = lmIndex >= 0 ? lmIndex : parentNode.children.length;
                                const newChildren = res.items;
                                // normalize depth based on parent
                                for (const nc of newChildren) { nc.depth = parentNode.depth + 1; }
                                parentNode.children.splice(insertAt, 0, ...newChildren);
                                // update or remove loadMore node
                                const remaining = res.total - (nextIndex + newChildren.length);
                                if (remaining > 0) {
                                    const newNext = nextIndex + newChildren.length;
                                    const lm = parentNode.children.find(c => CodebaseDigestTreeProvider.isVirtualFileNode(c) && (c as any).virtualType === 'loadMore');
                                    if (lm) { (lm as any).nextIndex = newNext; (lm as any).pageSize = pageSize; }
                                } else {
                                    const lmPos = parentNode.children.findIndex(c => CodebaseDigestTreeProvider.isVirtualFileNode(c) && (c as any).virtualType === 'loadMore');
                                    if (lmPos >= 0) { parentNode.children.splice(lmPos, 1); }
                                }
                                this.directoryCache.set(parentNode.path, parentNode.children);
                                this._onDidChangeTreeData.fire(parentNode);
                            }
                        } catch (e) {
                            try { this.diagnostics && this.diagnostics.warn ? this.diagnostics.warn('load more failed', e) : console.warn('load more failed', e); } catch {}
                        } finally { try { rel(); } catch {} }
                    })();
                }
                return [];
            }

            // Hydrate directory if children are missing or placeholder
            if (!element.children || element.children.length === 0 || (element.children.length === 1 && element.children[0].name === 'Loading...')) {
                // Show loading node immediately
                const loadingNode: FileNode = {
                    type: 'file',
                    name: 'Loading...',
                    relPath: element.relPath + '/__loading__',
                    path: '',
                    isSelected: false,
                    depth: element.depth + 1
                };
                // Start async scan
                const config = this.loadConfig();
                // Hydration of a directory can be long-running; serialize per-workspace
                // so multiple hydrations or full scans don't race. Use the workspace mutex
                // but make hydration non-blocking for the caller (we await acquisition
                // inside the background task).
                (async () => {
                    const m = getMutex(this.workspaceRoot || this.workspaceFolder.uri.fsPath);
                    const relRelease = await m.lock();
                    try {
                        // Use shallow one-level scan with pagination for responsiveness
                        const pageSize = Math.max(1, (config && typeof (config as any).directoryPageSize === 'number') ? (config as any).directoryPageSize : 200);
                        const res = await this.fileScanner.scanDirectoryShallow(element.path, config, this.scanToken || undefined, 0, pageSize);
                        const children = res.items;
                        // if there are more items than pageSize, append a virtual Load more node
                        if (res.total > children.length) {
                            const loadMore: FileNode & { virtualType: 'loadMore'; parentPath?: string; nextIndex?: number; pageSize?: number } = {
                                type: 'file',
                                name: 'Load more...',
                                relPath: element.relPath + '/__loadmore__',
                                path: '',
                                isSelected: false,
                                depth: element.depth + 1,
                                virtualType: 'loadMore',
                                parentPath: element.path,
                                nextIndex: children.length,
                                pageSize
                            } as any;
                            children.push(loadMore as FileNode);
                        }
                        // set depths
                        for (const c of children) { c.depth = element.depth + 1; }
                        element.children = children;
                        this.directoryCache.set(element.path, children);
                        this._onDidChangeTreeData.fire(element);
                    } catch (e) {
                        try { this.diagnostics && this.diagnostics.warn ? this.diagnostics.warn('scanDirectory failed', e) : console.warn('scanDirectory failed', e); } catch {}
                    } finally {
                        try { relRelease(); } catch (e) { }
                    }
                })();
                return [loadingNode];
            }
            if (this.directoryCache.has(element.path)) {
                return this.directoryCache.get(element.path)!;
            }
            return element.children;
        }
        return [];
    }

    getTreeItem(element: FileNode): vscode.TreeItem {
        // Use expandedRelPaths to set collapsible state
            if ((CodebaseDigestTreeProvider.isVirtualFileNode(element) && element.virtualType === 'welcome') || element.relPath === '__welcome__') {
            const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
            item.description = 'Generate a digest of your codebase for LLMs. Choose an action below:';
            item.tooltip = 'Welcome to Code Ingest';
            item.iconPath = new vscode.ThemeIcon('rocket');
            item.contextValue = ContextValues.welcome;
            // Clicking the welcome node focuses the sidebar dashboard view
            // Pass the WorkspaceFolder Uri object (not a string) so command
            // handlers can unambiguously scope the action to this provider's folder
            const welcomeCmd: vscode.Command = {
                command: 'codebaseDigest.focusView',
                title: 'Focus Code Ingest',
                arguments: [this.workspaceFolder.uri]
            };
            item.command = welcomeCmd;
            return item;
        }
        // Special-case welcome action rows which are shown below the main welcome node
    if (CodebaseDigestTreeProvider.isVirtualFileNode(element) && element.virtualType === 'welcomeAction') {
        // Narrow the element to the minimal shape we expect for welcome actions.
        const elRec = element as unknown as { action?: unknown };
        const act = (typeof elRec.action === 'string') ? elRec.action : '';
            const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
            // Map icons per action for better UX
            const iconMap: Record<string, string> = {
                openDashboard: 'rocket',
                generate: 'play',
                ingest: 'cloud',
                clearCache: 'trash',
                settings: 'gear'
            };
            const icon = iconMap[act] || 'gear';
            item.iconPath = new vscode.ThemeIcon(icon);
            item.contextValue = ContextValues.file;
            // Map friendly action names to extension command IDs
            const cmdMap: Record<string, string> = {
                openDashboard: 'codebaseDigest.openDashboard',
                generate: 'codebaseDigest.generateDigest',
                ingest: 'codebaseDigest.ingestRemoteRepo',
                clearCache: 'codebaseDigest.invalidateCache',
                settings: 'codebaseDigest.openSettings'
            };
            const cmd = cmdMap[act] || 'codebaseDigest.openDashboard';
            // Use Uri so handlers have full workspaceFolder context (multi-root safe)
            const actionCmd: vscode.Command = {
                command: cmd,
                title: element.name,
                arguments: [this.workspaceFolder.uri]
            };
            item.command = actionCmd;
            return item;
        }
    if ((CodebaseDigestTreeProvider.isVirtualFileNode(element) && element.virtualType === 'scanning') || element.relPath === '__scanning__') {
            const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
            item.description = 'Scanning your workspace for files...';
            item.tooltip = 'Scanning in progress';
            item.iconPath = new vscode.ThemeIcon('sync');
            item.contextValue = ContextValues.scanning;
            return item;
        }
        let collapsibleState = vscode.TreeItemCollapsibleState.None;
        if (element.type === 'directory') {
            collapsibleState = this.expandState.isExpanded(element.relPath)
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.Collapsed;
        }
        const treeItem = new vscode.TreeItem(
            element.name,
            collapsibleState
        );
        // If virtual group, show metadata in description
    if (CodebaseDigestTreeProvider.isVirtualFileNode(element) && element.virtualType === 'virtualGroup') {
        const el = element as unknown as { childCount?: unknown; totalSize?: unknown };
        const count = typeof el.childCount === 'number' ? el.childCount as number : 0;
        const size = this.formatSize(typeof el.totalSize === 'number' ? el.totalSize as number : 0);
            treeItem.description = `${count} files · ${size}`;
            treeItem.contextValue = 'virtualGroup';
        }
        treeItem.resourceUri = vscode.Uri.file(element.path);
    treeItem.contextValue = element.type;
    treeItem.iconPath = createTreeIcon(element);
    treeItem.tooltip = formatTooltip(element);
        treeItem.command = {
            command: 'codebaseDigest.toggleSelection',
            title: 'Toggle Selection',
            arguments: [element]
        };
        return treeItem;
    }

    /**
     * Expose expand/collapse for command wiring
     */
    public handleExpandAll() { this.expandAll(); }
    public handleCollapseAll() { this.collapseAll(); }

    // Pause an ongoing scan by setting cancellation flag. Resume will recreate a token on next refresh.
    public pauseScan(): void {
        if (this.scanToken) {
            this.scanToken.isCancellationRequested = true;
            try { emitProgress({ op: 'scan', mode: 'end', determinate: false, message: 'Scan paused' }); } catch (e) { }
        }
    }

    // Resume scanning: cancel any current token if set and trigger a fresh refresh.
    // We intentionally do not emit a separate "Resuming" progress event here because
    // refresh() will emit the scan start/end progress events. Emitting both led to
    // duplicate progress messages being shown in the webview.
    public resumeScan(): void {
        try {
            if (this.scanToken) {
                // ensure previous scan is signaled to cancel; refresh will create a new token
                this.scanToken.isCancellationRequested = true;
            }
        } catch (e) { /* swallow */ }
        // Start a fresh scan which will emit its own progress events
        try { this.refresh(); } catch (e) { /* swallow */ }
    }
}