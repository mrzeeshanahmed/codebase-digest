import { DigestGenerator } from '../services/digestGenerator';
import { ContentProcessor } from '../services/contentProcessor';
import { TokenAnalyzer } from '../services/tokenAnalyzer';
import { DigestConfig } from '../types/interfaces';

describe('DigestGenerator - ASCII tree inclusion', () => {
  const mockContent = {
    'a/file1.txt': 'Alpha',
    'b/file2.txt': 'Beta',
  };
  const mockFiles = [
    { path: '/abs/a/file1.txt', relPath: 'a/file1.txt', ext: '.txt', isBinary: false, name: 'file1.txt', type: 'file' as const, isSelected: false, depth: 0 },
    { path: '/abs/b/file2.txt', relPath: 'b/file2.txt', ext: '.txt', isBinary: false, name: 'file2.txt', type: 'file' as const, isSelected: false, depth: 0 },
  ];

  const contentProcessor = {
    getFileContent: jest.fn(async (p: string) => ({ content: (mockContent as any)[p.split('/abs/')[1]], isBinary: false })),
  } as unknown as ContentProcessor;

  const tokenAnalyzer = { estimate: (body: string) => (body ? body.length : 0) } as unknown as TokenAnalyzer;

  it('includes tree when includeTree: true', async () => {
    const cfg = { outputFormat: 'markdown', token: { model: 'default' }, includeTree: true } as unknown as DigestConfig;
    const generator = new DigestGenerator(contentProcessor as any, tokenAnalyzer as any);
    const res = await generator.generate(mockFiles as any, cfg as any, [], 'markdown');
    // tree should be present in result.tree and in content/chunks
    expect(res.tree && res.tree.length).toBeGreaterThan(0);
    expect(res.content).toContain(res.tree!);
    expect(res.chunks && res.chunks.length).toBeGreaterThan(0);
    // chunks first entry should include the tree (we unshifted it)
    expect(res.chunks![0]).toContain(res.tree!);
  });

  it("includes selected tree when includeTree: 'minimal'", async () => {
    const cfg = { outputFormat: 'markdown', token: { model: 'default' }, includeTree: 'minimal', maxSelectedTreeLines: 50 } as unknown as DigestConfig;
    const generator = new DigestGenerator(contentProcessor as any, tokenAnalyzer as any);
    const res = await generator.generate(mockFiles as any, cfg as any, [], 'markdown');
    expect(res.tree && res.tree.length).toBeGreaterThan(0);
    expect(res.content).toContain(res.tree!);
    expect(res.chunks![0]).toContain(res.tree!);
  });
});
