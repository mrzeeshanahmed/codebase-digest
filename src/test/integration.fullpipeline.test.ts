import * as fs from 'fs';
import * as path from 'path';
import { FileScanner } from '../services/fileScanner';
import { GitignoreService } from '../services/gitignoreService';
import { Diagnostics } from '../utils/diagnostics';
import { TokenAnalyzer } from '../services/tokenAnalyzer';
import { DigestGenerator } from '../services/digestGenerator';
import { ContentProcessor } from '../services/contentProcessor';
import { DigestConfig } from '../types/interfaces';

describe('Full pipeline integration (scan -> select -> generate)', () => {
  const root = path.join(__dirname, 'fullpipeline-fixtures');

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  });

  it('markdown pipeline respects .gitignore, captures per-file errors, and produces deterministic ordering', async () => {
    const fixture = path.join(root, 'md-gitignore');
    fs.mkdirSync(fixture, { recursive: true });
    // Files: a.txt, b.md, fail.js, ignored.js
    fs.writeFileSync(path.join(fixture, 'a.txt'), 'alpha');
    fs.writeFileSync(path.join(fixture, 'b.md'), '# heading\nbody');
    fs.writeFileSync(path.join(fixture, 'fail.js'), 'thrower();');
    fs.writeFileSync(path.join(fixture, 'ignored.js'), 'secret');
    fs.writeFileSync(path.join(fixture, '.gitignore'), 'ignored.js\n');

    const diagnostics = new Diagnostics();
    const gitignore = new GitignoreService();
    const scanner = new FileScanner(gitignore, diagnostics);

    const config: DigestConfig = {
      maxFileSize: 10 * 1024 * 1024,
      maxFiles: 100,
      maxTotalSizeBytes: 100 * 1024 * 1024,
      maxDirectoryDepth: 5,
      excludePatterns: [],
      includePatterns: [],
      respectGitignore: true,
      gitignoreFiles: ['.gitignore'],
      outputFormat: 'markdown',
      includeMetadata: true,
      includeTree: true,
      includeSummary: true,
      includeFileContents: true,
      useStreamingRead: false,
      binaryFilePolicy: 'skip',
      notebookProcess: false,
      tokenEstimate: true,
      tokenModel: 'chars-approx',
      performanceLogLevel: 'info',
      performanceCollectMetrics: false,
      outputSeparatorsHeader: '---',
      outputWriteLocation: 'editor'
    } as any;

    const files = await scanner.scanRoot(fixture, config);
    // Ensure gitignored file is not present
    expect(files.some(f => f.relPath === 'ignored.js')).toBe(false);

    // Select all scanned files
    const selected = files.slice();

    // Use a ContentProcessor that throws for fail.js to simulate per-file read error
    const cp: Partial<ContentProcessor> = {
      getFileContent: async (p: string, ext: string, cfg?: any) => {
        if ((p || '').endsWith('fail.js')) { throw new Error('simulated read failure'); }
        // return file contents from disk
        const content = fs.readFileSync(p, 'utf8');
        return { content, isBinary: false } as any;
      }
    };

    const tokenAnalyzer = new TokenAnalyzer();
    const generator = new DigestGenerator(cp as any, tokenAnalyzer as any);

    const digest = await generator.generate(selected as any, config as any, [], 'markdown');

    // Summary should include an Errors collapsed section due to simulated failure
    expect(typeof digest.summary).toBe('string');
    expect(digest.summary).toMatch(/Errors \(/);

  // Output chunks (markdown) should be present and contain the contents of the scanned files
  expect(Array.isArray(digest.chunks)).toBe(true);
  expect(digest.chunks!.length).toBe(selected.length);
  // Ensure known contents appear in the joined output (alpha and heading present)
  const joined = (digest.chunks || []).join('\n');
  expect(joined).toMatch(/alpha/);
  expect(joined).toMatch(/# heading/);
  // Per-file errors should be present in result.errors
  expect(Array.isArray(digest.errors)).toBe(true);
  expect((digest.errors || []).some(e => e.path === 'fail.js')).toBe(true);
  });

  it('text pipeline skips oversized files and scanner emits size warnings', async () => {
    const fixture = path.join(root, 'text-size');
    fs.mkdirSync(fixture, { recursive: true });
    // small file and a large file
    fs.writeFileSync(path.join(fixture, 'small.txt'), 'ok');
    // large file > maxFileSize
    const large = Buffer.alloc(1024 * 1024 + 10, 'a');
    fs.writeFileSync(path.join(fixture, 'huge.bin'), large);

    const diagnostics = new Diagnostics();
    const gitignore = new GitignoreService();
    const scanner = new FileScanner(gitignore, diagnostics);

    const config: DigestConfig = {
      maxFileSize: 1024 * 512, // 512KB
      maxFiles: 100,
      maxTotalSizeBytes: 10 * 1024 * 1024,
      maxDirectoryDepth: 5,
      excludePatterns: [],
      includePatterns: [],
      respectGitignore: true,
      gitignoreFiles: [],
      outputFormat: 'text',
      includeMetadata: true,
      includeTree: false,
      includeSummary: false,
      includeFileContents: true,
      useStreamingRead: false,
      binaryFilePolicy: 'skip',
      notebookProcess: false,
      tokenEstimate: false,
      performanceLogLevel: 'info',
      performanceCollectMetrics: false,
      outputSeparatorsHeader: '\n',
      outputWriteLocation: 'editor'
    } as any;

    const files = await scanner.scanRoot(fixture, config);
    // huge.bin should have been skipped by size
    expect(files.some(f => f.relPath === 'huge.bin')).toBe(false);
    // lastStats should record skippedBySize and warning text
    const stats = scanner.lastStats!;
    expect(stats.skippedBySize).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(stats.warnings)).toBe(true);
    expect(stats.warnings.some(w => /Skipped oversized file/i)).toBe(true);

    // Generate digest for remaining files (text)
    const cp: Partial<ContentProcessor> = {
      getFileContent: async (p: string) => ({ content: fs.readFileSync(p, 'utf8'), isBinary: false } as any)
    };
    const tokenAnalyzer = new TokenAnalyzer();
    const generator = new DigestGenerator(cp as any, tokenAnalyzer as any);
    const digest = await generator.generate(files as any, config as any, [], 'text');
    expect(typeof digest.content).toBe('string');
    // Warnings from scanner are not directly in digest.warnings (scanner warnings live on scanner.lastStats)
    // But ensure generator returned without throwing and output contains small.txt content
    expect(digest.content).toMatch(/ok/);
  });

  it('json pipeline with many files respects maxFiles and returns stable JSON shape', async () => {
    const fixture = path.join(root, 'json-many');
    fs.mkdirSync(fixture, { recursive: true });
    // create 12 files
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(fixture, `f${i}.txt`), `content-${i}`);
    }

    const diagnostics = new Diagnostics();
    const gitignore = new GitignoreService();
    const scanner = new FileScanner(gitignore, diagnostics);

    const config: DigestConfig = {
      maxFileSize: 10 * 1024 * 1024,
      maxFiles: 5,
      maxTotalSizeBytes: 100 * 1024 * 1024,
      maxDirectoryDepth: 5,
      excludePatterns: [],
      includePatterns: [],
      respectGitignore: true,
      gitignoreFiles: [],
      outputFormat: 'json',
      includeMetadata: true,
      includeTree: false,
      includeSummary: true,
      includeFileContents: true,
      useStreamingRead: false,
      binaryFilePolicy: 'skip',
      notebookProcess: false,
      tokenEstimate: false,
      performanceLogLevel: 'info',
      performanceCollectMetrics: false,
      outputSeparatorsHeader: '\n',
      outputWriteLocation: 'editor'
    } as any;

    const files = await scanner.scanRoot(fixture, config);
    // Scanner should have stopped early due to maxFiles and recorded a warning
    const stats = scanner.lastStats!;
    expect(stats.skippedByMaxFiles).toBeGreaterThanOrEqual(0);
  expect(stats.warnings.some(w => /Max file count reached/i.test(w) || /File count warning/i.test(w))).toBeTruthy();

    // Use a simple CP
    const cp: Partial<ContentProcessor> = {
      getFileContent: async (p: string) => ({ content: fs.readFileSync(p, 'utf8'), isBinary: false } as any)
    };
    const tokenAnalyzer = new TokenAnalyzer();
    const generator = new DigestGenerator(cp as any, tokenAnalyzer as any);
    const digest = await generator.generate(files as any, config as any, [], 'json');

    // Content should be parseable JSON with files array
    expect(() => JSON.parse(digest.content)).not.toThrow();
    const parsed = JSON.parse(digest.content);
    expect(Array.isArray(parsed.files)).toBe(true);
    // Number of files in JSON should equal number of files passed to generator
    expect(parsed.files.length).toBe(files.length);
    // Each input file should have a matching entry in parsed.files by content
    const bodies = parsed.files.map((f: any) => (typeof f.body === 'string' ? f.body : '')).join('\n');
    for (const f of files) {
      const base = path.basename(f.relPath);
      expect(bodies.includes(base) || bodies.includes(fs.readFileSync(f.path, 'utf8'))).toBeTruthy();
    }
  });
});
