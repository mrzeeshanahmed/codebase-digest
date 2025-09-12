import * as fs from 'fs';
import * as path from 'path';
// ...existing code...

export interface NotebookCell {
    type: 'code' | 'markdown';
    source: string;
    outputs?: string[];
}

export interface NotebookConfig {
    includeCodeCells?: boolean;
    includeMarkdownCells?: boolean;
    includeOutputs?: boolean;
    outputMaxChars?: number;
    codeFenceLanguage?: string;
    notebookIncludeNonTextOutputs?: boolean;
    notebookNonTextOutputMaxBytes?: number;
}

export interface ParsedNotebook {
    cells: NotebookCell[];
    metadata?: any;
}

export class NotebookProcessor {
    /**
     * Parse a .ipynb file and return a structured representation of its cells.
     * Safe against malformed notebooks.
     */
    static parseIpynb(filePath: string, config?: { notebookIncludeNonTextOutputs?: boolean, notebookNonTextOutputMaxBytes?: number }): ParsedNotebook {
        let raw = '';
        try {
            raw = fs.readFileSync(filePath, 'utf8');
        } catch {
            return { cells: [] };
        }
        let nb: any;
        try {
            nb = JSON.parse(raw);
        } catch {
            return { cells: [] };
        }
        const cells: NotebookCell[] = [];
        const includeNonText = config?.notebookIncludeNonTextOutputs ?? false;
        const maxBytes = config?.notebookNonTextOutputMaxBytes ?? 200000;
        if (Array.isArray(nb?.cells)) {
            for (const cell of nb.cells) {
                if (cell.cell_type === 'code') {
                    const source = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');
                    let outputs: string[] = [];
                    if (Array.isArray(cell.outputs)) {
                        for (const out of cell.outputs) {
                            if (out.output_type === 'stream' && out.text) {
                                outputs.push(Array.isArray(out.text) ? out.text.join('') : out.text);
                            } else if (out.output_type === 'execute_result' && out.data && out.data['text/plain']) {
                                outputs.push(Array.isArray(out.data['text/plain']) ? out.data['text/plain'].join('') : out.data['text/plain']);
                            } else if (out.output_type === 'error' && out.evalue) {
                                outputs.push(`Error: ${out.evalue}`);
                            } else if (includeNonText && out.data) {
                                // Try image/png, image/jpeg, text/html, etc.
                                let handled = false;
                                for (const key of Object.keys(out.data)) {
                                    if (key.startsWith('image/')) {
                                        let base64 = '';
                                        if (Array.isArray(out.data[key])) {
                                            base64 = out.data[key].join('');
                                        } else {
                                            base64 = out.data[key];
                                        }
                                        if (typeof base64 === 'string' && base64.length > 0) {
                                            if (base64.length > maxBytes) {
                                                outputs.push(`[non-text output too large, omitted]`);
                                            } else {
                                                outputs.push(`[base64:${key}]${base64}`);
                                            }
                                            handled = true;
                                            break;
                                        }
                                    } else if (key === 'text/html') {
                                        // Treat HTML outputs as plain text (searchable) rather than
                                        // encoding them to base64 which downstream search/redaction
                                        // may treat as binary. Respect the maxBytes limit measured
                                        // on the raw UTF-8 HTML payload.
                                        let html = Array.isArray(out.data[key]) ? out.data[key].join('') : out.data[key];
                                        let htmlBytes = Buffer.byteLength(html, 'utf8');
                                        if (htmlBytes > maxBytes) {
                                            outputs.push(`[non-text output too large, omitted]`);
                                        } else {
                                            // Prefix with a light marker so callers can recognize
                                            // this as HTML if needed, but keep the body as plain
                                            // UTF-8 text so it is indexable/searchable.
                                            outputs.push(`[html]${html}`);
                                        }
                                        handled = true;
                                        break;
                                    }
                                }
                                if (!handled) {
                                    outputs.push('[non-text output omitted]');
                                }
                            } else if (out.data) {
                                // If not including non-text outputs, emit a placeholder
                                outputs.push('[non-text output omitted]');
                            }
                        }
                    }
                    cells.push({ type: 'code', source, outputs });
                } else if (cell.cell_type === 'markdown') {
                    const source = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');
                    cells.push({ type: 'markdown', source });
                }
            }
        }
        return { cells, metadata: nb?.metadata };
    }

