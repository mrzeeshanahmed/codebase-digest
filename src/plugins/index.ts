import { FileNode, DigestConfig } from '../types/interfaces';

export interface HandledContent {
    content: string;
    isBinary: boolean;
}

// Analyzer types: per-language analyzers can inspect a file and return a small summary
export interface AnalyzerResult {
    // Short human-readable summary (one sentence) of findings, e.g. "Imports: react, fs; Exports: default"
    summary?: string;
    // Optional machine-friendly data the analyzer wants to attach
    data?: Record<string, any>;
}

export type AnalyzerFn = (filePath: string, ext: string, content?: string) => Promise<AnalyzerResult>;

const analyzers: Array<{ lang: string; fn: AnalyzerFn }> = [];

export function registerAnalyzer(lang: string, fn: AnalyzerFn) {
    analyzers.push({ lang, fn });
}

export function getAnalyzer(lang: string): AnalyzerFn | undefined {
    const found = analyzers.find(a => a.lang === lang);
    return found ? found.fn : undefined;
}

export function listAnalyzers() {
    return analyzers.map(a => a.lang);
}

// Internal plugin registries
// Optional tiktoken adapter registration
// To enable tiktoken-based token estimation, install a compatible adapter:
//   npm install optional-tiktoken-adapter
// The adapter must export an 'estimateTokens(content, cfg)' function.
try {
    // Lazy require an optional tokenizer, if user installed it
    // Use a dynamic require hidden from webpack's static analysis so the optional
    // adapter isn't treated as a hard dependency during bundling.
    const dynamicRequire: NodeRequire = eval('require');
    const { estimateTokens } = dynamicRequire('optional-tiktoken-adapter');
    registerTokenizer('tiktoken', (content, cfg) => estimateTokens(content, cfg));
} catch {}
const fileHandlers: Array<{
    name: string;
    predicate: (node: FileNode) => boolean;
    handler: (node: FileNode, cfg: DigestConfig, format: 'markdown' | 'text') => Promise<HandledContent>;
}> = [];

const tokenizers: Array<{
    name: string;
    adapter: (content: string, cfg: DigestConfig) => number;
}> = [];

export function registerFileHandler(
    name: string,
    predicate: (node: FileNode) => boolean,
    handler: (node: FileNode, cfg: DigestConfig, format: 'markdown' | 'text') => Promise<HandledContent>
) {
    fileHandlers.push({ name, predicate, handler });
}

export function registerTokenizer(
    name: string,
    adapter: (content: string, cfg: DigestConfig) => number
) {
    tokenizers.push({ name, adapter });
}

export function getMatchingHandler(node: FileNode) {
    return fileHandlers.find(h => h.predicate(node));
}

export function getTokenizer(name: string) {
    // Returns the adapter function for the given tokenizer name, or undefined if not found
    const found = tokenizers.find(t => t.name === name);
    return found ? found.adapter : undefined;
}

// Example: To register a tiktoken-based tokenizer in future, use:
// registerTokenizer('tiktoken', (content, cfg) => {
//     // Implement tiktoken logic here
//     return tiktokenEstimate(content, cfg);
// });

// Built-in notebook handler registration
import { NotebookProcessor } from '../services/notebookProcessor';
registerFileHandler(
    'notebook',
    (node) => node.name.endsWith('.ipynb'),
    async (node, cfg, format) => {
        const nb = NotebookProcessor.parseIpynb(node.path);
        let content = `Jupyter Notebook: ${node.name}\n\n`;
        for (const cell of nb.cells) {
            if (cell.type === 'markdown') {
                content += cell.source + '\n\n';
            } else if (cell.type === 'code') {
                content += '```python\n' + cell.source + '\n';
                if (cell.outputs && cell.outputs.length > 0) {
                    content += '\n# Outputs:\n';
                    for (const out of cell.outputs) {
                        content += '# ' + out.replace(/\n/g, '\n# ') + '\n';
                    }
                }
                content += '```\n\n';
            }
        }
        return { content, isBinary: false };
    }
);
