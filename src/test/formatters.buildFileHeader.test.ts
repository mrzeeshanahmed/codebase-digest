import { describe, it, expect } from '@jest/globals';
import { Formatters } from '../utils/formatters';
import { DigestConfig, FileNode } from '../types/interfaces';

describe('Formatters.buildFileHeader', () => {
  it('renders the relPath token and ends with a newline', () => {
    const config: DigestConfig = {
      outputFormat: 'text',
      outputPresetCompatible: false,
      includeTree: false,
      includeMetadata: true,
      includeFileContents: false,
      excludePatterns: [],
      includePatterns: [],
      maxFileSize: 100000,
      maxFiles: 100,
      maxTotalSizeBytes: 1000000,
      maxDirectoryDepth: 10,
      respectGitignore: true,
      gitignoreFiles: [],
      binaryFilePolicy: 'skip',
      notebookProcess: false,
      tokenEstimate: false,
      tokenModel: '',
      performanceLogLevel: 'info',
      performanceCollectMetrics: false,
      outputSeparatorsHeader: '\n---\n',
      outputWriteLocation: 'editor',
      includeSummary: false,
      useStreamingRead: true,
      // ensure we use a simple explicit header template for test clarity
      outputHeaderTemplate: '==== <relPath> (<size>, <modified>) ===='
    } as unknown as DigestConfig;

    const file: FileNode = {
      path: '/project/src/index.ts',
      relPath: 'src/index.ts',
      name: 'index.ts',
      type: 'file',
      isSelected: true,
      depth: 2,
      size: 1234
    } as FileNode;

    const fmt = new Formatters();
    const header = fmt.buildFileHeader(file, config);

    expect(header).toContain('src/index.ts');
    // header must end with a single newline
    expect(header.endsWith('\n')).toBe(true);
    // size token should be present in human readable form (e.g., '1.2 KB' or similar)
    expect(header.match(/[0-9]+/)).not.toBeNull();
  });
});
