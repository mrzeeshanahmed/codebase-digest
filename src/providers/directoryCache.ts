import { FileNode } from '../types/interfaces';
import { ContentProcessor } from '../services/contentProcessor';

export class DirectoryCache {
    private cache: Map<string, FileNode[]> = new Map();
    private fileScanner: any;

    constructor(fileScanner: any) {
        this.fileScanner = fileScanner;
    }

    has(path: string): boolean { return this.cache.has(path); }
    get(path: string): FileNode[] | undefined { return this.cache.get(path); }
    set(path: string, children: FileNode[]) { this.cache.set(path, children); }

    async hydrateDirectory(dirPath: string, config: any): Promise<FileNode[]> {
        // Use ContentProcessor.scanDirectory to perform directory traversal for caching.
        const children = await ContentProcessor.scanDirectory(dirPath, config as any, 0, dirPath);
        this.cache.set(dirPath, children);
        return children;
    }
}
