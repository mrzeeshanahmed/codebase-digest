import { DigestConfig, TraversalStats, FileNode } from '../types/interfaces';

export class Formatters {
    /**
     * Static alias for kSuffix for test compatibility
     */
    static kSuffix(n: number): string {
        return new Formatters().kSuffix(n);
    }

    /**
     * Static alias for humanFileSize for test compatibility
     */
    static humanFileSize(bytes: number): string {
        return new Formatters().humanFileSize(bytes);
    }

    /**
     * Static alias for formatMtime for test compatibility
     */
    static formatMtime(date: Date): string {
        return new Formatters().formatMtime(date);
    }
    /**
     * Builds a summary block for the digest output.
     */
    buildSummary(
        config: DigestConfig,
        stats: TraversalStats,
        selection: FileNode[],
        tokenEstimate: number | null,
        workspaceName: string,
        workspacePath: string,
        warnings: string[]
    ): string {
        const lines: string[] = [];
    lines.push(`# Code Ingest`);
        lines.push(`Workspace: ${workspaceName}`);
        lines.push(`Path: ${workspacePath}`);
        lines.push(`Files: ${selection.length}`);
        lines.push(`Total Size: ${Formatters.humanFileSize(stats.totalSize || 0)}`);
        if (tokenEstimate !== null) {
            lines.push(`Tokens: ${Formatters.kSuffix(tokenEstimate)}`);
        }
        lines.push(`Generated: ${Formatters.formatMtime(new Date())}`);
        lines.push(`Limits: MaxFiles=${config.maxFiles}, MaxTotalSize=${Formatters.humanFileSize(config.maxTotalSizeBytes)}, MaxFileSize=${Formatters.humanFileSize(config.maxFileSize)}, MaxDirectoryDepth=${config.maxDirectoryDepth}`);
        if (config.includePatterns && config.includePatterns.length > 0) {
            lines.push(`Include Patterns: ${config.includePatterns.join(', ')}`);
        }
        if (config.excludePatterns && config.excludePatterns.length > 0) {
            let excludeLine = `Exclude Patterns: ${config.excludePatterns.join(', ')}`;
            if (config.respectGitignore) { excludeLine += ' (plus .gitignore)'; }
            lines.push(excludeLine);
        }
        if (warnings && warnings.length > 0) {
            lines.push(`\n**Warnings:**`);
            for (const w of warnings) {
                lines.push(`- ${w}`);
            }
        }
        return lines.join('\n');
    }

    /**
     * Builds an ASCII tree of all nodes using the same renderer as minimal tree.
     */
    buildTree(nodes: FileNode[], showSymlinks: boolean): string {
        // Use the same render logic as buildSelectedTreeLines, but for full tree
        function renderNode(node: FileNode, prefix: string, isLast: boolean): string[] {
            const parts: string[] = [];
            const connector = isLast ? '└── ' : '├── ';
            let label = node.name;
            if (node.type === 'symlink') { label += ' [symlink]'; }
            parts.push(prefix + connector + label);
            if (node.children && node.children.length > 0) {
                for (let i = 0; i < node.children.length; i++) {
                    const child = node.children[i];
                    const last = i === node.children.length - 1;
                    parts.push(...renderNode(child, prefix + (isLast ? '    ' : '│   '), last));
                }
            }
            return parts;
        }
        let lines: string[] = [];
        for (let i = 0; i < nodes.length; i++) {
            lines.push(...renderNode(nodes[i], '', i === nodes.length - 1));
        }
        return lines.join('\n');
    }

    /**
     * Builds a minimal ASCII tree from selected FileNodes (only selected leaves and necessary parents).
     * Returns the tree as a string.
     */
    buildSelectedTree(selectedFiles: FileNode[]): string {
        return Formatters.buildSelectedTreeLines(selectedFiles).join('\n');
    }

    /**
     * Helper: builds minimal tree lines from selected FileNodes, up to maxLines.
     */
    static buildSelectedTreeLines(selectedFiles: FileNode[], maxLines: number = 100): string[] {
        // Build trie from relPaths
        const trie: Record<string, any> = {};
        for (const file of selectedFiles) {
            const parts = file.relPath.split(/[\\\/]/);
            let node: Record<string, any> = trie;
            for (const part of parts) {
                if (!node[part]) { node[part] = {}; }
                node = node[part];
            }
        }
        // Render ASCII tree from trie
        function render(node: Record<string, any>, prefix = '', isLast = true): string[] {
            const keys = Object.keys(node);
            let lines: string[] = [];
            keys.forEach((key, idx) => {
                const last = idx === keys.length - 1;
                const connector = last ? '└── ' : '├── ';
                lines.push(prefix + connector + key);
                lines.push(...render(node[key], prefix + (last ? '    ' : '│   '), last));
            });
            return lines;
        }
        let lines: string[] = render(trie);
        if (lines.length > maxLines) {
            lines = lines.slice(0, maxLines);
            lines.push('... (truncated)');
        }
        return lines;
    }

    /**
     * Builds a file header string for output using config template and token substitution.
     */
    buildFileHeader(node: FileNode, config: DigestConfig): string {
        const FSUtils = require('./fsUtils').FSUtils;
        const template = config.outputHeaderTemplate || '==== <relPath> (<size>, <modified>) ====';
        let header = template
            .replace(/<relPath>/g, node.relPath)
            .replace(/<size>/g, node.size ? FSUtils.humanFileSize(node.size) : '')
            .replace(/<modified>/g, node.mtime ? (typeof (FSUtils as any).formatMtime === 'function' ? (FSUtils as any).formatMtime(node.mtime) : Formatters.formatMtime(node.mtime)) : '');
        if (node.type === 'symlink') {
            header += ' [symlink]';
        }
        // Always end with a single newline
        if (!header.endsWith('\n')) { header += '\n'; }
        return header;
    }

    /**
     * Wraps content in code fences for markdown, infers language by extension.
     */
    fence(content: string, ext: string, format: 'markdown' | 'text'): string {
        if (format === 'markdown') {
            // Leave .md contents unfenced
            if (ext === '.md') {
                return content;
            }
            const lang = this.inferLang(ext);
            return `\n\`\`\`${lang}\n${content}\n\`\`\``;
        }
        // For 'text', skip fences entirely
        return content;
    }

    /**
     * Formats a number with k/M suffixes.
     */
    kSuffix(n: number): string {
    if (n < 1000) { return n.toString(); }
    if (n < 1000000) { return (n / 1000).toFixed(1) + 'k'; }
    return (n / 1000000).toFixed(1) + 'M';
    }

    /**
     * Formats a Date to ISO local string.
     */
    formatMtime(date: Date): string {
        return date.toLocaleString();
    }

    /**
     * Formats bytes as human-readable string.
     */
    humanFileSize(bytes: number): string {
    if (bytes < 1024) { return `${bytes} B`; }
        const units = ['KB', 'MB', 'GB', 'TB'];
        let i = -1;
        do {
            bytes /= 1024;
            i++;
        } while (bytes >= 1024 && i < units.length - 1);
        return `${bytes.toFixed(1)} ${units[i]}`;
    }

    /**
     * Infers language for code fence from file extension.
     */
    inferLang(ext: string): string {
        const map: { [key: string]: string } = {
            '.ts': 'typescript',
            '.js': 'javascript',
            '.py': 'python',
            '.md': '',
            '.json': 'json',
            '.java': 'java',
            '.go': 'go',
            '.rb': 'ruby',
            '.cs': 'csharp',
            '.cpp': 'cpp',
            '.c': 'c',
            '.rs': 'rust',
        };
        return map[ext] || '';
    }
}
