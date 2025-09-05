import * as vscode from 'vscode';
import { FileNode } from '../types/interfaces';

export const ContextValues = {
    welcome: 'welcome',
    scanning: 'scanning',
    file: 'file',
    directory: 'directory'
} as const;

export function formatSize(size: number | undefined): string {
    if (typeof size !== 'number' || isNaN(size)) { return ''; }
    if (size < 1024) { return `${size} B`; }
    if (size < 1024 * 1024) { return `${(size / 1024).toFixed(1)} KB`; }
    if (size < 1024 * 1024 * 1024) { return `${(size / (1024 * 1024)).toFixed(1)} MB`; }
    return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatTooltip(node: FileNode): string {
    const parts: string[] = [];
    if (node.relPath) { parts.push(node.relPath); }
    if (node.size) {
        const s = formatSize(node.size);
        if (s) { parts.push(s); }
    }
    if (node.mtime) { parts.push(`Modified: ${node.mtime}`); }
    return parts.join('\n');
}

export function createTreeIcon(node: FileNode): vscode.ThemeIcon {
    if (node.isSelected) { return new vscode.ThemeIcon('check'); }
    if (node.type === 'directory') { return new vscode.ThemeIcon('folder'); }
    return new vscode.ThemeIcon('file');
}

// Build a nested tree object from an array of relative file paths.
// Folders are represented as nested objects; files are leaf objects
// with the marker `__isFile: true` and the original `path` preserved.
export function buildFileTree(files: string[]): any {
    const tree: Record<string, any> = {};
    if (!Array.isArray(files) || files.length === 0) { return tree; }

    for (const p of files) {
        if (!p) { continue; }
        const parts = String(p).split(/[\\\/]/);
        let currentNode: Record<string, any> = tree;

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isFile = i === parts.length - 1;

            if (!currentNode[part]) {
                currentNode[part] = isFile ? { __isFile: true, path: p } : {};
            }
            currentNode = currentNode[part];
        }
    }
    return tree;
}
