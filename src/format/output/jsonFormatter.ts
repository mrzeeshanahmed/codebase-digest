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
    /**
     * finalize is intentionally a no-op for JSON output.
     *
     * The JSON generator assembles a canonical, well-formed JSON payload from
     * the collected pieces and does not rely on a simple string-join of the
     * provided chunks. To avoid accidental misuse in tests or other callers,
     * this method returns an empty string. In non-production environments we
     * emit a console warning if callers pass non-empty chunks so maintainers
     * can detect improper usage.
     */
    finalize(chunks: string[], cfg: DigestConfig) {
        try {
            if (chunks && chunks.length > 0 && process.env.NODE_ENV !== 'production') {
                console.warn('JsonFormatter.finalize: incoming chunks are ignored for JSON output; returning empty string');
            }
        } catch (e) { /* ignore logging failures */ }
        return '';
    }
}
