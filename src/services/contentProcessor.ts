import * as path from 'path';
import { NotebookProcessor } from './notebookProcessor';
import { FSUtils } from '../utils/fsUtils';
import { DigestConfig, FileNode } from '../types/interfaces';
import { internalErrors, interactiveMessages } from '../utils';

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
            // If stat failed (null), treat as a read error instead of
            // proceeding — this avoids inconsistent behavior where a
            // subsequent isReadable check may return true but stat info is
            // not available causing later code to mis-handle the file.
            if (!stat) {
                throw new internalErrors.FileReadError(filePath, 'Unable to stat file or permission denied');
            }
            // Validate readability before attempting to read. If unreadable,
            // throw a typed FileReadError so callers (DigestGenerator) can
            // aggregate the error into per-file results instead of showing
            // a popup for every unreadable file.
            const readable = await FSUtils.isReadable(filePath);
            if (!readable) {
                throw new internalErrors.FileReadError(filePath, 'Permission denied or unreadable file');
            }
            const size = stat.size ?? 0;

            // Binary detection
            const isBinary = await FSUtils.isBinary(filePath);
            if (isBinary && cfg.binaryFilePolicy) {
                // Normalize policy string so callers or UI that use 'include'
                // (labelled "Include Placeholder" in the settings) are treated
                // the same as the internal 'includePlaceholder' value.
                let policy = String(cfg.binaryFilePolicy).trim();
                // Allow legacy/alias 'include' to mean includePlaceholder
                if (policy.toLowerCase() === 'include') {
                    policy = 'includePlaceholder';
                }
                if (policy === 'skip') {
                    return { content: '[binary file skipped]', isBinary: true };
                } else if (policy === 'includePlaceholder') {
                    const sizeStr = FSUtils.humanFileSize(size);
                    return { content: `[binary file: ${sizeStr}]`, isBinary: true };
                } else if (policy === 'includeBase64') {
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
                    throw new internalErrors.FileReadError(filePath, String(readErr));
            }
            return { content, isBinary: false };
        } catch (e) {
            // Propagate typed FileReadError so the digest generator can
            // collect it in per-file errors and present an aggregated report.
            // For any other unexpected error, promote it to a FileReadError
            // instead of silently swallowing the failure.
            if (e instanceof internalErrors.FileReadError) {
                throw e;
            }
            // Ensure we throw a typed FileReadError so callers can distinguish
            // read failures from other runtime errors and record them.
            throw new internalErrors.FileReadError(filePath, String(e));
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
            // Resolve candidate absolute path and ensure it stays within the initial root
            const candidate = path.resolve(rootDir, entry.name);
            // Resolve real paths when possible to avoid symlink escape; fall back to resolved paths
            const resolvedRootPath = (async () => {
                try { return await fsp.realpath(root); } catch { return path.resolve(root); }
            })();
            const resolvedCandidatePath = (async () => {
                try { return await fsp.realpath(candidate); } catch { return path.resolve(candidate); }
            })();
            const rr = await resolvedRootPath;
            const rc = await resolvedCandidatePath;
            // If the candidate resolves outside the scanned root, skip it to
            // avoid path traversal attacks or symlink escape. Use path.relative for a
            // cross-platform containment test rather than string startsWith.
            const rel = path.relative(rr, rc);
            const isInside = rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep));
            if (!isInside) {
                // best-effort debug; do not throw for traversal to avoid breaking scans
                console.debug(`[ContentProcessor.scanDirectory] Skipping path outside root: ${candidate}`);
                continue;
            }
            const absPath = candidate;
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
                    isSelected: false,
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
