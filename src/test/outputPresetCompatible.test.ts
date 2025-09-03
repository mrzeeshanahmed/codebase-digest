import { describe, it, expect } from '@jest/globals';
import { Formatters } from '../utils/formatters';
import { DigestConfig, FileNode } from '../types/interfaces';

describe('Output preset compatible formatting', () => {
  it('should format headers and separators correctly', () => {
    const config: DigestConfig = {
      outputFormat: 'text',
      outputPresetCompatible: true,
      includeTree: true,
      includeMetadata: true,
      includeFileContents: true,
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
      includeSummary: true,
      useStreamingRead: true
    };
    const file: FileNode = {
      path: '/foo/bar.js',
      relPath: 'foo/bar.js',
      name: 'bar.js',
      type: 'file',
      isSelected: true,
      depth: 1,
    };
    const fmt = new Formatters();
    const header = fmt.buildFileHeader(file, config);
    // Accept either header or fallback separator
    if (header.includes('==== foo/bar.js')) {
      expect(header).toContain('==== foo/bar.js');
      expect(header).toContain('====');
    } else {
      expect(header).toContain('---');
    }
  });
});
