import * as path from 'path';
import { NotebookProcessor } from '../services/notebookProcessor';
import { DigestConfig } from '../types/interfaces';

export function handleNotebook(filePath: string, cfg: DigestConfig): { content: string, isBinary: boolean } | null {
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.ipynb' || !cfg.notebookProcess) {
        return null;
    }

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
