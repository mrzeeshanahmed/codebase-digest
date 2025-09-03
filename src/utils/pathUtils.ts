/**
 * PathUtils: Cross-platform path normalization and workspace-relative helpers
 */
import * as vscode from 'vscode';
import * as path from 'path';

export class PathUtils {
    /**
     * Returns the absolute path of the first workspace folder, or undefined if none.
     */
    static getWorkspaceRoot(): string | undefined {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return undefined;
        }
        return folders[0].uri.fsPath;
    }

    /**
     * Returns the absolute path of a given WorkspaceFolder, or undefined if not provided.
     */
    static getFolderRoot(folder?: vscode.WorkspaceFolder): string | undefined {
        return folder ? folder.uri.fsPath : undefined;
    }

    /**
     * Returns root-relative POSIX path for a given WorkspaceFolder, no leading ./, normalized.
     */
    static toRelPathFromFolder(absPath: string, folder?: vscode.WorkspaceFolder): string {
        const root = this.getFolderRoot(folder);
    if (!root) { return this.toPosix(absPath); } // fallback: return normalized absPath
        return this.toRelPath(absPath, root);
    }

    /**
     * Returns a slug for a given WorkspaceFolder (last folder name), or empty string if not provided.
     */
    static slugFromFolder(folder?: vscode.WorkspaceFolder): string {
    if (!folder) { return ''; }
        return this.slugFromPath(folder.uri.fsPath);
    }

    /**
     * Converts Windows backslashes to POSIX slashes.
     */
    static toPosix(p: string): string {
        return p.replace(/\\+/g, '/');
    }

    /**
     * Returns root-relative POSIX path, no leading ./, normalized.
     */
    static toRelPath(absPath: string, root: string): string {
    let rel = path.relative(root, absPath);
    rel = this.toPosix(rel);
    if (rel.startsWith('./')) { rel = rel.slice(2); }
    return rel.replace(/^\/+/, '');
    }

    /**
     * Returns the last folder name of a path.
     */
    static slugFromPath(absPath: string): string {
        const norm = this.toPosix(absPath);
        const parts = norm.split('/').filter(Boolean);
        return parts.length ? parts[parts.length - 1] : '';
    }

    /**
     * path.join wrapper returning normalized POSIX string.
     */
    static join(...parts: string[]): string {
        return this.toPosix(path.join(...parts));
    }

    /**
     * Returns POSIX dirname of a path.
     */
    static dirname(p: string): string {
        return this.toPosix(path.dirname(p));
    }

    /**
     * Returns POSIX basename of a path.
     */
    static basename(p: string): string {
        return path.basename(this.toPosix(p));
    }

    /**
     * Returns POSIX extname of a path.
     */
    static extname(p: string): string {
        return path.extname(this.toPosix(p));
    }
}
