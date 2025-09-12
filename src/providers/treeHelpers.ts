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

// Encode a string so it is safe to place into DOM dataset attributes
// Uses a compact base64url encoding which avoids quotes/angle-brackets
// and is safe for attribute values. We expose both encode/decode helpers
// so consumers (including the webview HTML/JS) can round-trip values.
export function encodeForDataAttribute(s: string): string {
    if (s === null || s === undefined) { return ''; }
    try {
        // Use base64url to avoid characters that are problematic in HTML attributes
        const b = Buffer.from(String(s), 'utf8').toString('base64');
        // base64 -> base64url (replace +/ with -_ and trim =)
        return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    } catch (e) {
        return encodeURIComponent(String(s));
    }
}

export function decodeFromDataAttribute(v: string): string {
    if (!v) { return ''; }
    try {
        // base64url -> base64 (restore padding)
        const pad = v.length % 4 === 0 ? '' : '='.repeat(4 - (v.length % 4));
        const b = (v || '').replace(/-/g, '+').replace(/_/g, '/') + pad;
        return Buffer.from(b, 'base64').toString('utf8');
    } catch (e) {
        try { return decodeURIComponent(String(v)); } catch (ex) { return String(v); }
    }
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
