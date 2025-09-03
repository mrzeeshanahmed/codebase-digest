import { buildTreeLines, buildTree, buildSelectedTreeLines } from '../format/treeBuilder';
import { FileNode } from '../types/interfaces';

describe('treeBuilder', () => {
    const sampleFiles: FileNode[] = [
        { name: 'src', relPath: 'src', path: '/src', type: 'directory', children: [
            { name: 'index.ts', relPath: 'src/index.ts', path: '/src/index.ts', type: 'file' },
            { name: 'lib', relPath: 'src/lib', path: '/src/lib', type: 'directory', children: [
                { name: 'util.ts', relPath: 'src/lib/util.ts', path: '/src/lib/util.ts', type: 'file' }
            ] }
        ] },
        { name: 'README.md', relPath: 'README.md', path: '/README.md', type: 'file' }
    ] as any;

    it('builds full tree and respects maxLines', () => {
        const lines = buildTreeLines(sampleFiles, 'full', 10);
        expect(Array.isArray(lines)).toBe(true);
        expect(lines.length).toBeGreaterThan(0);
        const joined = buildTree(sampleFiles, true);
        expect(joined.split('\n').length).toBe(lines.length);
    });

    it('builds minimal tree (selected) and truncates when needed', () => {
        // selected list: only leaves provided to minimal builder
        const selected = [
            { name: 'index.ts', relPath: 'src/index.ts', path: '/src/index.ts', type: 'file' },
            { name: 'util.ts', relPath: 'src/lib/util.ts', path: '/src/lib/util.ts', type: 'file' },
            { name: 'README.md', relPath: 'README.md', path: '/README.md', type: 'file' }
        ] as any;
        const lines = buildSelectedTreeLines(selected, 2);
        expect(Array.isArray(lines)).toBe(true);
        // Should be truncated to maxLines and include the truncation marker
        expect(lines.length).toBe(3);
        expect(lines[lines.length - 1]).toMatch(/truncated/i);
    });
});
