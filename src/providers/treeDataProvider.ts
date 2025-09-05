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
import { getMutex } from '../utils/asyncLock';
import { minimatch } from 'minimatch';

export class CodebaseDigestTreeProvider implements vscode.TreeDataProvider<FileNode> {
    private expandState: ExpandState;

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
    public config?: any;
    private selectedRelPaths: string[] = [];
    private previewUpdater?: () => void;
    private totalFiles: number = 0;
    private totalSize: number = 0;
    private lastScanStats: any;
    private directoryCache: DirectoryCache;
    private scanning: boolean = false;
    // Simple cancellation token for scan operations
    private scanToken: { isCancellationRequested?: boolean } | null = null;
    // Per-directory debounce timers to coalesce rapid FS events
    private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private selectionManager: SelectionManager;

    constructor(folder: vscode.WorkspaceFolder, services: any) {
    this.workspaceFolder = folder;
    this.gitignoreService = services.gitignoreService;
    this.fileScanner = services.fileScanner;
    this.workspaceRoot = folder.uri.fsPath;
    this.directoryCache = new DirectoryCache(this.fileScanner);
    this.selectionManager = new SelectionManager(() => this.rootNodes, this.selectedRelPaths, (n) => this._onDidChangeTreeData.fire(n), () => this.previewUpdater && this.previewUpdater());
    this.expandState = new ExpandState({ maxDepth: MAX_EXPAND_DEPTH, onDidChange: () => this._onDidChangeTreeData.fire(undefined), onPreviewUpdate: () => this.previewUpdater && this.previewUpdater() });

        // Register FileSystemWatcher for incremental updates (guard in tests where workspace may be mocked)
        const watcher = (vscode.workspace && typeof (vscode.workspace as any).createFileSystemWatcher === 'function')
            ? (vscode.workspace as any).createFileSystemWatcher('**/*')
            : null;
        const path = require('path');
        const handleChange = (uri: vscode.Uri) => {
            const dir = path.dirname(uri.fsPath);

            // Debounce key is the directory path; coalesce rapid events for same dir
            const key = String(dir || this.workspaceRoot || 'root');
            const runNow = async () => {
                // If the dir equals workspace root, perform a full refresh
                if (dir === this.workspaceRoot) {
                    // Respect any existing cancellation token: refresh will create a fresh token
                    try { this.refresh(); } catch (e) { /* swallow */ }
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
                    // Pass through current scan token so a global cancellation will abort this directory scan if needed
                    parentNode.children = await this.fileScanner.scanDirectory(parentNode.path, config, this.scanToken || undefined);
                    this.directoryCache.set(parentNode.path, parentNode.children);
                    this._onDidChangeTreeData.fire(parentNode);
                }
            };

            // Clear existing timer and schedule a new one
            try {
                const prev = this.debounceTimers.get(key);
                if (prev) { clearTimeout(prev); }
            } catch (e) { /* ignore timing clear errors */ }
            const t = setTimeout(async () => {
                try { await runNow(); } catch (e) { /* swallow */ } finally { this.debounceTimers.delete(key); }
            }, 250);
            this.debounceTimers.set(key, t as ReturnType<typeof setTimeout>);
        };
        if (watcher) {
            watcher.onDidCreate(handleChange);
            watcher.onDidDelete(handleChange);
            watcher.onDidChange(handleChange);
        }
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
        const group = this.rootNodes.find(r => (r as any).virtualType === 'virtualGroup' && r.name === groupName);
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
                this.scanToken = null;
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
                            // Normalize depth for top-level group children
                            extracted.depth = 1;
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
                const groupNode: FileNode = {
                    type: 'directory',
                    name: groupName,
                    relPath: `virtual:${groupName}`,
                    path: '',
                    isSelected: false,
                    depth: 0,
                    children,
                    // mark as virtual for easier detection
                    virtualType: 'virtualGroup' as any,
                    // attach metadata
                    childCount,
                    totalSize
                } as any;
                groups.push(groupNode);
            }
        }

        if (groups.length > 0) {
            // Prepend virtual groups so they appear first-level
            this.rootNodes = [...groups, ...this.rootNodes];
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
        // Defensive config loading from workspace settings
        const cfg = vscode.workspace.getConfiguration('codebaseDigest', this.workspaceFolder.uri);
        return {
            maxFileSize: cfg.get('maxFileSize', 1024 * 1024),
            maxFiles: cfg.get('maxFiles', 1000),
            maxTotalSizeBytes: cfg.get('maxTotalSizeBytes', 100 * 1024 * 1024),
            maxDirectoryDepth: cfg.get('maxDirectoryDepth', 20),
            excludePatterns: cfg.get('excludePatterns', []),
            includePatterns: cfg.get('includePatterns', []),
            respectGitignore: cfg.get('respectGitignore', true),
            gitignoreFiles: cfg.get('gitignoreFiles', []),
            outputFormat: cfg.get('outputFormat', 'markdown'),
            includeMetadata: cfg.get('includeMetadata', true),
            includeTree: cfg.get('includeTree', true),
            includeSummary: cfg.get('includeSummary', true),
            includeFileContents: cfg.get('includeFileContents', false),
            useStreamingRead: cfg.get('useStreamingRead', false),
            binaryFilePolicy: cfg.get('binaryFilePolicy', 'skip'),
            notebookProcess: cfg.get('notebookProcess', false),
            notebookIncludeNonTextOutputs: cfg.get('notebookIncludeNonTextOutputs', false),
            tokenEstimate: cfg.get('tokenEstimate', false),
            tokenModel: cfg.get('tokenModel', 'chars-approx'),
            performanceLogLevel: cfg.get('performanceLogLevel', 'info'),
            performanceCollectMetrics: cfg.get('performanceCollectMetrics', false),
            outputSeparatorsHeader: cfg.get('outputSeparatorsHeader', ''),
            outputWriteLocation: cfg.get('outputWriteLocation', 'editor'),
            // Defensive default for new keys
            // Minimal tree flag: true/false/'minimal'
            includeTreeMode: cfg.get('includeTreeMode', 'full'),
            // Add more keys here as needed, always with a default
        };
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
                        name: 'Welcome to Codebase Digest',
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
                    } as any,
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
                    } as any,
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
                    } as any,
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
                    } as any,
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
                    } as any
                ];
            }
            return this.rootNodes;
        }
        if (element.type === 'directory') {
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
                        const children = await this.fileScanner.scanDirectory(element.path, config, this.scanToken || undefined);
                        element.children = children;
                        this.directoryCache.set(element.path, children);
                        this._onDidChangeTreeData.fire(element);
                    } catch (e) {
                        // swallow; keep UI responsive
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
        if ((element as any).virtualType === 'welcome' || element.relPath === '__welcome__') {
            const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
            item.description = 'Generate a digest of your codebase for LLMs. Choose an action below:';
            item.tooltip = 'Welcome to Codebase Digest';
            item.iconPath = new vscode.ThemeIcon('rocket');
            item.contextValue = ContextValues.welcome;
            // Clicking the welcome node focuses the sidebar dashboard view
            item.command = {
                command: 'codebaseDigest.focusView',
                title: 'Focus Codebase Digest',
                arguments: [this.workspaceFolder.uri.fsPath]
            } as any;
            return item;
        }
        // Special-case welcome action rows which are shown below the main welcome node
        if ((element as any).virtualType === 'welcomeAction') {
            const act = (element as any).action || '';
            const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('gear');
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
            item.command = {
                command: cmd,
                title: element.name,
                arguments: [this.workspaceFolder.uri.fsPath]
            } as any;
            return item;
        }
        if ((element as any).virtualType === 'scanning' || element.relPath === '__scanning__') {
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
        if ((element as any).virtualType === 'virtualGroup') {
            const count = (element as any).childCount || 0;
            const size = this.formatSize((element as any).totalSize || 0);
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