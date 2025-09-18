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
import { safeExecuteCommand } from './utils/safeExecuteCommand';
import { ensureZustandReferenced } from './utils/ensureZustandUsed';


import { CodebaseDigestTreeProvider } from './providers/treeDataProvider';
import { registerCodebasePanel } from './providers/codebasePanel';
import { registerAllCommands, registerFolderCommands } from './commands/index';
import { Diagnostics } from './utils/diagnostics';
import { GitignoreService } from './services/gitignoreService';
import { FileScanner } from './services/fileScanner';
// per-command registration now handled by src/commands/index
import { validateConfig, isDigestConfig } from './utils/validateConfig';
import { logUserError } from './utils/errors';
import { setTransientOverride } from './utils/transientOverrides';
import { WorkspaceManager } from './services/workspaceManager';
import { ConfigurationService } from './services/configurationService';
import { clearListeners } from './providers/eventBus';
import { DigestGenerator } from './services/digestGenerator';
// DEPRECATED: PreviewPanel import removed.

// Lightweight runtime interface used during early activation when full provider
// instances may not yet be available.
interface MiniTreeProvider {
	workspaceRoot: string;
	getPreviewData(): { selectedCount: number; totalFiles: number; selectedSize: number | string; tokenEstimate: number; contextLimit: number };
	setPreviewUpdater(): void;
	selectAll(): void;
	clearSelection(): void;
	expandAll(): void;
	collapseAll(): void;
}

// Narrow runtime shape for provider-like objects we interact with at activation time
interface TreeLike extends Partial<MiniTreeProvider> {
	refresh?: () => void;
	pauseScan?: () => void;
	resumeScan?: () => void;
	dispose?: () => void;
	viewTitleSetter?: () => void;
	statusBarItem?: vscode.StatusBarItem;
	updateCounts?: () => void;
	toggleExpand?: (relPath: string) => void;
}

interface PanelLike {
	reveal?: () => void;
}

function stringifyErr(err: unknown): string {
	try {
		if (!err) { return String(err); }
		if (typeof err === 'string') { return err; }
		if (typeof err === 'object' && err !== null) {
			const maybeMsg = (err as { message?: unknown }).message;
			if (typeof maybeMsg === 'string' && maybeMsg.length > 0) { return maybeMsg; }
			try { return JSON.stringify(err); } catch { return String(err); }
		}
		return String(err);
	} catch { return String(err); }
}

