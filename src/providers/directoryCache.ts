import { FileNode, DigestConfig } from '../types/interfaces';
import { ContentProcessor } from '../services/contentProcessor';

export class DirectoryCache {
    private cache: Map<string, FileNode[]> = new Map();
    private fileScanner: unknown;

    constructor(fileScanner: unknown) {
        this.fileScanner = fileScanner;
    }

    has(path: string): boolean { return this.cache.has(path); }
    get(path: string): FileNode[] | undefined { return this.cache.get(path); }
    set(path: string, children: FileNode[]) { this.cache.set(path, children); }

    async hydrateDirectory(dirPath: string, config: DigestConfig): Promise<FileNode[]> {
        // Use ContentProcessor.scanDirectory to perform directory traversal for caching.
        // Pass the typed DigestConfig through; ContentProcessor.scanDirectory expects DigestConfig.
        const children = await ContentProcessor.scanDirectory(dirPath, config, 0, dirPath);
        // Ensure cached nodes do not carry selection state. Selection should be
        // managed by the SelectionManager / tree provider, not by a passive cache
        // hydration. Clear isSelected recursively to avoid polluting UI selection.
        const clearSelection = (nodes?: FileNode[]) => {
            if (!Array.isArray(nodes)) { return; }
            for (const n of nodes) {
                try {
                    const rec = n as unknown as Record<string, unknown>;
                    if (typeof rec.isSelected !== 'undefined') { rec.isSelected = false; }
                    if (Array.isArray(rec.children)) { clearSelection(rec.children as unknown as FileNode[]); }
                } catch (e) {}
            }
        };
        try { clearSelection(children); } catch (e) {}
        this.cache.set(dirPath, children);
        return children;
    }
}
