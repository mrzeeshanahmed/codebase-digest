import { DigestGenerator } from '../services/digestGenerator';
import { ContentProcessor } from '../services/contentProcessor';
import { TokenAnalyzer } from '../services/tokenAnalyzer';
import { Formatters } from '../utils/formatters';
import { DigestConfig } from '../types/interfaces';

describe('DigestGenerator', () => {
  const mockContent = {
    'file1.txt': 'Hello world',
    'file2.md': '# Title\nBody',
    'file3.js': 'console.log("hi")',
  };

  const mockFiles = [
    { path: '/abs/file1.txt', relPath: 'file1.txt', ext: 'txt', isBinary: false, name: 'file1.txt', type: 'file' as const, isSelected: false, depth: 0 },
    { path: '/abs/file2.md', relPath: 'file2.md', ext: 'md', isBinary: false, name: 'file2.md', type: 'file' as const, isSelected: false, depth: 0 },
    { path: '/abs/file3.js', relPath: 'file3.js', ext: 'js', isBinary: false, name: 'file3.js', type: 'file' as const, isSelected: false, depth: 0 },
  ];

  const config: DigestConfig = {
    outputFormat: 'markdown',
    token: { model: 'default', divisorOverrides: {}, limit: 0 },
    outputSeparatorsHeader: '---',
    filterPresets: ['codeOnly'],
  } as any;

  it('reads plain text files via ContentProcessor and fences for markdown (non-plugin path)', async () => {
    const contentProcessor = {
    getFileContent: jest.fn(async (path, ext, cfg) => ({ content: (mockContent as any)[path.split('/abs/')[1]], isBinary: false })),
    } as unknown as ContentProcessor;
  const mockTokenAnalyzer = { estimate: (body: string) => (body ? body.length : 0) } as any;
  const generator = new DigestGenerator(contentProcessor as any, mockTokenAnalyzer as any);
    const result = await generator.generate(mockFiles as any, config as any, [], 'markdown' as any);
    expect(result.chunks).toBeDefined();
    expect(result.chunks!.length).toBe(3);
    // Check that non-markdown files are fenced for markdown; markdown files are left unfenced
    expect(result.chunks![0]).toContain('```');
    // file2.md is markdown and should not be fenced by formatters.fence
  const chunk1 = result.chunks![1] as string;
    expect(chunk1.includes('```')).toBe(false);
    expect(result.chunks![2]).toContain('```');
  // token estimate should be greater than zero (implementation may include headers/fences)
  expect(result.tokenEstimate).toBeGreaterThan(0);
    // Deterministic order by index: chunk order matches file order
    expect(result.chunks![0]).toContain(mockContent['file1.txt']);
    expect(result.chunks![1]).toContain(mockContent['file2.md']);
    expect(result.chunks![2]).toContain(mockContent['file3.js']);
  });

  it('uses plugin fileHandler when available (plugin path)', async () => {
    const contentProcessor = {
      getFileContent: jest.fn(async (p) => ({ content: (mockContent as any)[p.split('/abs/')[1]], isBinary: false })),
    } as unknown as ContentProcessor;
    // Plugin handler: only handles .md files
    // Use a synchronous fileHandler so .find does not wrongly pick the plugin due to Promise truthiness
    const pluginHandler = {
      fileHandler: jest.fn((file, ext, cfg) => {
        const norm = (ext || '').toString();
        if (norm === 'md' || norm === '.md' || norm.endsWith('.md')) { return 'PLUGIN_MD'; }
        return undefined;
      })
    };
  const mockTokenAnalyzer2 = { estimate: (body: string) => (body ? body.length : 0) } as any;
  const generator = new DigestGenerator(contentProcessor as any, mockTokenAnalyzer2 as any);
    const result = await generator.generate(mockFiles as any, config as any, [pluginHandler as any], 'markdown' as any);
  // ext may be passed with or without a leading dot depending on implementation; accept either
  expect((pluginHandler as any).fileHandler).toHaveBeenCalledWith(mockFiles[0], expect.stringMatching(/\.?txt$/), config);
  expect((pluginHandler as any).fileHandler).toHaveBeenCalledWith(mockFiles[1], expect.stringMatching(/\.?md$/), config);
  expect((pluginHandler as any).fileHandler).toHaveBeenCalledWith(mockFiles[2], expect.stringMatching(/\.?js$/), config);
    // file2.md handled by plugin
  // Plugin should have provided content for the .md file; accept fallback undefined as failure
  expect(result.chunks![1] && result.chunks![1].includes('PLUGIN_MD')).toBe(true);
    // file1.txt and file3.js handled by fallback
    expect(result.chunks![0]).toContain(mockContent['file1.txt']);
    expect(result.chunks![2]).toContain(mockContent['file3.js']);
  // Token estimate should be positive (exact accounting may include headers/fences)
  expect(result.tokenEstimate).toBeGreaterThan(0);
  // Deterministic order by index: chunk order matches file order (content checked above)
  });
});
