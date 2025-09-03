import { FileNode, DigestConfig } from '../../types/interfaces';
import { ContentProcessor } from '../../services/contentProcessor';

export interface OutputFormatter {
    buildHeader(node: FileNode, cfg: DigestConfig): string;
    buildBody(node: FileNode, ext: string, cfg: DigestConfig, cp: ContentProcessor): Promise<string>;
    finalize(chunks: string[], cfg: DigestConfig): string;
}
