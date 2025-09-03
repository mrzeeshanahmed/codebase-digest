import { OutputFormatter } from './types';
import { FileNode, DigestConfig } from '../../types/interfaces';
import { ContentProcessor } from '../../services/contentProcessor';
import { Formatters } from '../../utils/formatters';

export class TextFormatter implements OutputFormatter {
    private formatters = new Formatters();
    buildHeader(node: FileNode, cfg: DigestConfig) {
        return this.formatters.buildFileHeader(node, cfg);
    }
    async buildBody(node: FileNode, ext: string, cfg: DigestConfig, cp: ContentProcessor) {
        const result = await cp.getFileContent(node.path, ext, cfg);
        node.isBinary = result.isBinary;
        return result.content;
    }
    finalize(chunks: string[], cfg: DigestConfig) {
        const sep = cfg.outputSeparatorsHeader || '\n---\n';
        return chunks.join(sep);
    }
}
