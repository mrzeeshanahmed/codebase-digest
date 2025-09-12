import { OutputFormatter } from './types';
import { FileNode, DigestConfig } from '../../types/interfaces';
import { ContentProcessor } from '../../services/contentProcessor';
import { Formatters } from '../../utils/formatters';

export class MarkdownFormatter implements OutputFormatter {
    private formatters = new Formatters();
    buildHeader(node: FileNode, cfg: DigestConfig) {
        return this.formatters.buildFileHeader(node, cfg);
    }
    async buildBody(node: FileNode, ext: string, cfg: DigestConfig, cp: ContentProcessor) {
        const result = await cp.getFileContent(node.path, ext, cfg);
        node.isBinary = result.isBinary;
        let body = result.content;
        if (cfg.outputFormat === 'markdown' && !node.isBinary) {
            // Avoid double-fencing if the ContentProcessor (e.g., NotebookProcessor)
            // already returned fenced content (``` or ~~~). Detect a leading
            // fence and a matching closing fence before adding an extra wrapper.
            try {
                const trimmed = (body || '').trim();
                const m = trimmed.match(/^([`~]{3,})\s*(\S+)?/);
                let alreadyFenced = false;
                if (m && m[1]) {
                    const fence = m[1];
                    const closingRe = new RegExp(fence.replace(/[`~]/g, ch => `\\${ch}`) + "\\s*$", 'm');
                    if (closingRe.test(trimmed)) { alreadyFenced = true; }
                }
                if (!alreadyFenced) {
                    body = this.formatters.fence(body, ext, 'markdown');
                }
            } catch (e) {
                // on any detection failure, fall back to fencing to preserve safety
                body = this.formatters.fence(body, ext, 'markdown');
            }
        }
        return body;
    }
    finalize(chunks: string[], cfg: DigestConfig) {
        const sep = cfg.outputSeparatorsHeader || '\n---\n';
        return chunks.join(sep);
    }
}