    /**
     * Converts a ParsedNotebook to text/markdown output per config.
     */
    static toText(nb: ParsedNotebook, cfg: NotebookConfig & { notebookIncludeNonTextOutputs?: boolean, notebookNonTextOutputMaxBytes?: number }, relPath?: string, format?: 'markdown' | 'text'): string {
        if (!nb || !Array.isArray(nb.cells)) { return ''; }
        const lines: string[] = [];
    const rel = relPath ?? '[notebook]';
    const fmt = format ?? 'markdown';
    // Generate a unique per-call fence marker that is extremely unlikely
    // to collide with notebook content. Using a randomized suffix reduces
    // the chance of accidental replacement if the notebook contains the
    // same literal token. We'll replace via split/join to avoid regexp
    // surprises or special-character issues.
    const FENCE_MARKER = `__CODE_FENCE_TRIPLE__${Date.now()}_${Math.random().toString(36).slice(2)}__`;
        lines.push(`# Jupyter Notebook: ${rel}\n`);
        let cellNum = 1;
        for (const cell of nb.cells) {
            if (cell.type === 'markdown' && cfg.includeMarkdownCells) {
                if (fmt === 'markdown') {
                    lines.push(cell.source.trim() + '\n');
                } else {
                    lines.push('---\nMarkdown Cell:\n' + cell.source.trim() + '\n');
                }
            }
            if (cell.type === 'code' && cfg.includeCodeCells) {
                if (fmt === 'markdown') {
                    // Use standard markdown fenced code blocks (triple backticks).
                    lines.push(`\n\n${FENCE_MARKER}${cfg.codeFenceLanguage || 'python'}\n${cell.source.trim()}\n${FENCE_MARKER}`);
                } else {
                    lines.push(`\n---\nCode Cell:\n${cell.source.trim()}\n`);
                }
                if (cfg.includeOutputs && cell.outputs && cell.outputs.length > 0) {
                    for (const output of cell.outputs) {
                        let outStr = output;
                        // If output is base64 (starts with [base64:...]), emit as fenced block
                        if (cfg.notebookIncludeNonTextOutputs && typeof outStr === 'string' && outStr.startsWith('[base64:')) {
                            const label = outStr.substring(8, outStr.indexOf(']'));
                            const base64Content = outStr.substring(outStr.indexOf(']') + 1);
                            if (fmt === 'markdown') {
                                // Represent base64 blobs inside fenced blocks for readability.
                                lines.push(`\n\n${FENCE_MARKER}base64\n# Type: ${label}\n${base64Content}\n${FENCE_MARKER}`);
                            } else {
                                lines.push(`\n---\nBase64 Output (${label}):\n${base64Content}\n`);
                            }
                        } else if (typeof outStr === 'string') {
                            // Normal output
                            let outText = outStr;
                            if (cfg.outputMaxChars && outText.length > cfg.outputMaxChars) {
                                outText = outText.slice(0, cfg.outputMaxChars) + '\n...[truncated]';
                            }
                            if (fmt === 'markdown') {
                                lines.push(`\n# Outputs (Cell ${cellNum}):\n# ${outText.replace(/\n/g, '\n# ')}\n`);
                            } else {
                                lines.push(`\nOutputs (Cell ${cellNum}):\n${outText}\n`);
                            }
                        }
                    }
                }
            }
            cellNum++;
        }
    // Use a unique constant marker for fence placeholders while assembling
    // the output to avoid inserting raw backticks into intermediate
    // strings (which can be brittle when post-processing). Replace the
    // marker with actual triple-backticks once the document is assembled.
    const doc = lines.join('');
    // Use split/join which is deterministic and avoids regexp edge-cases.
    return doc.split(FENCE_MARKER).join('```');
    }

    /**
     * Build the content for a notebook file from ParsedNotebook and config.
     */
    static buildNotebookContent(filePath: string, cfg: NotebookConfig, format: 'markdown' | 'text', relPath: string): string {
        const nb = NotebookProcessor.parseIpynb(filePath, {
            notebookIncludeNonTextOutputs: cfg.notebookIncludeNonTextOutputs ?? false,
            notebookNonTextOutputMaxBytes: cfg.notebookNonTextOutputMaxBytes ?? 200000,
        });
        return NotebookProcessor.toText(nb, cfg, relPath, format);
    }
}
