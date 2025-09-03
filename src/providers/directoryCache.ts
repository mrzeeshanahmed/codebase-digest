import { FileNode } from '../types/interfaces';
import { FileScanner } from '../services/fileScanner';

export class DirectoryCache {
    private cache: Map<string, FileNode[]> = new Map();
    private fileScanner: FileScanner;

    constructor(fileScanner: FileScanner) {
        this.fileScanner = fileScanner;
    }

    has(path: string): boolean { return this.cache.has(path); }
    get(path: string): FileNode[] | undefined { return this.cache.get(path); }
    set(path: string, children: FileNode[]) { this.cache.set(path, children); }

    async hydrateDirectory(path: string, config: any): Promise<FileNode[]> {
        const children = await this.fileScanner.scanDirectory(path, config);
        this.cache.set(path, children);
        return children;
    }
}
