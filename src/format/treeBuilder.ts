import { FileNode, DigestConfig } from '../types/interfaces';
import { Formatters } from '../utils/formatters';

/**
 * Central helper that returns tree lines for either 'minimal' (selected-only)
 * or 'full' mode. Ensures maxLines safety for either mode and centralizes
 * calls to Formatters.
 */
export function buildTreeLines(files: FileNode[], mode: 'minimal' | 'full' = 'full', maxLines = 100): string[] {
    const f = new Formatters();
    if (mode === 'minimal') {
        // Use the static helper which already implements truncation
        return (Formatters as any).buildSelectedTreeLines(files, maxLines);
    }
    // Full tree: build full tree string and split into lines
    const full = f.buildTree(files, true) || '';
    // Normalize CRLF to LF so splitting and truncation work consistently across platforms
    const normalized = full.replace(/\r\n/g, '\n');
    const lines = normalized.length ? normalized.split('\n') : [];
    if (lines.length > maxLines) {
        return [...lines.slice(0, maxLines), '... (truncated)'];
    }
    return lines;
}

export function buildTree(files: FileNode[], includeFull = true) {
    // When requesting the full tree, explicitly pass a very large maxLines
    // to avoid accidental truncation by the default (100 lines).
    return includeFull ? buildTreeLines(files, 'full', Number.MAX_SAFE_INTEGER).join('\n') : '';
}

export function buildSelectedTreeLines(files: FileNode[], maxLines: number) {
    return buildTreeLines(files, 'minimal', maxLines);
}
