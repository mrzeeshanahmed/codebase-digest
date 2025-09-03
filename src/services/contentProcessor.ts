import * as path from 'path';
import { NotebookProcessor } from './notebookProcessor';
import { FSUtils } from '../utils/fsUtils';
import { DigestConfig, FileNode } from '../types/interfaces';
import { FileReadError } from '../utils/errors';

export class ContentProcessor {
    /**
     * Reads file content, detects binary, and normalizes line endings. Handles .ipynb via NotebookProcessor.
     * @param filePath Absolute path to file
     * @param ext File extension (lowercase, with dot)
     * @param cfg DigestConfig
     * @returns Promise<{ content: string, isBinary: boolean }>
     */
    async getFileContent(filePath: string, ext: string, cfg: DigestConfig): Promise<{ content: string, isBinary: boolean }> {
    try {
            // Notebook handling
            if (ext === '.ipynb' && cfg.notebookProcess) {
                // Map DigestConfig to NotebookConfig, including new toggles
                const notebookCfg = {
                    includeCodeCells: cfg.notebookIncludeCodeCells ?? cfg.includeFileContents ?? true,
                    includeMarkdownCells: cfg.notebookIncludeMarkdownCells ?? true,
                    includeOutputs: cfg.notebookIncludeOutputs ?? true,
                    outputMaxChars: cfg.notebookOutputMaxChars ?? 10000,
                    codeFenceLanguage: cfg.notebookCodeFenceLanguage ?? 'python',
                    notebookIncludeNonTextOutputs: cfg.notebookIncludeNonTextOutputs ?? false,
                    notebookNonTextOutputMaxBytes: cfg.notebookNonTextOutputMaxBytes ?? 200000,
                };
                // Output format and relPath
                const format = cfg.outputFormat === 'markdown' ? 'markdown' : 'text';
                const relPath = path.basename(filePath);
                const nbContent = NotebookProcessor.buildNotebookContent(filePath, notebookCfg, format, relPath);
                return { content: nbContent, isBinary: false };
            }

            // Stat for size
            const stat = await FSUtils.safeStat(filePath);
            // Validate readability before attempting to read. If unreadable,
            // throw a typed FileReadError so callers (DigestGenerator) can
            // aggregate the error into per-file results instead of showing
            // a popup for every unreadable file.
            const readable = await FSUtils.isReadable(filePath);
            if (!readable) {
                throw new FileReadError(filePath, 'Permission denied or unreadable file');
            }
            const size = stat?.size ?? 0;

            // Binary detection
            const isBinary = await FSUtils.isBinary(filePath);
            if (isBinary && cfg.binaryFilePolicy) {
                if (cfg.binaryFilePolicy === 'skip') {
                    return { content: '[binary file skipped]', isBinary: true };
                } else if (cfg.binaryFilePolicy === 'includePlaceholder') {
                    const sizeStr = FSUtils.humanFileSize(size);
                    return { content: `[binary file: ${sizeStr}]`, isBinary: true };
                } else if (cfg.binaryFilePolicy === 'includeBase64') {
                    const base64 = await FSUtils.readFileBase64(filePath);
                    let fenced = base64;
                    if (cfg.outputFormat === 'markdown') {
                        const fenceLang = cfg.base64FenceLanguage || 'base64';
                        fenced = `\`\`\`${fenceLang}\n${base64}\n\`\`\``;
                    }
                    return { content: fenced, isBinary: true };
                }
            }

            // Text file reading
            let content = '';
            const threshold = cfg.streamingThresholdBytes ?? 1024 * 1024;
            try {
                if (cfg.useStreamingRead && size > threshold) {
                    content = await FSUtils.readTextFile(filePath, true);
                } else {
                    content = await FSUtils.readTextFile(filePath, false);
                }
            } catch (readErr) {
                // Wrap and surface to caller
                throw new FileReadError(filePath, String(readErr));
            }
            return { content, isBinary: false };
        } catch (e) {
            // Propagate typed FileReadError to allow the digest generator to
            // collect it in result.errors and surface a single aggregated
            // error section. For other errors, return empty content to allow
            // generation to continue silently.
            if (e instanceof FileReadError) {
                throw e;
            }
            return { content: '', isBinary: false };
        }
    }

