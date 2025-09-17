import * as vscode from 'vscode';
import { CodebaseDigestTreeProvider } from '../providers/treeDataProvider';
import { WorkspaceManager } from '../services/workspaceManager';
import { registerCommands } from './generateDigest';
import { registerToggles } from './toggles';
import { registerSelectionCommands } from './selectionCommands';
import { registerRefreshTree } from './refreshTree';
import { registerIngestRemoteRepo } from './ingestRemoteRepo';
import { viewMetricsCommand } from './viewMetrics';

/**
 * Central command registrar for the extension.
 *
 * Responsibilities:
 * - `registerAllCommands` is the single entrypoint used by `activate()` to wire up
 *   all global and per-folder commands in one place. It iterates known
 *   `treeProviders` and delegates per-folder command registration to
 *   `registerFolderCommands`, then registers commands that are global or
 *   programmatic (not tied to a specific folder).
 *
 * - `registerFolderCommands` encapsulates commands and toggles that are
 *   specific to a single workspace folder / tree provider. This is invoked
 *   during activation for existing folders and again when folders are added
 *   dynamically (see `onDidChangeWorkspaceFolders` in `extension.ts`).
 *
 * Notes for contributors:
 * - Keep per-folder logic in `registerFolderCommands` so `activate()` stays
 *   concise and easier to test.
 * - Avoid registering global commands inside `registerFolderCommands`.
 */
export function registerAllCommands(
    context: vscode.ExtensionContext,
    treeProviders: Map<string, CodebaseDigestTreeProvider>,
    workspaceManager: WorkspaceManager,
    workspaceFolders?: readonly vscode.WorkspaceFolder[]
) {
    // Per-folder registrations
    for (const [folderPath, treeProvider] of treeProviders.entries()) {
        registerFolderCommands(context, treeProvider, workspaceManager, workspaceFolders);
    }

    // Global/programmatic commands
    // Register ingest remote repo commands once globally
    registerIngestRemoteRepo(context);
}

/**
 * Register commands related to a single folder/provider. Used when adding folders dynamically.
 */
export function registerFolderCommands(
    context: vscode.ExtensionContext,
    treeProvider: CodebaseDigestTreeProvider,
    workspaceManager: WorkspaceManager,
    workspaceFolders?: readonly vscode.WorkspaceFolder[]
) {
    // UI toggles (persisted settings)
    try { registerToggles(context, treeProvider); } catch (e) { /* ignore */ }
    // Generate / core commands
    try { registerCommands(context, treeProvider, { workspaceManager }); } catch (e) { /* ignore */ }
    // Selection helpers
    try { registerSelectionCommands(context, treeProvider); } catch (e) { /* ignore */ }
    // Refresh tree
    try { registerRefreshTree(context, treeProvider); } catch (e) { /* ignore */ }

    // Register viewMetrics command scoped to this folder so UI buttons can call it
    try {
        context.subscriptions.push(vscode.commands.registerCommand('codebaseDigest.viewMetrics', (fp?: string) => {
            const resolved = getFolderPath(fp, workspaceFolders);
            const folder = resolved ? workspaceFolders?.find(f => f.uri.fsPath === resolved) : undefined;
            viewMetricsCommand(folder, workspaceManager);
        }));
    } catch (e) { /* ignore */ }
}

function getFolderPath(input?: string | vscode.Uri, workspaceFolders?: readonly vscode.WorkspaceFolder[]): string | undefined {
    if (typeof input === 'string' && input) { return input; }
    if (input instanceof vscode.Uri && input.fsPath) { return input.fsPath; }
    if (workspaceFolders && workspaceFolders.length > 0) { return workspaceFolders[0].uri.fsPath; }
    return undefined;
}
