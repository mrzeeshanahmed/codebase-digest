import { ContentProcessor } from './services/contentProcessor';
import { TokenAnalyzer } from './services/tokenAnalyzer';
/**
 * Code Ingest Extension Orchestration Flow
 *
 * 1. scan: Initiate file scanning and filtering for the active workspace folder.
 * 2. select: Allow users to select files via tree view, dashboard, or commands.
 * 3. generate: Trigger digest generation using the provider and workspace manager.
 * 4. write: Output digest to the chosen location (editor, file, clipboard) with progressive feedback.
 * 5. cache: Manage cached digests for fast reopening and regeneration.
 *
 * This flow guides command routing, dashboard updates, and output handling for maintainable extension behavior.
 */
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';


import { CodebaseDigestTreeProvider } from './providers/treeDataProvider';
import { registerCodebasePanel } from './providers/codebasePanel';
import { viewMetricsCommand } from './commands/viewMetrics';
import { registerCommands } from './commands/generateDigest';
import { registerToggles } from './commands/toggles';
import { registerSelectionCommands } from './commands/selectionCommands';
import { registerRefreshTree } from './commands/refreshTree';
import { Diagnostics } from './utils/diagnostics';
import { GitignoreService } from './services/gitignoreService';
import { FileScanner } from './services/fileScanner';
import { registerIngestRemoteRepo } from './commands/ingestRemoteRepo';
import { validateConfig } from './utils/validateConfig';
import { showUserError } from './utils/errors';
import { setTransientOverride } from './utils/transientOverrides';
import { WorkspaceManager } from './services/workspaceManager';
import { clearListeners } from './providers/eventBus';
// DEPRECATED: PreviewPanel import removed.