    /**
     * Extract semantic comments/docs from a file and return a small heuristic summary.
     * Returns { comments: string[], summary: string }
     */
    async getSemanticSummary(filePath: string, ext: string, cfg: DigestConfig): Promise<{ comments: string[]; summary: string }> {
        try {
            const { content, isBinary } = await this.getFileContent(filePath, ext, cfg);
            if (isBinary || !content) {
                return { comments: [], summary: 'Binary or empty file' };
            }
            const comments = extractCommentsByExt(content, ext);
            let summary = '';
            if (comments.length > 0) {
                // Heuristic: take first non-empty line of first comment block
                const first = comments[0].split(/\r?\n/).map(l => l.trim()).find(l => l.length > 0) || '';
                if (first) {
                    summary = first.length > 160 ? first.slice(0, 157) + '...' : first;
                } else {
                    summary = `Contains ${comments.length} documentation block(s).`;
                }
            } else {
                // Fallback: try to extract top-level symbol or first non-empty code line
                const codeLine = content.split(/\r?\n/).map(l => l.trim()).find(l => l.length > 0 && !l.startsWith('//') && !l.startsWith('#') && !l.startsWith('/*')) || '';
                if (codeLine) {
                    // Attempt to detect function/class/def
                    const m = codeLine.match(/^(export\s+)?(class|function|def|fn|package|module)\s+([A-Za-z0-9_]+)/);
                    if (m && m[3]) {
                        summary = `Top-level symbol: ${m[2]} ${m[3]}`;
                    } else {
                        summary = codeLine.length > 160 ? codeLine.slice(0, 157) + '...' : codeLine;
                    }
                } else {
                    summary = 'No documentation found';
                }
            }
            return { comments, summary };
        } catch (e) {
            return { comments: [], summary: 'Error extracting summary' };
        }
    }
    /**
     * Recursively scans a directory and returns an array of FileNode objects for files only.
     * Threads initialRoot parameter from the first call, and computes relPath using path.relative(initialRoot, absPath).
     */
    static async scanDirectory(rootDir: string, cfg: DigestConfig, depth: number = 0, initialRoot?: string): Promise<FileNode[]> {
        const nodes: FileNode[] = [];
        const fsp = await import('fs/promises');
        const entries = await FSUtils.safeStat(rootDir) ? await fsp.readdir(rootDir, { withFileTypes: true }) : [];
        const root = initialRoot || rootDir;
        for (const entry of entries) {
            const absPath = path.join(rootDir, entry.name);
            if (entry.isDirectory()) {
                if (depth < (cfg.maxDirectoryDepth ?? 20)) {
                    nodes.push(...await ContentProcessor.scanDirectory(absPath, cfg, depth + 1, root));
                }
            } else if (entry.isFile()) {
                const stat = await FSUtils.safeStat(absPath);
                nodes.push({
                    path: absPath,
                    relPath: path.relative(root, absPath),
                    name: entry.name,
                    type: 'file',
                    size: stat?.size,
                    mtime: stat?.mtime,
                    isSelected: true,
                    depth,
                });
            }
        }
        return nodes;
    }
}

function extractCommentsByExt(content: string, ext: string): string[] {
    const out: string[] = [];
    const normExt = (ext || '').toLowerCase();
    if (normExt === '.js' || normExt === '.ts' || normExt === '.jsx' || normExt === '.tsx') {
        // JSDoc /** ... */ blocks
        const re = /\/\*\*[\s\S]*?\*\//g;
        const m = content.match(re);
        if (m) { for (const s of m) { out.push(stripJSDocMarkers(s)); } }
        return out;
    }
    if (normExt === '.py') {
        // Module-level triple-quoted docstring at the top
        const re = /^\s*(?:"""([\s\S]*?)"""|'''([\s\S]*?)''')/;
        const m = content.match(re);
        if (m) { out.push((m[1] || m[2] || '').trim()); }
        return out;
    }
    // For Go, Rust, Java: top-of-file comment block or continuous // comments at top
    if (['.go', '.rs', '.java'].includes(normExt)) {
        // Collect leading // lines
        const lines = content.split(/\r?\n/);
        const leading: string[] = [];
        for (const line of lines) {
            const t = line.trim();
            if (t.startsWith('//')) { leading.push(t.replace(/^\/\//, '').trim()); continue; }
            if (t === '') { if (leading.length > 0) { break; } else { continue; } }
            // Non-comment code – stop scanning
            break;
        }
        if (leading.length > 0) { out.push(leading.join('\n')); }
        return out;
    }
    // Generic fallback: extract any /** */ or leading //
    const reAny = /\/\*[\s\S]*?\*\//g;
    const ma = content.match(reAny);
    if (ma) { for (const s of ma) { out.push(stripJSDocMarkers(s)); } }
    return out;
}

function stripJSDocMarkers(s: string): string {
    return s.replace(/^\/\*\*?/, '').replace(/\*\/$/, '').split(/\r?\n/).map((l: string) => {
        return (l as string).replace(/^\s*\*\s?/, '').trim();
    }).filter((l: string) => { return l.length > 0; }).join('\n');
}
