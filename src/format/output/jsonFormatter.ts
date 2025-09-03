import { OutputFormatter } from './types';
import { FileNode, DigestConfig } from '../../types/interfaces';
import { ContentProcessor } from '../../services/contentProcessor';

export class JsonFormatter implements OutputFormatter {
    buildHeader(node: FileNode, cfg: DigestConfig) {
        return ''; // headers encoded separately in JSON output
    }
    async buildBody(node: FileNode, ext: string, cfg: DigestConfig, cp: ContentProcessor) {
        const result = await cp.getFileContent(node.path, ext, cfg);
        node.isBinary = result.isBinary;
        return result.content;
    }
    finalize(chunks: string[], cfg: DigestConfig) {
        // For JSON we return empty here; generation code will assemble canonical JSON
        return chunks.join('');
    }
}
