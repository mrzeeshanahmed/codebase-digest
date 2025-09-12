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
            // already returned fenced content. Previously we checked only for a
            // leading fence; notebooks and other processors may contain fenced
            // blocks anywhere in the returned text. Detect any triple-backtick
            // or triple-tilde fence anywhere and skip adding an extra wrapper.
            try {
                const txt = (body || '');
                const hasFence = /(^|\n)\s*([`~]{3,})/.test(txt);
                if (!hasFence) {
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
