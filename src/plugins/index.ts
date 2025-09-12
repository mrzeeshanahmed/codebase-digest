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
// Try to dynamically import an optional tiktoken adapter. Using dynamic import
// avoids eval() and plays nicer with bundlers and static analysis.
// Provide an explicit initialization hook and a ready-promise so callers can
// await optional tokenizer registration if they need to (avoids implicit race
// when consumers try to read a tokenizer synchronously).
// Lazy initializer for optional tokenizer adapters. We intentionally avoid
// starting a top-level microtask so bundlers can't easily include an optional
// dependency at build time. Callers should await this function if they need
// deterministic availability of optional adapters.
let _optionalTokenizersReady: Promise<void> | null = null;
export async function initOptionalTokenizers(): Promise<void> {
    if (_optionalTokenizersReady) { return _optionalTokenizersReady; }
    _optionalTokenizersReady = (async () => {
        try {
            let mod: any = undefined;
            try {
                // Try a regular dynamic import first (works in Node 14+ and modern bundlers)
                // @ts-ignore: optional runtime dependency may not have types or be installed
                mod = await import('optional-tiktoken-adapter');
            } catch (e) {
                // Dynamic import may be transformed by some bundlers. Use an
                // eval-backed require to avoid static analysis including the
                // optional package in the bundle.
                try {
                    const req = eval('require');
                    mod = req('optional-tiktoken-adapter');
                } catch (e2) {
                    // ignore
                }
            }
            if (mod && typeof mod.estimateTokens === 'function') {
                registerTokenizer('tiktoken', (content, cfg) => mod.estimateTokens(content, cfg));
            }
        } catch (e) {
            // ignore missing optional dependency or any runtime error
        }
    })();
    return _optionalTokenizersReady;
}
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
        // Respect workspace configuration: if notebook processing is disabled,
        // do not synthesize notebook content. Return a harmless empty content so
        // callers can continue to treat the file as non-binary but empty.
        try {
            if (!cfg || (typeof (cfg as any).notebookProcess === 'boolean' && !(cfg as any).notebookProcess)) {
                return { content: '', isBinary: false };
            }
        } catch (e) {
            // if cfg shape unexpected, proceed with processing
        }

        const nb = NotebookProcessor.parseIpynb(node.path);
        let content = `Jupyter Notebook: ${node.name}\n\n`;
        for (const cell of nb.cells) {
            if (cell.type === 'markdown') {
                if ((cfg as any).notebookIncludeMarkdownCells === false) { continue; }
                content += cell.source + '\n\n';
            } else if (cell.type === 'code') {
                if ((cfg as any).notebookIncludeCodeCells === false) { continue; }
                const lang = (cfg as any).notebookCodeFenceLanguage || 'python';
                content += '```' + lang + '\n' + cell.source + '\n';
                if ((cfg as any).notebookIncludeOutputs !== false && cell.outputs && cell.outputs.length > 0) {
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
