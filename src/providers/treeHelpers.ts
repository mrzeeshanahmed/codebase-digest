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