export function activate(context: vscode.ExtensionContext) {
try { console.log('[codebase-digest] activate() called'); } catch (e) { try { console.debug('extension.activate log failed', e); } catch {} }
	// Surface any uncaught promise rejections or exceptions during extension runtime
	const onUnhandledRejection = (reason: any, promise: Promise<any>) => {
		try {
			const msg = reason && reason.message ? reason.message : String(reason);
			try { showUserError('An internal error occurred', String(msg)); } catch (e) { try { console.error('UnhandledRejection', msg); } catch {} }
		} catch (e) {}
	};
	const onUncaughtException = (err: any) => {
		try {
			const msg = err && err.message ? err.message : String(err);
			try { showUserError('An unexpected error occurred', String(msg)); } catch (e) { try { console.error('UncaughtException', msg); } catch {} }
		} catch (e) {}
	};
	try {
		(global as any).process && typeof (global as any).process.on === 'function' && (global as any).process.on('unhandledRejection', onUnhandledRejection);
		(global as any).process && typeof (global as any).process.on === 'function' && (global as any).process.on('uncaughtException', onUncaughtException);
		context.subscriptions.push({ dispose: () => { try { (global as any).process && typeof (global as any).process.removeListener === 'function' && (global as any).process.removeListener('unhandledRejection', onUnhandledRejection); } catch {} try { (global as any).process && typeof (global as any).process.removeListener === 'function' && (global as any).process.removeListener('uncaughtException', onUncaughtException); } catch {} } });
	} catch (e) {}
	// Ensure the sidebar view has a provider as early as possible so VS Code doesn't report "no data provider"
	try {
		const { registerCodebaseView } = require('./providers/codebasePanel');
		if (typeof registerCodebaseView === 'function') {
			const earlyDummy: any = {
				workspaceRoot: '',
				getPreviewData: () => ({ selectedCount: 0, totalFiles: 0, selectedSize: 0, tokenEstimate: 0, contextLimit: 0 }),
				setPreviewUpdater: () => { },
				selectAll: () => { },
				clearSelection: () => { },
				expandAll: () => { },
				collapseAll: () => { }
			};
			try { registerCodebaseView(context, context.extensionUri, earlyDummy); } catch (e) { /* ignore */ }
		}
	} catch (e) { /* ignore */ }
	// Estimate Tokens command (fast heuristic): sum (size/4) or fallback to relPath length/4
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.estimateTokens', async (folderPath?: string) => {
		const resolvedPath = getFolderPath(folderPath);
		if (!resolvedPath) { return; }
		const tp = treeProviders.get(resolvedPath);
		if (!tp) { return; }
		const selectedFiles = tp.getSelectedFiles();
		if (selectedFiles.length === 0) {
			vscode.window.showInformationMessage('No files selected for token estimation.');
			return;
		}
		// Lightweight estimate without heavy file reads: use known size or relPath length
		let totalEstimate = 0;
		for (const file of selectedFiles) {
			const size = (typeof file.size === 'number' && file.size > 0) ? file.size : (file.relPath ? file.relPath.length : 1000);
			totalEstimate += Math.ceil(size / 4);
		}
		// Format a human-friendly number
		const formatted = totalEstimate.toLocaleString();
		vscode.window.showInformationMessage(`Estimated tokens for selected files: ${formatted}`);
		// Broadcast previewDelta so UI tokens chip updates immediately
		try {
			const { postPreviewDeltaToActiveViews } = require('./providers/codebasePanel');
			if (typeof postPreviewDeltaToActiveViews === 'function') {
				postPreviewDeltaToActiveViews({ tokenEstimate: totalEstimate }, resolvedPath);
			} else {
				const { broadcastPreviewDelta } = require('./providers/codebasePanel');
				broadcastPreviewDelta({ tokenEstimate: totalEstimate }, resolvedPath);
			}
		} catch (e) { /* ignore if module not available */ }
		if (tp.updateCounts) { tp.updateCounts(); }
	}));
	// Expand/Collapse All commands
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.expandAll', async (folderPath?: string) => {
		const resolvedPath = getFolderPath(folderPath);
		if (resolvedPath) {
			const tp = treeProviders.get(resolvedPath);
			if (tp) { await tp.expandAll(); }
		}
	}));

	// Toggle expand for a specific relPath (from webview keyboard)
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.toggleExpand', async (folderPath?: string, relPath?: string) => {
		const resolvedPath = getFolderPath(folderPath);
		if (!resolvedPath || !relPath) { return; }
		const tp = treeProviders.get(resolvedPath);
		if (tp && typeof (tp as any).toggleExpand === 'function') { (tp as any).toggleExpand(relPath); }
	}));

	// Pause/Resume scanning commands (invoked from panel)
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.pauseScan', async (folderPath?: string) => {
		const resolvedPath = getFolderPath(folderPath);
		if (!resolvedPath) { return; }
		const tp = treeProviders.get(resolvedPath);
		if (tp && typeof (tp as any).pauseScan === 'function') { (tp as any).pauseScan(); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.resumeScan', async (folderPath?: string) => {
		const resolvedPath = getFolderPath(folderPath);
		if (!resolvedPath) { return; }
		const tp = treeProviders.get(resolvedPath);
		if (tp && typeof (tp as any).resumeScan === 'function') { (tp as any).resumeScan(); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.collapseAll', async (folderPath?: string) => {
		const resolvedPath = getFolderPath(folderPath);
		if (resolvedPath) {
			const tp = treeProviders.get(resolvedPath);
			if (tp) { await tp.collapseAll(); }
		}
	}));
	// Helper to resolve a valid folder path string
	function getFolderPath(input?: string | vscode.Uri): string | undefined {
	if (typeof input === 'string' && input) { return input; }
	if (input instanceof vscode.Uri && input.fsPath) { return input.fsPath; }
	if (workspaceFolders && workspaceFolders.length > 0) { return workspaceFolders[0].uri.fsPath; }
	return undefined;
	}
	const workspaceFolders = vscode.workspace.workspaceFolders;
	try { console.log('[codebase-digest] workspaceFolders=', workspaceFolders && workspaceFolders.map(f => f.uri.fsPath)); } catch (e) { try { console.debug('extension.workspaceFolders log failed', e); } catch {} }
	const workspaceManager = new WorkspaceManager(workspaceFolders);
	// Create a tree provider per folder
	const treeProviders: Map<string, CodebaseDigestTreeProvider> = new Map();

	if (workspaceFolders && workspaceFolders.length > 0) {
		for (const folder of workspaceFolders) {
			try { console.log('[codebase-digest] registering provider for folder', folder.uri.fsPath); } catch (e) { try { console.debug('extension.register provider log failed', e); } catch {} }
			const services = workspaceManager.getBundleForFolder(folder);
			if (!services) { continue; }
			const treeProvider = new CodebaseDigestTreeProvider(folder, services);
			treeProviders.set(folder.uri.fsPath, treeProvider);
			// Ensure the provider's disposable (watcher/timers) is disposed on extension deactivation
			try { context.subscriptions.push({ dispose: () => { try { if (typeof (treeProvider as any).dispose === 'function') { (treeProvider as any).dispose(); } } catch (e) {} } }); } catch (e) {}
			// Initial scan so the tree appears at activation
			treeProvider.refresh();

			// Register the sidebar WebviewViewProvider so the Primary Sidebar view has content
			try {
				// lazy import to avoid circular references
				const { registerCodebaseView } = require('./providers/codebasePanel');
				if (typeof registerCodebaseView === 'function') {
					registerCodebaseView(context, context.extensionUri, treeProvider);
				}
			} catch (e) {
				// ignore — fallback: panel can still be opened via command/status bar
			}

			// On activation, optionally focus the contributed Primary Sidebar view (config validation runs later once Diagnostics is available)
			try {
				const cfg = vscode.workspace.getConfiguration('codebaseDigest', folder.uri) as any;
				const openSidebar = cfg.get ? cfg.get('openSidebarOnActivate', true) : true;
				if (openSidebar) {
					try {
						vscode.commands.executeCommand('workbench.view.extension.codebase-digest').then(undefined, () => {});
					} catch (err) {
						// ignore
					}
				}
			} catch (e) {
				// If config read fails, don't auto-open anything by default to avoid surprising the user
			}
		}
	} else {
		// No workspace folders: register a minimal sidebar provider so the contributed view has a data provider
		try {
			const { registerCodebaseView } = require('./providers/codebasePanel');
			if (typeof registerCodebaseView === 'function') {
				const dummyProvider: any = {
					workspaceRoot: '',
					getPreviewData: () => ({ selectedCount: 0, totalFiles: 0, selectedSize: 0, tokenEstimate: 0, contextLimit: 0 }),
					setPreviewUpdater: () => { },
					selectAll: () => { },
					clearSelection: () => { },
					expandAll: () => { },
					collapseAll: () => { }
				};
				registerCodebaseView(context, context.extensionUri, dummyProvider);
			}
		} catch (e) { /* ignore */ }
	}
	// Retain panel-focused openDashboard command; proxy dashboard-specific commands are no longer needed
	// Register a single global command to open the dashboard panel for the first workspace folder (or per-folder via args)
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.openDashboardPanel', (folderPath?: string) => {
		const resolved = getFolderPath(folderPath);
		if (!resolved) { return; }
		const tp = treeProviders.get(resolved);
		if (!tp) { return; }
		// Create and reveal the panel when explicitly requested by the user.
		const panel = registerCodebasePanel(context, context.extensionUri, tp);
		try {
			if (panel && typeof (panel as any).reveal === 'function') { (panel as any).reveal(); }
		} catch (e) {
			// If reveal fails for any reason, silently ignore so the rest of the extension still works.
		}
	}));

	// Expose a small command to flash the status bar when digest completes
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.flashDigestReady', (folderPath?: string) => {
		flashDigestReady(folderPath);
	}));
	// Invalidate Digest Cache command
	async function clearCacheImpl() {
		const cfg = vscode.workspace.getConfiguration('codebaseDigest');
		let cacheDir = cfg.get('cacheDir', '');
		if (!cacheDir || typeof cacheDir !== 'string') {
			cacheDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ? require('path').join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.codebase-digest-cache') : '';
		}
		const fs = require('fs');
		const fsp = require('fs/promises');
		if (!cacheDir) {
			vscode.window.showInformationMessage('No digest cache directory found.');
			return;
		}
		try {
			const exists = await fsp.stat(cacheDir).then(() => true, () => false);
			if (!exists) {
				vscode.window.showInformationMessage('No digest cache directory found.');
				return;
			}
			await fsp.rm(cacheDir, { recursive: true, force: true });
			vscode.window.showInformationMessage('Digest cache cleared.');
		} catch (e) {
			vscode.window.showErrorMessage('Failed to clear digest cache: ' + (typeof e === 'object' && e && 'message' in e ? (e as any).message : String(e)));
		}
	}
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.invalidateCache', clearCacheImpl));
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.clearCache', clearCacheImpl));
	// Dashboard webview wiring
	// DEPRECATED: PreviewPanel logic removed.

	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.openDashboard', () => {
	// Prefer focusing the Primary Sidebar view; fall back to opening the panel if necessary
	vscode.commands.executeCommand('codebaseDigest.focusView').then(() => {
		// focusing succeeded or was attempted; nothing else to do
	}, () => {
		// fallback: open as panel
		vscode.commands.executeCommand('codebaseDigest.openDashboardPanel');
	});
	}));

	// Output format quick toggles
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.setOutputFormatMarkdown', async (folderPath?: string) => {
		const resolvedPath = getFolderPath(folderPath);
		if (!resolvedPath) { return; }
		await vscode.workspace.getConfiguration('codebaseDigest', vscode.Uri.file(resolvedPath)).update('outputFormat', 'markdown', vscode.ConfigurationTarget.Workspace);
		if (resolvedPath) { const tp = treeProviders.get(resolvedPath); if (tp) { tp.refresh(); } }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.setOutputFormatText', async (folderPath?: string) => {
		const resolvedPath = getFolderPath(folderPath);
		if (!resolvedPath) { return; }
		await vscode.workspace.getConfiguration('codebaseDigest', vscode.Uri.file(resolvedPath)).update('outputFormat', 'text', vscode.ConfigurationTarget.Workspace);
		if (resolvedPath) { const tp = treeProviders.get(resolvedPath); if (tp) { tp.refresh(); } }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.setOutputFormatJson', async (folderPath?: string) => {
		const resolvedPath = getFolderPath(folderPath);
		if (!resolvedPath) { return; }
		await vscode.workspace.getConfiguration('codebaseDigest', vscode.Uri.file(resolvedPath)).update('outputFormat', 'json', vscode.ConfigurationTarget.Workspace);
		if (resolvedPath) { const tp = treeProviders.get(resolvedPath); if (tp) { tp.refresh(); } }
	}));
	// Load config for diagnostics and gitignore
	const diagnostics = new Diagnostics('info');
	const gitignoreService = new GitignoreService();
	const fileScanner = new FileScanner(gitignoreService, diagnostics);

	// Validate and coerce workspace-specific configuration now that diagnostics is available.
	// This ensures invalid settings are corrected and non-blocking warnings are emitted during activation.
	try {
		if (workspaceFolders && workspaceFolders.length > 0) {
			for (const folder of workspaceFolders) {
				try {
					const cfg = vscode.workspace.getConfiguration('codebaseDigest', folder.uri) as any;
					try {
						// Build a plain runtime snapshot from workspace configuration keys.
						// This avoids mutating the WorkspaceConfiguration object directly. If
						// callers want to persist intentional corrections, call `cfg.update(...)`
						// selectively — do not mutate `cfg` fields in-place.
						const runtimeCfg: any = {
							// numeric limits and common fields with sensible defaults
							maxFileSize: cfg.get('maxFileSize', 10485760),
							maxFiles: cfg.get('maxFiles', 25000),
							maxTotalSizeBytes: cfg.get('maxTotalSizeBytes', 536870912),
							maxDirectoryDepth: cfg.get('maxDirectoryDepth', 20),
							tokenLimit: cfg.get('tokenLimit', 32000),
							// enums / policies
							outputFormat: cfg.get('outputFormat', 'markdown'),
							binaryFilePolicy: cfg.get('binaryFilePolicy', 'skip'),
							// caching / limits
							contextLimit: cfg.get('contextLimit', 0),
							cacheEnabled: cfg.get('cacheEnabled', false),
							cacheDir: cfg.get('cacheDir', ''),
							// notebook handling
							notebookIncludeNonTextOutputs: cfg.get('notebookIncludeNonTextOutputs', false),
							notebookNonTextOutputMaxBytes: cfg.get('notebookNonTextOutputMaxBytes', 200000),
							// redaction
							showRedacted: cfg.get('showRedacted', false),
							redactionPatterns: cfg.get('redactionPatterns', []),
							redactionPlaceholder: cfg.get('redactionPlaceholder', '[REDACTED]'),
							// pattern lists and ignore behavior
							// Provide safe defaults so large folders are excluded unless the user overrides them.
							excludePatterns: cfg.get('excludePatterns', ['node_modules/**', '.git/**', '*.log', '*.tmp', '.DS_Store', 'Thumbs.db']),
							includePatterns: cfg.get('includePatterns', []),
							respectGitignore: cfg.get('respectGitignore', true),
							gitignoreFiles: cfg.get('gitignoreFiles', ['.gitignore']),
							// feature flags / outputs
							includeMetadata: cfg.get('includeMetadata', true),
							includeTree: cfg.get('includeTree', true),
							includeSummary: cfg.get('includeSummary', true),
							includeFileContents: cfg.get('includeFileContents', true),
							useStreamingRead: cfg.get('useStreamingRead', true),
							notebookProcess: cfg.get('notebookProcess', true),
							tokenEstimate: cfg.get('tokenEstimate', true),
							tokenModel: cfg.get('tokenModel', 'chars-approx'),
							tokenDivisorOverrides: cfg.get('tokenDivisorOverrides', {}),
							performanceLogLevel: cfg.get('performanceLogLevel', 'info'),
							performanceCollectMetrics: cfg.get('performanceCollectMetrics', false),
							outputSeparatorsHeader: cfg.get('outputSeparatorsHeader', ''),
							outputWriteLocation: cfg.get('outputWriteLocation', 'editor'),
							filterPresets: cfg.get('filterPresets', []),
						};
						try {
							validateConfig(runtimeCfg, diagnostics);
						} catch (vcErr) {
							try { diagnostics.warn('Failed to validate config for ' + folder.uri.fsPath + ': ' + String(vcErr)); } catch (dErr) { /* swallow */ }
						}
					} catch (e) {
						// Silently ignore per-folder config validation errors; do not block activation
					}
				} catch (e) {
					// Silently ignore per-folder config validation errors; do not block activation
				}
			}
		}
	} catch (e) {
		// Defensive: do not allow validation errors to block activation
	}

	// Register toggles for each treeProvider
	for (const [folderPath, treeProvider] of treeProviders.entries()) {
		registerToggles(context, treeProvider);
	}

	// Note: TreeView UI registration removed. The CodebaseDigestTreeProvider remains
	// as the backing model for scans, selections and preview computations used by
	// the panel-based dashboard. We no longer register a VS Code TreeView UI.

	// Status bar item
	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusBar.text = 'Code Ingest';
	// Clicking the status bar focuses the sidebar view (preferred) or opens the panel as fallback
	statusBar.tooltip = 'Focus Code Ingest view';
	statusBar.command = 'codebaseDigest.focusView';
	statusBar.show();
	context.subscriptions.push(statusBar);

	// Implement focusView command to reveal the Primary Sidebar view and focus the dashboard view
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.focusView', async (folderPath?: string) => {
		// Focus the custom view container first
		try {
			await vscode.commands.executeCommand('workbench.view.extension.codebase-digest');
		} catch (e) {
			// ignore
		}
		// No further action required — the view provider will resolve when visible. If a user prefers the panel, they can still run openDashboardPanel.
	}));

	// Register all commands to route to correct provider/folder
	for (const [folderPath, treeProvider] of treeProviders.entries()) {
		registerCommands(context, treeProvider, { workspaceManager });
		// Register view metrics command scoped to this folder
		context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.viewMetrics', (fp?: string) => {
			const resolved = getFolderPath(fp);
			const folder = resolved ? workspaceFolders?.find(f => f.uri.fsPath === resolved) : undefined;
			viewMetricsCommand(folder, workspaceManager);
		}));
		registerSelectionCommands(context, treeProvider);
		registerRefreshTree(context, treeProvider);
	}
	// Register ingest remote repo command once globally
	registerIngestRemoteRepo(context);

	// Settings command
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.openSettings', () => {
		vscode.commands.executeCommand('workbench.action.openSettings', 'codebaseDigest');
	}));

	// One-shot command: disable redaction for the next Generate run
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.disableRedactionForNextRun', (folderPath?: string) => {
		const resolved = getFolderPath(folderPath);
		setTransientOverride(resolved, { showRedacted: true });
		vscode.window.showInformationMessage('Redaction disabled for the next Generate run.');
	}));

	// Toolbar buttons for view
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.toolbar.generateDigest', (folderPath?: string) => {
		vscode.commands.executeCommand('codebaseDigest.generateDigest', folderPath);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.toolbar.selectAll', (folderPath?: string) => {
		const resolvedPath = getFolderPath(folderPath);
		if (resolvedPath) { const tp = treeProviders.get(resolvedPath); if (tp) { tp.selectAll(); } }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.toolbar.clearSelection', (folderPath?: string) => {
		const resolvedPath = getFolderPath(folderPath);
		if (resolvedPath) { const tp = treeProviders.get(resolvedPath); if (tp) { tp.clearSelection(); } }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.toolbar.refresh', (folderPath?: string) => {
		const resolvedPath = getFolderPath(folderPath);
		if (resolvedPath) { const tp = treeProviders.get(resolvedPath); if (tp) { tp.refresh(); } }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.toolbar.settings', () => {
		vscode.commands.executeCommand('codebaseDigest.openSettings');
	}));

	// Context menu actions for Preview node
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.choosePreset', async (folderPath?: string) => {
		const resolvedPath = getFolderPath(folderPath);
		if (!resolvedPath) { return; }
		const presets = ['default', 'codeOnly', 'docsOnly', 'testsOnly'];
		const selected = await vscode.window.showQuickPick(presets, { placeHolder: 'Choose a filter preset' });
		if (selected) {
			await vscode.workspace.getConfiguration('codebaseDigest', vscode.Uri.file(resolvedPath)).update('filterPresets', [selected], vscode.ConfigurationTarget.Workspace);
			const tp = treeProviders.get(resolvedPath); if (tp) { tp.refresh(); }
		}
	}));

	// Command: apply preset programmatically (used as a fallback from webview)
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.applyPreset', async (folderPath?: string, preset?: string) => {
		const resolvedPath = getFolderPath(folderPath);
		if (!resolvedPath) { return; }
		const allowed = ['default', 'codeOnly', 'docsOnly', 'testsOnly'];
		if (!preset || !allowed.includes(preset)) { return; }
		await vscode.workspace.getConfiguration('codebaseDigest', vscode.Uri.file(resolvedPath)).update('filterPresets', [preset], vscode.ConfigurationTarget.Workspace);
		const tp = treeProviders.get(resolvedPath); if (tp) { tp.refresh(); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.editPatterns', async (folderPath?: string) => {
		const resolvedPath = getFolderPath(folderPath);
		if (!resolvedPath) { return; }
		const cfg = vscode.workspace.getConfiguration('codebaseDigest', vscode.Uri.file(resolvedPath));
		const include = await vscode.window.showInputBox({ prompt: 'Include patterns (comma-separated)', value: (cfg.get('includePatterns') as string[]).join(',') });
		const exclude = await vscode.window.showInputBox({ prompt: 'Exclude patterns (comma-separated)', value: (cfg.get('excludePatterns') as string[]).join(',') });
		if (include !== undefined) { await cfg.update('includePatterns', include.split(',').map(s => s.trim()).filter(Boolean), vscode.ConfigurationTarget.Workspace); }
		if (exclude !== undefined) { await cfg.update('excludePatterns', exclude.split(',').map(s => s.trim()).filter(Boolean), vscode.ConfigurationTarget.Workspace); }
		const tp = treeProviders.get(resolvedPath); if (tp) { tp.refresh(); }
	}));

	// Edit virtual folders mapping command
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.editVirtualFolders', async (folderPath?: string) => {
		const resolvedPath = getFolderPath(folderPath);
		if (!resolvedPath) { return; }
		const cfg = vscode.workspace.getConfiguration('codebaseDigest', vscode.Uri.file(resolvedPath));
		const current = cfg.get('virtualFolders', {});
		// Show quick pick to choose an action
		const action = await vscode.window.showQuickPick(['View/Edit JSON', 'Add Group', 'Remove Group'], { placeHolder: 'Choose virtual folders action' });
		if (!action) { return; }
		if (action === 'View/Edit JSON') {
			const doc = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(current, null, 2) });
			await vscode.window.showTextDocument(doc);
			// User edits the JSON and saves; we can't detect save here synchronously — instruct user to use Settings or run command again after edit
			return;
		}
		if (action === 'Add Group') {
			const name = await vscode.window.showInputBox({ prompt: 'Group name (e.g., App or Tests)' });
			if (!name) { return; }
			const patterns = await vscode.window.showInputBox({ prompt: 'Glob patterns (comma-separated). Use trailing slash for prefix (e.g., src/app/).', value: '' });
			if (patterns === undefined) { return; }
			const arr = patterns.split(',').map(s => s.trim()).filter(Boolean);
			const cm = current as Record<string, string[]>;
			cm[name] = arr;
			await cfg.update('virtualFolders', current, vscode.ConfigurationTarget.Workspace);
			vscode.window.showInformationMessage(`Virtual group '${name}' saved.`);
			// Refresh tree providers if present
			const tp = treeProviders.get(resolvedPath); if (tp) { tp.refresh(); }
			return;
		}
		if (action === 'Remove Group') {
			const names = Object.keys(current || {});
			if (names.length === 0) { vscode.window.showInformationMessage('No virtual groups defined.'); return; }
			const pick = await vscode.window.showQuickPick(names, { placeHolder: 'Select group to remove' });
			if (!pick) { return; }
			const cm2 = current as Record<string, string[]>;
			delete cm2[pick];
			await cfg.update('virtualFolders', current, vscode.ConfigurationTarget.Workspace);
			vscode.window.showInformationMessage(`Virtual group '${pick}' removed.`);
			const tp = treeProviders.get(resolvedPath); if (tp) { tp.refresh(); }
			return;
		}
	}));

	// Wire up explorer view title and status bar update
	function updateCounts(folderPath?: string) {
		const resolvedPath = getFolderPath(folderPath);
		if (!resolvedPath) { return; }
		const treeProvider = treeProviders.get(resolvedPath);
		if (!treeProvider) { return; }
		const preview = treeProvider.getPreviewData();
	let title = `Code Ingest (${preview.selectedCount} selected, ${preview.totalFiles} total, ${preview.selectedSize})`;
		let statusText = title;
		const contextLimit = vscode.workspace.getConfiguration('codebaseDigest', vscode.Uri.file(resolvedPath)).get('contextLimit', 0);
		if (contextLimit > 0 && preview.tokenEstimate && preview.tokenEstimate > contextLimit) {
			statusText = `$(warning) ${title} (over limit)`;
		}
		statusBar.text = statusText;
		// Push state to dashboard if open (handled by panel/provider)
	}

	// Helper to flash status bar for digest completion
	let digestFlashTimeout: NodeJS.Timeout | undefined;
	function flashDigestReady(folderPath?: string) {
		if (digestFlashTimeout) {
			clearTimeout(digestFlashTimeout);
			digestFlashTimeout = undefined;
		}
		statusBar.text = '$(rocket) Digest ready';
		digestFlashTimeout = setTimeout(() => {
			updateCounts(getFolderPath(folderPath));
			digestFlashTimeout = undefined;
		}, 2000);
	}
	for (const [folderPath, treeProvider] of treeProviders.entries()) {
	(treeProvider as any).viewTitleSetter = () => updateCounts(folderPath);
	// Ensure provider has access to the shared status bar item for UI updates
	try { (treeProvider as any).statusBarItem = statusBar; } catch (e) { /* ignore */ }
	treeProvider.setPreviewUpdater(() => updateCounts(folderPath));
	treeProvider.updateViewTitle();
	updateCounts(folderPath);
	}

	// Listen for workspace folder changes and keep WorkspaceManager, treeProviders and registrations in sync
	vscode.workspace.onDidChangeWorkspaceFolders((e) => {
		// Handle added folders: create bundles, providers, register view and commands
		if (e.added && e.added.length > 0) {
			for (const folder of e.added) {
				try {
					// Ensure workspace manager creates a bundle for this folder
					workspaceManager.addFolder(folder);
					const services = workspaceManager.getBundleForFolder(folder);
					if (!services) { continue; }
					// Create and store a new tree provider
					const treeProvider = new CodebaseDigestTreeProvider(folder, services);
					treeProviders.set(folder.uri.fsPath, treeProvider);
					// Ensure the provider's disposable (watcher/timers) is disposed on extension deactivation
					try { context.subscriptions.push({ dispose: () => { try { if (typeof (treeProvider as any).dispose === 'function') { (treeProvider as any).dispose(); } } catch (e) {} } }); } catch (e) {}
					// Initial scan
					treeProvider.refresh();
					// Register sidebar view for this provider
					try {
						const { registerCodebaseView } = require('./providers/codebasePanel');
						if (typeof registerCodebaseView === 'function') {
							registerCodebaseView(context, context.extensionUri, treeProvider);
						}
					} catch (err) { /* ignore */ }
					// Register per-folder commands and toggles
					registerToggles(context, treeProvider);
					registerCommands(context, treeProvider, { workspaceManager });
					registerSelectionCommands(context, treeProvider);
					registerRefreshTree(context, treeProvider);
				} catch (err) {
					try { console.error('[codebase-digest] error adding workspace folder', folder.uri.fsPath, err); } catch (e) { /* ignore */ }
				}
			}
		}
		// Handle removed folders: dispose providers, remove bundles, and unregister per-folder resources
		if (e.removed && e.removed.length > 0) {
			for (const folder of e.removed) {
				try {
					const key = folder.uri.fsPath;
					// Dispose and remove tree provider
					const tp = treeProviders.get(key);
					if (tp && typeof (tp as any).dispose === 'function') {
						try { (tp as any).dispose(); } catch (dErr) { /* ignore */ }
					}
					treeProviders.delete(key);
					// Remove bundle from workspace manager
					try { workspaceManager.removeFolder(folder); } catch (wmErr) { /* ignore */ }
					// Best-effort: attempt to dispose any panel/view registrations related to this folder
					try {
						// codebasePanel keeps active views internally; calling refresh on other providers will not reference removed folder
						const { registeredDisposable } = require('./providers/codebasePanel');
						if (registeredDisposable && typeof registeredDisposable.dispose === 'function') {
							try { registeredDisposable.dispose(); } catch (e) { /* ignore */ }
						}
					} catch (e) { /* ignore */ }
				} catch (err) {
					try { console.error('[codebase-digest] error removing workspace folder', folder.uri.fsPath, err); } catch (e) { /* ignore */ }
				}
			}
		}
	});
}

export function deactivate() {
	try { clearListeners(); } catch (e) { /* ignore */ }
}
