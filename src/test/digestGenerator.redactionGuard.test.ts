import { DigestGenerator } from '../services/digestGenerator';
import { ContentProcessor } from '../services/contentProcessor';
import { TokenAnalyzer } from '../services/tokenAnalyzer';
import { DigestConfig } from '../types/interfaces';

// Mock redactSecrets so we can simulate aggressive redaction that removes the tree
jest.mock('../utils/redactSecrets', () => ({
  redactSecrets: jest.fn(() => ({ applied: true, content: '<<REDACTED-CONTENT>>' }))
}));

describe('DigestGenerator - final guard after redaction', () => {
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

  it('re-inserts fenced tree at top for markdown when redaction removed it', async () => {
    const cfg = { outputFormat: 'markdown', includeTree: true } as unknown as DigestConfig;
    const generator = new DigestGenerator(contentProcessor as any, tokenAnalyzer as any);
    const res = await generator.generate(mockFiles as any, cfg as any, [], 'markdown');

    // tree should exist and final result must contain it even though redactSecrets returned REDACTED content
    expect(res.tree && res.tree.length).toBeGreaterThan(0);
    expect(res.content).toContain(res.tree!);
    expect(res.chunks && res.chunks.length).toBeGreaterThan(0);
    expect(res.chunks![0]).toContain(res.tree!);
  });

  it('re-inserts raw tree at top for text when redaction removed it', async () => {
    const cfg = { outputFormat: 'text', includeTree: true } as unknown as DigestConfig;
    const generator = new DigestGenerator(contentProcessor as any, tokenAnalyzer as any);
    const res = await generator.generate(mockFiles as any, cfg as any, [], 'text');

    expect(res.tree && res.tree.length).toBeGreaterThan(0);
    expect(res.content).toContain(res.tree!);
    expect(res.chunks && res.chunks.length).toBeGreaterThan(0);
    expect(res.chunks![0]).toContain(res.tree!);
  });
});