export function activate(context: vscode.ExtensionContext) {
try { console.log('[codebase-digest] activate() called'); } catch (e) { try { console.debug('extension.activate log failed', e); } catch {} }
	// Ensure optional runtime references are exercised so depcheck/packagers mark packages as used
	try { ensureZustandReferenced(); } catch (e) {}
	// Surface any uncaught promise rejections or exceptions during extension runtime
	const onUnhandledRejection = (reason: unknown, _promise: Promise<unknown>) => {
		try {
			const msg = stringifyErr(reason);
			try { logUserError('An internal error occurred', msg); } catch (err) { try { console.error('UnhandledRejection', msg, err); } catch {} }
		} catch (e) { /* ignore */ }
	};
	const onUncaughtException = (err: unknown) => {
		try {
			const msg = stringifyErr(err);
			try { logUserError('An unexpected error occurred', msg); } catch (e) { try { console.error('UncaughtException', msg, e); } catch {} }
		} catch (e) { /* ignore */ }
	};
	try {
		// Safely access global.process without double-casting; build a small wrapper so
		// we can remove listeners reliably while avoiding brittle casts.
		const gRec = global as unknown as Record<string, unknown> | undefined;
		const globalProcess = gRec && typeof gRec['process'] === 'object' ? (gRec['process'] as NodeJS.Process) : undefined;
		if (globalProcess && typeof globalProcess.on === 'function') {
			const handleUnhandled = (reason: unknown, p?: Promise<unknown>) => { try { onUnhandledRejection(reason, p as Promise<unknown>); } catch { onUnhandledRejection(reason, Promise.resolve()); } };
			const handleUncaught = (err: unknown) => onUncaughtException(err);
			try { globalProcess.on('unhandledRejection', handleUnhandled); } catch {}
			try { globalProcess.on('uncaughtException', handleUncaught); } catch {}
			context.subscriptions.push({ dispose: () => { try { if (typeof globalProcess.removeListener === 'function') { try { globalProcess.removeListener('unhandledRejection', handleUnhandled); } catch {} try { globalProcess.removeListener('uncaughtException', handleUncaught); } catch {} } } catch {} } });
		}
	} catch (e) {}
	// Ensure the sidebar view has a provider as early as possible so VS Code doesn't report "no data provider"
	try {
		const { registerCodebaseView } = require('./providers/codebasePanel');
		if (typeof registerCodebaseView === 'function') {
			const earlyDummy: MiniTreeProvider = {
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
		if (tp) {
			const tRec = tp as unknown as TreeLike;
			if (tRec && typeof tRec.toggleExpand === 'function') {
				try { tRec.toggleExpand!(relPath); } catch {}
			}
		}
	}));

	// Pause/Resume scanning commands (invoked from panel)
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.pauseScan', async (folderPath?: string) => {
		const resolvedPath = getFolderPath(folderPath);
		if (!resolvedPath) { return; }
		const tp = treeProviders.get(resolvedPath);
		if (tp) {
			const tRec = tp as unknown as TreeLike;
			if (tRec && typeof tRec.pauseScan === 'function') {
				try { tRec.pauseScan!(); } catch {}
			}
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.resumeScan', async (folderPath?: string) => {
		const resolvedPath = getFolderPath(folderPath);
		if (!resolvedPath) { return; }
		const tp = treeProviders.get(resolvedPath);
		if (tp) {
			const tRec = tp as unknown as TreeLike;
			if (tRec && typeof tRec.resumeScan === 'function') {
				try { tRec.resumeScan!(); } catch {}
			}
		}
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
			try { context.subscriptions.push({ dispose: () => { try { const tpRec = treeProvider as unknown as Record<string, unknown>; if (tpRec && typeof tpRec['dispose'] === 'function') { try { (tpRec['dispose'] as () => void)(); } catch (e) {} } } catch (e) {} } }); } catch (e) {}
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
				// ignore  fallback: panel can still be opened via command/status bar
			}

				// On activation, optionally focus the contributed Primary Sidebar view (config validation runs later once Diagnostics is available)
				try {
				const cfgSnapshot = ConfigurationService.getWorkspaceConfig(folder);
			const openSidebar = typeof (cfgSnapshot as any).openSidebarOnActivate === 'boolean' ? (cfgSnapshot as any).openSidebarOnActivate : true;
				if (openSidebar) {
					try {
						// best-effort: avoid unhandled rejections
						safeExecuteCommand('workbench.view.extension.codebase-digest').then(() => {/*noop*/});
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
				const dummyProvider: MiniTreeProvider = {
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

	// Subscribe to configuration changes so webviews and preview state update
	try {
		const cfg = vscode.workspace.getConfiguration('codebaseDigest');
		const onCfgChanged = (e: vscode.ConfigurationChangeEvent) => {
			try {
				// Only react to changes under the codebaseDigest section
				if (!e.affectsConfiguration('codebaseDigest')) { return; }
				// Recompute a minimal preview state payload and broadcast to active views
				// so they can update UI (e.g., token chips, output format and tree options)
				try {
					const updated = {
						outputFormat: cfg.get('outputFormat'),
						includeTree: cfg.get('includeTree'),
						outputPresetCompatible: cfg.get('outputPresetCompatible'),
						filterPresets: cfg.get('filterPresets') || cfg.get('presets') || []
					};
					// postPreviewDeltaToActiveViews will forward to all open panels and sidebar views
					const { postPreviewDeltaToActiveViews } = require('./providers/codebasePanel');
					try { postPreviewDeltaToActiveViews({ config: updated }); } catch (e) { /* ignore */ }
				} catch (e) { /* swallow preview update errors */ }
				// Additionally, refresh any tree providers so their preview computations use new settings
				try {
					if (workspaceFolders && workspaceFolders.length > 0) {
						for (const folder of workspaceFolders) {
							const tp = (null as any) as any; // resolved at runtime in closure; treeProviders exists above
							// Use a best-effort require to avoid circular dependency issues
							try {
								const mod = require('./providers/codebasePanel');
								// codebasePanel keeps active view references; ask providers to recompute preview if they expose an API
								if (typeof mod.refreshActiveViews === 'function') {
									try { mod.refreshActiveViews(folder.uri.fsPath); } catch (e) {}
								}
							} catch (e) { /* ignore per-folder refresh errors */ }
						}
					}
				} catch (e) { /* swallow */ }
			} catch (e) { /* ignore overall errors */ }
		};
		const disposable = vscode.workspace.onDidChangeConfiguration(onCfgChanged);
		context.subscriptions.push(disposable);
	} catch (e) { /* swallow configuration wiring errors */ }
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
			if (panel) {
				const pRec = panel as unknown as PanelLike;
				if (pRec && typeof pRec.reveal === 'function') {
					try { pRec.reveal!(); } catch {}
				}
			}
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
		// Read validated snapshot for safe defaults. Prefer a specific workspace folder when available
		const cfgSnapshot = (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0)
			? ConfigurationService.getWorkspaceConfig(vscode.workspace.workspaceFolders[0])
			: ConfigurationService.getWorkspaceConfig();
		let cacheDir = typeof cfgSnapshot.cacheDir === 'string' ? cfgSnapshot.cacheDir : '';
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
			vscode.window.showErrorMessage('Failed to clear digest cache: ' + stringifyErr(e));
		}
	}
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.invalidateCache', clearCacheImpl));
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.clearCache', clearCacheImpl));
	// Dashboard webview wiring
	// DEPRECATED: PreviewPanel logic removed.

	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.openDashboard', async () => {
	// Prefer focusing the Primary Sidebar view; fall back to opening the panel if necessary
	try {
		const result = await safeExecuteCommand('codebaseDigest.focusView');
		if (!result) {
			// best-effort fallback
			safeExecuteCommand('codebaseDigest.openDashboardPanel').then(() => {/*noop*/});
		}
	} catch (e) {
		safeExecuteCommand('codebaseDigest.openDashboardPanel').then(() => {/*noop*/});
	}
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
						// Use centralized ConfigurationService to load and validate per-folder settings
						try {
							ConfigurationService.getWorkspaceConfig(folder, diagnostics);
						} catch (vcErr) {
							try { diagnostics.warn('Failed to validate config for ' + folder.uri.fsPath + ': ' + String(vcErr)); } catch {}
						}
					} catch (e) {
						// Silently ignore per-folder config validation errors; do not block activation
					}
				}
			}
		} catch (e) {
			// Defensive: do not allow validation errors to block activation
		}

	// Per-folder command registration is handled centrally by `registerAllCommands` below.
	// This avoids duplicate registrations and keeps all command wiring in one place.

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
			await safeExecuteCommand('workbench.view.extension.codebase-digest');
		} catch (e) {
			// ignore
		}
		// No further action required — the view provider will resolve when visible. If a user prefers the panel, they can still run openDashboardPanel.
	}));

	// Per-folder registrations are delegated to registerFolderCommands above.
	// Register global commands and any remaining central registrations now.
	try { registerAllCommands(context, treeProviders, workspaceManager, workspaceFolders); } catch (e) { /* ignore */ }

	// Settings command
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.openSettings', () => {
		safeExecuteCommand('workbench.action.openSettings', 'codebaseDigest').then(() => {/*noop*/});
	}));

	// One-shot command: disable redaction for the next Generate run
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.disableRedactionForNextRun', (folderPath?: string) => {
		const resolved = getFolderPath(folderPath);
		// transient overrides accept arbitrary records; keep a local narrow for clarity
		const to = { showRedacted: true } as Record<string, unknown>;
		setTransientOverride(resolved, to);
		vscode.window.showInformationMessage('Redaction disabled for the next Generate run.');
	}));

	// Toolbar buttons for view
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.toolbar.generateDigest', (folderPath?: string) => {
		safeExecuteCommand('codebaseDigest.generateDigest', folderPath).then(() => {/*noop*/});
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
		safeExecuteCommand('codebaseDigest.openSettings').then(() => {/*noop*/});
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
		// Read validated snapshot for defaults, preserve cfg for updates
		const cfgSnapshot = ConfigurationService.getWorkspaceConfig(vscode.Uri.file(resolvedPath));
	const cfg = vscode.workspace.getConfiguration('codebaseDigest', vscode.Uri.file(resolvedPath));
	const include = await vscode.window.showInputBox({ prompt: 'Include patterns (comma-separated)', value: Array.isArray(cfgSnapshot.includePatterns) ? (cfgSnapshot.includePatterns as string[]).join(',') : '' });
	const exclude = await vscode.window.showInputBox({ prompt: 'Exclude patterns (comma-separated)', value: Array.isArray(cfgSnapshot.excludePatterns) ? (cfgSnapshot.excludePatterns as string[]).join(',') : '' });
		if (include !== undefined) { await cfg.update('includePatterns', include.split(',').map(s => s.trim()).filter(Boolean), vscode.ConfigurationTarget.Workspace); }
		if (exclude !== undefined) { await cfg.update('excludePatterns', exclude.split(',').map(s => s.trim()).filter(Boolean), vscode.ConfigurationTarget.Workspace); }
		const tp = treeProviders.get(resolvedPath); if (tp) { tp.refresh(); }
	}));

	// Edit virtual folders mapping command
	context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.editVirtualFolders', async (folderPath?: string) => {
		const resolvedPath = getFolderPath(folderPath);
		if (!resolvedPath) { return; }
		// Use snapshot for reads, preserve WorkspaceConfiguration for updates
	const cfgSnapshot = ConfigurationService.getWorkspaceConfig(vscode.Uri.file(resolvedPath));
	const cfg = vscode.workspace.getConfiguration('codebaseDigest', vscode.Uri.file(resolvedPath));
	const current = (cfgSnapshot as any).virtualFolders || cfg.get('virtualFolders', {});
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
		const cfgSnapshot2 = ConfigurationService.getWorkspaceConfig(vscode.Uri.file(resolvedPath));
		const contextLimit = typeof (cfgSnapshot2 as any).contextLimit === 'number' ? (cfgSnapshot2 as any).contextLimit : 0;
		if (contextLimit > 0 && preview.tokenEstimate && preview.tokenEstimate > contextLimit) {
			statusText = `$(warning) ${title} (over limit)`;
		}
		statusBar.text = statusText;
		// Push state to dashboard if open (handled by panel/provider)
	}

	// Helper to flash status bar for digest completion
	let digestFlashTimeout: ReturnType<typeof setTimeout> | undefined;
	function flashDigestReady(folderPath?: string) {
		if (digestFlashTimeout) {
			clearTimeout(digestFlashTimeout);
			digestFlashTimeout = undefined;
		}
		statusBar.text = '$(rocket) Digest ready';
		const __cbd_digest_flash_to = setTimeout(() => {
				updateCounts(getFolderPath(folderPath));
				digestFlashTimeout = undefined;
			}, 2000);
		try { if (__cbd_digest_flash_to && typeof (__cbd_digest_flash_to as any).unref === 'function') { try { (__cbd_digest_flash_to as any).unref(); } catch (e) {} } } catch (e) {}
		digestFlashTimeout = __cbd_digest_flash_to as unknown as ReturnType<typeof setTimeout>;
	}
	for (const [folderPath, treeProvider] of treeProviders.entries()) {
		// Narrow to a small runtime-friendly shape instead of casting to Record<string, unknown>
		const tpRec = treeProvider as unknown as TreeLike;
		try {
			// Ensure a viewTitleSetter is present and set it defensively
			if (typeof tpRec.viewTitleSetter === 'undefined') {
				try { tpRec.viewTitleSetter = () => updateCounts(folderPath); } catch {}
			} else {
				try { tpRec.viewTitleSetter = () => updateCounts(folderPath); } catch {}
			}
		} catch {}
		// Ensure provider has access to the shared status bar item for UI updates
		try { if (tpRec) { try { tpRec.statusBarItem = statusBar; } catch (e) { /* ignore */ } } } catch (e) { /* ignore */ }
		treeProvider.setPreviewUpdater(() => updateCounts(folderPath));
		try { treeProvider.updateViewTitle(); } catch {}
		try { updateCounts(folderPath); } catch {}
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
						try { context.subscriptions.push({ dispose: () => { try { const tpRec = treeProvider as unknown as Record<string, unknown>; if (tpRec && typeof tpRec['dispose'] === 'function') { try { (tpRec['dispose'] as () => void)(); } catch (e) {} } } catch (e) {} } }); } catch (e) {}
						// Initial scan
						treeProvider.refresh();
						// Register sidebar view for this provider
						try {
							const { registerCodebaseView } = require('./providers/codebasePanel');
							if (typeof registerCodebaseView === 'function') {
								registerCodebaseView(context, context.extensionUri, treeProvider);
							}
						} catch (err) { /* ignore */ }
						// Register per-folder commands and toggles via centralized helper
						try { registerFolderCommands(context, treeProvider, workspaceManager, workspaceFolders); } catch (e) { /* ignore */ }
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
					if (tp) {
						const tpRec = tp as unknown as Record<string, unknown>;
						if (tpRec && typeof tpRec['dispose'] === 'function') {
							try { (tpRec['dispose'] as () => void)(); } catch (dErr) { /* ignore */ }
						}
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
	// Dispose shared resources from services (avoid leaking OutputChannels)
	try {
		// Dispose any error channel/resources exposed by the DigestGenerator if available at runtime.
		const dgRec = DigestGenerator as unknown as Record<string, unknown> | undefined;
		if (dgRec && typeof dgRec['disposeErrorChannel'] === 'function') {
			try { (dgRec['disposeErrorChannel'] as () => void)(); } catch (e) { /* ignore */ }
		}
	} catch (e) { /* ignore */ }
}
